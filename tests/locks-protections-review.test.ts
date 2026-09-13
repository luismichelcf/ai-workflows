import { describe, expect, it } from 'vitest';

import { verifyProtections } from '../src/index.js';

// Review of part 4 (13-sep-2026). A report of "protected" for a branch the rulesets do not
// really cover is worse than no report. GitHub's documentation, read that day:
//   - `ref_name` takes `~DEFAULT_BRANCH`, `~ALL` and fnmatch patterns (File::FNM_PATHNAME,
//     so `*` stops at a slash and `**` does not); an exclusion wins over an inclusion.
//   - `bypass_actors` "is only returned if the user making the API request has write access
//     to the ruleset"; a missing key means "not shown", not "nobody".
//   - The list endpoint returns a summary without `rules`, `conditions` or `bypass_actors`.

const detail = (over: Record<string, unknown> = {}) => ({
  id: 20211188,
  name: 'Require status checks to pass',
  target: 'branch',
  source_type: 'Repository',
  source: 'luismichelcf/Socialabs',
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
  ...over,
});

const requirement = { requiredChecks: ['todo-verde', 'turno-fila'], requireUpToDate: true, defaultBranch: 'main' };

const refs = (include: string[], exclude: string[] = []) => ({ conditions: { ref_name: { include, exclude } } });

describe('which branch a ruleset really covers', () => {
  it('the real ruleset of Socialabs still covers its default branch', () => {
    expect(verifyProtections([detail()], requirement).ok).toBe(true);
  });

  it('a ruleset for main does not protect a repository whose default branch is master', () => {
    expect(verifyProtections([detail(refs(['refs/heads/main']))], { ...requirement, defaultBranch: 'master' }).ok).toBe(false);
  });

  it('a ruleset for the literal default branch name covers it', () => {
    expect(verifyProtections([detail(refs(['refs/heads/master']))], { ...requirement, defaultBranch: 'master' }).ok).toBe(true);
  });

  it('an exclusion of the default branch wins over its inclusion', () => {
    expect(verifyProtections([detail(refs(['~DEFAULT_BRANCH'], ['~DEFAULT_BRANCH']))], requirement).ok).toBe(false);
  });

  it('excluding refs/heads/main takes it out of ~ALL', () => {
    expect(verifyProtections([detail(refs(['~ALL'], ['refs/heads/main']))], requirement).ok).toBe(false);
  });

  it('~ALL covers the default branch', () => {
    expect(verifyProtections([detail(refs(['~ALL']))], requirement).ok).toBe(true);
  });

  it('refs/heads/* and refs/heads/ma* cover main', () => {
    expect(verifyProtections([detail(refs(['refs/heads/*']))], requirement).ok).toBe(true);
    expect(verifyProtections([detail(refs(['refs/heads/ma*']))], requirement).ok).toBe(true);
  });

  it('a single * stops at a slash; ** does not', () => {
    const nested = { ...requirement, defaultBranch: 'release/main' };

    expect(verifyProtections([detail(refs(['refs/heads/*']))], nested).ok).toBe(false);
    expect(verifyProtections([detail(refs(['refs/heads/**']))], nested).ok).toBe(true);
  });

  it('refs/heads/*/main does not cover main', () => {
    expect(verifyProtections([detail(refs(['refs/heads/*/main']))], requirement).ok).toBe(false);
  });
});

describe('who can get around the rules', () => {
  it('when GitHub does not show who can bypass, it is not assumed to be nobody', () => {
    const withoutActors: Record<string, unknown> = detail();
    delete withoutActors['bypass_actors'];
    const report = verifyProtections([withoutActors], requirement);

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/saltarse/);
  });

  it('when the reader itself can bypass the rules, it says so', () => {
    for (const current_user_can_bypass of ['always', 'pull_requests_only', 'exempt']) {
      const report = verifyProtections([detail({ current_user_can_bypass })], requirement);

      expect(report.ok, current_user_can_bypass).toBe(false);
    }
  });
});

describe('what it cannot evaluate does not count', () => {
  it('an organisation ruleset aimed at other repositories does not protect this one', () => {
    const orgRuleset = detail({
      source_type: 'Organization',
      source: 'socialabs',
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
        repository_name: { include: ['otro-repo'], exclude: [], protected: true },
      },
    });

    expect(verifyProtections([orgRuleset], requirement).ok).toBe(false);
  });

  it('recognises the summary list and asks for the detail of each ruleset', () => {
    const summary = {
      id: 20211188,
      name: 'Require status checks to pass',
      target: 'branch',
      source_type: 'Repository',
      source: 'luismichelcf/Socialabs',
      enforcement: 'active',
      node_id: 'RRS_lACqUmVwb3NpdG9yec5',
      _links: { self: { href: 'https://api.github.com/repos/luismichelcf/Socialabs/rulesets/20211188' } },
      created_at: '2026-08-27T10:00:00.000-05:00',
      updated_at: '2026-09-01T10:00:00.000-05:00',
    };
    const report = verifyProtections([summary], requirement);

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/detalle/);
  });
});
