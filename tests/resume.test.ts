import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, validateConfig } from '../src/index.js';

import { chain, fakeClock, harness, pipeline, recorder, reject, stage } from './helpers.js';

// The finding that forced the contract rewrite. The slice-1 engine resumed by POSITION:
// it stored the stage it stopped at and restarted from that index. Three reviewers found
// the same hole by different routes — inserting a stage before that point made the stage
// vanish and the piece finish as `done`.
//
// The owner's stated requirement is "adding a stage must be one line of config". An engine
// whose only job is that no stage gets skipped cannot skip a stage when one is added.

describe('resuming by evidence', () => {
  it('runs a stage inserted BEFORE the point where the piece stopped', async () => {
    const store = createMemoryStore();
    const first = recorder();

    const before = harness(
      chain(
        stage('spec', { gate: first.gateFor('spec') }),
        stage('build', { gate: first.gateFor('build') }),
        stage('gate', { gate: first.gateFor('gate', reject('la puerta esta roja')) }),
      ),
      { store },
    );
    await before.engine.run('997');
    expect(first.seen).toEqual(['spec', 'build', 'gate']);

    // The owner adds one line of config: mutation tests, between build and gate.
    const second = recorder();
    const grown = pipeline(
      chain(
        stage('spec', { gate: second.gateFor('spec') }),
        stage('build', { gate: second.gateFor('build') }),
        stage('mutants', { gate: second.gateFor('mutants') }),
        stage('gate', { gate: second.gateFor('gate') }),
      ),
    );
    expect(validateConfig(grown)).toEqual({ ok: true });
    const engine = createEngine({ config: grown, store });

    const result = await engine.run('997');

    expect(second.seen).toContain('mutants');
    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });

  it('does not re-run a stage that already passed under the same pipeline', async () => {
    const counted = recorder();
    const { engine } = harness(
      chain(
        stage('spec', { gate: counted.gateFor('spec') }),
        stage('build', { gate: counted.gateFor('build', reject('aun no')) }),
      ),
    );

    await engine.run('997');
    await engine.run('997');

    expect(counted.seen.filter((name) => name === 'spec')).toHaveLength(1);
  });

  it('refuses to resume when a stage it had passed no longer exists', async () => {
    const store = createMemoryStore();
    const before = harness(
      chain(stage('spec'), stage('qa', { gate: reject('el preview no carga') })),
      { store },
    );
    await before.engine.run('997');

    // The stage is renamed. The stored evidence now names something that is gone: the old
    // engine silently restarted the piece from zero, repeating every external effect.
    const renamed = pipeline(chain(stage('spec'), stage('quality')));
    const engine = createEngine({ config: renamed, store });

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(result.outcome === 'ran' && result.status.reason).toContain('qa');
  });

  it('writes one journal entry per stage it resolves, with its outcome', async () => {
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const { engine } = harness(
      chain(stage('spec'), stage('build', { gate: reject('falta el benchmark') })),
      { store },
    );

    await engine.run('997');
    const journal = await store.journal('997');

    expect(journal.map((entry) => [entry.stage, entry.outcome])).toEqual([
      ['spec', 'passed'],
      ['build', 'rejected'],
    ]);
  });

  it('keeps the journal append-only across runs', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(stage('spec'), stage('build', { gate: reject('aun no') })),
      { store },
    );

    await engine.run('997');
    await engine.run('997');
    const journal = await store.journal('997');

    // `spec` passed once and is not re-run; `build` was rejected twice.
    expect(journal.filter((entry) => entry.stage === 'spec')).toHaveLength(1);
    expect(journal.filter((entry) => entry.stage === 'build').length).toBeGreaterThan(1);
  });

  it('does not re-run a piece that already finished', async () => {
    const counted = recorder();
    const { engine } = harness(chain(stage('spec', { gate: counted.gateFor('spec') })));

    await engine.run('997');
    await engine.run('997');

    expect(counted.seen).toEqual(['spec']);
  });
});

describe('stages that do not apply', () => {
  it('records a skip as a skip, never as a pass', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('mutants', {
          appliesWhen: () => false,
          gate: () => {
            throw new Error('no debe correr: la etapa no aplica');
          },
        }),
      ),
      { store },
    );

    const result = await engine.run('997');
    const journal = await store.journal('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
    expect(journal.find((entry) => entry.stage === 'mutants')?.outcome).toBe('skipped');
  });

  it('keeps the motive of the skip, so nobody can read it as approved later', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('mutants', { gate: skipBecause('el diff no toca lib/calc') }),
      ),
      { store },
    );

    await engine.run('997');
    const entry = (await store.journal('997')).find((item) => item.stage === 'mutants');

    expect(entry?.outcome).toBe('skipped');
    expect(entry?.reason).toContain('lib/calc');
  });

  it('gives appliesWhen what the change is, so a stage can be conditional on the diff', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('mutants', {
          appliesWhen: (context) =>
            (context.change as { files: string[] }).files.some((file) =>
              file.startsWith('lib/calc'),
            ),
          gate: () => ({ ok: true }),
        }),
      ),
      { store, describeChange: () => ({ files: ['app/ui/boton.tsx'] }) },
    );

    await engine.run('997');
    const entry = (await store.journal('997')).find((item) => item.stage === 'mutants');

    expect(entry?.outcome).toBe('skipped');
  });
});

const skipBecause = (reason: string) => () => ({ ok: 'skipped', reason }) as const;
