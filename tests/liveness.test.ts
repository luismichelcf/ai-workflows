import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, validateConfig } from '../src/index.js';

import { chain, fakeClock, harness, pipeline, recorder, stage } from './helpers.js';

// Everything the second review found about a run that is still in flight: what another
// terminal can see, what a second controller can do, and what happens when a stage outlives
// its lease — which every real stage does, since the lease is seconds and a test suite is
// minutes.

const held = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
};

describe('while a piece is running', () => {
  it('says which stage it is in, instead of looking like it never ran', async () => {
    // Status was only written when the whole run ended, so `status` from another terminal
    // returned undefined mid-run — and a piece whose controller died was indistinguishable
    // from one that never started.
    const slow = held();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('qa', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );

    const running = engine.run('997');
    await Promise.resolve();
    const midRun = await engine.status('997');
    slow.release();
    await running;

    expect(midRun?.state).toBe('running');
    expect(midRun?.stage).toBe('qa');
  });

  it('says when the current stage started', async () => {
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('qa', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now });

    const running = engine.run('997');
    await Promise.resolve();
    const midRun = await engine.status('997');
    slow.release();
    await running;

    expect(midRun?.startedAt).toBe(clock.now());
  });

  it('shows up in the list of pieces', async () => {
    const slow = held();
    const { engine } = harness(
      chain(
        stage('qa', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );

    const running = engine.run('997');
    await Promise.resolve();
    const listed = await engine.list();
    slow.release();
    await running;

    expect(listed.map((status) => status.piece)).toContain('997');
  });
});

describe('a stage that outlives its lease', () => {
  it('keeps the piece: the engine renews while it works', async () => {
    // Measured before the fix: with a lease shorter than the stage, a second controller
    // took the piece, ran the same gate, and the first one wrote `done` over the second
    // one's rejection.
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 10 });

    const running = engine.run('997');
    await Promise.resolve();
    clock.advance(1000);
    const stolen = await store.reserve('997', 'B', 10);
    slow.release();
    await running;

    expect(stolen.ok).toBe(false);
  });

  it('does not write its verdict if it lost the piece anyway', async () => {
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 10 });

    const running = engine.run('997');
    await Promise.resolve();
    // Someone else took over and already recorded a verdict of their own.
    await store.release('997', 'A');
    await store.reserve('997', 'B', 60_000);
    await store.saveStatus(
      { piece: '997', stage: 'suite', state: 'blocked:rejected', reason: 'la suite quedo roja' },
      (await store.loadStatus('997'))?.version,
    );
    slow.release();
    await running;

    expect((await engine.status('997'))?.state).toBe('blocked:rejected');
  });
});

describe('two runs of the same controller', () => {
  it('does not run the gates twice in parallel', async () => {
    const slow = held();
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('qa', {
          gate: async () => {
            seen.seen.push('qa');
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
      { runId: 'A' },
    );

    const first = engine.run('997');
    const second = engine.run('997');
    slow.release();
    await Promise.all([first, second]);

    expect(seen.seen).toEqual(['qa']);
  });

  it('does not free the piece while one of them is still working', async () => {
    const slow = held();
    const { engine, store } = harness(
      chain(
        stage('qa', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
      { runId: 'A' },
    );

    const first = engine.run('997');
    const second = engine.run('997');
    await Promise.resolve();
    const stolen = await store.reserve('997', 'C', 60_000);
    slow.release();
    await Promise.all([first, second]);

    expect(stolen.ok).toBe(false);
  });
});

describe('stopping is not best-effort', () => {
  it('parks the piece even when someone else wrote in between', async () => {
    // `stop` read, then wrote with the version it read. Over a remote those are two round
    // trips, and a write in between made `stop` throw — the owner's brake silently lost.
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec')), { store });
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    const stale = await store.loadStatus('997');
    await store.saveStatus({ piece: '997', state: 'running', stage: 'spec' }, stale?.version);

    const parked = await engine.stop('997', 'el dueno lo detuvo');

    expect(parked.state).toBe('parked');
    expect((await engine.status('997'))?.state).toBe('parked');
  });
});

describe('the journal cannot be rewritten by a gate', () => {
  it('refuses an edit to an entry it handed out', async () => {
    // A gate took the journal it was given and turned its own `rejected` into `passed`,
    // inside the store. The freeze covered the array, not the entries — which defeats every
    // gate that checks history.
    const store = createMemoryStore();
    let attempt: unknown;
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: false, reason: 'el spec no pasa' }) }),
      ),
      { store },
    );
    await engine.run('997');

    const journal = await store.journal('997');
    try {
      (journal[0] as { outcome: string }).outcome = 'passed';
    } catch (error) {
      attempt = error;
    }

    expect(attempt).toBeDefined();
    expect((await store.journal('997'))[0]?.outcome).toBe('rejected');
  });
});

describe('a store that fails', () => {
  it('reports a technical block instead of throwing out of run', async () => {
    const store = createMemoryStore();
    const broken: typeof store = {
      ...store,
      append: async () => {
        throw new Error('502 de GitHub al escribir el diario');
      },
    };
    const config = pipeline(chain(stage('spec')));
    expect(validateConfig(config)).toEqual({ ok: true });
    const engine = createEngine({ config, store: broken });

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(result.outcome === 'ran' && result.status.reason).toContain('502');
  });
});
