import { describe, expect, it } from 'vitest';

import { decidePrePush, verifyProtections } from '../src/index.js';

// Third review of the part 4 fixes (13-sep-2026), checked against Ruby's own `dir.c`: seven
// patterns read as "protected" where GitHub does not protect, and one threw "Range out of
// order" instead of answering. Under FNM_PATHNAME a set never matches `/`, `\-` is a literal
// dash, `**/` only counts at the start of a segment, `[]` is an empty set, and `\` outside a set
// escapes the next character.

const detail = (over: Record<string, unknown> = {}) => ({
  id: 20211188,
  name: 'Require status checks to pass',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
  bypass_actors: [],
  current_user_can_bypass: 'never',
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: 'todo-verde', integration_id: 15368 },
          { context: 'turno-fila', integration_id: 15368 },
        ],
      },
    },
  ],
  ...over,
});

const refs = (include: string[], exclude: string[] = []) => ({ conditions: { ref_name: { include, exclude } } });
const report = (over: Record<string, unknown>, defaultBranch = 'main') =>
  verifyProtections([detail(over)], { requiredChecks: ['todo-verde', 'turno-fila'], requireUpToDate: true, defaultBranch });

describe('patterns that Ruby does not match do not protect', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['refs/heads/release[/]main', 'release/main'],
    ['refs/heads/release[+-0]main', 'release/main'],
    ['refs/heads/[a\\-z]ain', 'main'],
    ['refs/heads/rel**/main', 'rel/2026/main'],
    ['refs/heads/****/main', 'a/b/main'],
    ['refs/heads/[]m]ain', 'main'],
    ['refs/heads/release[!x]main', 'release/main'],
  ];

  for (const [pattern, branch] of cases) {
    it(`include ${pattern} does not cover ${branch}`, () => {
      expect(report(refs([pattern]), branch).ok).toBe(false);
    });
  }

  it('a backslash escapes the next character, so exclude refs/heads/\\main excludes main', () => {
    expect(report(refs(['~DEFAULT_BRANCH'], ['refs/heads/\\main'])).ok).toBe(false);
  });
});

describe('patterns that Ruby matches do protect', () => {
  for (const pattern of ['refs/heads/[l-n]ain', 'refs/heads/[^x]ain', 'refs/heads/[!x]ain', 'refs/heads/**/main']) {
    it(`include ${pattern} covers main`, () => {
      expect(report(refs([pattern])).ok).toBe(true);
    });
  }
});

describe('a pattern it cannot read is an answer, never an exception', () => {
  it('a reversed range returns a report instead of throwing', () => {
    expect(() => report(refs(['refs/heads/[z-a]ain']))).not.toThrow();
    expect(report(refs(['refs/heads/[z-a]ain'])).ok).toBe(false);
  });

  it('an unclosed set in include does not cover', () => {
    expect(report(refs(['refs/heads/[main'])).ok).toBe(false);
  });

  it('an unclosed set in exclude excludes, and the report names the pattern', () => {
    const result = report(refs(['~DEFAULT_BRANCH'], ['refs/heads/[main']));

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('refs/heads/[main');
  });
});

describe('the default branch name follows one rule in both places', () => {
  for (const name of ['ma]in', 'release+1']) {
    it(`accepts ${JSON.stringify(name)} in the rulesets check and in pre-push`, () => {
      expect(report(refs(['~DEFAULT_BRANCH']), name).ok).toBe(true);
      expect(decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch: name }).allow).toBe(true);
    });
  }

  for (const name of ['main.lock', 'main']) {
    it(`refuses ${JSON.stringify(name)} in the rulesets check and in pre-push`, () => {
      expect(report(refs(['~DEFAULT_BRANCH']), name).problems.join(' ')).toMatch(/defaultBranch/);
      expect(decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch: name }).allow).toBe(false);
    });
  }
});
