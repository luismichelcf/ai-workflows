import { describe, expect, it } from 'vitest';

import { createMemoryStore, type RunOutcome, type Store } from '../src/index.js';

import { chain, harness, stage } from './helpers.js';

// ai-workflows#6, flock finding: a store over GitHub fails routinely (a busy ref, the network), while
// the memory store never did. Wherever the store fails during a run, `run()` must come back with
// a status a person can read. An exception that escapes it crashes the CLI with a stack trace and
// saves nothing.

type Failing = 'renew' | 'append' | 'saveStatus' | 'loadStatus' | 'journal';

/** The memory store, except that the `failOn`-th call to `method` throws. */
const failingOn = (method: Failing, failOn: number): Store => {
  const inner = createMemoryStore();
  let calls = 0;
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls += 1;
      if (calls === failOn) throw new Error(`la red se cayó en ${method}`);
      return call(...args);
    };
  switch (method) {
    case 'renew':
      return { ...inner, renew: guard(inner.renew) };
    case 'append':
      return { ...inner, append: guard(inner.append) };
    case 'saveStatus':
      return { ...inner, saveStatus: guard(inner.saveStatus) };
    case 'loadStatus':
      return { ...inner, loadStatus: guard(inner.loadStatus) };
    case 'journal':
      return { ...inner, journal: guard(inner.journal) };
  }
};

const CASES: Array<[Failing, number]> = [];
for (const method of ['renew', 'append', 'saveStatus', 'loadStatus', 'journal'] as const) {
  for (let failOn = 1; failOn <= 6; failOn += 1) CASES.push([method, failOn]);
}

describe('a store that fails during a run', () => {
  it.each(CASES)('%s failing on call %i ends as a status, not as an exception', async (method, failOn) => {
    const { engine } = harness(chain(stage('spec'), stage('build')), { store: failingOn(method, failOn) });

    const outcome: RunOutcome = await engine.run('997');

    expect(outcome.outcome).toBe('ran');
    if (outcome.outcome === 'ran') {
      expect(['done', 'blocked:technical']).toContain(outcome.status.state);
    }
  });
});
