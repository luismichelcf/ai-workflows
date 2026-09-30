import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BRANCHES, branchWorld, recipe, type BranchWorld } from './judge-branches-fixtures.js';
import { git, removeRepositories } from './git-fixtures.js';

// PLAN-13-R6 §15, P3 (the flock of slice 6): criss-cross merges. With several merge bases, the
// judge's own files and the engine version are measured on what really lands: the union of the
// changes against EVERY merge base, and of the merge tree (`git merge-tree`, the merge GitHub
// performs) against the trusted tip. A conflicting merge tree counts as touched.
//
// The attack these tests reproduce (flock-security-1, BLOCKER 2):
//   1. main has M0 (the recipe that asks for less).
//   2. The owner commits M2 on main, which asks for more.
//   3. An older branch F (from M0, committed after M2) is merged into main: T = merge(M2, F).
//   4. The pull request head is H = merge(F, M2) resolving the recipe back to M0's, plus a payload.
//   5. `git merge-base T H` answers F, so F..H does not list the recipe; merging H into T reverts
//      it. Today the judge publishes success without any attestation.
//
// Interface fixed here: none beyond `runJudge`; the verdict is the one of §2.3 (failure with the
// order `/approve-judge-change <16 characters of the head>`).

afterEach(removeRepositories);

type Changes = Readonly<Record<string, string | null>>;

/**
 * A commit with `parents` whose tree is `from`'s tree with `changes` applied (`null` deletes), built
 * on a temporary index with a fixed date, so which merge base git prefers is under the test's control.
 */
function commitTree(root: string, parents: readonly string[], from: string, changes: Changes, date: string, message: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'aiw-index-'));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(folder, 'index'),
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const plumbing = (args: string[], input?: string): string =>
      execFileSync('git', args, { cwd: root, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) }).trim();
    plumbing(['read-tree', from]);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        plumbing(['update-index', '--force-remove', '--', path]);
        continue;
      }
      const blob = plumbing(['hash-object', '-w', '--stdin'], content);
      plumbing(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = plumbing(['write-tree']);
    return plumbing(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const WEAK = recipe(['todo-verde'], BRANCHES);
const STRONG = recipe(['todo-verde', 'extra-verde'], BRANCHES);
const PAYLOAD = { 'app/page.tsx': 'export const page = 666;\n' };
const FEATURE = { 'lib/f.ts': 'export const f = 1;\n' };

interface Cross {
  readonly w: BranchWorld;
  /** The trusted tip: merge(M2, F). */
  readonly tip: string;
  /** The head: merge(F, M2), as the test resolves it. */
  readonly head: string;
  readonly m2: string;
  readonly f: string;
}

/**
 * Builds the criss-cross of the header over `base` (M0 by default): M2 applies `owner` on main, F
 * applies FEATURE, the tip merges both (plus `tipExtra`), and the head merges both too, but with
 * `headResolution` applied on top of M2's tree.
 */
function crissCross(options: {
  readonly owner: Changes;
  readonly headResolution: Changes;
  readonly tipExtra?: Changes;
  readonly base?: (w: BranchWorld) => string;
}): Cross {
  const w = branchWorld({ mainRecipe: WEAK });
  const m0 = options.base?.(w) ?? w.main;
  const m2 = commitTree(w.root, [m0], m0, options.owner, '2030-01-01T00:00:01Z', 'la dueña endurece');
  // F is committed after M2, so git prefers it as the merge base.
  const f = commitTree(w.root, [m0], m0, FEATURE, '2030-01-01T00:00:02Z', 'una rama vieja');
  const tip = commitTree(w.root, [m2, f], m2, { ...FEATURE, ...options.tipExtra }, '2030-01-01T00:00:03Z', 'entra la rama vieja');
  const head = commitTree(w.root, [f, m2], m2, { ...FEATURE, ...options.headResolution }, '2030-01-01T00:00:04Z', 'mezcla con la principal');
  return { w, tip, head, m2, f };
}

/** The precondition of the attack: two merge bases, and the one git answers hides the change. */
function expectHidden(c: Cross, file: string): void {
  expect(git(c.w.root, 'merge-base', '--all', c.tip, c.head).split('\n').sort()).toEqual([c.m2, c.f].sort());
  expect(git(c.w.root, 'merge-base', c.tip, c.head)).toBe(c.f);
  expect(git(c.w.root, 'diff', '--name-only', c.f, c.head).split('\n')).not.toContain(file);
}

const rejectedForOwnFiles = (head: string) => [
  expect.objectContaining({ state: 'failure', description: expect.stringContaining(`/approve-judge-change ${head.slice(0, 16)}`) }),
];

describe('P3: own files reverted through a criss-cross merge', () => {
  it('a piece reverts the recipe the owner tightened: failure with /approve-judge-change', async () => {
    const c = crissCross({ owner: { '.ai-workflows/pipeline.yml': STRONG }, headResolution: { '.ai-workflows/pipeline.yml': WEAK, ...PAYLOAD } });
    expectHidden(c, '.ai-workflows/pipeline.yml');
    c.w.setBranch('main', c.tip);
    c.w.setBranch('staging', c.tip);
    c.w.pr(7, { head: c.head, headRef: 'feat/13-algo', baseRef: 'main' });
    // Every stage of the tightened recipe is green: only the judge's own files can reject it.
    c.w.checks(c.head, 'success', 'todo-verde', 'extra-verde');

    await c.w.judgePr(7);

    expect(c.w.github.verdicts(c.head)).toEqual(rejectedForOwnFiles(c.head));
  });

  it('a promotion from staging reverts the recipe: failure with /approve-judge-change', async () => {
    const c = crissCross({ owner: { '.ai-workflows/pipeline.yml': STRONG }, headResolution: { '.ai-workflows/pipeline.yml': WEAK, ...PAYLOAD } });
    expectHidden(c, '.ai-workflows/pipeline.yml');
    c.w.setBranch('main', c.tip);
    c.w.setBranch('staging', c.head);
    c.w.pr(20, { head: c.head, headRef: 'staging', baseRef: 'main' });

    await c.w.judgePr(20);

    expect(c.w.github.verdicts(c.head)).toEqual(rejectedForOwnFiles(c.head));
  });

  it('a piece reverts the engine version the owner bumped: failure with /approve-judge-change', async () => {
    const pkg = (version: string) => `${JSON.stringify({ name: 'proyecto', devDependencies: { 'ai-workflows': version } }, null, 2)}\n`;
    const c = crissCross({
      base: (w) => commitTree(w.root, [w.main], w.main, { 'package.json': pkg('github:luismichelcf/ai-workflows#v0.3.0') }, '2030-01-01T00:00:00Z', 'el motor'),
      owner: { 'package.json': pkg('github:luismichelcf/ai-workflows#v1.0.0') },
      headResolution: { 'package.json': pkg('github:luismichelcf/ai-workflows#v0.3.0'), ...PAYLOAD },
    });
    expectHidden(c, 'package.json');
    c.w.setBranch('main', c.tip);
    c.w.setBranch('staging', c.tip);
    c.w.pr(7, { head: c.head, headRef: 'feat/13-algo', baseRef: 'main' });
    c.w.checks(c.head, 'success', 'todo-verde');

    await c.w.judgePr(7);

    expect(c.w.github.verdicts(c.head)).toEqual(rejectedForOwnFiles(c.head));
  });

  it('a criss-cross whose merge tree conflicts counts as touched: failure with /approve-judge-change', async () => {
    // Nothing of the judge's changes on any side; only README.md conflicts between the tip and the head.
    const c = crissCross({
      owner: { 'lib/m2.ts': 'export const m2 = 1;\n' },
      tipExtra: { 'README.md': 'la principal dice esto\n' },
      headResolution: { 'README.md': 'la cabeza dice otra cosa\n', ...PAYLOAD },
    });
    expect(git(c.w.root, 'merge-base', '--all', c.tip, c.head).split('\n').sort()).toEqual([c.m2, c.f].sort());
    // The precondition: the merge GitHub would perform does conflict (exit 1 of merge-tree).
    expect(spawnSync('git', ['merge-tree', '--write-tree', c.tip, c.head], { cwd: c.w.root }).status).toBe(1);
    c.w.setBranch('main', c.tip);
    c.w.setBranch('staging', c.tip);
    c.w.pr(7, { head: c.head, headRef: 'feat/13-algo', baseRef: 'main' });
    c.w.checks(c.head, 'success', 'todo-verde');

    await c.w.judgePr(7);

    expect(c.w.github.verdicts(c.head)).toEqual(rejectedForOwnFiles(c.head));
  });
});
