import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  describeChangeFromCommits,
  describeChangeFromGit,
  diskProjectFiles,
  gitProjectFiles,
  parseRecipe,
  pieceOfBranch,
  readDeclaredKind,
  type ProjectFiles,
  type Recipe,
} from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R3 §1.1 (R19) and §2: on GitHub the judge never has the piece's working tree. It reads
// the change from commits only — the same facts, fingerprint included, that the engine computes
// next to the agent for a clean tree — and it learns the piece from the branch name and the
// declared kind from a line of the piece's plan, read from the commit, never from the disk.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(...rows: string[]): Recipe {
  const result = parseRecipe(lines(...rows), 'pipeline.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const STAGES = [
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node m.mjs',
];

const RECIPE = recipeOf(
  'version: 1',
  'locale: es',
  'classify:',
  '  money: ["lib/calc/**"]',
  'kinds:',
  '  names: [behavior, visual-only, docs]',
  '  default: behavior',
  '  from-paths: { docs: ["docs/**"] }',
  '  elevate:',
  '    - when: { touches-any: [money], kind-none: [behavior] }',
  '      to: behavior',
  'lanes:',
  '  full: [behavior]',
  '  light: [visual-only, docs]',
  'labels:',
  '  behavior: "comportamiento"',
  '  visual-only: "solo visual"',
  'pieces:',
  '  branch: ["*/{piece}", "*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  '  declared-kind:',
  '    file: "docs/plans/PLAN-{piece}.md"',
  '    line: "Tipo de cambio"',
  ...STAGES,
);

describe('§2: facts of a change from commits alone', () => {
  it('match the facts of the same change on a clean working tree', async () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'main');
    write(root, 'app/page.tsx', 'export const page = 2;\n');
    write(root, 'app/new.tsx', 'export const fresh = 1;\n');
    const head = commit(root, 'piece');

    const local = await describeChangeFromGit({ root, baseRef: 'main', recipe: RECIPE, piece: '13', declared: { kind: 'visual-only' } });
    const server = await describeChangeFromCommits({ root, base, head, recipe: RECIPE, piece: '13', declaredKind: 'visual-only' });

    expect(server).toEqual({ ...local, clean: true });
    expect(server.sha).toBe(head);
    expect(server.snapshot).toBe(git(root, 'rev-parse', `${head}^{tree}`));
    expect(server.files).toEqual(['app/new.tsx', 'app/page.tsx']);
    expect(server.kind).toBe('visual-only');
    expect(server.lane).toBe('light');
  });

  it('never looks at the working tree: another branch checked out and unsaved edits change nothing', async () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'main');
    write(root, 'lib/calc/tax.ts', 'export const tax = 2;\n');
    const head = commit(root, 'piece');
    const before = await describeChangeFromCommits({ root, base, head, recipe: RECIPE, piece: '13' });

    git(root, 'switch', '-q', 'main');
    write(root, 'app/page.tsx', 'unsaved\n');
    write(root, 'untracked.txt', 'new\n');
    const after = await describeChangeFromCommits({ root, base, head, recipe: RECIPE, piece: '13' });

    expect(after).toEqual(before);
    expect(after.files).toEqual(['lib/calc/tax.ts']);
    // Money raises whatever was declared, and nothing was declared: the default is behavior.
    expect(after.kind).toBe('behavior');
    expect(after.declaredKind).toBeUndefined();
  });

  it('diffs from the merge base, so a base that moved on does not add its files', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'export const page = 3;\n');
    const head = commit(root, 'piece');
    git(root, 'switch', '-q', 'main');
    write(root, 'docs/other.md', 'moved on\n');
    const base = commit(root, 'main moves');

    const facts = await describeChangeFromCommits({ root, base, head, recipe: RECIPE, piece: '13' });
    expect(facts.files).toEqual(['app/page.tsx']);
    expect(facts.base).toBe(base);
    expect(facts.mergeBase).toBe(git(root, 'merge-base', base, head));
  });

  it('refuses an invalid piece id before running git', async () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'main');
    await expect(describeChangeFromCommits({ root, base, head: base, recipe: RECIPE, piece: '../13' }))
      .rejects.toThrow(/invalid piece id/);
  });

  it('throws instead of returning half the facts when a commit is unknown', async () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'main');
    await expect(
      describeChangeFromCommits({ root, base, head: 'f'.repeat(40), recipe: RECIPE, piece: '13' }),
    ).rejects.toThrow();
  });
});

describe('§1.3: project files read from a commit', () => {
  it('reads the content at that commit, whatever the disk says', async () => {
    const root = repository();
    write(root, 'docs/plans/PLAN-13.md', 'committed\n');
    const head = commit(root, 'plan');
    writeFileSync(join(root, 'docs/plans/PLAN-13.md'), 'edited on disk\n');

    const files = gitProjectFiles(root, head);
    expect(await files.read('docs/plans/PLAN-13.md')).toBe('committed\n');
    expect(await files.read('docs/plans/PLAN-99.md')).toBeUndefined();
    expect(await files.list()).toEqual(['app/page.tsx', 'docs/plans/PLAN-13.md', 'lib/calc/tax.ts']);
  });

  it('refuses a path that leaves the project', async () => {
    const root = repository();
    const files = gitProjectFiles(root, git(root, 'rev-parse', 'HEAD'));
    await expect(files.read('../outside.md')).rejects.toThrow(/path/);
    await expect(files.read('/etc/passwd')).rejects.toThrow(/path/);
  });

  it('refuses a file larger than 1 MB, naming it', async () => {
    const root = repository();
    write(root, 'docs/huge.md', 'x'.repeat(1024 * 1024 + 1));
    const head = commit(root, 'huge');
    await expect(gitProjectFiles(root, head).read('docs/huge.md')).rejects.toThrow(/docs\/huge\.md/);
  });

  it('the disk version reads the working tree', async () => {
    const root = repository();
    write(root, 'docs/a.md', 'on disk\n');
    const files = diskProjectFiles(root);
    expect(await files.read('docs/a.md')).toBe('on disk\n');
    expect(await files.read('docs/missing.md')).toBeUndefined();
  });
});

describe('R19: the piece comes from the branch name', () => {
  const cases: [string, string | undefined][] = [
    ['feat/13-bloques', '13'],
    ['feat/13', '13'],
    ['fix/7-uno-y-otro', '7'],
    ['feat/99a-x', undefined],
    ['libre/12-prototipo', undefined],
    ['libre/12', undefined],
    ['main', undefined],
    ['a/b/13', undefined],
    ['feat/-13', undefined],
  ];
  for (const [branch, piece] of cases) {
    it(`${branch} → ${piece ?? 'no piece'}`, () => {
      const result = pieceOfBranch(RECIPE, branch, 42);
      if (piece === undefined) {
        expect(result).toEqual({ none: expect.stringContaining(branch) });
      } else {
        expect(result).toEqual({ piece });
      }
    });
  }

  it('without a pieces section, the piece is the pull request number', () => {
    const plain = recipeOf('version: 1', 'locale: es', ...STAGES);
    expect(pieceOfBranch(plain, 'libre/anything', 42)).toEqual({ piece: '42' });
  });
});

describe('R19: the declared kind comes from a line of the plan', () => {
  const files = (content: Record<string, string>): ProjectFiles => ({
    read: async (path) => content[path],
    list: async () => Object.keys(content),
  });
  const plan = (text: string) => files({ 'docs/plans/PLAN-13.md': text });

  const cases: [string, string][] = [
    ['Tipo de cambio: behavior', 'behavior'],
    ['**Tipo de cambio:** comportamiento', 'behavior'],
    ['- `Tipo de cambio`: visual-only', 'visual-only'],
    ['tipo de cambio: Solo Visual', 'visual-only'],
    ['TIPO DE CAMBIO:   docs  ', 'docs'],
    ['Típo de cámbio: comportamiento', 'behavior'],
  ];
  for (const [line, kind] of cases) {
    it(`"${line}" → ${kind}`, async () => {
      expect(await readDeclaredKind(RECIPE, '13', plan(lines('# Plan', '', line)))).toEqual({ kind });
    });
  }

  it('the first matching line wins; a line that only mentions the label does not count', async () => {
    const text = lines('El tipo de cambio: docs', 'Tipo de cambio: visual-only', 'Tipo de cambio: behavior');
    expect(await readDeclaredKind(RECIPE, '13', plan(text))).toEqual({ kind: 'visual-only' });
  });

  it('rejects a value that names no kind, naming the value', async () => {
    expect(await readDeclaredKind(RECIPE, '13', plan('Tipo de cambio: magia\n'))).toEqual({
      rejected: expect.stringContaining('magia'),
    });
  });

  it('without the file or the line, nothing is declared', async () => {
    expect(await readDeclaredKind(RECIPE, '13', files({}))).toEqual({});
    expect(await readDeclaredKind(RECIPE, '13', plan('# Plan sin tipo\n'))).toEqual({});
  });

  it('without declared-kind in the recipe, nothing is declared', async () => {
    const plain = recipeOf('version: 1', 'locale: es', 'kinds:', '  names: [behavior]', '  default: behavior', ...STAGES);
    expect(await readDeclaredKind(plain, '13', plan('Tipo de cambio: behavior\n'))).toEqual({});
  });

  it('rejects when the file cannot be read', async () => {
    const broken: ProjectFiles = {
      read: async () => {
        throw new Error('file "docs/plans/PLAN-13.md" is larger than 1 MB');
      },
      list: async () => [],
    };
    expect(await readDeclaredKind(RECIPE, '13', broken)).toEqual({
      rejected: expect.stringContaining('1 MB'),
    });
  });
});
