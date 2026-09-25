import { describe, expect, it } from 'vitest';

import {
  EffectNeedsReconciliation,
  ProcessTreeSurvived,
  createEngine,
  createMemoryStore,
  type GateResult,
  type StageConfig,
} from '../src/index.js';

import { chain, fakeClock, pipeline, stage } from './helpers.js';

// PLAN-13-R4 §5: `retry` and `required: false` in the engine. A retried stage runs its gate again
// after a rejection or an ordinary error, waiting between attempts under the cancellation signal,
// and only its last attempt reaches the journal. An optional stage that fails is recorded and the
// piece goes on; it is attempted again on the next run. What must never be retried or waved
// through, optional or not: a skip, a person's pending answer, a process group that survived, an
// effect left in doubt.

const QUARANTINE = { host: 'aqui', platform: 'posix', pgid: 4242 };

/** A gate that answers from a script, one answer per call, and counts the calls. */
function scripted(...answers: Array<GateResult | Error>) {
  let calls = 0;
  const gate = (): GateResult => {
    const answer = answers[Math.min(calls, answers.length - 1)] as GateResult | Error;
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gate, calls: () => calls };
}

const no = (reason: string): GateResult => ({ ok: false, reason });
const yes: GateResult = { ok: true };

function engineWith(stages: StageConfig[], locale = 'es') {
  const clock = fakeClock();
  const store = createMemoryStore({ now: clock.now });
  const waits: number[] = [];
  const onWait: Array<() => Promise<void>> = [];
  const engine = createEngine({
    config: pipeline(stages, locale),
    store,
    now: clock.now,
    // §5: the wait between attempts is injectable so the tests never sleep; it receives the
    // run's cancellation signal.
    sleep: async (ms: number, signal: AbortSignal) => {
      waits.push(ms);
      const hook = onWait.shift();
      if (hook !== undefined) await hook();
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    },
  });
  return { engine, store, waits, onWait };
}

const journalOf = async (store: ReturnType<typeof createMemoryStore>, name: string) =>
  (await store.journal('997')).filter((entry) => entry.stage === name);

describe('retry', () => {
  it('runs the gate again after rejections and passes when an attempt passes, with one entry', async () => {
    const gate = scripted(no('todavía no'), no('todavía no'), yes);
    const { engine, store, waits } = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 3, waitMs: 60_000 } })));

    const result = await engine.run('997');

    expect(result).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
    expect(gate.calls()).toBe(3);
    expect(waits).toEqual([60_000, 60_000]);
    expect((await journalOf(store, 'preview')).map((entry) => entry.outcome)).toEqual(['passed']);
  });

  it('retries an ordinary error too', async () => {
    const gate = scripted(new Error('la red se cayó'), yes);
    const { engine } = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 2, waitMs: 0 } })));

    expect(await engine.run('997')).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
    expect(gate.calls()).toBe(2);
  });

  it('stops after the last attempt, saying how many there were, with one entry', async () => {
    const gate = scripted(no('la vista previa no está lista'));
    const { engine, store } = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 3, waitMs: 10 } })));

    const result = await engine.run('997');

    expect(result).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:rejected', stage: 'preview', reason: expect.stringMatching(/la vista previa no está lista.*tras 3 intentos/) },
    });
    expect(gate.calls()).toBe(3);
    const entries = await journalOf(store, 'preview');
    expect(entries.map((entry) => entry.outcome)).toEqual(['rejected']);
    expect(entries[0]?.reason).toMatch(/tras 3 intentos/);
  });

  it('says it in English when the locale is English', async () => {
    const gate = scripted(new Error('boom'));
    const { engine } = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 2, waitMs: 0 } })), 'en');

    const result = await engine.run('997');

    expect(result).toMatchObject({ status: { state: 'blocked:technical', reason: expect.stringMatching(/after 2 attempts/) } });
  });

  it('a stop during the wait parks the piece without a failed entry and without another attempt', async () => {
    const gate = scripted(no('todavía no'), yes);
    const harness = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 3, waitMs: 60_000 } })));
    harness.onWait.push(async () => {
      await harness.engine.stop('997', 'el dueño pausó');
    });

    const result = await harness.engine.run('997');

    expect(result.outcome).toBe('parked');
    expect(gate.calls()).toBe(1);
    const outcomes = (await journalOf(harness.store, 'preview')).map((entry) => entry.outcome);
    expect(outcomes).not.toContain('failed');
    expect(outcomes).not.toContain('rejected');
  });

  it('never retries a skip', async () => {
    const gate = scripted({ ok: 'skipped', reason: 'no aplica' });
    const { engine, waits } = engineWith(chain(stage('preview', { gate: gate.gate, retry: { attempts: 3, waitMs: 5 } })));

    expect(await engine.run('997')).toMatchObject({ status: { state: 'done' } });
    expect(gate.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('never retries a person who has not answered yet', async () => {
    const gate = scripted(no('falta el visto bueno'));
    const { engine, waits } = engineWith(chain(stage('approval', { gate: gate.gate, needsHuman: true, retry: { attempts: 3, waitMs: 5 } })));

    expect(await engine.run('997')).toMatchObject({ status: { state: 'waiting:decision' } });
    expect(gate.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('never retries a process group that survived, nor an effect in doubt', async () => {
    const survived = scripted(new ProcessTreeSurvived(QUARANTINE), yes);
    const first = engineWith(chain(stage('qa', { gate: survived.gate, retry: { attempts: 3, waitMs: 5 } })));
    expect(await first.engine.run('997')).toMatchObject({ status: { state: 'blocked:technical', quarantine: QUARANTINE } });
    expect(survived.calls()).toBe(1);

    const doubt = scripted(new EffectNeedsReconciliation('997', 'open-pr:feat/997-x:abc', 'pending'), yes);
    const second = engineWith(chain(stage('merge', { gate: doubt.gate, retry: { attempts: 3, waitMs: 5 } })));
    expect(await second.engine.run('997')).toMatchObject({ status: { state: 'blocked:technical' } });
    expect(doubt.calls()).toBe(1);
  });
});

describe('required: false', () => {
  it('a rejection is recorded and the piece goes on to done', async () => {
    const optional = scripted(no('el barrido encontró algo'));
    const after = scripted(yes);
    const { engine, store } = engineWith(chain(
      stage('sweep', { gate: optional.gate, required: false }),
      stage('merge', { gate: after.gate }),
    ));

    const result = await engine.run('997');

    expect(result).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
    expect(after.calls()).toBe(1);
    expect((await journalOf(store, 'sweep')).map((entry) => [entry.outcome, entry.reason])).toEqual([
      ['rejected', 'el barrido encontró algo'],
    ]);
  });

  it('a technical failure is recorded as failed and the piece goes on to done', async () => {
    const optional = scripted(new Error('no se pudo correr'));
    const { engine, store } = engineWith(chain(
      stage('sweep', { gate: optional.gate, required: false }),
      stage('merge'),
    ));

    expect(await engine.run('997')).toMatchObject({ status: { state: 'done' } });
    expect((await journalOf(store, 'sweep')).map((entry) => entry.outcome)).toEqual(['failed']);
  });

  it('is attempted again on the next run, and a pass then is recorded', async () => {
    const optional = scripted(no('todavía no'), yes);
    const { engine, store } = engineWith(chain(
      stage('sweep', { gate: optional.gate, required: false }),
      stage('merge'),
    ));

    await engine.run('997');
    const second = await engine.run('997');

    expect(second).toMatchObject({ status: { state: 'done' } });
    expect(optional.calls()).toBe(2);
    expect((await journalOf(store, 'sweep')).map((entry) => entry.outcome)).toEqual(['rejected', 'passed']);
  });

  it('a passing optional stage is not run again while its evidence holds', async () => {
    const optional = scripted(yes);
    const { engine } = engineWith(chain(stage('sweep', { gate: optional.gate, required: false }), stage('merge')));

    await engine.run('997');
    await engine.run('997');

    expect(optional.calls()).toBe(1);
  });

  it('still blocks on a process group that survived or an effect in doubt', async () => {
    const survived = scripted(new ProcessTreeSurvived(QUARANTINE));
    const next = scripted(yes);
    const first = engineWith(chain(stage('sweep', { gate: survived.gate, required: false }), stage('merge', { gate: next.gate })));
    expect(await first.engine.run('997')).toMatchObject({ status: { state: 'blocked:technical', quarantine: QUARANTINE } });
    expect(next.calls()).toBe(0);

    const doubt = scripted(new EffectNeedsReconciliation('997', 'verdict:sweep:abc', 'uncertain'));
    const second = engineWith(chain(stage('sweep', { gate: doubt.gate, required: false }), stage('merge')));
    expect(await second.engine.run('997')).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep' } });
  });

  it('with retry, exhausts the attempts and then goes on', async () => {
    const optional = scripted(no('todavía no'));
    const { engine, store } = engineWith(chain(
      stage('sweep', { gate: optional.gate, required: false, retry: { attempts: 2, waitMs: 0 } }),
      stage('merge'),
    ));

    expect(await engine.run('997')).toMatchObject({ status: { state: 'done' } });
    expect(optional.calls()).toBe(2);
    expect((await journalOf(store, 'sweep'))[0]?.reason).toMatch(/tras 2 intentos/);
  });
});
