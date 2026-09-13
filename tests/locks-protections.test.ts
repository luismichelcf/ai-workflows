import { describe, expect, it } from 'vitest';

import { verifyProtections } from '../src/index.js';

// Installing a check is worthless if GitHub does not require it. This reads the repository's
// rulesets and says whether they actually enforce what the pipeline relies on.
//
// The first fixture is the real ruleset of luismichelcf/Socialabs, read from the GitHub API
// on 13-sep-2026. Everything else is that same ruleset with one thing changed.

const socialabs = {
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
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: 'todo-verde', integration_id: 15368 },
          { context: 'turno-fila', integration_id: 15368 },
        ],
      },
    },
  ],
};

type Ruleset = typeof socialabs;
const variant = (change: (ruleset: Ruleset) => void) => {
  const copy = JSON.parse(JSON.stringify(socialabs)) as Ruleset;
  change(copy);
  return [copy];
};

const require = { requiredChecks: ['todo-verde', 'turno-fila'], requireUpToDate: true };

describe('the real ruleset of Socialabs', () => {
  it('enforces what the pipeline relies on today', () => {
    const report = verifyProtections([socialabs], require);

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('is missing the pipeline s own check until it is added', () => {
    const report = verifyProtections([socialabs], {
      requiredChecks: ['todo-verde', 'turno-fila', 'ai-workflows'],
    });

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('ai-workflows');
  });
});

describe('what counts as not protected', () => {
  it('a ruleset that only evaluates, which blocks nothing', () => {
    const report = verifyProtections(variant((r) => { r.enforcement = 'evaluate'; }), require);

    expect(report.ok).toBe(false);
  });

  it('a disabled ruleset', () => {
    expect(verifyProtections(variant((r) => { r.enforcement = 'disabled'; }), require).ok).toBe(false);
  });

  it('a ruleset that does not apply to the default branch', () => {
    const report = verifyProtections(
      variant((r) => { r.conditions.ref_name.include = ['refs/heads/release/*']; }),
      require,
    );

    expect(report.ok).toBe(false);
  });

  it('force pushes allowed', () => {
    const report = verifyProtections(
      variant((r) => { r.rules = r.rules.filter((rule) => rule.type !== 'non_fast_forward'); }),
      require,
    );

    expect(report.ok).toBe(false);
  });

  it('deleting the branch allowed', () => {
    const report = verifyProtections(
      variant((r) => { r.rules = r.rules.filter((rule) => rule.type !== 'deletion'); }),
      require,
    );

    expect(report.ok).toBe(false);
  });

  it('branches not required to be up to date, when that is required', () => {
    const report = verifyProtections(
      variant((r) => {
        const checks = r.rules.find((rule) => rule.type === 'required_status_checks') as { parameters: { strict_required_status_checks_policy: boolean } };
        checks.parameters.strict_required_status_checks_policy = false;
      }),
      require,
    );

    expect(report.ok).toBe(false);
  });

  it('someone allowed to bypass the rules, naming who', () => {
    const report = verifyProtections(
      variant((r) => { (r.bypass_actors as unknown[]).push({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }); }),
      require,
    );

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('RepositoryRole');
  });

  it('a required check that any source could report', () => {
    // Without an integration id, any app or workflow that reports a status with that name
    // satisfies it — including one written to always pass.
    const report = verifyProtections(
      variant((r) => {
        const checks = r.rules.find((rule) => rule.type === 'required_status_checks') as { parameters: { required_status_checks: Array<{ context: string; integration_id?: number }> } };
        delete checks.parameters.required_status_checks[0]?.integration_id;
      }),
      require,
    );

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('todo-verde');
  });

  it('lists every problem at once, not only the first', () => {
    const report = verifyProtections(
      variant((r) => { r.rules = [{ type: 'deletion' }]; }),
      require,
    );

    expect(report.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('reading what GitHub sends', () => {
  it('reports that it could not read the rules, instead of throwing', () => {
    expect(() => verifyProtections('<html>502</html>', require)).not.toThrow();
    expect(verifyProtections('<html>502</html>', require).ok).toBe(false);
  });

  it('treats no rulesets at all as not protected', () => {
    expect(verifyProtections([], require).ok).toBe(false);
  });

  it('combines several rulesets that together cover the requirement', () => {
    const [checksOnly] = variant((r) => { r.rules = r.rules.filter((rule) => rule.type === 'required_status_checks'); });
    const [pushOnly] = variant((r) => { r.rules = r.rules.filter((rule) => rule.type !== 'required_status_checks'); });

    expect(verifyProtections([checksOnly, pushOnly], require).ok).toBe(true);
  });
});

describe('what it cannot promise', () => {
  it('always declares that an administrator can change these rules', () => {
    // The spec accepts this as residual risk (level C). Saying it every time is what keeps a
    // green report from being read as more than it is.
    const report = verifyProtections([socialabs], require);

    expect(report.limits.length).toBeGreaterThan(0);
  });
});
