import { afterEach, describe, expect, it } from 'vitest';

import {
  BRANCHES,
  MISMATCH,
  branchWorld,
  byOwner,
  recipe,
  type BranchWorld,
} from './judge-branches-fixtures.js';
import { removeRepositories } from './git-fixtures.js';

// PLAN-13-R6 §15 (the flock of slice 6), fixes P1 and P2 and the English motive, on the judge's
// paths that serve several working branches (§1.2, §6).
//
// Interface fixed here (for the builder):
//   - P1. The judgement woken from the piece's issue applies §1.2 as the pull request path does:
//     the piece's pull requests are grouped by head; for each head, EVERY open pull request with
//     that head into a branch of `into` is judged (pull requests of another piece and promotions
//     included, each with the trusted tip of its own target branch), and the worst verdict
//     (failure > error > pending > success) is published ONCE on that head, with the description
//     of the worst. The pull requests of other heads are found with `openPullRequestsWithHead`.
//   - P1. On the issue path the `branches` input is compared with the `into` of the principal's
//     recipe, as on the pull request path: when they differ, `error` with the motive MISMATCH is
//     published on every head of the piece, never a verdict.
//   - P2. When the tip of a target branch changes while judging, every judgement against that
//     branch is updated to the new tip at once; «changed again» is counted per branch. A branch
//     that moves once never ends in `error`, whatever other branch also moved once.
//   - The motive MISMATCH follows the recipe's language: in English it is exactly
//     MISMATCH_EN below.

afterEach(removeRepositories);

const PAGE = { 'app/page.tsx': 'export const page = 2;\n' };
const MISMATCH_EN = 'the judge workflow and the recipe do not declare the same branches';

/** The comment of a builder or a verdict on issue 13, which wakes the judgement from the issue. */
const ISSUE_EVENT = {
  action: 'created',
  issue: { number: 13 },
  comment: { body: 'Veredicto\n\n<!-- ai-workflows:event {"type":"verdict"} -->' },
};

const judgeIssue = (w: BranchWorld) => w.judge('issue_comment', ISSUE_EVENT);

/** Registers the pull requests again in `order`: the fake lists open pull requests in that order. */
function reorder(w: BranchWorld, order: readonly number[]): void {
  const saved = order.map((n) => {
    const pr = w.github.prs.get(n);
    if (pr === undefined) throw new Error(`no PR ${n}`);
    return pr;
  });
  for (const n of order) w.github.prs.delete(n);
  for (const pr of saved) w.github.prs.set(pr.number, pr);
}

/** A world whose staging tip carries its own recipe; the head sits on main. */
function withStaging(stagingChecks: readonly string[], mainChecks: readonly string[]) {
  const w = branchWorld({ mainRecipe: recipe(mainChecks, BRANCHES) });
  const staging = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': recipe(stagingChecks, BRANCHES) }, 'staging');
  w.setBranch('staging', staging);
  const head = w.commitOn(w.main, PAGE, 'pieza 13');
  return { w, staging, head };
}

/** #7 into staging (asks for `solo-staging`) and #8 into main (asks for `solo-main`), one head. */
function twoPrs(stagingCheck: 'success' | 'failure', mainCheck: 'success' | 'failure') {
  const { w, staging, head } = withStaging(['solo-staging'], ['solo-main']);
  w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
  w.pr(8, { head, headRef: 'feat/13-algo', baseRef: 'main' });
  w.checks(head, stagingCheck, 'solo-staging');
  w.checks(head, mainCheck, 'solo-main');
  return { w, staging, head };
}

describe('P1: from the issue, one verdict per SHA, the worst of all its pull requests (§1.2)', () => {
  for (const [name, staging, main, failing] of [
    ['into staging fails, into main passes', 'failure', 'success', 'solo-staging'],
    ['into staging passes, into main fails', 'success', 'failure', 'solo-main'],
  ] as const) {
    for (const order of [[7, 8], [8, 7]]) {
      it(`${name}, listed ${order.join(' then ')}: failure once, described by the failing one`, async () => {
        const { w, head } = twoPrs(staging, main);
        reorder(w, order);

        await judgeIssue(w);

        expect(w.github.verdicts(head)).toEqual([
          expect.objectContaining({ state: 'failure', description: expect.stringContaining(failing) }),
        ]);
      });
    }
  }

  for (const order of [[7, 9], [9, 7]]) {
    it(`a pull request of another piece with the same head counts too (listed ${order.join(' then ')})`, async () => {
      const { w, head } = withStaging(['solo-staging'], ['solo-main']);
      w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
      w.pr(9, { head, headRef: 'feat/14-otra', baseRef: 'staging' });
      w.checks(head, 'success', 'solo-main');
      w.checks(head, 'failure', 'solo-staging');
      reorder(w, order);

      await judgeIssue(w);

      expect(w.github.verdicts(head)).toEqual([
        expect.objectContaining({ state: 'failure', description: expect.stringContaining('solo-staging') }),
      ]);
    });
  }

  for (const order of [[7, 20], [20, 7]]) {
    it(`a promotion with the same head counts too: it touches the recipe without attestation (listed ${order.join(' then ')})`, async () => {
      const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
      const staging = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': `${recipe(['todo-verde'], BRANCHES)}# otra\n` }, 'staging');
      w.setBranch('staging', staging);
      // The piece's pull request carries the owner's attestation for this head; the promotion does not.
      w.pr(7, { head: staging, headRef: 'feat/13-algo', baseRef: 'main' });
      w.pr(20, { head: staging, headRef: 'staging', baseRef: 'main' });
      w.github.commentList.set(7, [byOwner(`/approve-judge-change ${staging.slice(0, 16)}`)]);
      w.checks(staging, 'success', 'todo-verde');
      reorder(w, order);

      await judgeIssue(w);

      expect(w.github.verdicts(staging)).toEqual([
        expect.objectContaining({ state: 'failure', description: expect.stringContaining(`/approve-judge-change ${staging.slice(0, 16)}`) }),
      ]);
    });
  }
});

describe('P1: from the issue, the input and the recipe must declare the same branches (§1.2)', () => {
  const cases: [string, string, readonly string[] | null][] = [
    ['the input says only main, the recipe says staging and main', recipe(['todo-verde'], BRANCHES), ['main']],
    ['the input says staging and main, the recipe has no section', recipe(['todo-verde']), ['staging', 'main']],
  ];
  for (const [name, mainRecipe, branches] of cases) {
    it(`${name}: error MISMATCH on every head of the piece, never a verdict`, async () => {
      const w = branchWorld({ mainRecipe, branches });
      w.setBranch('staging', w.main);
      const first = w.commitOn(w.main, PAGE, 'pieza 13 a');
      const second = w.commitOn(w.main, { 'README.md': 'otra\n' }, 'pieza 13 b');
      w.pr(7, { head: first, headRef: 'feat/13-a', baseRef: 'main' });
      w.pr(8, { head: second, headRef: 'fix/13-b', baseRef: 'main' });
      // With the branches in agreement, both would pass.
      w.checks(first, 'success', 'todo-verde');
      w.checks(second, 'success', 'todo-verde');

      await judgeIssue(w);

      for (const head of [first, second]) {
        expect(w.github.verdicts(head)).toEqual([
          expect.objectContaining({ state: 'error', description: expect.stringContaining(MISMATCH) }),
        ]);
      }
      expect(w.github.published.map((entry) => entry.state)).not.toContain('success');
    });
  }
});

describe('the motive MISMATCH in the language of the recipe', () => {
  const english = recipe(['todo-verde'], BRANCHES).replace('locale: es', 'locale: en');

  it('an English recipe, on the pull request path: the motive is in English', async () => {
    const w = branchWorld({ mainRecipe: english, branches: ['main'] });
    w.setBranch('staging', w.main);
    const head = w.commitOn(w.main, PAGE);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');

    await w.judgePr(7);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'error', description: MISMATCH_EN })]);
  });

  it('an English recipe, on the issue path: the motive is in English', async () => {
    const w = branchWorld({ mainRecipe: english, branches: ['main'] });
    w.setBranch('staging', w.main);
    const head = w.commitOn(w.main, PAGE);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');

    await judgeIssue(w);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'error', description: MISMATCH_EN })]);
  });

  it('control: a Spanish recipe keeps the Spanish motive', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES), branches: ['main'] });
    w.setBranch('staging', w.main);
    const head = w.commitOn(w.main, PAGE);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');

    await w.judgePr(7);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'error', description: MISMATCH })]);
  });
});

describe('P2: the tip of each branch, read again before publishing, counted per branch (§1.2)', () => {
  it('staging and main each move once, with one pull request into each: judged again, no error', async () => {
    const { w, staging, head } = twoPrs('success', 'success');
    const stagingMoved = w.commitOn(staging, { 'README.md': 'staging avanza\n' }, 'staging avanza');
    const mainMoved = w.commitOn(w.main, { 'README.md': 'main avanza\n' }, 'main avanza');
    w.setBranch('staging', staging, stagingMoved);
    w.setBranch('main', w.main, mainMoved);

    await w.judgePr(8);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'success' })]);
    expect(w.fetched).toEqual(expect.arrayContaining([stagingMoved, mainMoved]));
  });

  it('two pull requests with one head into main, main moves once: judged again, no error', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    w.setBranch('staging', w.main);
    const head = w.commitOn(w.main, PAGE, 'pieza 13');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.pr(8, { head, headRef: 'fix/14-otra', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');
    const mainMoved = w.commitOn(w.main, { 'README.md': 'main avanza\n' }, 'main avanza');
    w.setBranch('main', w.main, mainMoved);

    await w.judgePr(7);

    expect(w.github.verdicts(head)).toEqual([expect.objectContaining({ state: 'success' })]);
  });

  // A guard: it errors today and must keep erroring.
  it('main moves twice, with one pull request into staging and one into main: error naming the principal', async () => {
    const { w, head } = twoPrs('success', 'success');
    const second = w.commitOn(w.main, { 'README.md': 'main avanza\n' }, 'main avanza');
    const third = w.commitOn(second, { 'README.md': 'main avanza otra vez\n' }, 'main avanza otra vez');
    w.setBranch('main', w.main, second, third);

    await w.judgePr(8);

    const verdicts = w.github.verdicts(head);
    expect(verdicts.map((entry) => entry.state)).toEqual(['error']);
    expect(verdicts[0]?.description).toMatch(/principal/);
    expect(verdicts[0]?.description).toMatch(/cambi/);
  });
});

describe('the issue path: the tip of staging moves twice (§1.2, §6)', () => {
  // A guard: it errors today (a mutant `attempt >= 2` survived the flock) and must keep erroring.
  it('error naming staging, never a verdict of an old tip', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    const first = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': recipe(['todo-verde'], BRANCHES) }, 'staging 1');
    const second = w.commitOn(first, { '.ai-workflows/pipeline.yml': recipe(['todo-verde', 'extra-verde'], BRANCHES) }, 'staging 2');
    const third = w.commitOn(second, { 'README.md': 'otra\n' }, 'staging 3');
    const head = w.commitOn(w.main, PAGE, 'pieza 13');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde', 'extra-verde');
    w.setBranch('staging', first, second, third);

    await judgeIssue(w);

    const verdicts = w.github.verdicts(head);
    expect(verdicts.map((entry) => entry.state)).toEqual(['error']);
    expect(verdicts[0]?.description).toMatch(/staging/);
    expect(verdicts[0]?.description).toMatch(/cambi/);
  });
});
