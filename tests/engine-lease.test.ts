import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, runCommand, type Store } from '../src/index.js';

import { chain, pipeline, stage } from './helpers.js';

// ai-workflows#6, delta review. A lease that is not a finite positive number was written as
// `expiresAt: null`, which the git store then refuses to read, so the piece stayed locked for good.
// The realistic way in is a project script passing `Number(process.env.X)` with X unset. And a lease
// below the minimum was clamped only when reserving: renewals used the raw value, so a units
// mistake renewed on every tick (each one a commit over GitHub) and let the lease lapse at once.

const MIN_LEASE_MS = 30_000;

describe('the lease the engine asks the store for', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])('is refused when the engine is created: %s', (leaseMs) => {
    expect(() =>
      createEngine({ config: pipeline([stage('spec')]), store: createMemoryStore(), leaseMs }),
    ).toThrow(/lease/i);
  });

  it.each([Number.NaN, 0])('comes back from the CLI as an answer, not as a crash: %s', async (leaseMs) => {
    const output = await runCommand(['run', '997'], {
      config: pipeline([stage('spec')]),
      store: createMemoryStore(),
      leaseMs,
    });

    expect(output.ok).toBe(false);
    expect(output.text.length).toBeGreaterThan(0);
  });

  it('is never renewed below the minimum it is reserved with', async () => {
    const inner = createMemoryStore();
    const leases: number[] = [];
    const store: Store = {
      ...inner,
      reserve: async (piece, runId, leaseMs) => {
        leases.push(leaseMs);
        return inner.reserve(piece, runId, leaseMs);
      },
      renew: async (piece, runId, leaseMs) => {
        leases.push(leaseMs);
        return inner.renew(piece, runId, leaseMs);
      },
    };
    const engine = createEngine({
      config: pipeline(chain(stage('spec'), stage('build'))),
      store,
      leaseMs: 1_000,
    });

    await engine.run('997');

    expect(leases.length).toBeGreaterThan(1);
    expect(Math.min(...leases)).toBeGreaterThanOrEqual(MIN_LEASE_MS);
  });
});
