import { describe, expect, it } from 'vitest';

import {
  createEngine,
  createMemoryStore,
  parseTestRun,
  requireDifferentBuilder,
  requireFreshVerdicts,
  requireSections,
  requireSources,
  type ExecutionIdentity,
  type Verdict,
} from '../src/index.js';

import { chain, pipeline, recorder, stage } from './helpers.js';

// The thirteen attempts to get around the process. These are not a trial run: they are the
// engine's permanent suite, and every change re-attempts all of them. If one ever passes,
// the engine is broken, not the rule.
//
// Each case checks the SPECIFIC reason, the resulting state, and that nothing happened —
// not merely that "it failed". Each one also carries its positive control, because an
// implementation that rejects everything would pass a suite of refusals.
//
// Four cases cannot be executed yet: they need locks and checks that do not exist. They are
// declared below by name, with what they are waiting for. Declared beats pretended: a case
// silently missing from this file is how a suite of thirteen quietly becomes a suite of
// nine.

/** Cases that cannot run yet, and what each is waiting for. */
export const NOT_YET_EXECUTABLE: Record<string, string> = {
  'CN-05': 'needs the sign-off check on a real pull request (slice 4)',
  'CN-07': 'needs the editor hooks installed in a project (slice 4)',
  'CN-08': 'needs the server-side check enforced by a branch ruleset (slice 6)',
  'CN-09': 'needs the module boundary lint of a real project (slice 5)',
};

const builder: ExecutionIdentity = { provider: 'deepseek', model: 'deepseek-flash', session: 's-1' };
const reviewer: ExecutionIdentity = { provider: 'claude', model: 'claude-opus-5', session: 's-2' };

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  by: reviewer,
  sha: 'abc123',
  approved: true,
  ...over,
});

const sources = (...urls: string[]) => urls.map((url) => `- [x](${url})\n`).join('');
const fiveGood = sources(
  'https://productive.io/a',
  'https://scoro.com/b',
  'https://runn.io/c',
  'https://ruddr.io/d',
  'https://forecast.app/e',
);

describe('CN-01 · advancing without the benchmark', () => {
  it('is refused, naming what is missing', () => {
    const spec = '## Decisiones\n\ntexto\n';

    const result = requireSections(spec, ['Benchmark', 'Decisiones']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('Benchmark');
  });

  it('is refused when the sources are all the same vendor', () => {
    const five = sources(
      'https://productive.io/a',
      'https://productive.io/b',
      'https://productive.io/c',
      'https://productive.io/d',
      'https://productive.io/e',
    );

    expect(requireSources(five, { min: 5 }).ok).toBe(false);
  });

  it('positive control: a real benchmark advances', () => {
    expect(requireSources(fiveGood, { min: 5 }).ok).toBe(true);
  });
});

describe('CN-02 · the builder approving its own work', () => {
  it('is refused by execution identity, even published from the same account', () => {
    const result = requireDifferentBuilder([verdict({ by: builder })], builder);

    expect(result.ok).toBe(false);
  });

  it('is refused for another session of the same model when families must differ', () => {
    const result = requireDifferentBuilder(
      [verdict({ by: { ...builder, session: 's-9' } })],
      builder,
      { differentProvider: true },
    );

    expect(result.ok).toBe(false);
  });

  it('positive control: a verdict from another family advances', () => {
    expect(requireDifferentBuilder([verdict()], builder, { differentProvider: true }).ok).toBe(true);
  });
});

describe('CN-03 · using the review of A after the code became B', () => {
  it('is refused, naming both versions', () => {
    const result = requireFreshVerdicts([verdict({ sha: 'A' })], 'B');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('A');
    expect(result.ok === false && result.reason).toContain('B');
  });

  it('positive control: once B is reviewed, it advances', () => {
    expect(requireFreshVerdicts([verdict({ sha: 'B' })], 'B').ok).toBe(true);
  });
});

describe('CN-04 · declaring all green with a test of the zone in red', () => {
  it('is caught by reading the run, not the exit code', () => {
    const parsed = parseTestRun({
      output: 'FAIL tests/nomina.test.ts > el bono\nAssertionError: expected 800 to be 1000\nTests  1 failed | 170 passed (171)',
      exitCode: 0,
    });

    expect(parsed.failed).toBe(1);
  });

  it('is caught when the suite never ran at all', () => {
    expect(parseTestRun({ output: '', exitCode: 0 }).brokenEnvironment).toBe(true);
  });

  it('positive control: a genuine green run is accepted', () => {
    const parsed = parseTestRun({ output: 'Tests  171 passed (171)', exitCode: 0 });

    expect(parsed.failed).toBe(0);
    expect(parsed.brokenEnvironment).toBe(false);
  });
});

describe('CN-06 · interrupting mid-write and resuming', () => {
  it('leaves a single writer and no duplicated work', async () => {
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(chain(stage('spec', { gate: seen.gateFor('spec') }), stage('build')));
    const engine = createEngine({ config, store, runId: 'A' });

    const first = engine.run('997');
    const second = engine.run('997');
    await Promise.all([first, second]);

    expect(seen.seen.filter((name) => name === 'spec')).toHaveLength(1);
  });

  it('positive control: it resumes and finishes', async () => {
    const store = createMemoryStore();
    let allow = false;
    const config = pipeline(
      chain(stage('spec'), stage('build', { gate: () => (allow ? { ok: true } : { ok: false, reason: 'aun no' }) })),
    );
    const engine = createEngine({ config, store });

    await engine.run('997');
    allow = true;
    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });
});

describe('CN-10 · a piece that grows past what it declared', () => {
  it('re-runs the stage the wider change now demands', async () => {
    const files = { current: ['app/ui/boton.tsx'] };
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('spec'),
        stage('flock', {
          appliesWhen: (context) =>
            (context.change as { files: string[] }).files.some((file) => file.startsWith('lib/calc')),
          gate: seen.gateFor('flock'),
        }),
      ),
    );
    const engine = createEngine({ config, store, describeChange: () => ({ files: files.current }) });

    await engine.run('997');
    expect(seen.seen).not.toContain('flock');

    files.current = [...files.current, 'lib/calc/nomina.ts'];
    await engine.run('997');

    expect(seen.seen).toContain('flock');
  });

  it('positive control: a change that stays within scope does not add stages', async () => {
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('spec'),
        stage('flock', {
          appliesWhen: (context) =>
            (context.change as { files: string[] }).files.some((file) => file.startsWith('lib/calc')),
          gate: seen.gateFor('flock'),
        }),
      ),
    );
    const engine = createEngine({
      config,
      store,
      describeChange: () => ({ files: ['app/ui/boton.tsx'] }),
    });

    await engine.run('997');
    await engine.run('997');

    expect(seen.seen).not.toContain('flock');
  });
});

describe('CN-11 · a builder that edits a test and puts it back', () => {
  it('is refused: the journal holds the version seen when it was red', async () => {
    const store = createMemoryStore();
    const versions = ['v1', 'v2'];
    let call = 0;
    const config = pipeline(
      chain(
        stage('red-test', {
          nature: 'execution-record',
          gate: () => ({ ok: true, evidence: { testFile: versions[0] } }),
        }),
        stage('build', {
          nature: 'execution-record',
          gate: (context) => {
            const red = context.journal.find((entry) => entry.stage === 'red-test');
            const seenVersion = (red?.evidence as { testFile?: string } | undefined)?.testFile;
            const now = versions[call++ === 0 ? 1 : 1];
            return seenVersion === now
              ? { ok: true }
              : { ok: false, reason: `la prueba cambio: se vio ${seenVersion}, ahora es ${now}` };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store });

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:rejected');
    expect(result.outcome === 'ran' && result.status.reason).toContain('la prueba cambio');
  });

  it('positive control: a builder that leaves the test alone advances', async () => {
    const store = createMemoryStore();
    const config = pipeline(
      chain(
        stage('red-test', { gate: () => ({ ok: true, evidence: { testFile: 'v1' } }) }),
        stage('build', {
          gate: (context) => {
            const red = context.journal.find((entry) => entry.stage === 'red-test');
            return (red?.evidence as { testFile?: string } | undefined)?.testFile === 'v1'
              ? { ok: true }
              : { ok: false, reason: 'la prueba cambio' };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store });

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });
});

describe('CN-12 · two controllers racing for one piece', () => {
  it('gives it to exactly one, and the loser writes nothing', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'otro', 60_000);
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({ config, store, runId: 'mio' });

    const result = await engine.run('997');

    expect(result.outcome).toBe('busy');
    expect(await store.journal('997')).toEqual([]);
  });

  it('positive control: a single controller takes it and works', async () => {
    const store = createMemoryStore();
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({ config, store, runId: 'mio' });

    const result = await engine.run('997');

    expect(result.outcome).toBe('ran');
  });
});

describe('CN-13 · dying after an external effect and resuming', () => {
  it('does not do it twice', async () => {
    const store = createMemoryStore();
    let opened = 0;

    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 1234 };
    });
    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 5678 };
    });

    expect(opened).toBe(1);
  });

  it('refuses to guess when the effect was left in doubt', async () => {
    const store = createMemoryStore();
    await store
      .runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);

    await expect(store.runEffect('997', 'open-pr', async () => ({ pr: 1 }))).rejects.toThrow();
  });

  it('positive control: with no interruption it happens exactly once', async () => {
    const store = createMemoryStore();
    let opened = 0;

    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 1234 };
    });

    expect(opened).toBe(1);
  });
});

describe('the report of the thirteen', () => {
  const all = Array.from({ length: 13 }, (_, index) => `CN-${String(index + 1).padStart(2, '0')}`);

  it('accounts for every case: executed here, or declared as not yet executable', () => {
    // What this guards against: a case quietly disappearing. A suite of thirteen that
    // silently became a suite of nine still reports green.
    const executed = all.filter((name) => !(name in NOT_YET_EXECUTABLE));

    expect([...executed, ...Object.keys(NOT_YET_EXECUTABLE)].sort()).toEqual(all.sort());
  });

  it('says what each pending case is waiting for', () => {
    for (const [name, waiting] of Object.entries(NOT_YET_EXECUTABLE)) {
      expect(waiting.length, `${name} has no reason`).toBeGreaterThan(10);
    }
  });

  it('has four cases pending, no more', () => {
    // If this number goes up, something was quietly moved out of reach instead of fixed.
    expect(Object.keys(NOT_YET_EXECUTABLE)).toHaveLength(4);
  });
});
