import { expect } from 'vitest';

import {
  createEngine,
  createMemoryStore,
  validateConfig,
  type Engine,
  type GateResult,
  type PipelineConfig,
  type StageConfig,
  type Store,
} from '../src/index.js';

export const pass = (): GateResult => ({ ok: true });
export const reject = (reason: string) => (): GateResult => ({ ok: false, reason });
export const skip = (reason: string) => (): GateResult => ({ ok: 'skipped', reason });
export const fail = (reason: string) => (): GateResult => {
  throw new Error(reason);
};

/** A stage with the boring defaults filled in, so tests say only what they are about. */
export const stage = (name: string, overrides: Partial<StageConfig> = {}): StageConfig => ({
  name,
  nature: 'recompute',
  gate: pass,
  ...overrides,
});

/** Chains stages in the order given, so a test's list reads as its pipeline. */
export const chain = (...stages: StageConfig[]): StageConfig[] =>
  stages.map((s, index) =>
    index === 0 || s.after !== undefined
      ? s
      : { ...s, after: stages[index - 1]?.name ?? '' },
  );

export const pipeline = (stages: StageConfig[], locale = 'es'): PipelineConfig => ({
  locale,
  stages,
});

/** A clock the test drives, so leases are tested without sleeping. */
export const fakeClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

export interface Harness {
  readonly engine: Engine;
  readonly store: Store;
  readonly clock: ReturnType<typeof fakeClock>;
}

/** Builds an engine over a fresh memory store, asserting the pipeline is valid first. */
export const harness = (
  stages: StageConfig[],
  options: { store?: Store; runId?: string; describeChange?: (piece: string) => unknown } = {},
): Harness => {
  const config = pipeline(stages);
  expect(validateConfig(config)).toEqual({ ok: true });
  const clock = fakeClock();
  const store = options.store ?? createMemoryStore({ now: clock.now });
  const engine = createEngine({
    config,
    store,
    now: clock.now,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.describeChange === undefined ? {} : { describeChange: options.describeChange }),
  });
  return { engine, store, clock };
};

/** Every stage that actually executed, in order, for asserting what ran and what did not. */
export const recorder = () => {
  const seen: string[] = [];
  return {
    seen,
    gateFor:
      (name: string, result: () => GateResult = pass) =>
      (): GateResult => {
        seen.push(name);
        return result();
      },
  };
};
