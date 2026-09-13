import { describe, expect, it } from 'vitest';

import { verifyProtections } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026). GitHub reads `ref_name` patterns with Ruby's
// `File.fnmatch` and `FNM_PATHNAME` (documentation read that day):
//   - `*` and `?` stop at a slash; `[...]` is a set, `[!...]` or `[^...]` its complement.
//   - `**/` crosses zero or more folders; a `**` not followed by `/` is just `*`.
// A pattern read another way turned an exclusion into nothing and reported "protected".

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
const ok = (over: Record<string, unknown>, defaultBranch = 'main') => verifyProtections([detail(over)], { ...requirement, defaultBranch }).ok;

describe('patterns are read the way GitHub reads them', () => {
  it('**/ crosses zero folders, so refs/heads/**/main excludes main', () => {
    expect(ok(refs(['~DEFAULT_BRANCH'], ['refs/heads/**/main']))).toBe(false);
  });

  it('**/ crosses several folders', () => {
    expect(ok(refs(['refs/heads/**/main']), 'release/2026/main')).toBe(true);
  });

  it('a set [m]ain matches main, so it excludes it', () => {
    expect(ok(refs(['~DEFAULT_BRANCH'], ['refs/heads/[m]ain']))).toBe(false);
  });

  it('a complement [!x]ain matches main, and [!m]ain does not', () => {
    expect(ok(refs(['refs/heads/[!x]ain']))).toBe(true);
    expect(ok(refs(['refs/heads/[!m]ain']))).toBe(false);
  });

  it('a ** not followed by a slash is a single *', () => {
    expect(ok(refs(['refs/heads/**']), 'release/main')).toBe(false);
    expect(ok(refs(['refs/heads/**/*']), 'release/main')).toBe(true);
  });

  it('? is one character that is not a slash', () => {
    expect(ok(refs(['refs/heads/ma?n']))).toBe(true);
    expect(ok(refs(['refs/heads/m?']))).toBe(false);
    expect(ok(refs(['refs/heads/release?main']), 'release/main')).toBe(false);
  });
});

describe('what cannot be verified is not reported as fine', () => {
  it('bypass_actors set to null', () => {
    expect(ok({ bypass_actors: null })).toBe(false);
  });

  it('a bypass actor without a type', () => {
    expect(ok({ bypass_actors: [{ actor_id: 5 }] })).toBe(false);
  });

  it('no current_user_can_bypass at all', () => {
    const withoutField: Record<string, unknown> = detail();
    delete withoutField['current_user_can_bypass'];

    expect(verifyProtections([withoutField], requirement).ok).toBe(false);
  });

  it('an empty default branch name, naming the setting', () => {
    const report = verifyProtections([detail(refs(['~ALL'], ['refs/heads/main']))], { ...requirement, defaultBranch: '' });

    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/defaultBranch/);
  });
});
