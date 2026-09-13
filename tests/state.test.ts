import { describe, expect, it } from 'vitest';

import { EffectNeedsReconciliation, StaleVersion, createMemoryStore } from '../src/index.js';

import { fakeClock } from './helpers.js';

// §5.7. Two guarantees, both cheap and both load-bearing:
//   1. A reservation is taken under a lease with a version token, so two controllers racing
//      for the same piece cannot both win — including over a remote, where read and write
//      are two round trips and a `Map`-shaped check would be a race.
//   2. Every external effect carries an operation id and a pending/confirmed/uncertain
//      state, so resuming after a crash reconciles instead of opening a second pull request.

const LEASE = 30_000;

describe('reservations', () => {
  it('lets a free piece be reserved', async () => {
    const store = createMemoryStore();

    expect((await store.reserve('997', 'run-a', LEASE)).ok).toBe(true);
  });

  it('gives the piece to exactly one of two controllers racing for it', async () => {
    const store = createMemoryStore();

    const results = await Promise.all([
      store.reserve('997', 'run-a', LEASE),
      store.reserve('997', 'run-b', LEASE),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('tells the loser who holds it and until when, instead of a bare false', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a', LEASE);

    const result = await store.reserve('997', 'run-b', LEASE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.heldBy).toBe('run-a');
    expect(result.ok === false && result.expiresAt).toBeGreaterThan(0);
  });

  it('lets the holder renew its own lease', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a', LEASE);

    expect((await store.renew('997', 'run-a', LEASE)).ok).toBe(true);
  });

  it('refuses to renew a lease the caller does not hold', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a', LEASE);

    expect((await store.renew('997', 'run-b', LEASE)).ok).toBe(false);
  });

  it('frees the piece when its holder releases it', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a', LEASE);
    await store.release('997', 'run-a');

    expect((await store.reserve('997', 'run-b', LEASE)).ok).toBe(true);
  });

  it('ignores a release from someone who is not the holder', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a', LEASE);
    await store.release('997', 'run-b');

    expect((await store.reserve('997', 'run-c', LEASE)).ok).toBe(false);
  });

  it('lets another controller take over once the lease expired', async () => {
    // Without this, a controller killed mid-run leaves the piece reserved forever: over
    // GitHub the reservation outlives the process that wrote it.
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    await store.reserve('997', 'run-a', LEASE);

    clock.advance(LEASE + 1);

    expect((await store.reserve('997', 'run-b', LEASE)).ok).toBe(true);
  });

  it('does not let anyone take over while the lease is still alive', async () => {
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    await store.reserve('997', 'run-a', LEASE);

    clock.advance(LEASE - 1);

    expect((await store.reserve('997', 'run-b', LEASE)).ok).toBe(false);
  });
});

describe('versioned writes', () => {
  it('hands out a version with every read', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);

    expect((await store.loadStatus('997'))?.version).toBeTruthy();
  });

  it('accepts a write that carries the version it read', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    const read = await store.loadStatus('997');

    await expect(
      store.saveStatus({ piece: '997', state: 'done' }, read?.version),
    ).resolves.toBeTruthy();
  });

  it('refuses a write whose version is stale, instead of overwriting', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    const stale = (await store.loadStatus('997'))?.version;

    // Someone else writes in between.
    await store.saveStatus({ piece: '997', state: 'blocked:rejected' }, stale);

    await expect(store.saveStatus({ piece: '997', state: 'done' }, stale)).rejects.toBeInstanceOf(
      StaleVersion,
    );
  });

  it('changes the version on every write', async () => {
    const store = createMemoryStore();
    const first = await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    const second = await store.saveStatus({ piece: '997', state: 'done' }, first);

    expect(second).not.toBe(first);
  });

  it('lists every piece it knows about', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    await store.saveStatus({ piece: '998', state: 'done' }, undefined);

    expect((await store.listStatuses()).map((status) => status.piece).sort()).toEqual([
      '997',
      '998',
    ]);
  });
});

describe('the journal', () => {
  const entry = (stage: string, outcome: 'passed' | 'rejected') => ({
    stage,
    outcome,
    at: 1,
    runId: 'run-a',
    pipeline: 'fp',
  });

  it('keeps entries in the order they were appended', async () => {
    const store = createMemoryStore();
    await store.append('997', entry('spec', 'passed'));
    await store.append('997', entry('build', 'rejected'));

    expect((await store.journal('997')).map((item) => item.stage)).toEqual(['spec', 'build']);
  });

  it('keeps journals of different pieces apart', async () => {
    const store = createMemoryStore();
    await store.append('997', entry('spec', 'passed'));

    expect(await store.journal('998')).toEqual([]);
  });

  it('cannot be rewritten through the value it hands out', async () => {
    // The journal is what execution-record gates are checked against; a caller that could
    // edit it in place would defeat them.
    const store = createMemoryStore();
    await store.append('997', entry('spec', 'passed'));
    const journal = await store.journal('997');

    expect(() => (journal as { length: number }).length = 0).toThrow();
  });
});

describe('external effects', () => {
  it('does not repeat a confirmed effect: the second call returns the first result', async () => {
    const store = createMemoryStore();
    let attempts = 0;
    const openPr = async () => {
      attempts += 1;
      return { pr: 1234 };
    };

    const first = await store.runEffect('997', 'open-pr', openPr);
    const second = await store.runEffect('997', 'open-pr', openPr);

    expect(attempts).toBe(1);
    expect(second).toEqual(first);
  });

  it('runs the effect once when two calls race with the same operation id', async () => {
    // The in-flight case. Without it, two overlapping calls both see "not confirmed" and
    // both run: two pull requests, and the first one's number lost forever.
    const store = createMemoryStore();
    let attempts = 0;
    const openPr = async () => {
      attempts += 1;
      await Promise.resolve();
      return { pr: attempts };
    };

    const [a, b] = await Promise.all([
      store.runEffect('997', 'open-pr', openPr),
      store.runEffect('997', 'open-pr', openPr),
    ]);

    expect(attempts).toBe(1);
    expect(a).toEqual(b);
  });

  it('leaves an effect uncertain when it failed mid-flight', async () => {
    const store = createMemoryStore();

    await expect(
      store.runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      }),
    ).rejects.toThrow('la red se cayo');

    expect((await store.getEffect('997', 'open-pr'))?.state).toBe('uncertain');
  });

  it('refuses to retry an uncertain effect, instead of opening a second pull request', async () => {
    const store = createMemoryStore();
    let attempts = 0;
    await store
      .runEffect('997', 'open-pr', async () => {
        attempts += 1;
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);

    await expect(
      store.runEffect('997', 'open-pr', async () => {
        attempts += 1;
        return { pr: 1 };
      }),
    ).rejects.toBeInstanceOf(EffectNeedsReconciliation);
    expect(attempts).toBe(1);
  });

  it('runs the effect again once someone reconciled it', async () => {
    const store = createMemoryStore();
    await store
      .runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);

    await store.reconcileEffect('997', 'open-pr', { pr: 77 });

    expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 99 }))).toEqual({ pr: 77 });
  });

  it('keeps effects of different pieces apart', async () => {
    const store = createMemoryStore();
    await store.runEffect('997', 'open-pr', async () => ({ pr: 1 }));

    expect(await store.getEffect('998', 'open-pr')).toBeUndefined();
  });
});

describe('effects travel as JSON', () => {
  it('gives back the same shape after the result was stored', async () => {
    // Over a remote store the result is text, so a Date comes back as a string. The memory
    // store must make the same round trip, or the difference only shows up on a resume in
    // production — the one path nobody exercises by hand.
    const store = createMemoryStore();
    const stamp = '2026-09-12T10:00:00.000Z';

    await store.runEffect('997', 'open-pr', async () => ({ pr: 1, createdAt: stamp }));
    const again = await store.runEffect('997', 'open-pr', async () => ({ pr: 2, createdAt: stamp }));

    expect(again).toEqual({ pr: 1, createdAt: stamp });
  });

  it('does not hand back a live object a caller could mutate', async () => {
    const store = createMemoryStore();
    const first = await store.runEffect('997', 'open-pr', async () => ({ pr: 1 }));
    (first as { pr: number }).pr = 99;

    expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 2 }))).toEqual({ pr: 1 });
  });
});

describe('reconciling an effect', () => {
  it('lets a verifier say it never happened, so it can be retried', async () => {
    // Without this, whoever checks GitHub and finds no such PR would have to invent a
    // result to move on: fabricating evidence.
    const store = createMemoryStore();
    await store
      .runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);

    await store.reconcileEffect('997', 'open-pr', { didNotHappen: true });

    expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 7 }))).toEqual({ pr: 7 });
  });

  it('lets a verifier confirm what actually happened', async () => {
    const store = createMemoryStore();
    await store
      .runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);

    await store.reconcileEffect('997', 'open-pr', { confirmed: { pr: 77 } });

    expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 99 }))).toEqual({ pr: 77 });
  });
});

describe('the journal is append-only', () => {
  const anEntry = {
    stage: 'spec',
    outcome: 'rejected' as const,
    at: 1,
    runId: 'run-a',
    pipeline: 'fp',
  };

  it('refuses an edit to an entry it handed out', async () => {
    const store = createMemoryStore();
    await store.append('997', anEntry);
    const journal = await store.journal('997');

    expect(() => {
      (journal[0] as { outcome: string }).outcome = 'passed';
    }).toThrow();
  });

  it('keeps the stored entry intact even if a caller tried', async () => {
    const store = createMemoryStore();
    await store.append('997', anEntry);
    try {
      (((await store.journal('997'))[0]) as { outcome: string }).outcome = 'passed';
    } catch {
      // expected
    }

    expect((await store.journal('997'))[0]?.outcome).toBe('rejected');
  });

  it('drops one stage entries when asked to forget them', async () => {
    const store = createMemoryStore();
    await store.append('997', anEntry);
    await store.append('997', { ...anEntry, stage: 'vieja' });

    await store.forget('997', 'vieja');

    expect((await store.journal('997')).map((entry) => entry.stage)).toEqual(['spec']);
  });
});

describe('zones', () => {
  it('lets one piece take a zone', async () => {
    const store = createMemoryStore();

    expect((await store.reserveZone('nomina', '997', 'run-a', 30_000)).ok).toBe(true);
  });

  it('keeps a second piece out of a taken zone', async () => {
    const store = createMemoryStore();
    await store.reserveZone('nomina', '997', 'run-a', 30_000);

    expect((await store.reserveZone('nomina', '998', 'run-b', 30_000)).ok).toBe(false);
  });

  it('does not confuse one zone with another', async () => {
    const store = createMemoryStore();
    await store.reserveZone('nomina', '997', 'run-a', 30_000);

    expect((await store.reserveZone('tiempo', '998', 'run-b', 30_000)).ok).toBe(true);
  });

  it('frees the zone when its holder releases it', async () => {
    const store = createMemoryStore();
    await store.reserveZone('nomina', '997', 'run-a', 30_000);
    await store.releaseZone('nomina', 'run-a');

    expect((await store.reserveZone('nomina', '998', 'run-b', 30_000)).ok).toBe(true);
  });

  it('hands a lapsed zone to the next piece', async () => {
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    await store.reserveZone('nomina', '997', 'run-a', 30_000);

    clock.advance(30_001);

    expect((await store.reserveZone('nomina', '998', 'run-b', 30_000)).ok).toBe(true);
  });
});

describe('renew on a free piece', () => {
  it('does not name the caller as the holder of a piece nobody holds', async () => {
    const store = createMemoryStore();

    const result = await store.renew('997', 'run-a', 30_000);

    expect(result.ok === false && result.heldBy).not.toBe('run-a');
  });
});
