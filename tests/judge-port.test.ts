import { describe, expect, it } from 'vitest';

import { createJudgeGitHub, type GhRun } from '../src/index.js';

// PLAN-13-R3 §3.2, §3.4, §3.7 and §6: the port the judge talks to GitHub through, over `gh`.
// `gh` is the external edge: here a fake runner answers by the arguments it receives. What is
// pinned is what can go wrong in the translation — a queue list that cannot be confirmed, the
// pagination, which field says a comment was edited, the length of a status description, and
// that values reach GraphQL as variables, never spliced into the query text.

type Answer = GhRun | ((args: readonly string[], input?: string) => GhRun);

function fakeGh(routes: [RegExp, Answer][]) {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const runner = async (args: readonly string[], input?: string): Promise<GhRun> => {
    calls.push(input === undefined ? { args } : { args, input });
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

const queueAnswer = (nodes: unknown[], hasNextPage: unknown = false) => ok({
  data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage, endCursor: null }, nodes } } } },
});
const entry = (position: unknown, head: string, base: string, pr: number) => ({
  position,
  headCommit: { oid: head },
  baseCommit: { oid: base },
  pullRequest: { number: pr },
});

describe('mergeQueue', () => {
  it('reads the entries ordered by position, with head, base and PR', async () => {
    const gh = fakeGh([[/graphql/, queueAnswer([entry(2, 'b2', 'b1', 8), entry(1, 'b1', 'm0', 7)])]]);
    const port = createJudgeGitHub({ repository: REPO, runner: gh.runner });
    expect(await port.mergeQueue('main')).toEqual([
      { position: 1, headSha: 'b1', baseSha: 'm0', prNumber: 7 },
      { position: 2, headSha: 'b2', baseSha: 'b1', prNumber: 8 },
    ]);
  });

  it('passes owner, name and branch as GraphQL variables, never inside the query', async () => {
    const gh = fakeGh([[/graphql/, queueAnswer([])]]);
    await createJudgeGitHub({ repository: REPO, runner: gh.runner }).mergeQueue('ma"in');
    const args = gh.calls[0]?.args ?? [];
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    expect(query).not.toContain('duena');
    expect(query).not.toContain('ma"in');
    expect(args).toEqual(expect.arrayContaining(['owner=duena', 'name=proyecto', 'branch=ma"in']));
  });

  const unconfirmable: [string, GhRun][] = [
    ['another page', queueAnswer([entry(1, 'b1', 'm0', 7)], true)],
    ['no page information', queueAnswer([entry(1, 'b1', 'm0', 7)], null)],
    ['a repeated position', queueAnswer([entry(1, 'b1', 'm0', 7), entry(1, 'b2', 'b1', 8)])],
    ['a position that is not a positive integer', queueAnswer([entry(0, 'b1', 'm0', 7)])],
    ['an entry without its base', queueAnswer([{ position: 1, headCommit: { oid: 'b1' }, pullRequest: { number: 7 } }])],
    ['no list at all', ok({ data: { repository: { mergeQueue: null } } })],
  ];
  for (const [what, answer] of unconfirmable) {
    it(`throws on ${what}`, async () => {
      const gh = fakeGh([[/graphql/, answer]]);
      await expect(createJudgeGitHub({ repository: REPO, runner: gh.runner }).mergeQueue('main')).rejects.toThrow();
    });
  }
});

describe('comments', () => {
  it('reads every page and says who wrote each one, how, and whether it was edited', async () => {
    const raw = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      body: `/visto-bueno ${id}`,
      user: { login: 'duena', type: 'User' },
      performed_via_github_app: null,
      created_at: '2026-09-23T10:00:00Z',
      updated_at: '2026-09-23T10:00:00Z',
      ...extra,
    });
    const gh = fakeGh([[/issues\/7\/comments/, ok([[raw(1), raw(2, { updated_at: '2026-09-23T11:00:00Z' })], [raw(3, { performed_via_github_app: { id: 5 }, user: { login: 'bot', type: 'Bot' } })]])]]);
    const comments = await createJudgeGitHub({ repository: REPO, runner: gh.runner }).comments(7);
    expect(comments).toEqual([
      { body: '/visto-bueno 1', author: 'duena', authorType: 'User', performedViaApp: false, edited: false },
      { body: '/visto-bueno 2', author: 'duena', authorType: 'User', performedViaApp: false, edited: true },
      { body: '/visto-bueno 3', author: 'bot', authorType: 'Bot', performedViaApp: true, edited: false },
    ]);
    expect(gh.calls[0]?.args).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  });

  it('throws on a comment without its author or dates, instead of guessing', async () => {
    const gh = fakeGh([[/issues\/7\/comments/, ok([[{ id: 1, body: 'x', user: null }]])]]);
    await expect(createJudgeGitHub({ repository: REPO, runner: gh.runner }).comments(7)).rejects.toThrow();
  });
});

describe('checks and statuses', () => {
  it('asks only for the latest check runs of that exact name, and reads the app that made them', async () => {
    const gh = fakeGh([[/check-runs/, ok([{ total_count: 1, check_runs: [{ name: 'todo-verde', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, html_url: 'https://github.com/x/runs/1' }] }])]]);
    const runs = await createJudgeGitHub({ repository: REPO, runner: gh.runner }).checkRuns('abc', 'todo-verde');
    expect(runs).toEqual([{ status: 'completed', conclusion: 'success', app: 'github-actions', url: 'https://github.com/x/runs/1' }]);
    const joined = gh.calls[0]?.args.join(' ') ?? '';
    expect(joined).toContain('commits/abc/check-runs');
    expect(joined).toMatch(/check_name=todo-verde/);
    expect(joined).toMatch(/filter=latest/);
  });

  it('keeps only check runs with exactly that name', async () => {
    const gh = fakeGh([[/check-runs/, ok([{ check_runs: [
      { name: 'todo-verde', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, html_url: null },
      { name: 'todo-verde-extra', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, html_url: null },
    ] }])]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: gh.runner }).checkRuns('abc', 'todo-verde')).toHaveLength(1);
  });

  it('reads every status, newest first', async () => {
    const gh = fakeGh([[/statuses/, ok([[
      { context: 'todo-verde', state: 'failure', target_url: null, created_at: '2026-09-23T10:00:00Z' },
      { context: 'todo-verde', state: 'success', target_url: 'https://x', created_at: '2026-09-23T11:00:00Z' },
    ]])]]);
    const statuses = await createJudgeGitHub({ repository: REPO, runner: gh.runner }).statuses('abc');
    expect(statuses.map((status) => status.state)).toEqual(['success', 'failure']);
  });
});

describe('pull requests and runs', () => {
  it('finds only the open PRs whose head is exactly that SHA', async () => {
    const gh = fakeGh([[/commits\/abc\/pulls/, ok([[
      { number: 7, state: 'open', head: { sha: 'abc' } },
      { number: 8, state: 'closed', head: { sha: 'abc' } },
      { number: 9, state: 'open', head: { sha: 'other' } },
    ]])]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: gh.runner }).openPullRequestsWithHead('abc')).toEqual([7]);
  });

  it('a run that does not exist is undefined; any other failure throws', async () => {
    const missing = fakeGh([[/actions\/runs\/5/, { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: missing.runner }).workflowRun(5)).toBeUndefined();
    const broken = fakeGh([[/actions\/runs\/5/, { exitCode: 1, stdout: '', stderr: 'HTTP 502' }]]);
    await expect(createJudgeGitHub({ repository: REPO, runner: broken.runner }).workflowRun(5)).rejects.toThrow(/502/);
  });

  it('reads a run path and event', async () => {
    const gh = fakeGh([[/actions\/runs\/5/, ok({ path: '.github/workflows/ai-workflows.yml', event: 'pull_request_target', head_branch: 'feat/13-algo' })]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: gh.runner }).workflowRun(5)).toEqual({
      path: '.github/workflows/ai-workflows.yml',
      event: 'pull_request_target',
      headBranch: 'feat/13-algo',
    });
  });

  it('reads the default branch and its head from the API', async () => {
    const gh = fakeGh([
      [/branches\/main/, ok({ commit: { sha: 'm1' } })],
      [/repos\/duena\/proyecto$/, ok({ default_branch: 'main' })],
    ]);
    const port = createJudgeGitHub({ repository: REPO, runner: gh.runner });
    expect(await port.defaultBranch()).toBe('main');
    expect(await port.branchHead('main')).toBe('m1');
  });
});

describe('forcePushedHeads', () => {
  const timeline = (nodes: unknown[], hasNextPage: unknown = false) => ok({
    data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage, endCursor: null }, nodes } } } },
  });

  it('reads the head each force push replaced, with the PR number as a variable', async () => {
    const gh = fakeGh([[/graphql/, timeline([{ beforeCommit: { oid: 'old1' } }, { beforeCommit: { oid: 'old2' } }])]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: gh.runner }).forcePushedHeads(7)).toEqual(['old1', 'old2']);
    const args = gh.calls[0]?.args ?? [];
    expect((args.find((arg) => arg.startsWith('query=')) ?? '')).toContain('HEAD_REF_FORCE_PUSHED_EVENT');
    expect(args).toEqual(expect.arrayContaining(['number=7']));
  });

  it('skips an event whose previous head GitHub no longer names', async () => {
    const gh = fakeGh([[/graphql/, timeline([{ beforeCommit: null }, { beforeCommit: { oid: 'old2' } }])]]);
    expect(await createJudgeGitHub({ repository: REPO, runner: gh.runner }).forcePushedHeads(7)).toEqual(['old2']);
  });

  it('throws when the list cannot be confirmed', async () => {
    for (const answer of [timeline([], true), timeline([], null), ok({ data: { repository: { pullRequest: null } } })]) {
      const gh = fakeGh([[/graphql/, answer]]);
      await expect(createJudgeGitHub({ repository: REPO, runner: gh.runner }).forcePushedHeads(7)).rejects.toThrow();
    }
  });
});

describe('publishing', () => {
  it('publishes a status with a description cut to 140 characters', async () => {
    const gh = fakeGh([[/statuses\/abc/, ok({})]]);
    await createJudgeGitHub({ repository: REPO, runner: gh.runner }).publishStatus('abc', {
      context: 'ai-workflows',
      state: 'failure',
      description: 'x'.repeat(300),
      targetUrl: 'https://github.com/duena/proyecto/actions/runs/1',
    });
    const args = gh.calls[0]?.args ?? [];
    expect(args.join(' ')).toContain('repos/duena/proyecto/statuses/abc');
    const description = args.find((arg) => arg.startsWith('description=')) ?? '';
    expect([...description.slice('description='.length)].length).toBeLessThanOrEqual(140);
    expect(args).toEqual(expect.arrayContaining(['state=failure', 'context=ai-workflows', 'target_url=https://github.com/duena/proyecto/actions/runs/1']));
  });

  it('a status that cannot be published throws: the run must not look green', async () => {
    const gh = fakeGh([[/statuses\/abc/, { exitCode: 1, stdout: '', stderr: 'HTTP 403' }]]);
    await expect(createJudgeGitHub({ repository: REPO, runner: gh.runner }).publishStatus('abc', {
      context: 'ai-workflows', state: 'success', description: 'ok', targetUrl: 'https://x',
    })).rejects.toThrow(/403/);
  });

  it('keeps one trace comment per PR: updates it when it exists, creates it otherwise', async () => {
    const existing = fakeGh([
      [/issues\/7\/comments --paginate/, ok([[{ id: 44, body: '<!-- ai-workflows:trace -->\nold', user: { login: 'github-actions[bot]', type: 'Bot' }, performed_via_github_app: null, created_at: 'a', updated_at: 'a' }]])],
      [/issues\/comments\/44/, ok({})],
    ]);
    await createJudgeGitHub({ repository: REPO, runner: existing.runner }).upsertTraceComment(7, 'nuevo');
    const patch = existing.calls.find((call) => call.args.join(' ').includes('issues/comments/44'));
    expect(patch?.args).toEqual(expect.arrayContaining(['--method', 'PATCH']));
    expect(JSON.stringify(patch)).toContain('ai-workflows:trace');

    const fresh = fakeGh([
      [/issues\/7\/comments --paginate/, ok([[]])],
      [/issues\/7\/comments/, ok({})],
    ]);
    await createJudgeGitHub({ repository: REPO, runner: fresh.runner }).upsertTraceComment(7, 'nuevo');
    const post = fresh.calls.at(-1);
    expect(post?.args).toEqual(expect.arrayContaining(['--method', 'POST']));
    expect(JSON.stringify(post)).toContain('ai-workflows:trace');
  });

  it('a comment with the mark written by someone else is not the trace: a new one is created', async () => {
    const planted = fakeGh([
      [/issues\/7\/comments --paginate/, ok([[{ id: 45, body: '<!-- ai-workflows:trace -->\nsembrado', user: { login: 'otra', type: 'User' }, performed_via_github_app: null, created_at: 'a', updated_at: 'a' }]])],
      [/issues\/7\/comments/, ok({})],
    ]);
    await createJudgeGitHub({ repository: REPO, runner: planted.runner }).upsertTraceComment(7, 'nuevo');
    expect(planted.calls.some((call) => call.args.join(' ').includes('issues/comments/45'))).toBe(false);
    expect(planted.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--method', 'POST']));
  });
});
