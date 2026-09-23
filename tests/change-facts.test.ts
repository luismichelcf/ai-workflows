import { afterEach, describe, expect, it } from 'vitest';

import { describeChangeFromGit, effectiveKind, parseRecipe, type Recipe } from '../src/index.js';

import { commit, emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §4: the facts of a change come from git, never from what a piece says about
// itself, and the kind that decides which stages apply is the effective one — declared, then
// forced by from-paths, then raised by elevate — with the lane following it (R15, CN-10).
// Git is local, so these run against real temporary repositories, never a simulation.

const RECIPE_TEXT = [
  'version: 1',
  'locale: es',
  'classify:',
  '  money: ["lib/calc/**"]',
  '  security: ["**/*auth*"]',
  '  production: [".github/workflows/**"]',
  'kinds:',
  '  names: [behavior, ui-behavior, visual-only, prod-config, config-no-prod, generated, docs, prototype]',
  '  default: behavior',
  '  from-paths:',
  '    docs: ["docs/**"]',
  '    prototype: ["proto/**"]',
  '  elevate:',
  '    - when: { touches-any: [money, security], kind-none: [behavior, ui-behavior] }',
  '      to: behavior',
  '    - when: { touches-any: [production], kind-any: [visual-only, config-no-prod, generated] }',
  '      to: prod-config',
  'lanes:',
  '  full: [behavior, ui-behavior, prod-config]',
  '  light: [visual-only, config-no-prod, generated, docs, prototype]',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node m.mjs',
  '',
].join('\n');

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const RECIPE = recipeOf(RECIPE_TEXT);

describe('§4.2: the effective kind, and the lane that follows it', () => {
  // Expected values written by hand from the rules of §4.2 and the recipe above.
  const table: [string, string | undefined, string[], string, string, string[]][] = [
    ['nothing declared', undefined, ['app/page.tsx'], 'behavior', 'full', []],
    ['declared and kept', 'visual-only', ['app/page.tsx'], 'visual-only', 'light', []],
    ['all files under docs/: docs, whatever was declared', 'behavior', ['docs/a.md', 'docs/b/c.md'], 'docs', 'light', ['from-paths: docs']],
    ['all files under proto/', undefined, ['proto/x.ts'], 'prototype', 'light', ['from-paths: prototype']],
    ['docs/ plus one more file is not docs', 'visual-only', ['docs/a.md', 'app/b.tsx'], 'visual-only', 'light', []],
    ['money raises a visual change to behavior', 'visual-only', ['lib/calc/tax.ts'], 'behavior', 'full', ['elevate 1']],
    ['security raises generated code to behavior', 'generated', ['src/auth.ts'], 'behavior', 'full', ['elevate 1']],
    ['money does not touch ui-behavior', 'ui-behavior', ['lib/calc/tax.ts'], 'ui-behavior', 'full', []],
    ['production raises config-no-prod', 'config-no-prod', ['.github/workflows/ci.yml'], 'prod-config', 'full', ['elevate 2']],
    ['production does not raise behavior', 'behavior', ['.github/workflows/ci.yml'], 'behavior', 'full', []],
    ['rules apply in order, each on the result of the last', 'generated', ['lib/calc/a.ts', '.github/workflows/ci.yml'], 'behavior', 'full', ['elevate 1']],
  ];

  for (const [name, declared, files, kind, lane, raisedBy] of table) {
    it(name, () => {
      expect(effectiveKind(RECIPE, declared, files)).toEqual({ kind, lane, raisedBy });
    });
  }

  it('refuses a declared kind outside the vocabulary', () => {
    expect(() => effectiveKind(RECIPE, 'feature', ['app/a.ts'])).toThrow(/unknown kind "feature"/);
  });

  it('has no lane when the recipe declares no lanes', () => {
    const noLanes = recipeOf(RECIPE_TEXT.replace(/lanes:\n(?: {2}.*\n){2}/, ''));
    expect(effectiveKind(noLanes, 'docs', ['app/a.ts'])).toEqual({ kind: 'docs', raisedBy: [] });
  });
});

// ---------------------------------------------------------------------------------------
// Facts from git
// ---------------------------------------------------------------------------------------

afterEach(removeRepositories);

const facts = (root: string, declared: { kind?: string; builder?: { provider: string; model: string; session: string } } = {}) =>
  describeChangeFromGit({ root, baseRef: 'main', recipe: RECIPE, piece: '42', declared });

describe('§4.1: the facts of a change, from git', () => {
  it('names the commit, the base and where they meet', async () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'main');
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    const head = commit(root, 'change');
    const change = await facts(root);
    expect(change.piece).toBe('42');
    expect(change.sha).toBe(head);
    expect(change.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(change.base).toBe(base);
    expect(change.mergeBase).toBe(base);
  });

  it('lists committed, uncommitted and new files once each, sorted, without renames', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    commit(root, 'change');
    git(root, 'mv', 'lib/calc/tax.ts', 'lib/calc/iva.ts');
    write(root, 'app/page.tsx', 'export const page = 3;\n');
    write(root, 'docs/nuevo.md', '# nuevo\n');
    const change = await facts(root);
    expect(change.files).toEqual(['app/page.tsx', 'docs/nuevo.md', 'lib/calc/iva.ts', 'lib/calc/tax.ts']);
  });

  it('classifies the files and computes the effective kind and lane', async () => {
    const root = repository();
    write(root, 'lib/calc/tax.ts', 'export const tax = 2;\n');
    commit(root, 'money');
    const change = await facts(root, { kind: 'visual-only' });
    expect(change.classes).toEqual(['money']);
    expect(change.declaredKind).toBe('visual-only');
    expect(change.kind).toBe('behavior');
    expect(change.lane).toBe('full');
  });

  it('passes the declared builder through, and nothing when none was declared', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const builder = { provider: 'deepseek', model: 'deepseek-flash', session: 's-1' };
    expect((await facts(root, { builder })).builder).toEqual(builder);
    expect((await facts(root)).builder).toBeUndefined();
  });
});

describe('§4.1: the snapshot is exactly what is judged', () => {
  it('is the tree of the commit when nothing is left unsaved', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const change = await facts(root);
    expect(change.snapshot).toBe(git(root, 'rev-parse', 'HEAD^{tree}'));
    expect(change.clean).toBe(true);
  });

  it('includes unsaved and new files: it is the tree a commit of everything would have', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    write(root, 'app/page.tsx', 'y\n');
    write(root, 'app/new.tsx', 'z\n');
    const change = await facts(root);
    expect(change.clean).toBe(false);
    expect(change.snapshot).not.toBe(git(root, 'rev-parse', 'HEAD^{tree}'));
    commit(root, 'everything');
    expect(git(root, 'rev-parse', 'HEAD^{tree}')).toBe(change.snapshot);
  });

  it('never touches the real index: what was staged stays staged, and nothing else', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'staged\n');
    git(root, 'add', 'app/page.tsx');
    write(root, 'app/page.tsx', 'staged and then edited\n');
    write(root, 'app/untracked.tsx', 'u\n');
    const before = git(root, 'status', '--porcelain');
    await facts(root);
    expect(git(root, 'status', '--porcelain')).toBe(before);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('app/page.tsx');
  });

  it('leaves ignored files out', async () => {
    const root = repository();
    write(root, '.gitignore', 'build/\n');
    commit(root, 'ignore');
    write(root, 'build/out.js', 'x\n');
    const change = await facts(root);
    expect(change.clean).toBe(true);
    expect(change.files).not.toContain('build/out.js');
  });
});

describe('§4.1: the fingerprint of the piece own changes', () => {
  it('is empty when the piece changes nothing', async () => {
    const root = repository();
    expect((await facts(root)).fingerprint).toBe('');
  });

  it('is the same for the same changes in a new commit', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    commit(root, 'first');
    const first = await facts(root);
    git(root, 'commit', '-q', '--amend', '-m', 'same changes, new commit');
    const second = await facts(root);
    expect(second.sha).not.toBe(first.sha);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when an unsaved edit changes what is judged', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    commit(root, 'c');
    const saved = await facts(root);
    write(root, 'app/page.tsx', 'export const page = 3;\n');
    expect((await facts(root)).fingerprint).not.toBe(saved.fingerprint);
  });

  it('tells apart the same substitution made in another place of a repetitive file', async () => {
    const repeated = Array.from({ length: 12 }, () => 'same line').join('\n') + '\n';
    const at = (index: number) => {
      const rows = repeated.split('\n');
      rows[index] = 'changed line';
      return rows.join('\n');
    };
    const first = repository();
    write(first, 'app/list.txt', repeated);
    git(first, 'add', '-A');
    git(first, 'commit', '-q', '-m', 'list');
    git(first, 'branch', '-f', 'main');
    write(first, 'app/list.txt', at(2));
    commit(first, 'change near the top');
    const second = repository();
    write(second, 'app/list.txt', repeated);
    git(second, 'add', '-A');
    git(second, 'commit', '-q', '-m', 'list');
    git(second, 'branch', '-f', 'main');
    write(second, 'app/list.txt', at(9));
    commit(second, 'change near the end');
    expect((await facts(first)).fingerprint).not.toBe((await facts(second)).fingerprint);
  });

  it('does not depend on the diff settings of the person who runs it', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    commit(root, 'c');
    const plain = (await facts(root)).fingerprint;
    git(root, 'config', 'diff.noprefix', 'true');
    git(root, 'config', 'diff.context', '10');
    git(root, 'config', 'color.diff', 'always');
    expect((await facts(root)).fingerprint).toBe(plain);
  });
});

describe('§4.1: facts are whole or not at all', () => {
  it('throws outside a repository', async () => {
    await expect(facts(emptyFolder())).rejects.toThrow();
  });

  it('throws when the base does not exist', async () => {
    const root = repository();
    await expect(
      describeChangeFromGit({ root, baseRef: 'no-such-branch', recipe: RECIPE, piece: '42', declared: {} }),
    ).rejects.toThrow(/no-such-branch/);
  });

  it('throws when the declared kind is not in the vocabulary', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    await expect(facts(root, { kind: 'feature' })).rejects.toThrow(/unknown kind "feature"/);
  });
});
