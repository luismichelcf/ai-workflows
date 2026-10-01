import { describe, expect, it } from 'vitest';

import { createJudgeGitHub, type GhRun } from '../src/index.js';
import { requireCheck } from '../src/judge/checks.js';
import type { CheckRunSummary, CommitStatus, JudgeGitHub } from '../src/judge/port.js';

// PLAN-13-R6 §7: a required check with a borrowed name. For the engine's red test
// (`ai-workflows/red-test`) a check-run counts only when THAT check-run is tied to a job of the
// official red-test workflow, run for this pull request and its current base:
//   1. the check-run belongs to the `github-actions` app and carries its check suite id;
//   2. the Actions runs of that check suite are exactly one, and its `head_sha` is the judged SHA;
//   3. the jobs of that run (every page, every attempt) include one whose `check_run_url` ends in
//      `/check-runs/<id of the check-run>`;
//   4. the workflow read by the run's `workflow_id` has EXACTLY the path of the red-test workflow
//      (no suffix is cut), and that file exists in the trusted base;
//   5. a `pull_request` run lists this pull request with `base.ref` equal to the judged base and a
//      `base.sha` that is the tip of that base or an ancestor of it; a `merge_group` run has the
//      group's SHA as its head (point 2).
// Among the check-runs of that name, the most recent one that passes the chain decides; the rest
// are ignored and noted. A chain that cannot be read waits (never green). A commit status named
// `ai-workflows/red-test` no longer counts. The project's checks keep today's rule (any app, check
// run or status), and the note says where the one that counted came from.
//
// Interface fixed by these tests (for the builder):
// - `CheckRunSummary.checkSuiteId?: number` — `check_suite.id` of the check-run.
// - `JudgeGitHub.checkSuiteRuns(checkSuiteId: number): Promise<ActionsRunSummary[]>`
//     GET repos/{repo}/actions/runs?check_suite_id=<id>
//     ActionsRunSummary = { id: number; headSha: string; event: string; workflowId: number;
//                           path: string; pullRequests: { number: number; baseRef: string; baseSha: string }[] }
// - `JudgeGitHub.workflowRunJobs(runId: number): Promise<{ id: number; checkRunUrl: string }[]>`
//     GET repos/{repo}/actions/runs/<id>/jobs?filter=all, with --paginate --slurp
// - `JudgeGitHub.workflowById(workflowId: number): Promise<{ path: string }>`
//     GET repos/{repo}/actions/workflows/<id>
// - `requireCheck(github, sha, name, locale, origin?: CheckOrigin)` in src/judge/checks.ts, with
//     CheckOrigin = {
//       event: 'pull_request' | 'merge_group';   // what the judged SHA is
//       pr: number;                              // the pull request being judged
//       baseRef: string;                         // the base branch it is judged against
//       baseSha: string;                         // the trusted tip of that base
//       isAncestorOfBase(sha: string): Promise<boolean>;  // sha is the tip or an ancestor of it (git)
//       existsInBase(path: string): Promise<boolean>;     // the file is in the trusted tree (git)
//     }
//   The judge builds it for every stage it judges; git answers the two questions (external edge).
// - `CheckOutcome.note` carries the trace: the ignored check-runs (naming their id) and, for a
//   project check, where the one that counted came from (the app, or that it was a commit status).

const RED = 'ai-workflows/red-test';
const OFFICIAL = '.github/workflows/ai-workflows-red-test.yml';
const IMPOSTOR = '.github/workflows/impostor.yml';
const REPO = 'duena/proyecto';
const HEAD = 'c'.repeat(40);
const TIP = 'b'.repeat(40);
const OLD_BASE = 'a'.repeat(40);
const REWRITTEN = 'e'.repeat(40);
const OFFICIAL_WF = 1;
const IMPOSTOR_WF = 2;

interface RunChain {
  readonly event?: string;
  readonly headSha?: string;
  readonly workflowId?: number;
  readonly path?: string;
  readonly pullRequests?: { number: number; baseRef: string; baseSha: string }[];
  /** The check-run ids the run's jobs point to; by default, the check-run itself. */
  readonly jobsPointTo?: number[];
  /** How many runs the check suite lists; by default one. */
  readonly runCount?: number;
}

function fake() {
  const byName = new Map<string, CheckRunSummary[]>();
  const suites = new Map<number, unknown[] | Error>();
  const jobs = new Map<number, unknown[] | Error>();
  const workflows = new Map<number, { path: string } | Error>([
    [OFFICIAL_WF, { path: OFFICIAL }],
    [IMPOSTOR_WF, { path: IMPOSTOR }],
  ]);
  const statuses: CommitStatus[] = [];
  const github = {
    checkRuns: async (sha: string, name: string) => (sha === HEAD ? [...(byName.get(name) ?? [])] : []),
    statuses: async (sha: string) => (sha === HEAD ? [...statuses] : []),
    checkSuiteRuns: async (id: number) => {
      const answer = suites.get(id) ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    workflowRunJobs: async (id: number) => {
      const answer = jobs.get(id) ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    workflowById: async (id: number) => {
      const answer = workflows.get(id);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`HTTP 404 workflow ${id}`);
      return answer;
    },
  } as unknown as JudgeGitHub;

  /** A check-run of `name` with its Actions chain; by default, the official red test of PR #7 into main. */
  const add = (
    id: number,
    status: string,
    conclusion: string | null,
    chain: RunChain = {},
    options: { name?: string; app?: string } = {},
  ): { suite: number; run: number } => {
    const name = options.name ?? RED;
    const suite = id + 1000;
    const run = id + 2000;
    const list = byName.get(name) ?? [];
    list.push({ id, checkSuiteId: suite, status, conclusion, app: options.app ?? 'github-actions', url: null } as CheckRunSummary);
    byName.set(name, list);
    const one = {
      id: run,
      headSha: chain.headSha ?? HEAD,
      event: chain.event ?? 'pull_request',
      workflowId: chain.workflowId ?? OFFICIAL_WF,
      path: chain.path ?? `${OFFICIAL}@refs/pull/7/merge`,
      pullRequests: chain.pullRequests ?? [{ number: 7, baseRef: 'main', baseSha: TIP }],
    };
    const count = chain.runCount ?? 1;
    suites.set(suite, Array.from({ length: count }, (_, index) => ({ ...one, id: run + index * 10000 })));
    jobs.set(run, (chain.jobsPointTo ?? [id]).map((target, index) => ({
      id: run * 10 + index,
      checkRunUrl: `https://api.github.com/repos/${REPO}/check-runs/${target}`,
    })));
    return { suite, run };
  };
  return { github, add, suites, jobs, workflows, statuses };
}

const origin = (over: Record<string, unknown> = {}) => ({
  event: 'pull_request' as const,
  pr: 7,
  baseRef: 'main',
  baseSha: TIP,
  isAncestorOfBase: async (sha: string) => sha === TIP || sha === OLD_BASE,
  existsInBase: async (path: string) => path === OFFICIAL,
  ...over,
});

const judge = (github: JudgeGitHub, over: Record<string, unknown> = {}, name = RED) =>
  requireCheck(github, HEAD, name, 'es', origin(over) as never);

describe('PLAN-13-R6 §7: the red test counts only through its chain', () => {
  it('control: the official check-run, tied to its job, of this PR and its base, counts', async () => {
    const f = fake();
    f.add(10, 'completed', 'success');
    expect((await judge(f.github)).outcome).toBe('passed');
  });

  it('1. an official failure and a newer green impostor from a workflow that is not the red test: the official one counts', async () => {
    const f = fake();
    f.add(10, 'completed', 'failure');
    f.add(12, 'completed', 'success', { workflowId: IMPOSTOR_WF, path: IMPOSTOR });
    const result = await judge(f.github);
    expect(result.outcome).toBe('rejected');
    // The ignored check-run is noted in the run's log.
    expect(result.note ?? '').toContain('12');
  });

  it('1. only the impostor: waits', async () => {
    const f = fake();
    f.add(12, 'completed', 'success', { workflowId: IMPOSTOR_WF, path: IMPOSTOR });
    expect((await judge(f.github)).outcome).toBe('waiting');
  });

  it('1. the official path, but the file does not exist in the trusted base: waits', async () => {
    const f = fake();
    f.add(10, 'completed', 'success');
    expect((await judge(f.github, { existsInBase: async () => false })).outcome).toBe('waiting');
  });

  it('2. a check-run of another app with the same name does not count', async () => {
    const alone = fake();
    alone.add(12, 'completed', 'success', {}, { app: 'otra-app' });
    expect((await judge(alone.github)).outcome).toBe('waiting');

    const withOfficial = fake();
    withOfficial.add(10, 'completed', 'failure');
    withOfficial.add(12, 'completed', 'success', {}, { app: 'otra-app' });
    expect((await judge(withOfficial.github)).outcome).toBe('rejected');
  });

  it('3. a newer check-run whose run is the official workflow, but no job of that run points to it, does not count', async () => {
    const f = fake();
    f.add(10, 'completed', 'failure');
    f.add(12, 'completed', 'success', { jobsPointTo: [99, 112] });
    expect((await judge(f.github)).outcome).toBe('rejected');

    const alone = fake();
    alone.add(12, 'completed', 'success', { jobsPointTo: [99, 112] });
    expect((await judge(alone.github)).outcome).toBe('waiting');
  });

  it('2 of the chain: a check suite with no run, or with two, or whose run has another head, does not count', async () => {
    for (const chain of [{ runCount: 0 }, { runCount: 2 }, { headSha: 'd'.repeat(40) }] as RunChain[]) {
      const f = fake();
      f.add(10, 'completed', 'success', chain);
      expect((await judge(f.github)).outcome, JSON.stringify(chain)).toBe('waiting');
    }
  });

  it('a check-run without its check suite cannot be tied: it does not count', async () => {
    const f = fake();
    f.add(10, 'completed', 'success');
    const list = await f.github.checkRuns(HEAD, RED);
    const withoutSuite = list.map(({ checkSuiteId: _drop, ...rest }) => rest);
    const github = { ...f.github, checkRuns: async () => withoutSuite } as unknown as JudgeGitHub;
    expect((await judge(github)).outcome).toBe('waiting');
  });

  const failing: [string, (f: ReturnType<typeof fake>, ids: { suite: number; run: number }) => Record<string, unknown>][] = [
    ['the runs of the check suite', (f, ids) => { f.suites.set(ids.suite, new Error('HTTP 502 corridas')); return {}; }],
    ['the jobs of the run', (f, ids) => { f.jobs.set(ids.run, new Error('HTTP 502 jobs')); return {}; }],
    ['the workflow of the run', (f) => { f.workflows.set(OFFICIAL_WF, new Error('HTTP 502 workflow')); return {}; }],
    ['the ancestry of the base', () => ({ isAncestorOfBase: async () => { throw new Error('HTTP 502 git merge-base'); } })],
    ['the trusted tree', () => ({ existsInBase: async () => { throw new Error('HTTP 502 git cat-file'); } })],
  ];
  for (const [what, breakIt] of failing) {
    it(`4. reading ${what} fails: waits, with the motive, never green`, async () => {
      const f = fake();
      const ids = f.add(10, 'completed', 'success');
      const over = breakIt(f, ids);
      const result = await judge(f.github, over);
      expect(result.outcome).toBe('waiting');
      expect(result.reason ?? '').toContain('HTTP 502');
    });
  }

  it('5. a commit status ai-workflows/red-test in success and no check-run: waits', async () => {
    const f = fake();
    f.statuses.push({ context: RED, state: 'success', targetUrl: null, createdAt: '2026-09-29T12:00:00Z' });
    expect((await judge(f.github)).outcome).toBe('waiting');
  });

  it('5. a commit status todo-verde in success for a project check counts, and the note says it was a status', async () => {
    const f = fake();
    f.statuses.push({ context: 'todo-verde', state: 'success', targetUrl: null, createdAt: '2026-09-29T12:00:00Z' });
    const result = await judge(f.github, {}, 'todo-verde');
    expect(result.outcome).toBe('passed');
    expect(result.note ?? '').toMatch(/todo-verde/);
    expect(result.note ?? '').toMatch(/estado/i);
  });

  it('5c. control: a project check published as a check-run by another app (not Actions) in success counts, and the note names the app', async () => {
    const f = fake();
    f.add(30, 'completed', 'success', {}, { name: 'todo-verde', app: 'vercel' });
    f.suites.set(1030, new Error('an app that is not Actions has no Actions run'));
    const result = await judge(f.github, {}, 'todo-verde');
    expect(result.outcome).toBe('passed');
    expect(result.note ?? '').toContain('vercel');
  });

  // The run for main is the newest check-run (22: a re-run of the old attempt), so only the chain,
  // not the order, can tell it is for another base.
  it('5b. the newest red test of this PR was for main and the PR now targets staging; the staging one is still running: waits', async () => {
    const f = fake();
    f.add(21, 'in_progress', null, { pullRequests: [{ number: 7, baseRef: 'staging', baseSha: TIP }] });
    f.add(22, 'completed', 'success', { pullRequests: [{ number: 7, baseRef: 'main', baseSha: TIP }] });
    expect((await judge(f.github, { baseRef: 'staging' })).outcome).toBe('waiting');
  });

  it('5b. and when the staging one ends in failure, failure counts', async () => {
    const f = fake();
    f.add(21, 'completed', 'failure', { pullRequests: [{ number: 7, baseRef: 'staging', baseSha: TIP }] });
    f.add(22, 'completed', 'success', { pullRequests: [{ number: 7, baseRef: 'main', baseSha: TIP }] });
    expect((await judge(f.github, { baseRef: 'staging' })).outcome).toBe('rejected');
  });

  it('5b. only the run for the old base: waits', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { pullRequests: [{ number: 7, baseRef: 'main', baseSha: TIP }] });
    expect((await judge(f.github, { baseRef: 'staging' })).outcome).toBe('waiting');
  });

  it('a run of another pull request does not count', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { pullRequests: [{ number: 8, baseRef: 'main', baseSha: TIP }] });
    expect((await judge(f.github)).outcome).toBe('waiting');
  });

  it('a pull request from a fork (the run lists no pull request) waits, saying the red test cannot be tied to this PR', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { pullRequests: [] });
    const result = await judge(f.github);
    expect(result.outcome).toBe('waiting');
    expect(result.reason ?? '').toContain('no se puede atar la prueba roja a este PR');
  });

  it('5d. base.sha an ancestor of the current tip counts', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { pullRequests: [{ number: 7, baseRef: 'main', baseSha: OLD_BASE }] });
    expect((await judge(f.github)).outcome).toBe('passed');
  });

  it('5d. base.sha that is not an ancestor (the base was rewritten) waits, with the motive', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { pullRequests: [{ number: 7, baseRef: 'main', baseSha: REWRITTEN }] });
    const result = await judge(f.github);
    expect(result.outcome).toBe('waiting');
    expect(result.reason ?? '').not.toBe('');
  });

  it('5e. the run path has a ref suffix and the workflow of its workflow_id is the official one: counts', async () => {
    const f = fake();
    f.add(20, 'completed', 'success', { path: `${OFFICIAL}@refs/heads/feat/13-x` });
    expect((await judge(f.github)).outcome).toBe('passed');
  });

  it('5e. the workflow of its workflow_id is ai-workflows-red-test.yml@falso.yml: does not count, although the cut run path would match', async () => {
    const f = fake();
    const trap = `${OFFICIAL}@falso.yml`;
    f.workflows.set(3, { path: trap });
    f.add(20, 'completed', 'success', { workflowId: 3, path: trap });
    // Every file exists in the base here: only the exact path of the workflow can refuse it.
    expect((await judge(f.github, { existsInBase: async () => true })).outcome).toBe('waiting');
  });

  it('merge group: a merge_group run on the group SHA counts; a pull_request run does not', async () => {
    const group = fake();
    group.add(20, 'completed', 'success', { event: 'merge_group', pullRequests: [] });
    expect((await judge(group.github, { event: 'merge_group' })).outcome).toBe('passed');

    const prRun = fake();
    prRun.add(20, 'completed', 'success');
    expect((await judge(prRun.github, { event: 'merge_group' })).outcome).toBe('waiting');
  });
});

// ---------------------------------------------------------------------------------------------
// The port: three new reads, over `gh` (the external edge is the runner).

type Answer = GhRun | ((args: readonly string[]) => GhRun);

function fakeGh(routes: [RegExp, Answer][]) {
  const calls: (readonly string[])[] = [];
  const runner = async (args: readonly string[]): Promise<GhRun> => {
    calls.push(args);
    const joined = args.join(' ');
    for (const [pattern, answer] of routes) {
      if (pattern.test(joined)) return typeof answer === 'function' ? answer(args) : answer;
    }
    return { exitCode: 1, stdout: '', stderr: `no route for: ${joined}` };
  };
  return { runner, calls };
}

const ok = (value: unknown): GhRun => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
const failed: GhRun = { exitCode: 1, stdout: '', stderr: 'HTTP 502' };
/** Answers a list as pages when asked for `--slurp`, or as the single object otherwise. */
const pages = (...list: unknown[]) => (args: readonly string[]): GhRun => ok(args.includes('--slurp') ? list : list[0]);

const rawRun = {
  id: 900,
  head_sha: HEAD,
  event: 'pull_request',
  workflow_id: 4,
  path: `${OFFICIAL}@refs/pull/7/merge`,
  pull_requests: [{ number: 7, base: { ref: 'main', sha: TIP, repo: { name: 'proyecto' } }, head: { ref: 'feat/13-x', sha: HEAD } }],
};

describe('PLAN-13-R6 §7: the port reads the chain', () => {
  const port = (routes: [RegExp, Answer][]) => {
    const gh = fakeGh(routes);
    return { gh, github: createJudgeGitHub({ repository: REPO, runner: gh.runner }) as JudgeGitHub & Record<string, any> };
  };

  it('checkRuns keeps the check suite id of each check-run', async () => {
    const { github } = port([[/check-runs/, ok([{ check_runs: [{ id: 101, name: RED, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, html_url: null, check_suite: { id: 77 } }] }])]]);
    expect(await github.checkRuns(HEAD, RED)).toEqual([
      { id: 101, checkSuiteId: 77, status: 'completed', conclusion: 'success', app: 'github-actions', url: null },
    ]);
  });

  it('checkSuiteRuns lists the Actions runs of one check suite, with head, event, workflow id, path and pull requests', async () => {
    const { gh, github } = port([[/actions\/runs\?/, pages({ total_count: 1, workflow_runs: [rawRun] })]]);
    expect(await github.checkSuiteRuns(55)).toEqual([
      { id: 900, headSha: HEAD, event: 'pull_request', workflowId: 4, path: `${OFFICIAL}@refs/pull/7/merge`, pullRequests: [{ number: 7, baseRef: 'main', baseSha: TIP }] },
    ]);
    const joined = gh.calls[0]?.join(' ') ?? '';
    expect(joined).toContain(`repos/${REPO}/actions/runs?`);
    expect(joined).toMatch(/check_suite_id=55\b/);
  });

  it('checkSuiteRuns throws on a failed call or a run without its head or workflow id', async () => {
    await expect(port([[/actions\/runs\?/, failed]]).github.checkSuiteRuns(55)).rejects.toThrow();
    const { head_sha: _head, ...noHead } = rawRun;
    await expect(port([[/actions\/runs\?/, pages({ workflow_runs: [noHead] })]]).github.checkSuiteRuns(55)).rejects.toThrow();
    const { workflow_id: _wf, ...noWorkflow } = rawRun;
    await expect(port([[/actions\/runs\?/, pages({ workflow_runs: [noWorkflow] })]]).github.checkSuiteRuns(55)).rejects.toThrow();
  });

  it('workflowRunJobs reads every page of every attempt, with the check-run url of each job', async () => {
    const { gh, github } = port([[/actions\/runs\/900\/jobs/, pages(
      { total_count: 2, jobs: [{ id: 1, check_run_url: `https://api.github.com/repos/${REPO}/check-runs/10` }] },
      { total_count: 2, jobs: [{ id: 2, check_run_url: `https://api.github.com/repos/${REPO}/check-runs/11` }] },
    )]]);
    expect(await github.workflowRunJobs(900)).toEqual([
      { id: 1, checkRunUrl: `https://api.github.com/repos/${REPO}/check-runs/10` },
      { id: 2, checkRunUrl: `https://api.github.com/repos/${REPO}/check-runs/11` },
    ]);
    const args = gh.calls[0] ?? [];
    expect(args.join(' ')).toMatch(/filter=all/);
    expect(args).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  });

  it('workflowRunJobs throws on a failed call or a job without its check-run url', async () => {
    await expect(port([[/jobs/, failed]]).github.workflowRunJobs(900)).rejects.toThrow();
    await expect(port([[/jobs/, pages({ jobs: [{ id: 1 }] })]]).github.workflowRunJobs(900)).rejects.toThrow();
  });

  it('workflowById reads the exact path of the workflow file', async () => {
    const { gh, github } = port([[/actions\/workflows\/4\b/, ok({ id: 4, path: `${OFFICIAL}@falso.yml`, name: 'x' })]]);
    expect(await github.workflowById(4)).toEqual({ path: `${OFFICIAL}@falso.yml` });
    expect(gh.calls[0]?.join(' ')).toContain(`repos/${REPO}/actions/workflows/4`);
  });

  it('workflowById throws on a failed call or a workflow without its path', async () => {
    await expect(port([[/workflows/, failed]]).github.workflowById(4)).rejects.toThrow();
    await expect(port([[/workflows/, ok({ id: 4 })]]).github.workflowById(4)).rejects.toThrow();
  });
});

// PLAN-13-R6 §15 (the flock of slice 6): mutants of the chain that survived. They pass today and
// must keep passing: only `success` is green, the newest official run decides, and a job ties to
// its own check-run id only.
describe('flock 6: guards on the red-test chain', () => {
  for (const conclusion of ['skipped', 'cancelled']) {
    it(`an official check-run that ended ${conclusion} is rejected, never green`, async () => {
      const f = fake();
      f.add(10, 'completed', conclusion);
      expect((await judge(f.github)).outcome).toBe('rejected');
    });
  }

  it('two official runs, the newest failed: rejected', async () => {
    const f = fake();
    f.add(10, 'completed', 'success');
    f.add(20, 'completed', 'failure');
    expect((await judge(f.github)).outcome).toBe('rejected');
  });

  it('two official runs, the newest passed: passed', async () => {
    const f = fake();
    f.add(10, 'completed', 'failure');
    f.add(20, 'completed', 'success');
    expect((await judge(f.github)).outcome).toBe('passed');
  });

  it('the newest decides whatever order GitHub lists them in', async () => {
    const f = fake();
    f.add(20, 'completed', 'failure');
    f.add(10, 'completed', 'success');
    expect((await judge(f.github)).outcome).toBe('rejected');
  });

  it('a job whose check_run_url ends in /check-runs/1234 does not tie check-run 123: waits', async () => {
    const f = fake();
    f.add(123, 'completed', 'success', { jobsPointTo: [1234] });
    expect((await judge(f.github)).outcome).toBe('waiting');
  });
});
