import { describe, expect, it } from 'vitest';

import { createAgentGitHub, type GhRun } from '../src/index.js';

// PLAN-13-R4 §9: the port the engine uses next to the agent, over `gh`. `gh` is the external
// edge: a fake runner answers by the arguments it receives. Pinned: every call carries the
// agents' token in its own environment and never in its arguments; values reach GraphQL as
// variables; lists are read page by page to the end (PLAN-13-R4 §9), and one that cannot be
// confirmed (a next page without its cursor, a missing field) throws instead of
// returning part of the truth; and the fields the reconciliation of §3.0.1 depends on.

type Answer = GhRun | ((args: readonly string[], input?: string) => GhRun);
interface Call { args: readonly string[]; input?: string; env?: Readonly<Record<string, string>> }

function fakeGh(routes: [RegExp, Answer][]) {
  const calls: Call[] = [];
  const runner = async (args: readonly string[], input?: string, env?: Readonly<Record<string, string>>): Promise<GhRun> => {
    calls.push({ args, ...(input === undefined ? {} : { input }), ...(env === undefined ? {} : { env }) });
    const joined = args.join(' ');
    for (const [pattern, answer] of routes) {
      if (pattern.test(joined)) return typeof answer === 'function' ? answer(args, input) : answer;
    }
    return { exitCode: 1, stdout: '', stderr: `no route for: ${joined}` };
  };
  return { runner, calls };
}

const ok = (value: unknown): GhRun => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
const REPO = 'duena/proyecto';
const TOKEN = 'ghs_agentToken0000000000000000000000000';
const HEAD = 'a'.repeat(40);

function port(routes: [RegExp, Answer][]) {
  const gh = fakeGh(routes);
  const github = createAgentGitHub({ repository: REPO, runner: gh.runner, token: async () => TOKEN });
  return { github, calls: gh.calls };
}

const prNode = (over: Record<string, unknown> = {}) => ({
  number: 7,
  url: 'https://github.com/duena/proyecto/pull/7',
  state: 'OPEN',
  isDraft: true,
  headRefOid: HEAD,
  headRefName: 'feat/13-algo',
  headRepository: { nameWithOwner: REPO },
  baseRefName: 'main',
  author: { login: 'mi-motor', __typename: 'Bot' },
  body: 'Refs #13\n<!-- ai-workflows:op open-pr:feat/13-algo:aaaa -->',
  mergeCommit: null,
  autoMergeRequest: null,
  isInMergeQueue: false,
  ...over,
});

const prList = (nodes: unknown[], hasNextPage: unknown = false, endCursor: unknown = null) =>
  ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } } });

/** Answers page by page: the call whose arguments carry `cursor=<c>` gets the page after `c`. */
const paged = (pages: GhRun[], cursors: string[]) => (args: readonly string[]): GhRun => {
  const cursor = args.find((arg) => arg.startsWith('cursor='))?.slice('cursor='.length);
  const index = cursor === undefined ? 0 : cursors.indexOf(cursor) + 1;
  return pages[index] ?? { exitCode: 1, stdout: '', stderr: `unexpected cursor ${String(cursor)}` };
};

describe('the agents token', () => {
  it('goes to every call in GH_TOKEN, never in the arguments', async () => {
    const { github, calls } = port([[/graphql/, prList([prNode()])], [/issues\/13$/, ok({ title: 'Algo' })]]);
    await github.pullRequestsOfBranch('feat/13-algo');
    await github.issueTitle(13);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.env?.['GH_TOKEN']).toBe(TOKEN);
      expect(call.args.join(' ')).not.toContain(TOKEN);
    }
  });

  it('without a token source, the calls run as the gh account (no GH_TOKEN)', async () => {
    const gh = fakeGh([[/issues\/13$/, ok({ title: 'Algo' })]]);
    await createAgentGitHub({ repository: REPO, runner: gh.runner }).issueTitle(13);
    expect(gh.calls[0]?.env?.['GH_TOKEN']).toBeUndefined();
  });
});

describe('pullRequestsOfBranch', () => {
  it('reads every state with the fields the reconciliation needs; a bot author gets its [bot] suffix, as REST writes it', async () => {
    const merged = prNode({
      number: 5,
      state: 'MERGED',
      isDraft: false,
      mergeCommit: { oid: 'm'.repeat(40) },
      author: { login: 'duena', __typename: 'User' },
      headRepository: { nameWithOwner: 'otra/copia' },
      baseRefName: 'develop',
    });
    const { github, calls } = port([[/graphql/, prList([prNode({ autoMergeRequest: { enabledAt: 'x' }, isInMergeQueue: true }), merged])]]);

    expect(await github.pullRequestsOfBranch('feat/13-algo')).toEqual([
      {
        number: 7, url: 'https://github.com/duena/proyecto/pull/7', state: 'OPEN', isDraft: true,
        headSha: HEAD, headRef: 'feat/13-algo', headRepo: REPO, baseRef: 'main', author: 'mi-motor[bot]',
        body: 'Refs #13\n<!-- ai-workflows:op open-pr:feat/13-algo:aaaa -->', mergeCommit: null, autoMerge: true, inMergeQueue: true,
      },
      {
        number: 5, url: 'https://github.com/duena/proyecto/pull/7', state: 'MERGED', isDraft: false,
        headSha: HEAD, headRef: 'feat/13-algo', headRepo: 'otra/copia', baseRef: 'develop', author: 'duena',
        body: 'Refs #13\n<!-- ai-workflows:op open-pr:feat/13-algo:aaaa -->', mergeCommit: 'm'.repeat(40), autoMerge: false, inMergeQueue: false,
      },
    ]);
    const args = calls[0]?.args ?? [];
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    expect(query).not.toContain('feat/13-algo');
    expect(args).toEqual(expect.arrayContaining(['owner=duena', 'name=proyecto', 'branch=feat/13-algo']));
  });

  const unconfirmable: [string, GhRun][] = [
    ['a next page without its cursor', prList([prNode()], true, null)],
    ['no page information', prList([prNode()], null)],
    ['a pull request without its head', prList([prNode({ headRefOid: null })])],
    ['a state it does not know', prList([prNode({ state: 'LOCKED' })])],
    ['no list at all', ok({ data: { repository: { pullRequests: null } } })],
  ];
  for (const [what, answer] of unconfirmable) {
    it(`throws on ${what}`, async () => {
      const { github } = port([[/graphql/, answer]]);
      await expect(github.pullRequestsOfBranch('feat/13-algo')).rejects.toThrow();
    });
  }

  it('reads every page, following the cursor as a variable, and returns them all in order', async () => {
    const { github, calls } = port([[/graphql/, paged([
      prList([prNode({ number: 1 })], true, 'c1'),
      prList([prNode({ number: 2 })], true, 'c2'),
      prList([prNode({ number: 3 })], false, null),
    ], ['c1', 'c2'])]]);
    expect((await github.pullRequestsOfBranch('feat/13-algo')).map((pr) => pr.number)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.args.find((arg) => arg.startsWith('cursor=')) ?? null)).toEqual([null, 'cursor=c1', 'cursor=c2']);
  });
});

describe('pullRequestHistory', () => {
  const timeline = (nodes: unknown[], hasNextPage: unknown = false, endCursor: unknown = null) =>
    ok({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });

  it('translates the events the reconciliation reads, in order, with who and when', async () => {
    const { github } = port([[/graphql/, timeline([
      { __typename: 'PullRequestCommit', commit: { oid: HEAD, committedDate: '2026-09-24T10:00:00Z' } },
      { __typename: 'ReadyForReviewEvent', actor: { login: 'mi-motor', __typename: 'Bot' }, createdAt: '2026-09-24T10:01:00Z' },
      { __typename: 'AutoMergeEnabledEvent', actor: { login: 'mi-motor', __typename: 'Bot' }, createdAt: '2026-09-24T10:02:00Z' },
      { __typename: 'AddedToMergeQueueEvent', actor: { login: 'mi-motor', __typename: 'Bot' }, createdAt: '2026-09-24T10:03:00Z' },
      { __typename: 'HeadRefForcePushedEvent', actor: { login: 'duena', __typename: 'User' }, createdAt: '2026-09-24T10:04:00Z' },
      { __typename: 'MergedEvent', actor: null, createdAt: '2026-09-24T10:05:00Z' },
    ])]]);

    expect(await github.pullRequestHistory(7)).toEqual([
      { type: 'head-changed', actor: null, at: '2026-09-24T10:00:00Z' },
      { type: 'ready', actor: 'mi-motor[bot]', at: '2026-09-24T10:01:00Z' },
      { type: 'auto-merge-enabled', actor: 'mi-motor[bot]', at: '2026-09-24T10:02:00Z' },
      { type: 'added-to-queue', actor: 'mi-motor[bot]', at: '2026-09-24T10:03:00Z' },
      { type: 'head-changed', actor: 'duena', at: '2026-09-24T10:04:00Z' },
      { type: 'merged', actor: null, at: '2026-09-24T10:05:00Z' },
    ]);
  });

  it('reads a long history page by page, in the order GitHub gives it (never re-sorted by date)', async () => {
    const { github } = port([[/graphql/, paged([
      timeline([{ __typename: 'ReadyForReviewEvent', actor: { login: 'mi-motor', __typename: 'Bot' }, createdAt: '2026-09-24T10:05:00Z' }], true, 'c1'),
      timeline([{ __typename: 'PullRequestCommit', commit: { oid: HEAD, committedDate: '2026-01-01T00:00:00Z' } }], false),
    ], ['c1'])]]);
    expect((await github.pullRequestHistory(7)).map((item) => item.type)).toEqual(['ready', 'head-changed']);
  });

  it('throws when a next page has no cursor or there is no page information', async () => {
    for (const answer of [timeline([], true, null), timeline([], null)]) {
      const { github } = port([[/graphql/, answer]]);
      await expect(github.pullRequestHistory(7)).rejects.toThrow();
    }
  });
});

describe('branchActivity', () => {
  it('reads the pushes and deletions of the branch with actor, before and after', async () => {
    const { github, calls } = port([[/activity/, ok([[
      { activity_type: 'push', actor: { login: 'mi-motor[bot]' }, before: 'b'.repeat(40), after: HEAD, timestamp: '2026-09-24T10:00:00Z', ref: 'refs/heads/feat/13-algo' },
      { activity_type: 'branch_deletion', actor: { login: 'duena' }, before: HEAD, after: '0'.repeat(40), timestamp: '2026-09-24T11:00:00Z', ref: 'refs/heads/feat/13-algo' },
    ]])]]);

    expect(await github.branchActivity('feat/13-algo')).toEqual([
      { type: 'push', actor: 'mi-motor[bot]', before: 'b'.repeat(40), after: HEAD, at: '2026-09-24T10:00:00Z' },
      { type: 'branch_deletion', actor: 'duena', before: HEAD, after: '0'.repeat(40), at: '2026-09-24T11:00:00Z' },
    ]);
    const joined = calls[0]?.args.join(' ') ?? '';
    expect(joined).toMatch(/repos\/duena\/proyecto\/activity/);
    expect(joined).toMatch(/ref=refs\/heads\/feat\/13-algo/);
    expect(joined).toMatch(/--paginate/);
  });

  it('throws on an entry without its actor field or its after', async () => {
    const { github } = port([[/activity/, ok([[{ activity_type: 'push', before: HEAD, timestamp: 'x' }]])]]);
    await expect(github.branchActivity('feat/13-algo')).rejects.toThrow();
  });
});

describe('every call names the repository (found in the real run: `gh pr ready` used the repository of the folder)', () => {
  it('markReady never depends on the folder it runs in', async () => {
    const { github, calls } = port([[/.*/, ok({ data: { markPullRequestReadyForReview: { pullRequest: { number: 7 } } }, node_id: 'PR_node7' })]]);
    await github.markReady(7);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const joined = call.args.join(' ');
      const named = call.args[0] === 'api'
        ? /repos\/duena\/proyecto|graphql/.test(joined)
        : call.args.includes('--repo') && call.args[call.args.indexOf('--repo') + 1] === REPO;
      expect(named, joined).toBe(true);
    }
  });
});

describe('markReady (found in the real run: `gh pr ready` answers with text, not JSON)', () => {
  it('succeeds when gh answers success with no JSON at all', async () => {
    const { github } = port([[/.*/, { exitCode: 0, stdout: '', stderr: '✓ Pull request #7 is marked as "ready for review"' }]]);
    await expect(github.markReady(7)).resolves.toBeUndefined();
  });

  it('still fails, naming the pull request, when gh fails', async () => {
    const { github } = port([[/.*/, { exitCode: 1, stdout: '', stderr: 'GraphQL: something broke' }]]);
    await expect(github.markReady(7)).rejects.toThrow(/7/);
  });
});

describe('writes', () => {
  it('creates a draft pull request with the body on stdin, never in the arguments', async () => {
    const body = 'Refs #13\n<!-- ai-workflows:op open-pr:feat/13-algo:aaaa -->';
    const { github, calls } = port([[/pulls/, ok({ number: 9 })]]);
    expect(await github.createDraftPullRequest({ branch: 'feat/13-algo', base: 'main', title: 'Algo', body })).toBe(9);
    const call = calls[0];
    expect(call?.args.join(' ')).toMatch(/--method POST/);
    expect(call?.args.join(' ')).not.toContain('ai-workflows:op');
    expect(JSON.parse(call?.input ?? '{}')).toEqual({ head: 'feat/13-algo', base: 'main', title: 'Algo', body, draft: true });
  });

  it('arms the auto-merge on the exact head, method and PR as GraphQL variables', async () => {
    const { github, calls } = port([[/graphql/, ok({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 7 } } } })], [/pulls\/7$/, ok({ node_id: 'PR_node7' })]]);
    await github.enableAutoMerge(7, { method: 'squash', headSha: HEAD });
    const mutation = calls.find((call) => call.args.some((arg) => arg.includes('enablePullRequestAutoMerge')));
    expect(mutation?.args).toEqual(expect.arrayContaining([`expectedHeadOid=${HEAD}`, 'mergeMethod=SQUASH', 'pullRequestId=PR_node7']));
  });

  it('comments on the issue with the body on stdin and returns the comment id', async () => {
    const { github, calls } = port([[/issues\/13\/comments/, ok({ id: 555 })]]);
    expect(await github.commentOnIssue(13, 'hola <!-- ai-workflows:message {"op":"x"} -->')).toBe(555);
    expect(calls[0]?.args.join(' ')).not.toContain('ai-workflows:message');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({ body: 'hola <!-- ai-workflows:message {"op":"x"} -->' });
  });
});

describe('deployments', () => {
  it('reads the deployments of a SHA in an environment, and the newest state of one', async () => {
    const { github, calls } = port([
      [/deployments\/31\/statuses/, ok([[{ state: 'success', environment_url: 'https://x.vercel.app', target_url: null }]])],
      [/deployments/, ok([[{ id: 30, sha: HEAD, creator: { login: 'vercel[bot]' } }, { id: 31, sha: HEAD, creator: { login: 'vercel[bot]' } }]])],
    ]);
    expect(await github.deployments(HEAD, 'Preview')).toEqual([
      { id: 30, sha: HEAD, creator: 'vercel[bot]' },
      { id: 31, sha: HEAD, creator: 'vercel[bot]' },
    ]);
    expect(calls[0]?.args.join(' ')).toMatch(/sha=a{40}/);
    expect(calls[0]?.args.join(' ')).toMatch(/environment=Preview/);
    expect(await github.deploymentState(31)).toEqual({ state: 'success', url: 'https://x.vercel.app' });
  });

  it('a deployment with no status yet has no state', async () => {
    const { github } = port([[/deployments\/31\/statuses/, ok([[]])]]);
    expect(await github.deploymentState(31)).toBeUndefined();
  });
});
