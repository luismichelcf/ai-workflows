import { afterEach, describe, expect, it } from 'vitest';

import {
  BRANCHES,
  MISMATCH,
  branchWorld,
  recipe,
  type BranchWorld,
} from './judge-branches-fixtures.js';
import { commit, git, removeRepositories, write } from './git-fixtures.js';

// Delta review of the flock fixes (PLAN-13-R6 §15 P2, §1.2), finding B1: when the tip of a target
// branch moves while the judge is judging, the new tip is a commit the judge's checkout does not
// hold yet (on GitHub it was pushed after the checkout). The judge must fetch it BEFORE asking git
// anything about it — whether the head already landed in it, its recipe, its merge base — and then
// judge the pull request again against it. Asking git first about an object that is not there
// (`git merge-base --is-ancestor` exits 128) turns the work into a technical error.
//
// The world here has a real bare remote: `fetchObjects` runs `git fetch <bare> <sha>`, and the
// moved tip exists only in that remote (checked before judging).
//
// Rule of the «landed» case (§1.2, the comment in the judge): a head that is already inside the
// new tip has nothing new to judge; the verdict computed against the old tip stands and is
// published for that target.
//
// Also (a NOTE of the same review, §15 P1): on the issue path, when the action input `branches`
// lists MORE branches than the recipe's `into`, the heads of pull requests into the extra branches
// get the MISMATCH error too, as on the pull request path.

afterEach(removeRepositories);

const PAGE = { 'app/page.tsx': 'export const page = 2;\n' };
const RECIPE_PATH = '.ai-workflows/pipeline.yml';

/** The comment of a builder or a verdict on issue 13, which wakes the judgement from the issue. */
const ISSUE_EVENT = {
  action: 'created',
  issue: { number: 13 },
  comment: { body: 'Veredicto\n\n<!-- ai-workflows:event {"type":"verdict"} -->' },
};

const judgeIssue = (w: BranchWorld) => w.judge('issue_comment', ISSUE_EVENT);

/**
 * #7 into `branch`, green on `todo-verde` and red on `extra-verde`. The branch starts at a tip
 * whose recipe asks only for `todo-verde`, and moves once, while judging, to a tip that exists only
 * on the remote and whose recipe also asks for `extra-verde`.
 */
function movingToRemoteTip(branch: 'staging' | 'main') {
  const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES), remote: true });
  const first = branch === 'main'
    ? w.main
    : w.commitOn(w.main, { [RECIPE_PATH]: `${recipe(['todo-verde'], BRANCHES)}# staging\n` }, 'staging 1');
  if (branch === 'staging') w.setBranch('staging', first);
  else w.setBranch('staging', w.main);
  const moved = w.commitRemote(first, { [RECIPE_PATH]: recipe(['todo-verde', 'extra-verde'], BRANCHES) }, `${branch} 2`);
  const head = w.commitOn(w.main, PAGE, 'pieza 13');
  w.pr(7, { head, headRef: 'feat/13-algo', baseRef: branch });
  w.checks(head, 'success', 'todo-verde');
  w.checks(head, 'failure', 'extra-verde');
  w.setBranch(branch, first, moved);
  return { w, first, moved, head };
}

describe('B1: a target tip that moved while judging is fetched before git is asked about it', () => {
  it('fixture: the moved tip exists only on the remote until it is fetched', () => {
    const { w, moved, first, head } = movingToRemoteTip('staging');
    expect(w.hasObject(first)).toBe(true);
    expect(w.hasObject(head)).toBe(true);
    expect(w.hasObject(moved)).toBe(false);
  });

  for (const branch of ['staging', 'main'] as const) {
    it(`pull request path, ${branch} moves to a tip only the remote has: judged again against it, the new stage is required`, async () => {
      const { w, moved, head } = movingToRemoteTip(branch);

      const report = await w.judgePr(7);

      expect(w.github.verdicts(head)).toEqual([
        expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
      ]);
      expect(w.fetched).toContain(moved);
      expect(report.pieces.map((piece) => piece.verdict)).not.toContain('technical');
    });
  }

  it('issue path, staging moves to a tip only the remote has: judged again against it, the new stage is required', async () => {
    const { w, moved, head } = movingToRemoteTip('staging');

    const report = await judgeIssue(w);

    expect(w.github.verdicts(head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
    ]);
    expect(w.fetched).toContain(moved);
    expect(report.pieces.map((piece) => piece.verdict)).not.toContain('technical');
  });
});

describe('B1: the head landed in the target while judging: the verdict against the old tip stands', () => {
  /**
   * #7 into staging, green on `todo-verde`. While judging, the head is merged into staging (a
   * merge commit) and the recipe of that new tip asks for `extra-verde`, which is red: judging
   * again against the new tip would fail, but the head has nothing new to judge there.
   */
  function landing(remote: boolean) {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES), remote });
    const first = w.commitOn(w.main, { [RECIPE_PATH]: `${recipe(['todo-verde'], BRANCHES)}# staging\n` }, 'staging 1');
    const head = w.commitOn(w.main, PAGE, 'pieza 13');
    const extra = { [RECIPE_PATH]: recipe(['todo-verde', 'extra-verde'], BRANCHES) };
    const landed = remote
      ? w.commitRemote(first, extra, 'staging recibe la pieza', head)
      : landedLocally(w, first, head, extra);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');
    w.setBranch('staging', first, landed);
    return { w, head, landed };
  }

  // Guard: with the new tip already in the checkout this holds today.
  it('the merged tip is already local: success, the verdict computed against the old tip', async () => {
    const { w, head } = landing(false);

    await w.judgePr(7);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'success' })]);
  });

  for (const path of ['pull request', 'issue'] as const) {
    it(`${path} path, the merged tip exists only on the remote: success, the verdict computed against the old tip`, async () => {
      const { w, head, landed } = landing(true);
      expect(w.hasObject(landed)).toBe(false);

      const report = path === 'issue' ? await judgeIssue(w) : await w.judgePr(7);

      expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'success' })]);
      expect(report.pieces).toEqual([expect.objectContaining({ pr: 7, verdict: 'passed' })]);
    });
  }
});

/** A merge commit of `head` into `into` in the checkout itself, with `files` written on top. */
function landedLocally(w: BranchWorld, into: string, head: string, files: Readonly<Record<string, string>>): string {
  const root = w.root;
  git(root, 'switch', '-q', '--detach', into);
  git(root, 'merge', '-q', '--no-ff', '--no-edit', head);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  const sha = commit(root, 'staging recibe la pieza');
  git(root, 'switch', '-q', 'main');
  return sha;
}

describe('NOTE: on the issue path, the input lists more branches than the recipe', () => {
  it('a head into an extra branch of the input gets the MISMATCH error too', async () => {
    // The recipe declares staging and main; the input adds develop.
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES), branches: ['staging', 'main', 'develop'] });
    w.setBranch('staging', w.main);
    w.setBranch('develop', w.main);
    const intoMain = w.commitOn(w.main, PAGE, 'pieza 13 a');
    const intoDevelop = w.commitOn(w.main, { 'README.md': 'otra\n' }, 'pieza 13 b');
    w.pr(7, { head: intoMain, headRef: 'feat/13-a', baseRef: 'main' });
    w.pr(8, { head: intoDevelop, headRef: 'fix/13-b', baseRef: 'develop' });
    w.checks(intoMain, 'success', 'todo-verde');
    w.checks(intoDevelop, 'success', 'todo-verde');

    await judgeIssue(w);

    for (const head of [intoMain, intoDevelop]) {
      expect(w.github.verdicts(head), head === intoMain ? 'into main' : 'into develop').toEqual([
        expect.objectContaining({ state: 'error', description: expect.stringContaining(MISMATCH) }),
      ]);
    }
    expect(w.github.published.map((entry) => entry.state)).not.toContain('success');
  });
});
