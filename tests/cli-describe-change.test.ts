import { describe, expect, it } from 'vitest';

import { createMemoryStore, runCommand, type GateContext, type GateResult } from '../src/index.js';

import { chain, pipeline, stage } from './helpers.js';

// ai-workflows#6: a project's own script runs pieces through `runCommand`. Without a way to pass
// `describeChange`, every gate gets an empty `change`, and a gate like «the same tests as the red
// run» has nothing to compare.

describe('run from the CLI with describeChange', () => {
  it('hands every gate what the project says the piece changes', async () => {
    const seen: unknown[] = [];
    const record = (context: GateContext): GateResult => {
      seen.push(context.change);
      return { ok: true };
    };
    const config = pipeline(chain(stage('spec', { gate: record }), stage('build', { gate: record })));

    const output = await runCommand(['run', '997'], {
      config,
      store: createMemoryStore(),
      describeChange: (piece) => ({ piece, files: ['src/a.ts'] }),
    });

    expect(output.ok).toBe(true);
    expect(seen).toEqual([
      { piece: '997', files: ['src/a.ts'] },
      { piece: '997', files: ['src/a.ts'] },
    ]);
  });

  it('asks for the change of the piece being run, and no other', async () => {
    const asked: string[] = [];
    const config = pipeline([stage('spec')]);

    await runCommand(['run', '1004'], {
      config,
      store: createMemoryStore(),
      describeChange: (piece) => {
        asked.push(piece);
        return {};
      },
    });

    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((piece) => piece === '1004')).toBe(true);
  });
});
