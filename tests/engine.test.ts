import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, validateConfig } from '../src/index.js';

// PLAN-997 §5.4 and §5.6. The engine's whole reason to exist: a stage advances ONLY if its
// gate says so, and a gate that cannot run is not the same as a gate that said no.
//   - gate returns {ok:false}  -> blocked:rejected   (the content is wrong)
//   - gate throws              -> blocked:technical  (the check could not run)
// A stage that needs a person stops at waiting:decision without failing.

type GateResult = { ok: true } | { ok: false; reason: string };

const ok = () => ({ ok: true }) as GateResult;
const no = (reason: string) => () => ({ ok: false, reason }) as GateResult;
const boom = (reason: string) => () => {
  throw new Error(reason);
};

const pipeline = (stages: Array<Record<string, unknown>>) => ({ locale: 'es', stages });

const engineFor = (stages: Array<Record<string, unknown>>) => {
  const config = pipeline(stages);
  expect(validateConfig(config).ok).toBe(true);
  return createEngine({ config, store: createMemoryStore() });
};

describe('engine.run', () => {
  it('runs every stage in order when all gates pass', async () => {
    const seen: string[] = [];
    const engine = engineFor([
      { name: 'spec', gate: () => { seen.push('spec'); return ok(); } },
      { name: 'build', after: 'spec', gate: () => { seen.push('build'); return ok(); } },
      { name: 'gate', after: 'build', gate: () => { seen.push('gate'); return ok(); } },
    ]);

    const result = await engine.run('997');

    expect(seen).toEqual(['spec', 'build', 'gate']);
    expect(result.state).toBe('done');
  });

  it('stops at the failing stage and does not run the next one', async () => {
    let laterRan = false;
    const engine = engineFor([
      { name: 'spec', gate: ok },
      { name: 'build', after: 'spec', gate: no('falta el benchmark') },
      { name: 'gate', after: 'build', gate: () => { laterRan = true; return ok(); } },
    ]);

    const result = await engine.run('997');

    expect(laterRan).toBe(false);
    expect(result.stage).toBe('build');
    expect(result.state).toBe('blocked:rejected');
  });

  it('reports the reason the gate gave, not a generic failure', async () => {
    const engine = engineFor([{ name: 'build', gate: no('falta el benchmark') }]);

    const result = await engine.run('997');

    expect(result.reason).toContain('falta el benchmark');
  });

  it('distinguishes a gate that could not run from a gate that said no', async () => {
    const engine = engineFor([{ name: 'gate', gate: boom('el preview no desplego') }]);

    const result = await engine.run('997');

    expect(result.state).toBe('blocked:technical');
    expect(result.stage).toBe('gate');
  });

  it('stops at waiting:decision when a stage needs a person, without failing', async () => {
    let laterRan = false;
    const engine = engineFor([
      { name: 'qa', gate: ok },
      { name: 'sign-off', after: 'qa', needsHuman: true, gate: no('sin visto bueno') },
      { name: 'queue', after: 'sign-off', gate: () => { laterRan = true; return ok(); } },
    ]);

    const result = await engine.run('997');

    expect(result.state).toBe('waiting:decision');
    expect(result.stage).toBe('sign-off');
    expect(laterRan).toBe(false);
  });

  it('resumes at the stage it stopped on, without re-running the ones already passed', async () => {
    let specRuns = 0;
    let allow = false;
    const engine = engineFor([
      { name: 'spec', gate: () => { specRuns += 1; return ok(); } },
      { name: 'build', after: 'spec', gate: () => (allow ? ok() : no('aun no')) },
    ]);

    await engine.run('997');
    expect(specRuns).toBe(1);

    allow = true;
    const second = await engine.run('997');

    expect(specRuns).toBe(1);
    expect(second.state).toBe('done');
  });

  it('a stopped piece keeps its work and does not advance on the next run', async () => {
    const engine = engineFor([
      { name: 'spec', gate: ok },
      { name: 'build', after: 'spec', gate: ok },
    ]);

    await engine.stop('997', 'el dueno lo detuvo');
    const result = await engine.run('997');

    expect(result.state).toBe('parked');
    expect(result.reason).toContain('el dueno lo detuvo');
  });
});

describe('engine.status', () => {
  it('reports nothing for a piece that never ran', async () => {
    const engine = engineFor([{ name: 'spec', gate: ok }]);

    expect(await engine.status('997')).toBeUndefined();
  });

  it('reports the stage and state the piece stopped at', async () => {
    const engine = engineFor([{ name: 'build', gate: no('falta el benchmark') }]);

    await engine.run('997');
    const status = await engine.status('997');

    expect(status?.stage).toBe('build');
    expect(status?.state).toBe('blocked:rejected');
  });
});
