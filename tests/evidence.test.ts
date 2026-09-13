import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, validateConfig } from '../src/index.js';

import { chain, harness, pipeline, recorder, reject, stage } from './helpers.js';

// The second review, written by building real pipelines against the engine. Everything here
// is a case it reproduced: the engine passed its 84 tests and still could not do these.
//
// The common root: evidence went stale by pipeline SHAPE (add a stage and everything is
// redone; the piece is `done` and nothing is redone) instead of by each stage's own rule.

describe('evidence a stage left behind', () => {
  it('keeps what a passing stage observed, so a later gate can read it', async () => {
    // Without this, a stage that PASSES leaves no trace: the only channel was `reason`,
    // which exists only when a gate fails. The two `execution-record` gates of the spec —
    // "was red seen before the build was authorised", "is the reviewer someone else" — are
    // checked against the journal, so they had nothing to check.
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('build', {
          nature: 'execution-record',
          gate: () => ({ ok: true, evidence: { builder: 'deepseek-4.1', testSha: 'abc123' } }),
        }),
      ),
      { store },
    );

    await engine.run('997');
    const entry = (await store.journal('997')).find((item) => item.stage === 'build');

    expect(entry?.evidence).toEqual({ builder: 'deepseek-4.1', testSha: 'abc123' });
  });

  it('lets a later gate reach that evidence through its journal', async () => {
    let builderSeen: unknown;
    const { engine } = harness(
      chain(
        stage('build', {
          gate: () => ({ ok: true, evidence: { builder: 'deepseek-4.1' } }),
        }),
        stage('flock', {
          nature: 'execution-record',
          gate: (context) => {
            const build = context.journal.find((entry) => entry.stage === 'build');
            builderSeen = (build?.evidence as { builder?: string } | undefined)?.builder;
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(builderSeen).toBe('deepseek-4.1');
  });
});

describe('when evidence goes stale', () => {
  // The queue updates a branch with `main` after the flock approved, so the SHA moves. The
  // spec's table says the flock survives that while QA and the sign-off expire. Each stage
  // decides for itself.
  const sha = { current: 'sha-1' };
  const qaStage = () =>
    stage('qa', {
      gate: () => ({ ok: true, evidence: { sha: sha.current } }),
      stillValid: (entry, context) =>
        (entry.evidence as { sha?: string } | undefined)?.sha ===
        (context.change as { sha: string }).sha,
    });

  it('re-runs a stage whose own rule says its evidence expired', async () => {
    sha.current = 'sha-1';
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('flock', { gate: seen.gateFor('flock') }),
        { ...qaStage(), gate: seen.gateFor('qa', () => ({ ok: true, evidence: { sha: sha.current } })) },
      ),
    );
    expect(validateConfig(config)).toEqual({ ok: true });
    const engine = createEngine({
      config,
      store,
      describeChange: () => ({ sha: sha.current }),
    });

    await engine.run('997');
    sha.current = 'sha-2';
    await engine.run('997');

    expect(seen.seen.filter((name) => name === 'qa')).toHaveLength(2);
  });

  it('keeps a stage whose rule says its evidence still holds', async () => {
    sha.current = 'sha-1';
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('flock', {
          gate: seen.gateFor('flock'),
          stillValid: () => true,
        }),
        { ...qaStage(), gate: seen.gateFor('qa', () => ({ ok: true, evidence: { sha: sha.current } })) },
      ),
    );
    const engine = createEngine({
      config,
      store,
      describeChange: () => ({ sha: sha.current }),
    });

    await engine.run('997');
    sha.current = 'sha-2';
    await engine.run('997');

    expect(seen.seen.filter((name) => name === 'flock')).toHaveLength(1);
  });

  it('does not redo settled stages just because a stage was added', async () => {
    // What the owner asked for: adding a stage must not re-ask him for a sign-off he gave.
    const store = createMemoryStore();
    const first = recorder();
    const before = harness(
      chain(
        stage('spec', { gate: first.gateFor('spec') }),
        stage('gate', { gate: first.gateFor('gate', reject('la puerta esta roja')) }),
      ),
      { store },
    );
    await before.engine.run('997');

    const second = recorder();
    const grown = pipeline(
      chain(
        stage('spec', { gate: second.gateFor('spec') }),
        stage('mutants', { gate: second.gateFor('mutants') }),
        stage('gate', { gate: second.gateFor('gate') }),
      ),
    );
    const engine = createEngine({ config: grown, store });

    await engine.run('997');

    expect(second.seen).toContain('mutants');
    expect(second.seen).not.toContain('spec');
  });
});

describe('a piece that already finished', () => {
  it('runs a stage added after it finished', async () => {
    // The `done` shortcut returned early without reading the journal, so hardening the
    // pipeline had no effect on pieces already through — the usual case.
    const store = createMemoryStore();
    const before = harness(chain(stage('spec'), stage('gate')), { store });
    await before.engine.run('997');

    const seen = recorder();
    const grown = pipeline(
      chain(stage('spec'), stage('mutants', { gate: seen.gateFor('mutants') }), stage('gate')),
    );
    const engine = createEngine({ config: grown, store });

    await engine.run('997');

    expect(seen.seen).toContain('mutants');
  });

  it('reports a renamed stage instead of quietly staying done', async () => {
    const store = createMemoryStore();
    const before = harness(chain(stage('spec'), stage('qa')), { store });
    await before.engine.run('997');

    const renamed = pipeline(chain(stage('spec'), stage('qa-axe')));
    const engine = createEngine({ config: renamed, store });

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(result.outcome === 'ran' && result.status.reason).toContain('qa');
  });

  it('does not re-run anything when the pipeline did not change', async () => {
    const seen = recorder();
    const { engine } = harness(chain(stage('spec', { gate: seen.gateFor('spec') })));

    await engine.run('997');
    await engine.run('997');

    expect(seen.seen).toEqual(['spec']);
  });
});

describe('a stage retired from the pipeline', () => {
  it('can be forgotten, so the piece is not stuck forever', async () => {
    const store = createMemoryStore();
    const before = harness(chain(stage('spec'), stage('vieja')), { store });
    await before.engine.run('997');

    const shrunk = pipeline(chain(stage('spec')));
    const engine = createEngine({ config: shrunk, store });
    expect((await engine.run('997')).outcome).toBe('ran');

    await store.forget('997', 'vieja');
    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });
});

describe('an exemption that stops applying', () => {
  it('is re-evaluated when the change grows into what it exempted', async () => {
    // The spec is explicit: if the diff widens into money or permissions, the affected
    // gates are invalidated and demanded again. A skip recorded under the old diff cannot
    // exempt the stage forever.
    const files = { current: ['app/ui/boton.tsx'] };
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('spec'),
        stage('mutants', {
          appliesWhen: (context) =>
            (context.change as { files: string[] }).files.some((file) =>
              file.startsWith('lib/calc'),
            ),
          gate: seen.gateFor('mutants'),
        }),
      ),
    );
    const engine = createEngine({ config, store, describeChange: () => ({ files: files.current }) });

    await engine.run('997');
    expect(seen.seen).not.toContain('mutants');

    files.current = ['app/ui/boton.tsx', 'lib/calc/nomina.ts'];
    await engine.run('997');

    expect(seen.seen).toContain('mutants');
  });

  it('can say exactly why it does not apply', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('red-test', {
          appliesWhen: () => ({ skip: 'cambio solo visual: sin prueba roja por ADR 0110' }),
          gate: () => ({ ok: true }),
        }),
      ),
      { store },
    );

    await engine.run('997');
    const entry = (await store.journal('997')).find((item) => item.stage === 'red-test');

    expect(entry?.outcome).toBe('skipped');
    expect(entry?.reason).toContain('ADR 0110');
  });
});

describe('appliesWhen that breaks its contract', () => {
  for (const [label, value] of [
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'no'],
    ['a number', 0],
    ['an empty object', {}],
  ] as const) {
    it(`blocks instead of exempting the stage when it returns ${label}`, async () => {
      // A missing `return` exempted the stage in silence and invented its motive: the exact
      // failure this engine exists to prevent, through the one door nobody was checking.
      const { engine } = harness(
        chain(stage('spec'), stage('mutants', { appliesWhen: () => value as never })),
      );

      const result = await engine.run('997');

      expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
      expect(result.outcome === 'ran' && result.status.stage).toBe('mutants');
    });
  }

  it('runs the stage when it plainly says true', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('mutants', { appliesWhen: () => true, gate: seen.gateFor('mutants') }),
      ),
    );

    await engine.run('997');

    expect(seen.seen).toContain('mutants');
  });
});
