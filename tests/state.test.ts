import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../src/index.js';

// PLAN-997 §5.7. Two guarantees, both of them cheap and both of them load-bearing:
//   1. A reservation is taken with a version comparison, so two controllers racing for the
//      same piece cannot both win (CN-12).
//   2. Every external effect carries an operation id and a pending/confirmed/uncertain state,
//      so resuming after a crash reconciles instead of repeating (CN-13).

describe('reservations', () => {
  it('lets a free piece be reserved', async () => {
    const store = createMemoryStore();

    expect(await store.reserve('997', 'run-a')).toBe(true);
  });

  it('gives the piece to exactly one of two controllers racing for it', async () => {
    const store = createMemoryStore();

    const results = await Promise.all([
      store.reserve('997', 'run-a'),
      store.reserve('997', 'run-b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a second controller while the first one holds the piece', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a');

    expect(await store.reserve('997', 'run-b')).toBe(false);
  });

  it('lets the same controller re-take its own reservation', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a');

    expect(await store.reserve('997', 'run-a')).toBe(true);
  });

  it('frees the piece when its holder releases it', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'run-a');
    await store.release('997', 'run-a');

    expect(await store.reserve('997', 'run-b')).toBe(true);
  });
});

describe('external effects', () => {
  it('records an effect as pending before it is attempted', async () => {
    const store = createMemoryStore();

    await store.beginEffect('997', 'open-pr');

    expect((await store.getEffect('997', 'open-pr'))?.state).toBe('pending');
  });

  it('marks it confirmed once it succeeded, keeping what it produced', async () => {
    const store = createMemoryStore();
    await store.beginEffect('997', 'open-pr');

    await store.confirmEffect('997', 'open-pr', { pr: 1234 });
    const effect = await store.getEffect('997', 'open-pr');

    expect(effect?.state).toBe('confirmed');
    expect(effect?.result).toEqual({ pr: 1234 });
  });

  it('does not repeat a confirmed effect: the second attempt returns the first result', async () => {
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

  it('leaves an effect uncertain when it failed mid-flight, instead of retrying blindly', async () => {
    const store = createMemoryStore();

    await expect(
      store.runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      }),
    ).rejects.toThrow('la red se cayo');

    expect((await store.getEffect('997', 'open-pr'))?.state).toBe('uncertain');
  });

  it('keeps effects of different pieces apart', async () => {
    const store = createMemoryStore();
    await store.runEffect('997', 'open-pr', async () => ({ pr: 1 }));

    expect(await store.getEffect('998', 'open-pr')).toBeUndefined();
  });
});
