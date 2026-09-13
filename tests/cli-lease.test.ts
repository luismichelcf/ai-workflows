import { describe, expect, it } from 'vitest';

import { createMemoryStore, runCommand, type Store } from '../src/index.js';

import { pipeline, stage } from './helpers.js';

// ai-workflows#6, flock finding: over GitHub every lease renewal is a commit, and the engine renews
// every third of the lease. With the 30-second default one long gate exhausts GitHub's limit on
// content-creating requests in about half an hour, so a project's script must be able to ask for
// a lease of minutes.

const recordingLeases = (): { store: Store; leases: number[] } => {
  const inner = createMemoryStore();
  const leases: number[] = [];
  return {
    leases,
    store: {
      ...inner,
      reserve: async (piece, runId, leaseMs) => {
        leases.push(leaseMs);
        return inner.reserve(piece, runId, leaseMs);
      },
    },
  };
};

describe('the lease a project asks for from the CLI', () => {
  it('reaches the engine', async () => {
    const { store, leases } = recordingLeases();

    const output = await runCommand(['run', '997'], {
      config: pipeline([stage('spec')]),
      store,
      leaseMs: 600_000,
    });

    expect(output.ok).toBe(true);
    expect(leases).toContain(600_000);
  });

  it('stays at the engine default when the project does not ask', async () => {
    const { store, leases } = recordingLeases();

    await runCommand(['run', '997'], { config: pipeline([stage('spec')]), store });

    expect(leases.length).toBeGreaterThan(0);
    expect(leases.every((lease) => lease === 30_000)).toBe(true);
  });
});
