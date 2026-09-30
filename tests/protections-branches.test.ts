import { describe, expect, it } from 'vitest';

import { verifyProtections } from '../src/index.js';

// PLAN-13-R6 §1.4 (§1.5 test 10): with working branches, the protections are checked on EACH
// branch of `into`, not only on the principal. A branch without the expected protection is named.
//
// Interface fixed here: `ProtectionRequirement.branches?: readonly string[]` — the branches of
// `into`. Absent, only `defaultBranch` is checked, as today. Every problem about a branch that is
// not the default one names that branch.

const ruleset = (include: string[], checks: string[] = ['todo-verde', 'ai-workflows']) => ({
  id: 1,
  name: 'Protección',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include } },
  bypass_actors: [],
  current_user_can_bypass: 'never',
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: checks.map((context) => ({ context, integration_id: 15368 })),
      },
    },
  ],
});

const requirement = {
  requiredChecks: ['todo-verde', 'ai-workflows'],
  requireUpToDate: true,
  defaultBranch: 'main',
  branches: ['staging', 'main'],
};

describe('§1.5 (10): verifyProtections with two branches', () => {
  it('a ruleset that covers only the default branch: staging is named as unprotected, and only staging', () => {
    const report = verifyProtections([ruleset(['~DEFAULT_BRANCH'])], requirement);

    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    for (const problem of report.problems) expect(problem).toContain('staging');
  });

  it('a check required on main but not on staging: named with the branch', () => {
    const report = verifyProtections(
      [ruleset(['~DEFAULT_BRANCH']), ruleset(['refs/heads/staging'], ['todo-verde'])],
      requirement,
    );

    expect(report.ok).toBe(false);
    expect(report.problems.some((problem) => problem.includes('ai-workflows') && problem.includes('staging'))).toBe(true);
  });

  // Guards (green today, they must stay green).
  it('control: rulesets that cover both branches pass', () => {
    const report = verifyProtections([ruleset(['~DEFAULT_BRANCH', 'refs/heads/staging'])], requirement);

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a ruleset that covers only staging: main is not protected', () => {
    const report = verifyProtections([ruleset(['refs/heads/staging'])], requirement);

    expect(report.ok).toBe(false);
    for (const problem of report.problems) expect(problem).not.toContain('staging');
  });
});
