import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, runCommand, type Store } from '../src/index.js';

import { pipeline, stage } from './helpers.js';

// ai-workflows#6, delta review. A lease that is not a finite positive number was written as
// `expiresAt: null`, which the git store then refuses to read, so the piece stayed locked for good.
// The realistic way in is a project script passing `Number(process.env.X)` with X unset.
//
// A lease below the 30-second minimum is a different case. The engine renews with the lease as
// given, on purpose: its own liveness and honesty tests make a short lease lapse to observe a
// theft. Clamping renewals broke those. A project's script is where a units mistake (seconds
// written as milliseconds) would renew on every tick, each renewal a commit over GitHub, so the
// CLI refuses it before any store call.

const MIN_LEASE_MS = 30_000;

/** The memory store, counting how often a piece is reserved. */
const countingReserves = (): { store: Store; reserves: () => number } => {
  const inner = createMemoryStore();
  let calls = 0;
  return {
    reserves: () => calls,
    store: {
      ...inner,
      reserve: async (piece, runId, leaseMs) => {
        calls += 1;
        return inner.reserve(piece, runId, leaseMs);
      },
    },
  };
};

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

  it('below the minimum, is refused by the CLI before it touches the store', async () => {
    const { store, reserves } = countingReserves();

    const output = await runCommand(['run', '997'], {
      config: pipeline([stage('spec')]),
      store,
      leaseMs: 900,
    });

    expect(output.ok).toBe(false);
    expect(output.text.length).toBeGreaterThan(0);
    expect(reserves()).toBe(0);
  });

  it('at the minimum itself, is accepted by the CLI', async () => {
    const { store, reserves } = countingReserves();

    const output = await runCommand(['run', '997'], {
      config: pipeline([stage('spec')]),
      store,
      leaseMs: MIN_LEASE_MS,
    });

    expect(output.ok).toBe(true);
    expect(reserves()).toBeGreaterThan(0);
  });
});
