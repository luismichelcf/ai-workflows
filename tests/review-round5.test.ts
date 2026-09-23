import { describe, expect, it } from 'vitest';

import { StaleVersion, createEngine, createMemoryStore, type Store } from '../src/index.js';

// Review round 5 of PR #17 (delta e033ec1..74c5a0c, the quarantine refactor). Two regressions
// the refactor brought and the proofs it lacked: a controller that lost its lease never writes
// over the one that holds it; a stop that lands while a quarantine is being checked wins, as a
// stop always did; a lift that loses its race runs no stage, and one that wins after a retry does.

const QA = { host: 'elsewhere-a', platform: 'posix', pgid: 11, confirmed: false } as const;
const QB = { host: 'elsewhere-b', platform: 'posix', pgid: 22, confirmed: false } as const;

function counting() {
  let ran = 0;
  const config = { locale: 'es', stages: [{ name: 'only', nature: 'recompute' as const, gate: () => { ran += 1; return { ok: true as const }; } }] };
  return { config, ran: () => ran };
}

describe('a controller that lost its lease while checking a quarantine writes nothing', () => {
  async function race(answerOfA: string | undefined) {
    let clock = 1_000_000;
    const store = createMemoryStore({ now: () => clock });
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    const common = { config, store, now: () => clock, leaseMs: 30_000 };
    const b = createEngine({ ...common, runId: 'b', confirmQuarantine: async () => undefined });
    let outcomeOfB: unknown;
    const a = createEngine({
      ...common,
      runId: 'a',
      confirmQuarantine: async () => {
        clock += 10 * 60_000; // A's check outlives its lease…
        outcomeOfB = await b.run('42'); // …and B takes the piece, lifts the quarantine and finishes
        return answerOfA;
      },
    });
    const outcomeOfA = await a.run('42');
    return { store, outcomeOfA, outcomeOfB, ran: ran() };
  }

  it('an answer of "still alive" is not written over the piece another controller finished', async () => {
    const { store, outcomeOfA, outcomeOfB, ran } = await race('still alive');
    expect(outcomeOfB).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
    expect(ran).toBe(1);
    expect(outcomeOfA).toMatchObject({ outcome: 'busy' });
    expect((await store.loadStatus('42'))?.status).toMatchObject({ state: 'done' });
    expect((await store.loadStatus('42'))?.status.quarantine).toBeUndefined();
  });

  it('an answer of "empty" does not block the piece another controller already lifted and finished', async () => {
    const { store, outcomeOfA, ran } = await race(undefined);
    expect(ran).toBe(1);
    expect(outcomeOfA).toMatchObject({ outcome: 'busy' });
    expect((await store.loadStatus('42'))?.status).toMatchObject({ state: 'done' });
  });
});

describe('a stop that lands while a quarantine is being checked wins', () => {
  it('stopped during a "still alive" check: the piece is parked, the quarantine kept', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    const outcome = await createEngine({
      config,
      store,
      confirmQuarantine: async () => {
        await createEngine({ config, store, runId: 'owner' }).stop('42', 'the owner stops it');
        return 'still alive';
      },
    }).run('42');
    expect(outcome).toMatchObject({ outcome: 'parked', status: { state: 'parked' } });
    expect((await store.loadStatus('42'))?.status).toMatchObject({ state: 'parked', quarantine: QA });
    expect(ran()).toBe(0);
  });

  it('stopped while another quarantine joined: parked, both quarantines kept', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    const outcome = await createEngine({
      config,
      store,
      confirmQuarantine: async () => {
        await createEngine({ config, store, runId: 'owner' }).stop('42', 'the owner stops it');
        const current = await store.loadStatus('42');
        if (current) await store.saveStatus({ ...current.status, quarantine: [QA, QB] }, current.version);
        return undefined;
      },
    }).run('42');
    expect(outcome).toMatchObject({ outcome: 'parked' });
    const status = (await store.loadStatus('42'))?.status;
    expect(status?.state).toBe('parked');
    expect(status?.quarantine).toEqual(expect.arrayContaining([QA, QB]));
    expect(ran()).toBe(0);
  });
});

describe('a lift runs stages only when its write lands', () => {
  function staleLift(times: number) {
    const inner = createMemoryStore();
    let left = times;
    const store: Store = {
      ...inner,
      saveStatus: async (status, version) => {
        if (left > 0 && status.quarantine === undefined && status.state === 'blocked:technical') {
          left -= 1;
          throw new StaleVersion('42');
        }
        return inner.saveStatus(status, version);
      },
    };
    return { inner, store };
  }

  it('a lift whose write always loses its race runs no stage and says so', async () => {
    const { inner, store } = staleLift(Number.POSITIVE_INFINITY);
    await inner.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    const outcome = await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(ran()).toBe(0);
    expect(outcome).toMatchObject({ outcome: 'ran', status: { state: 'blocked:technical', reason: expect.stringMatching(/quarantine/) } });
    expect((await inner.loadStatus('42'))?.status.quarantine).toEqual(QA);
  });

  it('a lift that loses one race and then lands runs the stages', async () => {
    const { inner, store } = staleLift(1);
    await inner.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(ran()).toBe(1);
    expect((await inner.loadStatus('42'))?.status.quarantine).toBeUndefined();
  });
});

describe('resume decides for the owner', () => {
  it('resuming a quarantined piece that was stopped lets it run once the quarantine is lifted', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA, previous: { state: 'parked', reason: 'the owner stopped it' } }, undefined);
    const { config, ran } = counting();
    const resumed = await createEngine({ config, store }).resume('42');
    expect(resumed.quarantine).toEqual(QA);
    await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(ran()).toBe(1);
  });
});
