import { describe, expect, it } from 'vitest';

import { createMemoryStore } from '../src/index.js';

import { chain, harness, stage } from './helpers.js';

// Gates are written by each project, so their return value is untrusted input like any
// other. The slice-1 engine took `if (result.ok)` at face value: a gate that returned
// `{ok: 'no'}` or `{ok: response.status}` APPROVED the stage, and one that forgot its
// `return` threw out of `run()` leaving the piece stuck in `running` with no reason.
//
// A motor whose whole job is refusing to be lied to cannot accept a malformed answer.

const malformed = [
  { label: 'a truthy string instead of true', value: { ok: 'no' } },
  { label: 'an object instead of true', value: { ok: {} } },
  { label: 'a number instead of true', value: { ok: 1 } },
  { label: 'nothing at all', value: undefined },
  { label: 'null', value: null },
  { label: 'an empty object', value: {} },
];

describe('a gate that breaks its contract', () => {
  for (const { label, value } of malformed) {
    it(`does not advance the piece when the gate returns ${label}`, async () => {
      const { engine } = harness(
        chain(stage('g', { gate: () => value as never }), stage('later')),
      );

      const result = await engine.run('997');

      expect(result.outcome).toBe('ran');
      expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
      expect(result.outcome === 'ran' && result.status.stage).toBe('g');
    });
  }

  it('never lets a malformed result reach the next stage', async () => {
    let laterRan = false;
    const { engine } = harness(
      chain(
        stage('g', { gate: () => ({ ok: 'no' }) as never }),
        stage('later', {
          gate: () => {
            laterRan = true;
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(laterRan).toBe(false);
  });

  it('rejects a refusal that gives no reason, instead of blocking mutely', async () => {
    const { engine } = harness(chain(stage('g', { gate: () => ({ ok: false }) as never })));

    const result = await engine.run('997');

    // Either state is defensible; a rejection with no motive is not: §5.6 requires the
    // piece to be parked WITH its motive, and a mute block cannot be acted on.
    expect(result.outcome === 'ran' && result.status.reason).toBeTruthy();
  });

  it('rejects an empty reason the same way as a missing one', async () => {
    const { engine } = harness(
      chain(stage('g', { gate: () => ({ ok: false, reason: '   ' }) as never })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && (result.status.reason ?? '').trim()).not.toBe('');
  });

  it('treats a rejected promise as a gate that could not run', async () => {
    const { engine } = harness(
      chain(stage('g', { gate: () => Promise.reject(new Error('la red se cayo')) })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(result.outcome === 'ran' && result.status.reason).toContain('la red se cayo');
  });

  it('keeps a readable reason when a gate throws something that is not an Error', async () => {
    const { engine } = harness(
      chain(
        stage('g', {
          gate: () => {
            throw { code: 42 };
          },
        }),
      ),
    );

    const result = await engine.run('997');
    const reason = result.outcome === 'ran' ? (result.status.reason ?? '') : '';

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(reason).not.toContain('[object Object]');
  });

  it('records the failing stage in the journal rather than losing it', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('g', { gate: () => undefined as never })), {
      store,
    });

    await engine.run('997');

    expect((await store.journal('997')).map((entry) => entry.outcome)).toContain('failed');
  });

  it('never leaves the piece in running after a gate misbehaves', async () => {
    const { engine } = harness(chain(stage('g', { gate: () => undefined as never })));

    await engine.run('997');

    expect((await engine.status('997'))?.state).not.toBe('running');
  });
});

describe('a gate that behaves', () => {
  it('gets the piece, the stage and the locale it needs to speak to a person', async () => {
    let seen: { piece: string; stage: string; locale: string } | undefined;
    const { engine } = harness(
      chain(
        stage('g', {
          gate: (context) => {
            seen = { piece: context.piece, stage: context.stage, locale: context.locale };
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(seen).toEqual({ piece: '997', stage: 'g', locale: 'es' });
  });

  it('is told when the run is a dry run, so it can check without acting', async () => {
    const modes: string[] = [];
    const { engine } = harness(
      chain(
        stage('g', {
          gate: (context) => {
            modes.push(context.mode);
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997', { mode: 'dry-run' });

    expect(modes).toEqual(['dry-run']);
  });

  it('leaves no trace of a dry run: the piece did not advance', async () => {
    const { engine } = harness(chain(stage('g')));

    await engine.run('997', { mode: 'dry-run' });

    expect(await engine.status('997')).toBeUndefined();
  });

  it('can read what the engine has already observed for this piece', async () => {
    let sawEarlier = false;
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('build', {
          gate: (context) => {
            sawEarlier = context.journal.some((entry) => entry.stage === 'spec');
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(sawEarlier).toBe(true);
  });
});
