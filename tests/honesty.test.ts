import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore } from '../src/index.js';

import { chain, fakeClock, harness, pipeline, recorder, stage } from './helpers.js';

// The fourth review. Every case here is one the engine currently gets wrong, and each one
// is the same failure in a different coat: the engine saying something that is not so.

const held = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
};

describe('evidence that cannot be stored', () => {
  // Storing evidence means putting it through JSON, and some values do not survive that.
  // The engine has to say so like it says anything else — not fall over. This is the only
  // path in the file where an exception escapes `run` with no status, no journal entry and
  // no diagnosis, and it was introduced by the very change meant to protect the journal.
  const unstorable: Array<[string, () => unknown]> = [
    [
      'a value that points at itself',
      () => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        return loop;
      },
    ],
    ['a function', () => ({ check: () => true })],
    ['a BigInt', () => ({ size: BigInt(9) })],
  ];

  for (const [label, make] of unstorable) {
    it(`reports it instead of crashing when the gate returns ${label}`, async () => {
      const { engine } = harness(
        chain(stage('spec', { gate: () => ({ ok: true, evidence: make() as never }) })),
      );

      const result = await engine.run('997');

      expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    });
  }

  it('names the stage whose evidence could not be stored', async () => {
    const { engine } = harness(
      chain(stage('build', { gate: () => ({ ok: true, evidence: { size: BigInt(9) } as never }) })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.reason).toContain('build');
  });
});

describe('losing the piece is always reported the same way', () => {
  it('says busy, not that it is still running, when the keepalive notices', async () => {
    // Measured: the answer depended on whether a 3 ms timer had fired. Same situation,
    // two different answers — one of them a status that was never stored.
    const inGate = held();
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            inGate.release();
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 30 });

    const running = engine.run('997');
    await inGate.promise;
    clock.advance(1000);
    await store.reserve('997', 'B', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    slow.release();
    const result = await running;

    expect(result.outcome).toBe('busy');
  });

  it('says who took it', async () => {
    const inGate = held();
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            inGate.release();
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 30 });

    const running = engine.run('997');
    await inGate.promise;
    clock.advance(1000);
    await store.reserve('997', 'B', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    slow.release();
    const result = await running;

    expect(result.outcome === 'busy' && result.heldBy).toContain('B');
  });

  it('does not report busy when nobody holds the piece', async () => {
    // `busy` means someone else has it. A lapsed lease that nobody took is a different
    // thing and needs a different answer, or the caller waits for a controller that does
    // not exist.
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const emptyHolder: typeof store = {
      ...store,
      renew: async () => ({ ok: false, heldBy: '', expiresAt: 0 }),
    };
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({ config, store: emptyHolder, now: clock.now });

    const result = await engine.run('997');

    expect(result.outcome).not.toBe('busy');
  });

  it('never reports a status it did not store', async () => {
    const inGate = held();
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            inGate.release();
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 30 });

    const running = engine.run('997');
    await inGate.promise;
    clock.advance(1000);
    await store.reserve('997', 'B', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    slow.release();
    const result = await running;

    if (result.outcome === 'ran') {
      expect(await engine.status('997')).toEqual(result.status);
    }
  });
});

describe('the lease holds through the whole run', () => {
  it('holds it between reserving and the first gate', async () => {
    // The keepalive only ran around each gate, so the stretch before the first one —
    // reading status, reading the journal, describing the change — was uncovered. Over a
    // store with real latency that stretch is where a piece gets stolen.
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const slowRead: typeof store = {
      ...store,
      journal: async (piece) => {
        for (let tick = 0; tick < 20; tick += 1) {
          clock.advance(5);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return store.journal(piece);
      },
    };
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({
      config,
      store: slowRead,
      now: clock.now,
      runId: 'A',
      leaseMs: 30,
    });

    const running = engine.run('997');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const stolen = await store.reserve('997', 'B', 30);
    await running;

    expect(stolen.ok).toBe(false);
  });
});

describe('two controllers in different processes', () => {
  it('do not both hold the piece just because they share a runId', async () => {
    // The instance counter that told them apart restarts at 1 in every process, so two
    // processes with the same runId present the same identity to the store. The test that
    // covered this opened both in one process, where the counter does distinguish them.
    const store = createMemoryStore();
    const config = pipeline(chain(stage('spec')));
    const one = createEngine({ config, store, runId: 'ci' });

    // A fresh process would start its counter over, which is what a second engine built
    // with the same runId has to be indistinguishable from.
    const first = await store.reserve('ci#1', 'ci#1', 60_000);
    expect(first.ok).toBe(true);

    const two = createEngine({ config, store, runId: 'ci' });
    const [a, b] = await Promise.all([one.run('997'), two.run('997')]);
    const ran = [a, b].filter((result) => result.outcome === 'ran');

    expect(ran).toHaveLength(1);
  });

  it('does not leak an internal counter into who holds the piece', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'otro-controlador', 60_000);
    const { engine } = harness(chain(stage('spec')), { store, runId: 'mio' });

    const result = await engine.run('997');

    expect(result.outcome === 'busy' && result.heldBy).toBe('otro-controlador');
  });
});

describe('a dry run says what it could not check', () => {
  // Owner's decision, 12-sep: check everything it can, and list what it could not. A dry
  // run that skips a stage it cannot rehearse and then answers `done` is a false green in
  // the one mode meant to be safe.
  it('does not answer done when it skipped a stage it could not rehearse', async () => {
    const { engine } = harness(
      chain(
        stage('open-pr', {
          gate: async (context) => {
            await context.runEffect('open-pr', async () => ({ pr: 7 }));
            return { ok: true };
          },
        }),
        stage('queue'),
      ),
    );

    const result = await engine.run('997', { mode: 'dry-run' });

    expect(result.outcome === 'ran' && result.status.state).not.toBe('done');
  });

  it('still checks the stages that come after it', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('open-pr', {
          gate: async (context) => {
            await context.runEffect('open-pr', async () => ({ pr: 7 }));
            return { ok: true };
          },
        }),
        stage('queue', { gate: seen.gateFor('queue') }),
      ),
    );

    await engine.run('997', { mode: 'dry-run' });

    expect(seen.seen).toContain('queue');
  });

  it('names the stage it could not check', async () => {
    const { engine } = harness(
      chain(
        stage('open-pr', {
          gate: async (context) => {
            await context.runEffect('open-pr', async () => ({ pr: 7 }));
            return { ok: true };
          },
        }),
      ),
    );

    const result = await engine.run('997', { mode: 'dry-run' });

    expect(result.outcome === 'ran' && result.status.reason).toContain('open-pr');
  });
});

describe('stopping a piece that does not exist', () => {
  // Owner's decision, 12-sep: say it does not exist; do not create it.
  it('does not store anything', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec')), { store });

    await engine.stop('no-existe', 'freno').catch(() => undefined);

    expect(await store.loadStatus('no-existe')).toBeUndefined();
  });

  it('does not leave a piece that a later run would find parked', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec')), { store });
    await engine.stop('no-existe', 'freno').catch(() => undefined);

    const result = await engine.run('no-existe');

    expect(result.outcome).not.toBe('parked');
  });

  it('still parks a piece that does exist', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec')), { store });
    await engine.run('997');

    const parked = await engine.stop('997', 'freno');

    expect(parked.state).toBe('parked');
  });
});

describe('releasing the piece is cleanup, not a verdict', () => {
  it('leaves a trace when it could not release', async () => {
    // Swallowing it silently means the lease stays taken until it lapses and nobody knows.
    const store = createMemoryStore();
    const broken: typeof store = {
      ...store,
      release: async () => {
        throw new Error('500 al soltar la etiqueta');
      },
    };
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({ config, store: broken });

    const result = await engine.run('997');

    expect(result.outcome).toBe('ran');
    expect(result.outcome === 'ran' && (result.status.reason ?? '')).toContain('500');
  });
});

describe('deep freezing covers what it claims', () => {
  it('freezes evidence nested several levels down', async () => {
    let edit: unknown;
    const { engine } = harness(
      chain(
        stage('spec', {
          gate: () => ({ ok: true, evidence: { a: { b: { c: 'original' } } } }),
        }),
        stage('flock', {
          gate: (context) => {
            try {
              (context.journal[0]?.evidence as { a: { b: { c: string } } }).a.b.c = 'cambiado';
            } catch (error) {
              edit = error;
            }
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(edit).toBeDefined();
  });

  it('freezes evidence inside arrays', async () => {
    let edit: unknown;
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: true, evidence: { items: [{ k: 'original' }] } }) }),
        stage('flock', {
          gate: (context) => {
            try {
              (context.journal[0]?.evidence as { items: Array<{ k: string }> }).items[0]!.k = 'x';
            } catch (error) {
              edit = error;
            }
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(edit).toBeDefined();
  });

  it('refuses an edit to an entry that carries evidence', async () => {
    let edit: unknown;
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: true, evidence: { sha: 'abc' } }) }),
        stage('flock', {
          gate: (context) => {
            try {
              (context.journal[0] as { outcome: string }).outcome = 'rejected';
            } catch (error) {
              edit = error;
            }
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(edit).toBeDefined();
  });

  it('does not freeze the object the gate kept for itself', async () => {
    // The engine stores a copy. Freezing the gate's own object would be a surprise the
    // contract never promised.
    let mutable = false;
    const { engine } = harness(
      chain(
        stage('spec', {
          gate: () => {
            const evidence = { sha: 'abc' };
            queueMicrotask(() => {
              try {
                evidence.sha = 'otro';
                mutable = true;
              } catch {
                mutable = false;
              }
            });
            return { ok: true, evidence };
          },
        }),
      ),
    );

    await engine.run('997');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(mutable).toBe(true);
  });
});
