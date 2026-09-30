import { afterEach, describe, expect, it } from 'vitest';

import { runJudge, type JudgeGitHub, type JudgeInput } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R6 §6: the judgement woken by a comment on the piece's issue never leaves an old green.
// As soon as the pull requests of the piece are known, and before judging the first one, every
// head gets `pending` «juzgando» in the context that applies (the advisory one in `advisory`),
// unless the newest status of the judge on that head is from a newer official run. A re-read that
// fails before publishing publishes `error` with its motive; each pull request is judged inside
// its own capture. The recipe and the open list are read up to three times; an unreadable recipe
// with a readable list publishes a broad `pending` «no pude leer la receta» on every open pull
// request into a branch of the `branches` input.
//
// Interface fixed by these tests (for the builder):
// - `JudgeInput.branches?: readonly string[]` — the `branches` input of the action (§1.2), the
//   branches that receive pieces. When absent, only the principal. The broad pending uses it,
//   because it is known without the recipe.
// - The initial pending has exactly the description `juzgando` (the same word the console step of
//   action.yml publishes). The broad one contains `no pude leer la receta`.
// - The reads before knowing the pull requests (the head of the principal and the recipe it
//   carries, and `openPullRequests`) are attempted three times in all; between attempts the judge
//   may wait only through `deps.sleep` (the tests inject one that returns at once).
// - A run that could not publish a status, or could not read its inputs, still ends failed (the
//   promise rejects), naming the pull request (`#<n>`) when there is one.
//
// Git is real (a temporary repository plays the trusted checkout); GitHub is the fake port.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// One stage the owner approves when the app changes: a head that touches `app/` waits (pending),
// a head that only touches `docs/` passes (success). So a verdict is never mistaken for the
// initial «juzgando».
const RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'agent-account: "agentes[bot]"',
  'classify:',
  '  visible: ["app/**"]',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'stages:',
  '  - id: approval',
  '    summary: "La dueña aprueba"',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/approval-review@1',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const JUDGE_PATH = '.github/workflows/ai-workflows.yml';
const RUN_ID = 100;
const JUZGANDO = 'juzgando';

interface Pr { readonly number: number; readonly head: string; readonly branch: string; readonly base?: string }
interface Published { readonly sha: string; readonly context: string; readonly state: string; readonly description: string }

interface Setup {
  /** The pull requests of the repository; `heads` gives the two real commits. */
  readonly prs?: (heads: { visible: string; quiet: string }) => Pr[];
  readonly over?: (t: { published: Published[]; calls: string[]; heads: { visible: string; quiet: string } }) => Partial<JudgeGitHub>;
}

function setup(options: Setup = {}) {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'app/page.tsx': 'uno\n' });
  write(root, 'app/page.tsx', 'dos\n');
  const visible = commit(root, 'toca lo visible');
  git(root, 'switch', '-q', '-c', 'docs', 'main');
  write(root, 'docs/nota.md', 'nota\n');
  const quiet = commit(root, 'solo documentos');
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const heads = { visible, quiet };
  const list = (options.prs ?? ((h) => [
    { number: 7, head: h.visible, branch: 'feat/13-boton' },
    { number: 10, head: h.quiet, branch: 'fix/13-docs' },
  ]))(heads);
  const published: Published[] = [];
  const calls: string[] = [];
  const base = {
    defaultBranch: async () => 'main',
    branchHead: async (branch: string) => {
      calls.push(`branchHead ${branch}`);
      return main;
    },
    pullRequest: async (n: number) => {
      calls.push(`pullRequest ${n}`);
      const pr = list.find((item) => item.number === n);
      if (pr === undefined) throw new Error(`no PR ${n}`);
      return { number: n, state: 'open', headSha: pr.head, headRef: pr.branch, baseRef: pr.base ?? 'main', headRepo: 'duena/proyecto' };
    },
    openPullRequestsWithHead: async () => [],
    openPullRequests: async () => {
      calls.push('openPullRequests');
      return list.map((pr) => ({ number: pr.number, headRef: pr.branch, headSha: pr.head, baseRef: pr.base ?? 'main' }));
    },
    mergeQueue: async () => [],
    comments: async () => [],
    issueComments: async () => [],
    reviews: async () => [],
    checkRuns: async () => [],
    statuses: async () => [],
    workflowRun: async () => ({ path: JUDGE_PATH, event: 'issue_comment', headBranch: 'main' }),
    forcePushedHeads: async () => [],
    publishStatus: async (sha: string, status: { context: string; state: string; description: string }) => {
      published.push({ sha, context: status.context, state: status.state, description: status.description });
    },
    upsertTraceComment: async () => {},
  };
  const github = { ...base, ...(options.over?.({ published, calls, heads }) ?? {}) } as unknown as JudgeGitHub;
  const judge = (input: Partial<JudgeInput> = {}) =>
    runJudge({
      eventName: 'issue_comment',
      event: { action: 'deleted', issue: { number: 13 }, comment: { body: 'Veredicto borrado' } },
      mode: 'on',
      context: 'ai-workflows',
      repository: 'duena/proyecto',
      workflowRef: `duena/proyecto/${JUDGE_PATH}@refs/heads/main`,
      actionRef: 'a'.repeat(40),
      runId: RUN_ID,
      serverUrl: 'https://github.com',
      alsoProtect: [],
      root,
      branches: ['main'],
      ...input,
    } as JudgeInput, { github, fetchObjects: async () => {}, sleep: async () => {} });
  return { ...heads, main, published, calls, judge };
}

const initial = (entry: Published | undefined) => entry?.state === 'pending' && entry.description === JUZGANDO;
const verdicts = (published: readonly Published[]) => published.filter((entry) => entry.description !== JUZGANDO);
const on = (published: readonly Published[], sha: string) => published.filter((entry) => entry.sha === sha);

describe('PLAN-13-R6 §6: «juzgando» on every head before judging', () => {
  it('1. a verdict was deleted and the second read of the pull request fails: first «juzgando», never success, and error at the end', async () => {
    let reads = 0;
    const t = setup({
      prs: (h) => [{ number: 7, head: h.quiet, branch: 'fix/13-docs' }],
      over: () => ({
        pullRequest: async (n: number) => {
          reads += 1;
          if (reads > 1) throw new Error('HTTP 502');
          return { number: n, state: 'open', headSha: t.quiet, headRef: 'fix/13-docs', baseRef: 'main', headRepo: 'duena/proyecto' };
        },
      }),
    });
    await t.judge().catch(() => undefined);
    expect(t.published[0]).toEqual({ sha: t.quiet, context: 'ai-workflows', state: 'pending', description: JUZGANDO });
    expect(t.published.map((entry) => entry.state)).not.toContain('success');
    expect(t.published.at(-1)).toEqual({ sha: t.quiet, context: 'ai-workflows', state: 'error', description: expect.stringContaining('502') });
  });

  it('2. two pull requests and the re-read of the principal fails while judging the first: «juzgando» on both first, error on the first, the second judged', async () => {
    const t = setup({
      over: ({ published }) => ({
        // The head of the principal answers before anything is published (the trusted commit) and
        // after the first pull request got its error; while only the initial pendings are out, it
        // fails (every attempt), which is the re-read before publishing the first verdict.
        branchHead: async () => {
          if (published.length > 0 && published.every((entry) => initial(entry))) throw new Error('HTTP 502 rama principal');
          return t.main;
        },
      }),
    });
    await t.judge().catch(() => undefined);
    expect(t.published.slice(0, 2).every(initial)).toBe(true);
    expect(t.published.slice(0, 2).map((entry) => entry.sha).sort()).toEqual([t.visible, t.quiet].sort());
    expect(verdicts(on(t.published, t.visible))).toEqual([expect.objectContaining({ state: 'error', description: expect.stringContaining('502') })]);
    expect(verdicts(on(t.published, t.quiet))).toEqual([expect.objectContaining({ state: 'success' })]);
  });

  it('3. order: the first N publications are the pendings of the N heads, then the verdicts', async () => {
    const t = setup();
    await t.judge();
    expect(t.published.slice(0, 2).map((entry) => [entry.sha, entry.state, entry.description]).sort()).toEqual(
      [[t.visible, 'pending', JUZGANDO], [t.quiet, 'pending', JUZGANDO]].sort(),
    );
    expect(t.published.slice(2)).toEqual([
      expect.objectContaining({ sha: t.visible, state: 'pending', description: expect.stringContaining('approval') }),
      expect.objectContaining({ sha: t.quiet, state: 'success' }),
    ]);
  });

  it('4. a head whose newest judge status is from a newer official run receives nothing; the other is judged', async () => {
    const t = setup({
      over: ({ heads }) => ({
        statuses: async (sha: string) => sha === heads.visible
          ? [{ context: 'ai-workflows', state: 'success', targetUrl: 'https://github.com/duena/proyecto/actions/runs/200', createdAt: '2026-09-29T12:00:00Z' }]
          : [],
      }),
    });
    await t.judge();
    expect(on(t.published, t.visible)).toEqual([]);
    expect(on(t.published, t.quiet)).toEqual([
      { sha: t.quiet, context: 'ai-workflows', state: 'pending', description: JUZGANDO },
      expect.objectContaining({ sha: t.quiet, state: 'success' }),
    ]);
  });

  it('4b. positive: an older official run on that head does not stop «juzgando»', async () => {
    const t = setup({
      prs: (h) => [{ number: 10, head: h.quiet, branch: 'fix/13-docs' }],
      over: ({ heads }) => ({
        statuses: async (sha: string) => sha === heads.quiet
          ? [{ context: 'ai-workflows', state: 'success', targetUrl: 'https://github.com/duena/proyecto/actions/runs/50', createdAt: '2026-09-29T12:00:00Z' }]
          : [],
      }),
    });
    await t.judge();
    expect(initial(t.published[0])).toBe(true);
  });

  it('5. in advisory, «juzgando» goes only to the advisory status', async () => {
    const t = setup();
    await t.judge({ mode: 'advisory' });
    expect(t.published.length).toBeGreaterThan(0);
    expect(t.published.map((entry) => entry.context)).toEqual(t.published.map(() => 'ai-workflows/advisory'));
    expect(t.published.slice(0, 2).every(initial)).toBe(true);
  });
});

describe('PLAN-13-R6 §6: before the pull requests of the piece are known', () => {
  it('6. the open list cannot be read after three attempts: the run ends with the motive and publishes nothing (declared limit)', async () => {
    const t = setup({
      over: ({ calls }) => ({
        openPullRequests: async () => {
          calls.push('openPullRequests');
          throw new Error('HTTP 502 lista');
        },
      }),
    });
    await expect(t.judge()).rejects.toThrow(/502 lista/);
    expect(t.calls.filter((call) => call === 'openPullRequests')).toHaveLength(3);
    expect(t.published).toEqual([]);
  });

  it('8. the recipe cannot be read after three attempts: «no pude leer la receta» on every open pull request into a branch of the input, none of another branch, no success', async () => {
    const t = setup({
      prs: (h) => [
        { number: 7, head: h.visible, branch: 'feat/13-boton' },
        { number: 8, head: h.quiet, branch: 'feat/14-otra', base: 'staging' },
        { number: 9, head: 'd'.repeat(40), branch: 'feat/13-fuera', base: 'develop' },
      ],
      over: ({ calls }) => ({
        branchHead: async (branch: string) => {
          calls.push(`branchHead ${branch}`);
          throw new Error('HTTP 502 rama principal');
        },
      }),
    });
    await expect(t.judge({ branches: ['main', 'staging'] })).rejects.toThrow();
    expect(t.calls.filter((call) => call.startsWith('branchHead'))).toHaveLength(3);
    expect(t.published.map((entry) => entry.sha).sort()).toEqual([t.visible, t.quiet].sort());
    for (const entry of t.published) {
      expect(entry).toEqual({ sha: entry.sha, context: 'ai-workflows', state: 'pending', description: expect.stringContaining('no pude leer la receta') });
    }
  });

  it('8b. the broad pending keeps the guard: a head with a newer official run receives nothing', async () => {
    const t = setup({
      over: ({ heads }) => ({
        branchHead: async () => {
          throw new Error('HTTP 502 rama principal');
        },
        statuses: async (sha: string) => sha === heads.visible
          ? [{ context: 'ai-workflows', state: 'success', targetUrl: 'https://github.com/duena/proyecto/actions/runs/200', createdAt: '2026-09-29T12:00:00Z' }]
          : [],
      }),
    });
    await t.judge().catch(() => undefined);
    expect(on(t.published, t.visible)).toEqual([]);
    expect(on(t.published, t.quiet)).toEqual([expect.objectContaining({ state: 'pending', description: expect.stringContaining('no pude leer la receta') })]);
  });

  it('9. the initial pending of the first of two pull requests cannot be published: it gets no verdict, the second is judged, and the run fails naming the first', async () => {
    const attempts: Published[] = [];
    const t = setup({
      over: ({ published, heads }) => ({
        publishStatus: async (sha: string, status: { context: string; state: string; description: string }) => {
          const entry = { sha, context: status.context, state: status.state, description: status.description };
          attempts.push(entry);
          if (sha === heads.visible && initial(entry)) throw new Error('HTTP 502 al publicar');
          published.push(entry);
        },
      }),
    });
    await expect(t.judge()).rejects.toThrow(/#7\b/);
    expect(on(attempts, t.visible)).toEqual([expect.objectContaining({ state: 'pending', description: JUZGANDO })]);
    expect(on(t.published, t.quiet)).toEqual([
      expect.objectContaining({ state: 'pending', description: JUZGANDO }),
      expect.objectContaining({ state: 'success' }),
    ]);
  });

  it('10. the open list fails twice and answers the third time: judged normally', async () => {
    let failures = 0;
    const t = setup({
      prs: (h) => [{ number: 10, head: h.quiet, branch: 'fix/13-docs' }],
      over: ({ calls, heads }) => ({
        openPullRequests: async () => {
          calls.push('openPullRequests');
          if (failures < 2) {
            failures += 1;
            throw new Error('HTTP 502 lista');
          }
          return [{ number: 10, headRef: 'fix/13-docs', headSha: heads.quiet, baseRef: 'main' }];
        },
      }),
    });
    await t.judge();
    expect(t.calls.filter((call) => call === 'openPullRequests')).toHaveLength(3);
    expect(verdicts(t.published)).toEqual([expect.objectContaining({ sha: t.quiet, state: 'success' })]);
  });

  // PLAN-13-R6 §15 (flock of slice 6): the guard (c) at publishing time on the issue path was
  // untested; only the guard before the initial pending was. A guard: it passes today.
  it('11. a newer official run publishes on a head after the initial pending: that pull request gets no verdict; the other is judged', async () => {
    const t = setup({
      over: ({ published, heads }) => ({
        statuses: async (sha: string) => sha === heads.visible && published.some((entry) => entry.sha === sha && initial(entry))
          ? [{ context: 'ai-workflows', state: 'pending', targetUrl: 'https://github.com/duena/proyecto/actions/runs/200', createdAt: '2026-09-29T12:00:00Z' }]
          : [],
      }),
    });
    await t.judge();
    expect(on(t.published, t.visible)).toEqual([{ sha: t.visible, context: 'ai-workflows', state: 'pending', description: JUZGANDO }]);
    expect(verdicts(on(t.published, t.quiet))).toEqual([expect.objectContaining({ state: 'success' })]);
  });

  it('10b. the head of the principal fails twice and answers the third time: judged normally', async () => {
    let failures = 0;
    const t = setup({
      prs: (h) => [{ number: 10, head: h.quiet, branch: 'fix/13-docs' }],
      over: () => ({
        branchHead: async () => {
          if (failures < 2) {
            failures += 1;
            throw new Error('HTTP 502 rama principal');
          }
          return t.main;
        },
      }),
    });
    await t.judge();
    expect(verdicts(t.published)).toEqual([expect.objectContaining({ sha: t.quiet, state: 'success' })]);
  });
});
