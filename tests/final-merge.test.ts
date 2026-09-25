import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../src/index.js';

import { AGENT, BRANCH, FakeGitHub, MERGE_STAGES, OWNER, PIECE, pieceRepository, runFinal } from './final-fixtures.js';
import { removeRepositories } from './git-fixtures.js';

// PLAN-13-R4 §3.0, §3.0.1 and §3.6 (CN-06, CN-13): the pull request of the piece and the merge.
// The branch is pushed with the judged SHA, a draft pull request is opened once and only once
// (its body carries the mark of the operation), marked ready, armed to merge on that exact head,
// and watched to the end. Every effect survives a crash on either side of the call without
// being repeated, and without undoing what a person did by hand in between.

afterEach(() => removeRepositories());

const MERGED_AT = 'f'.repeat(40);

/** GitHub merges the pull request on the n-th read of its detail. */
function mergesOnRead(github: FakeGitHub, read = 2): void {
  github.onDetail = (pr, reads) => {
    if (reads >= read && pr.autoMerge && pr.state === 'OPEN') github.merge(pr, MERGED_AT);
  };
}

describe('the happy path', () => {
  it('pushes, opens one draft, marks it ready, arms the merge on the head and waits for it', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    mergesOnRead(github);

    const run = await runFinal(root, github, MERGE_STAGES());

    expect(run.outcome).toMatchObject({ outcome: 'ran', status: { state: 'blocked:rejected', stage: 'after' } });
    expect(github.branches.get(BRANCH)).toBe(head);
    expect(github.calls).toMatchObject({ push: 1, createDraftPullRequest: 1, markReady: 1, enableAutoMerge: 1 });
    const pr = github.prs[0];
    expect(pr?.body).toContain(`Refs #${PIECE}`);
    expect(pr?.body).toContain(`<!-- ai-workflows:op open-pr:${BRANCH}:${head} -->`);
    expect((pr as unknown as { mergeMethod?: string }).mergeMethod).toBe('squash');
    expect(run.entryOf('merge')?.evidence).toMatchObject({
      block: { pr: pr?.number, headSha: head, mergeSha: MERGED_AT },
    });
  });

  it('the pull request targets the main branch', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    mergesOnRead(github);
    await runFinal(root, github, MERGE_STAGES());
    expect(github.prs[0]?.baseRef).toBe('main');
  });
});

describe('what already exists on GitHub', () => {
  it('a pull request merged while the engine was down passes without pushing or arming anything (CN-06)', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    github.addPullRequest({ number: 5, state: 'MERGED', headSha: head, mergeCommit: MERGED_AT, body: `Refs #13\n<!-- ai-workflows:op open-pr:${BRANCH}:${head} -->` });

    const run = await runFinal(root, github, MERGE_STAGES());

    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
    expect(github.calls).toMatchObject({ push: 0, createDraftPullRequest: 0, markReady: 0, enableAutoMerge: 0 });
    expect(run.entryOf('merge')?.evidence).toMatchObject({ block: { pr: 5, mergeSha: MERGED_AT } });
  });

  it('a merged pull request of another account, or into another base, never makes the merge pass', async () => {
    for (const foreign of [{ author: OWNER }, { baseRef: 'develop' }, { headRepo: 'otra/copia' }]) {
      const { root, head } = pieceRepository();
      const github = new FakeGitHub();
      github.addPullRequest({ number: 5, state: 'MERGED', headSha: head, mergeCommit: MERGED_AT, ...foreign });
      mergesOnRead(github);

      const run = await runFinal(root, github, MERGE_STAGES());

      expect(github.calls.enableAutoMerge, JSON.stringify(foreign)).toBe(1);
      expect(run.entryOf('merge')?.evidence ?? {}).not.toMatchObject({ block: { pr: 5 } });
    }
  });

  it('an open pull request opened by the owner is refused, and no other is opened', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    github.addPullRequest({ number: 5, headSha: head, author: OWNER });

    const run = await runFinal(root, github, MERGE_STAGES());

    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(new RegExp(`${OWNER}.*ciérralo`)) } });
    expect(github.calls.createDraftPullRequest).toBe(0);
  });

  it('a pull request of the app without any mark, open or closed, is technical and no other is opened', async () => {
    for (const state of ['OPEN', 'CLOSED'] as const) {
      const { root, head } = pieceRepository();
      const github = new FakeGitHub();
      github.addPullRequest({ number: 5, state, headSha: head, body: 'Refs #13' });

      const run = await runFinal(root, github, MERGE_STAGES());

      expect(run.outcome, state).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge', reason: expect.stringMatching(/#5/) } });
      expect(github.calls.createDraftPullRequest, state).toBe(0);
    }
  });

  it('two open pull requests of the branch are technical', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    const mark = `Refs #13\n<!-- ai-workflows:op open-pr:${BRANCH}:${head} -->`;
    github.addPullRequest({ number: 5, headSha: head, body: mark });
    github.addPullRequest({ number: 6, headSha: head, body: mark });

    expect((await runFinal(root, github, MERGE_STAGES())).outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge' } });
  });

  it('a remote branch with commits that are not here is refused, pointing at sync', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.humanPush(BRANCH, '9'.repeat(40));

    const run = await runFinal(root, github, MERGE_STAGES());

    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(/sync/) } });
    expect(github.calls.push).toBe(0);
  });
});

describe('a crash between an effect and its record (CN-13)', () => {
  it('after opening the pull request: the resume finds it by its mark and never opens a second', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('createDraftPullRequest', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    expect(first.outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge' } });

    mergesOnRead(github);
    const second = await first.again();

    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
    expect(github.calls.createDraftPullRequest).toBe(1);
    expect(github.prs).toHaveLength(1);
  });

  it('before opening it: the resume sees nothing happened and opens exactly one', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('createDraftPullRequest', { when: 'before' });
    const store = createMemoryStore();

    await runFinal(root, github, MERGE_STAGES(), { store });
    mergesOnRead(github);
    const second = await runFinal(root, github, MERGE_STAGES(), { store });

    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
    expect(github.prs).toHaveLength(1);
  });

  it('a closed pull request of an earlier operation (another mark) does not count as this one', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    github.addPullRequest({ number: 5, state: 'CLOSED', headSha: head, body: `Refs #13\n<!-- ai-workflows:op open-pr:${BRANCH}:${'0'.repeat(40)} -->` });
    github.failures.set('createDraftPullRequest', { when: 'before' });
    const store = createMemoryStore();

    await runFinal(root, github, MERGE_STAGES(), { store });
    mergesOnRead(github);
    await runFinal(root, github, MERGE_STAGES(), { store });

    expect(github.calls.createDraftPullRequest).toBe(1); // the one that failed before doing anything is not counted
    expect(github.prs.filter((pr) => pr.state !== 'CLOSED')).toHaveLength(1);
  });

  it('after opening it, if someone removes the mark and closes it, the resume is technical and opens nothing', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('createDraftPullRequest', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    const pr = github.prs[0];
    if (pr === undefined) throw new Error('fixture: no pull request');
    Object.assign(pr, { body: 'Refs #13', state: 'CLOSED' });

    const second = await first.again();

    expect(second.outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge' } });
    expect(github.prs).toHaveLength(1);
  });

  it('after the push: a person who then moves the branch is respected, the push is not repeated', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('push', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    github.humanPush(BRANCH, undefined);

    const second = await first.again();

    expect(github.calls.push).toBe(1);
    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(/rama cambió/) } });
  });

  it('after marking ready: if the owner turns it back into a draft, it is not marked again', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('markReady', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    const pr = github.prs[0];
    if (pr === undefined) throw new Error('fixture: no pull request');
    Object.assign(pr, { isDraft: true });

    const second = await first.again();

    expect(github.calls.markReady).toBe(1);
    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(/volvió a borrador/) } });
  });

  it('after arming: if the owner disarms it, it is not armed again, and the watch says so', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('enableAutoMerge', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    const pr = github.prs[0];
    if (pr === undefined) throw new Error('fixture: no pull request');
    Object.assign(pr, { autoMerge: false });

    const second = await first.again();

    expect(github.calls.enableAutoMerge).toBe(1);
    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(/desarmó/) } });
  });

  it('an unreadable history leaves the effect in doubt as technical, never repeated', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.failures.set('enableAutoMerge', { when: 'after' });
    const store = createMemoryStore();

    const first = await runFinal(root, github, MERGE_STAGES(), { store });
    github.readErrors.set('pullRequestHistory', 5);
    const second = await first.again();

    expect(second.outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge', reason: expect.stringMatching(/merge:/) } });
    expect(github.calls.enableAutoMerge).toBe(1);
  });
});

describe('the watch (§3.6)', () => {
  it('refuses when the head changes, the pull request is closed, or it leaves the queue', async () => {
    const cases: [string, (pr: import('../src/index.js').AgentPullRequest) => void, RegExp][] = [
      ['head', (pr) => Object.assign(pr, { headSha: '9'.repeat(40) }), /cabeza/],
      ['closed', (pr) => Object.assign(pr, { state: 'CLOSED' }), /cerr/],
      ['queue', (pr) => Object.assign(pr, { autoMerge: false, inMergeQueue: false }), /cola|desarm/],
    ];
    for (const [what, change, reason] of cases) {
      const { root } = pieceRepository();
      const github = new FakeGitHub();
      github.onDetail = (pr, reads) => {
        if (reads === 2) change(pr);
      };
      const run = await runFinal(root, github, MERGE_STAGES());
      expect(run.outcome, what).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(reason) } });
    }
  });

  it('one read without auto-merge and without queue entry is not yet leaving: it takes two in a row', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.onDetail = (pr, reads) => {
      if (reads === 2) Object.assign(pr, { autoMerge: false, inMergeQueue: false });
      if (reads === 3) Object.assign(pr, { inMergeQueue: true });
      if (reads === 4) github.merge(pr, MERGED_AT);
    };
    const run = await runFinal(root, github, MERGE_STAGES());
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
  });

  it('stops at the time limit, and the next run watches again without arming anything', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    const store = createMemoryStore();
    let waited = 0;
    const sleep = async (ms: number) => {
      waited += ms;
    };

    const first = await runFinal(root, github, MERGE_STAGES('      with: { method: squash, timeout-minutes: 1, poll-seconds: 30 }'), { store, sleep });
    expect(first.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge', reason: expect.stringMatching(/no terminó en 1 minuto/) } });
    expect(waited).toBeGreaterThanOrEqual(60_000);

    mergesOnRead(github, 1);
    const second = await runFinal(root, github, MERGE_STAGES('      with: { method: squash, timeout-minutes: 1, poll-seconds: 30 }'), { store, sleep });
    expect(second.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
    expect(github.calls.enableAutoMerge).toBe(1);
  });

  it('tolerates three read errors in a row and is technical on the fourth', async () => {
    const tolerated = pieceRepository();
    const lenient = new FakeGitHub();
    mergesOnRead(lenient, 1);
    let armed = false;
    const original = lenient.enableAutoMerge.bind(lenient);
    lenient.enableAutoMerge = async (...args) => {
      await original(...args);
      if (!armed) lenient.readErrors.set('pullRequestDetail', 3);
      armed = true;
    };
    expect((await runFinal(tolerated.root, lenient, MERGE_STAGES())).outcome).toMatchObject({ status: { stage: 'after' } });

    const strict = pieceRepository();
    const harsh = new FakeGitHub();
    const originalHarsh = harsh.enableAutoMerge.bind(harsh);
    harsh.enableAutoMerge = async (...args) => {
      await originalHarsh(...args);
      harsh.readErrors.set('pullRequestDetail', 4);
    };
    expect((await runFinal(strict.root, harsh, MERGE_STAGES())).outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'merge' } });
  });
});
