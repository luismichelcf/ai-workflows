import { afterEach, describe, expect, it } from 'vitest';

import {
  BRANCHES,
  BRANCHES_NO_PROMOTION,
  FORK,
  MISMATCH,
  branchWorld,
  byOwner,
  recipe,
  type BranchWorld,
} from './judge-branches-fixtures.js';
import { removeRepositories } from './git-fixtures.js';

// PLAN-13-R6 §1 (R27): the judge judges, piece by piece, the pull requests into every working
// branch the recipe of the principal declares in `branches.into`; a promotion (`from` → `to` of a
// declared pair, from this same repository) is judged only by the judge's own files.
//
// Interface fixed here (see also judge-branches-fixtures.ts):
//   - `JudgeInput.branches?: readonly string[]`: the action input. Absent or empty = [principal].
//     It is compared with the `branches.into` of the principal's recipe (a recipe without the
//     section = [principal]); when they differ the judge publishes `error` with the motive
//     «el workflow del juez y la receta no declaran las mismas ramas».
//   - The trusted base of a pull request is the live tip of its own target branch: its recipe
//     decides the stages and its merge base the files. A missing or invalid recipe there is
//     `error`, never the principal's recipe.
//   - Before publishing, the tip of each target branch is read again: moved once → judged again
//     with the new tip; moved twice → `error` whose motive names the branch and that it changed
//     (for a branch that is not the principal: «la rama <rama> cambió mientras se juzgaba»).
//   - One verdict per SHA: every open pull request with that head into a branch of `into` is
//     judged, and the worst is published (failure > error > pending > success, §1.2).
//   - `closed` and `edited` out of `into`: the remaining pull requests with that head are judged;
//     with none left, nothing at all is published.
//
// The tip of a branch is read once to judge and once before each publication, as the tip of the
// principal is today (judge-core, «main moved»); the head sequences below rely on that.

afterEach(removeRepositories);

const PAGE = { 'app/page.tsx': 'export const page = 2;\n' };

/** A world whose staging tip carries its own recipe; the pull request head sits on main. */
function withStaging(stagingChecks: readonly string[], mainChecks: readonly string[] = ['todo-verde']) {
  const w = branchWorld({ mainRecipe: recipe(mainChecks, BRANCHES) });
  const staging = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': recipe(stagingChecks, BRANCHES) }, 'staging');
  w.setBranch('staging', staging);
  const head = w.commitOn(w.main, PAGE, 'pieza 13');
  return { w, staging, head };
}

describe('§1.5 (1): a pull request into staging is judged from the tip of staging', () => {
  it('a stage that exists only in the recipe of staging is required', async () => {
    const { w, head } = withStaging(['todo-verde', 'extra-verde']);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');

    await w.judgePr(7);

    expect(w.github.verdicts(head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
    ]);
  });

  it('control: the same head into main is judged with the recipe of main, which does not have that stage', async () => {
    const { w, head } = withStaging(['todo-verde', 'extra-verde']);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');

    await w.judgePr(7);

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
  });

  it('the files of the change are measured from the merge base with staging, not with main', async () => {
    // Staging changed the recipe. A pull request branched from staging does not touch it; measured
    // against main it would, and the judge's own files would reject it.
    const { w, staging } = withStaging(['todo-verde']);
    const head = w.commitOn(staging, PAGE, 'pieza 13 sobre staging');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');

    const report = await w.judgePr(7);

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
    expect(report.pieces).toEqual([expect.objectContaining({ pr: 7, piece: '13', verdict: 'passed' })]);
  });

  for (const [name, content] of [
    ['missing', null],
    ['invalid', 'version: 2\nlocale: es\nstages: []\n'],
  ] as const) {
    it(`a recipe ${name} on staging is an error with its motive, never the recipe of main`, async () => {
      const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
      const staging = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': content }, 'staging');
      w.setBranch('staging', staging);
      const head = w.commitOn(w.main, PAGE, 'pieza 13');
      w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
      // With the recipe of main this pull request would pass.
      w.checks(head, 'success', 'todo-verde');

      await w.judgePr(7);

      const verdicts = w.github.verdicts(head);
      expect(verdicts.map((entry) => entry.state)).toEqual(['error']);
      if (content === null) expect(verdicts[0]?.description).toMatch(/pipeline\.yml/);
    });
  }
});

describe('§1.5 (2): a pull request into a branch outside the input gets no status', () => {
  // A guard as well: today nothing is published for a base that is not the principal.
  it('into develop: nothing is published', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    w.setBranch('staging', w.main);
    w.setBranch('develop', w.main);
    const head = w.commitOn(w.main, PAGE);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'develop' });
    w.checks(head, 'success', 'todo-verde');

    await w.judgePr(7);

    expect(w.github.published).toEqual([]);
  });
});

describe('§1.5 (3): the input and the recipe must declare the same branches', () => {
  const cases: [string, string, readonly string[] | null][] = [
    ['the input says only main, the recipe says staging and main', recipe(['todo-verde'], BRANCHES), ['main']],
    ['no input, the recipe says staging and main', recipe(['todo-verde'], BRANCHES), null],
    ['the input says staging and main, the recipe has no section', recipe(['todo-verde']), ['staging', 'main']],
  ];
  for (const [name, mainRecipe, branches] of cases) {
    it(`${name}: error with the exact motive`, async () => {
      const w = branchWorld({ mainRecipe, branches });
      w.setBranch('staging', w.main);
      const head = w.commitOn(w.main, PAGE);
      w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
      w.checks(head, 'success', 'todo-verde');

      await w.judgePr(7);

      expect(w.github.verdicts(head)).toEqual([
        expect.objectContaining({ state: 'error', description: expect.stringContaining(MISMATCH) }),
      ]);
    });
  }
});

describe('§1.5 (4): a promotion from staging to main is judged only by the judge\'s own files', () => {
  function promotion(stagingFiles: Readonly<Record<string, string | null>>) {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    const staging = w.commitOn(w.main, stagingFiles, 'staging');
    w.setBranch('staging', staging);
    w.pr(20, { head: staging, headRef: 'staging', baseRef: 'main' });
    // No check is set: a promotion is not a piece and its stages are not judged.
    return { w, staging };
  }

  it('without the judge\'s own files: success, without looking for a piece', async () => {
    const { w, staging } = promotion({ 'app/page.tsx': 'export const page = 3;\n' });

    const report = await w.judgePr(20);

    expect(w.github.verdicts(staging).map((entry) => entry.state)).toEqual(['success']);
    expect(report.pieces).toEqual([expect.objectContaining({ pr: 20, verdict: 'passed', stages: [] })]);
    expect(report.pieces[0]?.piece).toBeUndefined();
  });

  it('touching .ai-workflows/pipeline.yml: failure with the order of 16 characters', async () => {
    const { w, staging } = promotion({ '.ai-workflows/pipeline.yml': `${recipe(['todo-verde'], BRANCHES)}# otra\n` });

    await w.judgePr(20);

    expect(w.github.verdicts(staging)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining(`/approve-judge-change ${staging.slice(0, 16)}`) }),
    ]);
  });

  it('with the owner\'s attestation for that head: success', async () => {
    const { w, staging } = promotion({ '.ai-workflows/pipeline.yml': `${recipe(['todo-verde'], BRANCHES)}# otra\n` });
    w.github.commentList.set(20, [byOwner(`/approve-judge-change ${staging.slice(0, 16)}`)]);

    await w.judgePr(20);

    expect(w.github.verdicts(staging).map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('§1.5 (5): what looks like a promotion but is not one is judged as a piece', () => {
  it('head staging into main from a fork: judged as a piece, and it names none', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    const staging = w.commitOn(w.main, PAGE, 'staging');
    w.setBranch('staging', staging);
    w.pr(21, { head: staging, headRef: 'staging', baseRef: 'main', headRepo: FORK });

    await w.judgePr(21);

    expect(w.github.verdicts(staging)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringMatching(/Sin pieza/) }),
    ]);
  });

  it('head staging into main without the pair declared: judged as a piece, and it names none', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES_NO_PROMOTION) });
    const staging = w.commitOn(w.main, PAGE, 'staging');
    w.setBranch('staging', staging);
    w.pr(21, { head: staging, headRef: 'staging', baseRef: 'main' });

    await w.judgePr(21);

    expect(w.github.verdicts(staging)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringMatching(/Sin pieza/) }),
    ]);
  });
});

describe('§1.5 (6): a hotfix straight into main is a piece', () => {
  it('hotfix/7-x into main, with main in into, is judged as piece 7', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    w.setBranch('staging', w.main);
    const head = w.commitOn(w.main, PAGE);
    w.pr(30, { head, headRef: 'hotfix/7-x', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');

    const report = await w.judgePr(30);

    expect(report.pieces).toEqual([expect.objectContaining({ pr: 30, piece: '7', verdict: 'passed' })]);
    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('§1.5 (7) and §1.4: the indirect triggers look for pull requests into every branch of into', () => {
  it('the judgment from the issue finds and judges an open pull request into staging, with the recipe of staging', async () => {
    const { w, head } = withStaging(['todo-verde', 'extra-verde']);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');

    await w.judge('issue_comment', {
      action: 'created',
      issue: { number: 13 },
      comment: { body: 'Veredicto\n\n<!-- ai-workflows:event {"type":"verdict"} -->' },
    });

    expect(w.github.verdicts(head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
    ]);
  });

  it('a workflow_run of a pull request finds the open pull request into staging and judges it with the recipe of staging', async () => {
    const { w, head } = withStaging(['todo-verde', 'extra-verde']);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');

    await w.judge('workflow_run', {
      workflow_run: {
        event: 'pull_request',
        head_sha: head,
        path: '.github/workflows/ai-workflows-red-test.yml',
        repository: { full_name: 'duena/proyecto' },
        pull_requests: [],
      },
    });

    expect(w.github.verdicts(head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
    ]);
  });
});

describe('§1.5 (9): without a branches section, and an input that says only main, all is as today', () => {
  // A guard, not a red test: it passes today and must keep passing.
  it('the input [main] and a recipe without the section agree: the pull request into main is judged', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde']), branches: ['main'] });
    const head = w.commitOn(w.main, PAGE);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'success', 'todo-verde');

    await w.judgePr(7);

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
  });
});

/**
 * Two pull requests with the same head: #7 into staging (judged with `solo-staging`) and #8 into
 * main (judged with `solo-main`). Each recipe asks for a check the other does not know.
 */
function twoPrs(stagingCheck: 'success' | 'failure', mainCheck: 'success' | 'failure'): { w: BranchWorld; head: string } {
  const { w, head } = withStaging(['solo-staging'], ['solo-main']);
  w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
  w.pr(8, { head, headRef: 'feat/13-algo', baseRef: 'main' });
  w.checks(head, stagingCheck, 'solo-staging');
  w.checks(head, mainCheck, 'solo-main');
  return { w, head };
}

describe('§1.5 (12): one verdict per SHA, the worst of all its pull requests', () => {
  for (const [name, staging, main, failing] of [
    ['into staging passes, into main fails', 'success', 'failure', 'solo-main'],
    ['into main passes, into staging fails', 'failure', 'success', 'solo-staging'],
  ] as const) {
    for (const run of [7, 8]) {
      it(`${name}: the run of #${run} publishes failure, described by the failing one`, async () => {
        const { w, head } = twoPrs(staging, main);

        await w.judgePr(run);

        expect(w.github.verdicts(head)).toEqual([
          expect.objectContaining({ state: 'failure', description: expect.stringContaining(failing) }),
        ]);
      });
    }
  }

  it('failure is worse than error across pull requests: a technical one into staging does not hide a rejection into main', async () => {
    const w = branchWorld({ mainRecipe: recipe(['solo-main'], BRANCHES) });
    const staging = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': null }, 'staging sin receta');
    w.setBranch('staging', staging);
    const head = w.commitOn(w.main, PAGE, 'pieza 13');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.pr(8, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.checks(head, 'failure', 'solo-main');

    await w.judgePr(7);

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['failure']);
  });

  it('a pull request with that head into a branch outside into does not count', async () => {
    const { w, head } = withStaging(['solo-staging'], ['solo-main']);
    w.setBranch('develop', w.main);
    w.pr(8, { head, headRef: 'feat/13-algo', baseRef: 'main' });
    w.pr(9, { head, headRef: 'feat/13-algo', baseRef: 'develop' });
    w.checks(head, 'success', 'solo-main');
    w.checks(head, 'failure', 'solo-staging');

    await w.judgePr(8);

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('§1.5 (13): a green pull request into staging retargeted outside into, and back', () => {
  it('outside into nothing is published; back into staging it is judged again', async () => {
    const { w, head } = withStaging(['todo-verde']);
    w.setBranch('develop', w.main);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');

    await w.judgePr(7, 'opened');
    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);

    const pr = w.github.prs.get(7);
    if (pr === undefined) throw new Error('no PR 7');
    pr.baseRef = 'develop';
    const before = w.github.published.length;
    await w.judge('pull_request_target', w.prEvent(7, 'edited', { changes: { base: { ref: { from: 'staging' } } } }));
    expect(w.github.published.length).toBe(before);

    pr.baseRef = 'staging';
    await w.judge('pull_request_target', w.prEvent(7, 'edited', { changes: { base: { ref: { from: 'develop' } } } }));
    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success', 'success']);
  });
});

describe('§1.5 (14): the tip of staging is read again before publishing', () => {
  function moving() {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    const first = w.commitOn(w.main, { '.ai-workflows/pipeline.yml': recipe(['todo-verde'], BRANCHES) }, 'staging 1');
    const second = w.commitOn(first, { '.ai-workflows/pipeline.yml': recipe(['todo-verde', 'extra-verde'], BRANCHES) }, 'staging 2');
    const third = w.commitOn(second, { 'README.md': 'otra\n' }, 'staging 3');
    const head = w.commitOn(w.main, PAGE, 'pieza 13');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'staging' });
    w.checks(head, 'success', 'todo-verde');
    w.checks(head, 'failure', 'extra-verde');
    return { w, first, second, third, head };
  }

  it('staging moved once with a recipe that asks for one more stage: judged again, and the verdict asks for it', async () => {
    const { w, first, second, head } = moving();
    w.setBranch('staging', first, second);

    await w.judgePr(7);

    expect(w.fetched).toContain(second);
    expect(w.github.verdicts(head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('extra-verde') }),
    ]);
  });

  it('staging moved twice: error with the motive, never a verdict of an old tip', async () => {
    const { w, first, second, third, head } = moving();
    w.setBranch('staging', first, second, third);

    await w.judgePr(7);

    const verdicts = w.github.verdicts(head);
    expect(verdicts.map((entry) => entry.state)).toEqual(['error']);
    expect(verdicts[0]?.description).toMatch(/staging/);
    expect(verdicts[0]?.description).toMatch(/cambi/);
  });
});

describe('§1.5 (15): when a pull request stops counting, the others with its head are judged again', () => {
  it('the failing one is closed: the other one is judged and its verdict stays on the SHA', async () => {
    const { w, head } = twoPrs('failure', 'success');
    const pr = w.github.prs.get(7);
    if (pr === undefined) throw new Error('no PR 7');
    pr.state = 'closed';

    const report = await w.judgePr(7, 'closed');

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
    expect(report.pieces.map((piece) => piece.pr)).toEqual([8]);
  });

  it('the failing one is retargeted outside into: the other one is judged and its verdict stays on the SHA', async () => {
    const { w, head } = twoPrs('failure', 'success');
    w.setBranch('develop', w.main);
    const pr = w.github.prs.get(7);
    if (pr === undefined) throw new Error('no PR 7');
    pr.baseRef = 'develop';

    await w.judge('pull_request_target', w.prEvent(7, 'edited', { changes: { base: { ref: { from: 'staging' } } } }));

    expect(w.github.verdicts(head).map((entry) => entry.state)).toEqual(['success']);
  });

  it('the only pull request with that head is closed: nothing at all is published', async () => {
    const { w, head } = withStaging(['todo-verde']);
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main', state: 'closed' });
    w.checks(head, 'failure', 'todo-verde');

    await w.judgePr(7, 'closed');

    expect(w.github.published).toEqual([]);
  });
});
