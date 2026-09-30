import { afterEach, describe, expect, it } from 'vitest';

import { BRANCH, FakeGitHub, MERGE_STAGES, pieceRepository, runFinal } from './final-fixtures.js';
import { removeRepositories } from './git-fixtures.js';

// PLAN-13-R6 §1.1 (§1.5 test 11): the `pull-request` block opens the piece's pull request into the
// first branch of `branches.into`, and `github-merge` merges into the base of that pull request.
// Without the section both keep using the principal (final-merge.test.ts).
//
// Interface fixed here: `pullRequestOf` opens the draft with `base: recipe.branches.into[0]` when
// the recipe declares branches, and accepts as the piece's own an open or merged pull request of
// the agents into that same branch.
//
// `runFinal` writes the recipe as its header, `stages:` and the rows it is given; the section
// `branches:` is appended after the stages, at the top level of the recipe.

afterEach(() => removeRepositories());

const WITH_BRANCHES = [...MERGE_STAGES(), 'branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }'];

/** GitHub merges the pull request on the second read of its detail. */
function mergesOnRead(github: FakeGitHub): void {
  github.onDetail = (pr, reads) => {
    if (reads >= 2 && pr.autoMerge && pr.state === 'OPEN') github.merge(pr);
  };
}

describe('§1.5 (11): the pull request of a piece targets into[0]', () => {
  it('opens one draft into staging, arms it and merges it there', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    mergesOnRead(github);

    const run = await runFinal(root, github, WITH_BRANCHES);

    expect(github.calls.createDraftPullRequest).toBe(1);
    const pr = github.prs[0];
    expect(pr?.baseRef).toBe('staging');
    expect(pr?.headRef).toBe(BRANCH);
    expect(github.calls.enableAutoMerge).toBe(1);
    expect(run.entryOf('merge')?.evidence).toMatchObject({ block: { pr: pr?.number, headSha: head } });
  });

  it('an open pull request of the agents into staging, with its mark, is the piece\'s own: no other is opened', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    github.branches.set(BRANCH, head);
    github.addPullRequest({ number: 5, headSha: head, baseRef: 'staging', body: `Refs #13\n<!-- ai-workflows:op open-pr:${BRANCH}:${head} -->` });
    mergesOnRead(github);

    const run = await runFinal(root, github, WITH_BRANCHES);

    expect(github.calls.createDraftPullRequest).toBe(0);
    expect(run.entryOf('merge')?.evidence).toMatchObject({ block: { pr: 5, headSha: head } });
  });
});
