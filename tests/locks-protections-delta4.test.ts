import { describe, expect, it } from 'vitest';

import { decidePrePush, verifyProtections } from '../src/index.js';

// Fourth review of the part 4 fixes (13-sep-2026):
//   - In Ruby's `dir.c` a reversed range still matches its two ends before the order is compared,
//     so `[m-a]ain` matches `main`. Dropping the range reported "protected" where GitHub is not.
//   - A pattern it cannot read turned the report red even when another entry already decided.
//   - "One rule" for the branch name still differed: `origin/main`, `HEAD` and a leading dash.

const detail = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'r',
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
        required_status_checks: [{ context: 'todo-verde', integration_id: 15368 }],
      },
    },
  ],
  ...over,
});

const refs = (include: string[], exclude: string[] = []) => ({ conditions: { ref_name: { include, exclude } } });
const report = (over: Record<string, unknown>, defaultBranch = 'main') =>
  verifyProtections([detail(over)], { requiredChecks: ['todo-verde'], requireUpToDate: true, defaultBranch });

describe('a reversed range still matches its two ends', () => {
  it('exclude refs/heads/[m-a]ain excludes main', () => {
    expect(report(refs(['~DEFAULT_BRANCH'], ['refs/heads/[m-a]ain'])).ok).toBe(false);
  });

  it('include refs/heads/[!m-a]ain does not cover main', () => {
    expect(report(refs(['refs/heads/[!m-a]ain'])).ok).toBe(false);
  });

  it('include refs/heads/[z-a]ain does not cover main, and [!]ain does', () => {
    expect(report(refs(['refs/heads/[z-a]ain'])).ok).toBe(false);
    expect(report(refs(['refs/heads/[!]ain'])).ok).toBe(true);
  });
});

describe('a pattern it cannot read only matters when it could change the answer', () => {
  it('an unreadable include next to ~DEFAULT_BRANCH changes nothing', () => {
    const result = report(refs(['~DEFAULT_BRANCH', 'refs/heads/release/[x']));

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('an unreadable include alone still leaves the branch uncovered, naming it', () => {
    const result = report(refs(['refs/heads/[main']));

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('refs/heads/[main');
  });
});

describe('the default branch setting follows one rule everywhere', () => {
  for (const name of ['origin/main', 'refs/heads/main', 'HEAD', '-main', '-', '--']) {
    it(`refuses ${JSON.stringify(name)} in the rulesets check and in pre-push`, () => {
      expect(report(refs(['~DEFAULT_BRANCH']), name).problems.join(' ')).toMatch(/defaultBranch/);
      expect(decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch: name }).allow).toBe(false);
    });
  }
});
