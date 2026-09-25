import { afterEach, describe, expect, it } from 'vitest';

import { runJudge, type JudgeGitHub } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// Review of the flock, part 5 (PLAN-13-R5 §2.6): the judgement woken by a comment on the piece's
// issue must keep the guarantees every other judgement has before publishing (PLAN-13-R3 §3.8):
// (b) a main that moved while judging is judged again with its recipe, (c) a newer official run
// that already published on that head wins. And a read that fails is never a quiet green: the run
// fails, and a pull request whose head is known gets its error status.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
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
const EVENT = { action: 'created', issue: { number: 13 }, comment: { body: 'Veredicto\n\n<!-- ai-workflows:event {"type":"verdict"} -->' } };
const JUDGE_PATH = '.github/workflows/ai-workflows.yml';

function setup(over: Partial<JudgeGitHub> = {}) {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'app/page.tsx': 'uno\n' });
  write(root, 'app/page.tsx', 'dos\n');
  const head = commit(root, 'visible');
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  write(root, 'README.md', 'la principal avanzó\n');
  const movedMain = commit(root, 'main avanza');
  git(root, 'reset', '-q', '--hard', main);
  const published: { sha: string; state: string; description: string }[] = [];
  const fetched: string[][] = [];
  const github = {
    defaultBranch: async () => 'main',
    branchHead: async () => main,
    pullRequest: async (n: number) => ({ number: n, state: 'open', headSha: head, headRef: 'feat/13-boton', baseRef: 'main', headRepo: 'duena/proyecto' }),
    openPullRequestsWithHead: async () => [7],
    openPullRequests: async () => [{ number: 7, headRef: 'feat/13-boton', headSha: head, baseRef: 'main' }],
    mergeQueue: async () => [],
    comments: async () => [],
    issueComments: async () => [],
    reviews: async () => [],
    checkRuns: async () => [],
    statuses: async () => [],
    workflowRun: async (id: number) => ({ path: JUDGE_PATH, event: 'pull_request_target', headBranch: 'main', id }),
    forcePushedHeads: async () => [],
    publishStatus: async (sha: string, status: { state: string; description: string }) => {
      published.push({ sha, state: status.state, description: status.description });
    },
    upsertTraceComment: async () => {},
    ...over,
  } as unknown as JudgeGitHub;
  const judge = () =>
    runJudge({
      eventName: 'issue_comment',
      event: EVENT,
      mode: 'on',
      context: 'ai-workflows',
      repository: 'duena/proyecto',
      workflowRef: `duena/proyecto/${JUDGE_PATH}@refs/heads/main`,
      actionRef: 'a'.repeat(40),
      runId: 100,
      serverUrl: 'https://github.com',
      alsoProtect: [],
      root,
    }, {
      github,
      fetchObjects: async (shas) => {
        fetched.push(shas);
      },
    });
  return { head, main, movedMain, published, fetched, judge };
}

describe('the judgement from the issue keeps the guarantees of §3.8', () => {
  it('(c) a newer official run that already published on that head wins: this run stays quiet', async () => {
    const t = setup({
      statuses: async () => [{ context: 'ai-workflows', state: 'failure', targetUrl: 'https://github.com/duena/proyecto/actions/runs/200', createdAt: '2026-09-25T12:00:00Z' }],
    } as Partial<JudgeGitHub>);
    await t.judge();
    expect(t.published).toEqual([]);
  });

  it('an older official run does not silence it', async () => {
    const t = setup({
      statuses: async () => [{ context: 'ai-workflows', state: 'success', targetUrl: 'https://github.com/duena/proyecto/actions/runs/50', createdAt: '2026-09-25T12:00:00Z' }],
    } as Partial<JudgeGitHub>);
    await t.judge();
    expect(t.published.map((entry) => entry.sha)).toEqual([t.head]);
  });

  it('(b) a main that moved while judging is judged again from the new main before publishing', async () => {
    let reads = 0;
    const holder: { moved?: string } = {};
    const t = setup({
      branchHead: async () => {
        reads += 1;
        return reads === 1 ? tMain() : holder.moved ?? '';
      },
    } as Partial<JudgeGitHub>);
    function tMain() {
      return t.main;
    }
    holder.moved = t.movedMain;
    await t.judge();
    expect(t.fetched.flat()).toContain(t.movedMain);
    expect(t.published.map((entry) => entry.sha)).toEqual([t.head]);
  });
});

describe('a read that fails in the judgement from the issue is never a quiet green', () => {
  it('the recipe of main cannot be read: the run fails', async () => {
    const t = setup();
    const bad = setup({ branchHead: async () => 'f'.repeat(40) } as Partial<JudgeGitHub>);
    void t;
    await expect(bad.judge()).rejects.toThrow();
    expect(bad.published).toEqual([]);
  });

  it('the open pull requests cannot be read: the run fails', async () => {
    const t = setup({ openPullRequests: async () => { throw new Error('HTTP 502'); } } as Partial<JudgeGitHub>);
    await expect(t.judge()).rejects.toThrow(/502/);
    expect(t.published).toEqual([]);
  });

  it('a pull request that cannot be re-read gets an error status on the head already known', async () => {
    const t = setup({ pullRequest: async () => { throw new Error('HTTP 502 al releer'); } } as Partial<JudgeGitHub>);
    await t.judge().catch(() => undefined);
    expect(t.published).toEqual([expect.objectContaining({ sha: t.head, state: 'error' })]);
  });

  // Round 2: the statuses cannot be read before publishing (§3.8 c cannot be decided): no verdict is
  // published on top of what may be a newer one, the head gets its error, and the run fails.
  it('statuses that cannot be read: no verdict, an error on the head, and the run fails', async () => {
    const t = setup({ statuses: async () => { throw new Error('HTTP 502 al leer estados'); } } as Partial<JudgeGitHub>);
    await expect(t.judge()).rejects.toThrow(/502/);
    expect(t.published.map((entry) => entry.state)).not.toContain('success');
    expect(t.published.map((entry) => entry.state)).not.toContain('pending');
    expect(t.published).toEqual([expect.objectContaining({ sha: t.head, state: 'error' })]);
  });

  it('a verdict that cannot be published makes the run fail after the other pull requests were judged', async () => {
    const other = 'd'.repeat(40);
    const seen: string[] = [];
    const t = setup({
      openPullRequests: async () => [
        { number: 7, headRef: 'feat/13-boton', headSha: 'e'.repeat(40), baseRef: 'main' },
        { number: 8, headRef: 'fix/13-otra', headSha: other, baseRef: 'main' },
      ],
      pullRequest: async (n: number) => ({ number: n, state: 'open', headSha: n === 7 ? 'e'.repeat(40) : other, headRef: n === 7 ? 'feat/13-boton' : 'fix/13-otra', baseRef: 'main', headRepo: 'duena/proyecto' }),
      publishStatus: async (sha: string) => {
        seen.push(sha);
        if (sha === 'e'.repeat(40)) throw new Error('no se pudo publicar');
      },
    } as Partial<JudgeGitHub>);
    await expect(t.judge()).rejects.toThrow(/publicar/);
    expect(seen).toContain(other);
  });

  it('an error status that cannot be published for one pull request does not stop the others', async () => {
    const other = 'd'.repeat(40);
    let first = true;
    const published: string[] = [];
    const t = setup({
      openPullRequests: async () => [
        { number: 7, headRef: 'feat/13-boton', headSha: 'e'.repeat(40), baseRef: 'main' },
        { number: 8, headRef: 'fix/13-otra', headSha: other, baseRef: 'main' },
      ],
      pullRequest: async (n: number) => {
        if (n === 7) throw new Error('HTTP 502 al releer');
        return { number: n, state: 'open', headSha: other, headRef: 'fix/13-otra', baseRef: 'main', headRepo: 'duena/proyecto' };
      },
      publishStatus: async (sha: string, status: { state: string }) => {
        if (first && status.state === 'error') {
          first = false;
          throw new Error('no se pudo publicar');
        }
        published.push(`${sha}:${status.state}`);
      },
    } as Partial<JudgeGitHub>);
    await t.judge().catch(() => undefined);
    expect(published.some((entry) => entry.startsWith(other))).toBe(true);
  });
});
