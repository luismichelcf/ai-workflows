import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runJudge, type JudgeGitHub, type JudgeInput, type PullRequestComment } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R3 §3 and §4: the judge. Git is real (a temporary repository plays the checkout of the
// trusted commit, and already holds every object a pull request would bring); GitHub is the
// external edge, replaced by a fake port that records what the judge publishes. Every case
// checks the state published and where, the motive, and what did not happen — with its positive.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const REPO = 'duena/proyecto';
const RUN = 111;
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
const WORKFLOW = '.github/workflows/ai-workflows.yml';
const RED_WORKFLOW = '.github/workflows/ai-workflows-red-test.yml';
const ACTION_REF = 'a'.repeat(40);
const OWNER = 'duena';

// A command that leaves a mark if anything ever runs it: the judge never runs a suite (SV-01).
const MARKER = 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", "ran");\n';

const RECIPE = lines(
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  'classify:',
  '  visible: ["app/**"]',
  'kinds:',
  '  names: [behavior, visual-only, docs]',
  '  default: behavior',
  '  from-paths: { docs: ["docs/**"] }',
  'labels:',
  '  behavior: "comportamiento"',
  '  visual-only: "solo visual"',
  'pieces:',
  '  branch: ["*/{piece}", "*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  '  declared-kind:',
  '    file: "docs/plans/PLAN-{piece}.md"',
  '    line: "Tipo de cambio"',
  'stages:',
  '  - id: spec',
  '    summary: "Un plan con su resumen"',
  '    nature: structure',
  '    gate:',
  '      uses: ai-workflows/spec-structure@1',
  '      with: { file: "docs/plans/PLAN-{piece}.md", sections: ["En tres líneas"] }',
  '    server: recompute',
  '  - id: red-test',
  '    summary: "Primero una prueba que falla"',
  '    after: spec',
  '    nature: execution-record',
  '    applies-if: { kind-any: [behavior] }',
  '    valid-while: forever',
  '    gate:',
  '      uses: ai-workflows/red-test@1',
  '      with: { command: "node ran.mjs {tests}" }',
  '    server: { require-check: ai-workflows/red-test }',
  '  - id: checks',
  '    summary: "Todas las pruebas en verde"',
  '    after: red-test',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/command@1',
  '      with: { command: "node ran.mjs" }',
  '    server: { require-check: todo-verde }',
  '  - id: owner-approval',
  '    summary: "La dueña aprueba lo que se ve"',
  '    after: checks',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    valid-while: same-fingerprint',
  '    gate:',
  '      uses: ai-workflows/approval-comment@1',
  '      with: { command: /visto-bueno }',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: owner-approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const PLAN = (kind: string) => lines('# Plan 13', '', '## En tres líneas', '', 'Qué pasa, qué cambia, por qué.', '', `Tipo de cambio: ${kind}`);

// ---------------------------------------------------------------------------------------------
// The fake GitHub port

interface Published {
  readonly sha: string;
  readonly context: string;
  readonly state: string;
  readonly description: string;
  readonly targetUrl: string;
}

interface PullRequest {
  number: number;
  state: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  headRepo: string;
}

interface CheckRun { status: string; conclusion: string | null; app: string; url: string | null }
interface Status { context: string; state: string; targetUrl: string | null; createdAt: string }

class FakeGitHub implements JudgeGitHub {
  readonly published: Published[] = [];
  readonly traces: { pr: number; body: string }[] = [];
  readonly calls: string[] = [];
  readonly prs = new Map<number, PullRequest>();
  /** Successive answers for the head of a PR: the last one repeats. */
  readonly headSequence = new Map<number, string[]>();
  readonly commentList = new Map<number, PullRequestComment[] | Error>();
  readonly checks = new Map<string, CheckRun[] | Error>();
  readonly statusList = new Map<string, Status[]>();
  readonly runs = new Map<number, { path: string; event: string }>();
  readonly openWithHead = new Map<string, number[] | Error>();
  readonly forcePushed = new Map<number, string[] | Error>();
  queue: { position: number; headSha: string; baseSha: string; prNumber: number }[] | Error = [];
  /** Successive answers for the head of main: the last one repeats. */
  mainHeads: string[] = [];
  private clock = 0;

  constructor(readonly main: string) {
    this.mainHeads = [main];
    this.runs.set(RUN, { path: WORKFLOW, event: 'pull_request_target' });
  }

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 8, 23, 12, 0, this.clock)).toISOString();
  }

  /** What the console step published before the judge started: its own pending. */
  pendingFromConsoleStep(sha: string, context = 'ai-workflows'): void {
    this.addStatus(sha, { context, state: 'pending', targetUrl: RUN_URL });
  }

  addStatus(sha: string, status: Omit<Status, 'createdAt'>): void {
    const list = this.statusList.get(sha) ?? [];
    list.unshift({ ...status, createdAt: this.stamp() });
    this.statusList.set(sha, list);
  }

  setCheck(sha: string, name: string, runs: CheckRun[] | Error): void {
    this.checks.set(`${sha} ${name}`, runs);
  }

  async defaultBranch(): Promise<string> {
    this.calls.push('defaultBranch');
    return 'main';
  }

  async branchHead(branch: string): Promise<string> {
    this.calls.push(`branchHead ${branch}`);
    const next = this.mainHeads.length > 1 ? this.mainHeads.shift() : this.mainHeads[0];
    return next as string;
  }

  async pullRequest(n: number): Promise<PullRequest> {
    this.calls.push(`pullRequest ${n}`);
    const pr = this.prs.get(n);
    if (pr === undefined) throw new Error(`no PR ${n}`);
    const sequence = this.headSequence.get(n);
    if (sequence !== undefined && sequence.length > 0) {
      const head = sequence.length > 1 ? sequence.shift() : sequence[0];
      return { ...pr, headSha: head as string };
    }
    return { ...pr };
  }

  async openPullRequestsWithHead(sha: string): Promise<number[]> {
    this.calls.push(`openPullRequestsWithHead ${sha}`);
    const answer = this.openWithHead.get(sha) ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async mergeQueue(branch: string) {
    this.calls.push(`mergeQueue ${branch}`);
    if (this.queue instanceof Error) throw this.queue;
    return this.queue;
  }

  async comments(n: number): Promise<PullRequestComment[]> {
    this.calls.push(`comments ${n}`);
    const answer = this.commentList.get(n) ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async checkRuns(sha: string, name: string): Promise<CheckRun[]> {
    this.calls.push(`checkRuns ${sha} ${name}`);
    const answer = this.checks.get(`${sha} ${name}`) ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async statuses(sha: string): Promise<Status[]> {
    this.calls.push(`statuses ${sha}`);
    return [...(this.statusList.get(sha) ?? [])];
  }

  async workflowRun(id: number) {
    this.calls.push(`workflowRun ${id}`);
    return this.runs.get(id);
  }

  async forcePushedHeads(n: number): Promise<string[]> {
    this.calls.push(`forcePushedHeads ${n}`);
    const answer = this.forcePushed.get(n) ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async publishStatus(sha: string, status: { context: string; state: string; description: string; targetUrl: string }) {
    this.published.push({ sha, ...status });
    this.addStatus(sha, { context: status.context, state: status.state, targetUrl: status.targetUrl });
  }

  async upsertTraceComment(pr: number, body: string): Promise<void> {
    this.traces.push({ pr, body });
  }

  /** Only what the judge published for a context. */
  on(context = 'ai-workflows'): Published[] {
    return this.published.filter((entry) => entry.context === context);
  }
}

// ---------------------------------------------------------------------------------------------
// A world: the trusted main with the recipe, and pull requests built on it

const byOwner = (body: string, extra: Partial<PullRequestComment> = {}): PullRequestComment => ({
  body,
  author: OWNER,
  authorType: 'User',
  performedViaApp: false,
  edited: false,
  ...extra,
});

interface World {
  readonly root: string;
  readonly main: string;
  readonly github: FakeGitHub;
  readonly fetched: string[];
  /** SHAs GitHub no longer delivers: fetching them fails. */
  readonly gone: Set<string>;
  /** Commits `files` on a new branch from main and registers it as PR `n`. Returns its head. */
  pr(n: number, branch: string, files: Readonly<Record<string, string>>): string;
  /** Everything a behavior PR needs to pass except what the test changes. */
  green(n: number, head: string): void;
  input(overrides?: Partial<JudgeInput>): JudgeInput;
  judge(overrides?: Partial<JudgeInput>): ReturnType<typeof runJudge>;
}

function world(mainFiles: Readonly<Record<string, string>> = {}): World {
  const root = repository({
    '.ai-workflows/pipeline.yml': RECIPE,
    'ran.mjs': MARKER,
    'app/page.tsx': 'export const page = 1;\n',
    'README.md': 'proyecto\n',
    ...mainFiles,
  });
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const github = new FakeGitHub(main);
  const fetched: string[] = [];
  const gone = new Set<string>();
  let current: { n: number; head: string } | undefined;

  const self: World = {
    root,
    main,
    github,
    fetched,
    gone,
    pr(n, branch, files) {
      git(root, 'switch', '-q', '-c', `pr-${n}`, main);
      for (const [path, content] of Object.entries(files)) write(root, path, content);
      const head = commit(root, `PR ${n}`);
      git(root, 'switch', '-q', 'main');
      github.prs.set(n, { number: n, state: 'open', headSha: head, headRef: branch, baseRef: 'main', headRepo: REPO });
      current = { n, head };
      return head;
    },
    green(n, head) {
      github.setCheck(head, 'ai-workflows/red-test', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
      github.setCheck(head, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
      github.commentList.set(n, [byOwner(`/visto-bueno ${head.slice(0, 7)}`)]);
    },
    input(overrides = {}) {
      const target = current;
      return {
        eventName: 'pull_request_target',
        event: target === undefined ? {} : {
          pull_request: {
            number: target.n,
            head: { sha: target.head, ref: github.prs.get(target.n)?.headRef, repo: { full_name: REPO } },
            base: { sha: main, ref: 'main' },
          },
          repository: { full_name: REPO, default_branch: 'main' },
        },
        mode: 'on',
        context: 'ai-workflows',
        repository: REPO,
        workflowRef: `${REPO}/${WORKFLOW}@refs/heads/main`,
        actionRef: ACTION_REF,
        runId: RUN,
        serverUrl: 'https://github.com',
        alsoProtect: [RED_WORKFLOW],
        root,
        ...overrides,
      };
    },
    judge(overrides = {}) {
      return runJudge(self.input(overrides), {
        github,
        fetchObjects: async (shas) => {
          const missing = shas.filter((sha) => gone.has(sha));
          if (missing.length > 0) throw new Error(`fatal: remote error: upload-pack: not our ref ${missing.join(' ')}`);
          fetched.push(...shas);
        },
      });
    },
  };
  return self;
}

/** A behavior PR that touches what is visible, with its plan and a test. */
function behaviorPr(w: World, n = 7, branch = 'feat/13-algo'): string {
  return w.pr(n, branch, {
    'docs/plans/PLAN-13.md': PLAN('comportamiento'),
    'app/page.tsx': 'export const page = 2;\n',
    'tests/page.test.ts': 'test\n',
  });
}

const stageOf = (report: Awaited<ReturnType<typeof runJudge>>, id: string, pr = 0) =>
  report.pieces[pr]?.stages.find((stage) => stage.id === id);

// ---------------------------------------------------------------------------------------------

describe('§3.3: a pull request that meets every stage', () => {
  it('publishes success on its head, with the run as target, and runs no command', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.github.on()).toEqual([
      { sha: head, context: 'ai-workflows', state: 'success', description: expect.any(String), targetUrl: RUN_URL },
    ]);
    expect(report.pieces).toEqual([
      expect.objectContaining({ pr: 7, piece: '13', verdict: 'passed' }),
    ]);
    expect(report.pieces[0]?.stages.map((stage) => [stage.id, stage.outcome])).toEqual([
      ['spec', 'passed'],
      ['red-test', 'passed'],
      ['checks', 'passed'],
      ['owner-approval', 'passed'],
    ]);
    expect(existsSync(join(w.root, 'ran.txt'))).toBe(false);
    expect(report.summary).toContain('owner-approval');
  });

  it('skips a stage that does not apply, with its motive', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13-docs', { 'docs/plans/PLAN-13.md': PLAN('docs') });
    w.github.setCheck(head, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
    expect(stageOf(report, 'red-test')).toEqual({ id: 'red-test', outcome: 'skipped', reason: expect.stringMatching(/No aplica/) });
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('skipped');
  });

  it('rejects when the spec stage, recomputed from the head, is missing its section', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13-docs', { 'docs/plans/PLAN-13.md': lines('# Plan', 'Tipo de cambio: docs') });
    w.github.setCheck(head, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'failure', description: expect.stringContaining('spec') })]);
    expect(stageOf(report, 'spec')?.outcome).toBe('rejected');
  });
});

describe('CN-08: a branch without a piece never merges', () => {
  for (const branch of ['libre/prototipo', 'arreglo-rapido']) {
    it(`rejects ${branch} without judging any stage`, async () => {
      const w = world();
      const head = w.pr(7, branch, { 'app/page.tsx': 'export const page = 3;\n' });
      w.green(7, head);
      w.github.pendingFromConsoleStep(head);

      const report = await w.judge();

      expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'failure', description: expect.stringMatching(/pieza/) })]);
      expect(report.pieces).toEqual([expect.objectContaining({ pr: 7, verdict: 'rejected', stages: [] })]);
    });
  }

  it('positive: the same change on a branch with a piece is judged', async () => {
    const w = world();
    const head = behaviorPr(w, 7, 'fix/13');
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    await w.judge();
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('R19: the declared kind', () => {
  it('a value that names no kind rejects the pull request, naming it', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13', { 'docs/plans/PLAN-13.md': PLAN('magia'), 'app/page.tsx': 'x\n' });
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringContaining('magia') })]);
    expect(report.pieces[0]?.verdict).toBe('rejected');
  });

  it('a visual-only piece skips the red test (as declared), and paths still raise docs', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13', { 'docs/plans/PLAN-13.md': PLAN('solo visual'), 'app/page.tsx': 'x\n' });
    w.green(7, head);
    w.github.setCheck(head, 'ai-workflows/red-test', []);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(stageOf(report, 'red-test')?.outcome).toBe('skipped');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('SV-01 and SV-06: require-check reads a check, never runs a suite', () => {
  const run = (conclusion: string | null, status = 'completed'): CheckRun => ({ status, conclusion, app: 'github-actions', url: null });

  async function judged(setup: (w: World, head: string) => void) {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    setup(w, head);
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    return { w, head, report };
  }

  it('green on another SHA does not count: the stage waits for its check', async () => {
    const { w, head, report } = await judged((w, h) => {
      w.github.setCheck(h, 'todo-verde', []);
      w.github.setCheck(w.main, 'todo-verde', [run('success')]);
    });
    expect(stageOf(report, 'checks')).toEqual({ id: 'checks', outcome: 'waiting', reason: expect.stringContaining('todo-verde') });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'pending' })]);
    expect(existsSync(join(w.root, 'ran.txt'))).toBe(false);
  });

  it('a check still running waits', async () => {
    const { report } = await judged((w, h) => w.github.setCheck(h, 'todo-verde', [run(null, 'in_progress')]));
    expect(stageOf(report, 'checks')?.outcome).toBe('waiting');
  });

  for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled', 'timed_out']) {
    it(`a check that ended ${conclusion} rejects, naming the check and how it ended`, async () => {
      const { w, report } = await judged((w, h) => w.github.setCheck(h, 'todo-verde', [run(conclusion)]));
      expect(stageOf(report, 'checks')).toEqual({
        id: 'checks',
        outcome: 'rejected',
        reason: expect.stringMatching(new RegExp(`todo-verde.*${conclusion}`)),
      });
      expect(w.github.on()).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringContaining('checks') })]);
    });
  }

  it('SV-06: the red-test check failing rejects the pull request naming the stage', async () => {
    const { w, report } = await judged((w, h) => w.github.setCheck(h, 'ai-workflows/red-test', [run('failure')]));
    expect(stageOf(report, 'red-test')?.outcome).toBe('rejected');
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringContaining('red-test') })]);
  });

  it('a commit status with the same name counts too, and every one must be green', async () => {
    const onlyStatus = await judged((w, h) => {
      w.github.setCheck(h, 'todo-verde', []);
      w.github.addStatus(h, { context: 'todo-verde', state: 'success', targetUrl: null });
    });
    expect(stageOf(onlyStatus.report, 'checks')?.outcome).toBe('passed');

    const mixed = await judged((w, h) => w.github.addStatus(h, { context: 'todo-verde', state: 'failure', targetUrl: null }));
    expect(stageOf(mixed.report, 'checks')?.outcome).toBe('rejected');

    const latestWins = await judged((w, h) => {
      w.github.addStatus(h, { context: 'todo-verde', state: 'failure', targetUrl: null });
      w.github.addStatus(h, { context: 'todo-verde', state: 'success', targetUrl: null });
    });
    expect(stageOf(latestWins.report, 'checks')?.outcome).toBe('passed');
  });

  it('a check that cannot be read leaves only that stage technical, and publishes error', async () => {
    const { w, report } = await judged((w, h) => w.github.setCheck(h, 'todo-verde', new Error('403 Resource not accessible by integration')));
    expect(stageOf(report, 'checks')).toEqual({ id: 'checks', outcome: 'technical', reason: expect.stringContaining('403') });
    expect(stageOf(report, 'spec')?.outcome).toBe('passed');
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'error' })]);
  });
});

describe('RC-06 and SV-04: the judge judges with the recipe of main, and guards its own files', () => {
  it('a pull request that removes a stage is judged with it, and rejected for touching the recipe', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13', {
      'docs/plans/PLAN-13.md': PLAN('comportamiento'),
      'app/page.tsx': 'x\n',
      '.ai-workflows/pipeline.yml': RECIPE.replace(/ {2}- id: checks[\s\S]*?server: \{ require-check: todo-verde \}\n/, ''),
    });
    w.green(7, head);
    w.github.setCheck(head, 'todo-verde', []);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(stageOf(report, 'checks')?.outcome).toBe('waiting');
    expect(report.pieces[0]?.verdict).toBe('rejected');
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringContaining('/approve-judge-change') })]);
  });

  for (const path of ['.ai-workflows/blocks/x/block.yml', WORKFLOW, RED_WORKFLOW]) {
    it(`touching ${path} needs the owner's attestation for this head`, async () => {
      const w = world();
      const head = w.pr(7, 'feat/13', { 'docs/plans/PLAN-13.md': PLAN('comportamiento'), 'app/page.tsx': 'x\n', [path]: 'changed\n' });
      w.green(7, head);
      w.github.pendingFromConsoleStep(head);
      await w.judge();
      expect(w.github.on()).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringContaining('/approve-judge-change') })]);
    });
  }

  const attempts: [string, PullRequestComment | ((head: string) => PullRequestComment), string][] = [
    ['another account', (h) => byOwner(`/approve-judge-change ${h.slice(0, 7)}`, { author: 'otra' }), 'failure'],
    ['an edited comment', (h) => byOwner(`/approve-judge-change ${h.slice(0, 7)}`, { edited: true }), 'failure'],
    ['a comment through an app', (h) => byOwner(`/approve-judge-change ${h.slice(0, 7)}`, { performedViaApp: true }), 'failure'],
    ['a bot', (h) => byOwner(`/approve-judge-change ${h.slice(0, 7)}`, { authorType: 'Bot' }), 'failure'],
    ['an older version', byOwner('/approve-judge-change 0000000'), 'failure'],
    ['a code in a quote', (h) => byOwner(`> /approve-judge-change ${h.slice(0, 7)}`), 'failure'],
    ['the owner, for this head', (h) => byOwner(`/approve-judge-change ${h.slice(0, 7)}`), 'success'],
  ];
  for (const [who, comment, state] of attempts) {
    it(`attestation from ${who} → ${state}`, async () => {
      const w = world();
      const head = w.pr(7, 'feat/13', { 'docs/plans/PLAN-13.md': PLAN('comportamiento'), 'app/page.tsx': 'x\n', '.ai-workflows/blocks/x/block.yml': 'x\n' });
      w.green(7, head);
      const written = typeof comment === 'function' ? comment(head) : comment;
      w.github.commentList.set(7, [byOwner(`/visto-bueno ${head.slice(0, 7)}`), written]);
      w.github.pendingFromConsoleStep(head);
      await w.judge();
      expect(w.github.on().map((entry) => entry.state)).toEqual([state]);
    });
  }

  it('without a recipe on main, every pull request gets error, never green', async () => {
    const w = world({ '.ai-workflows/pipeline.yml': '' });
    git(w.root, 'rm', '-q', '.ai-workflows/pipeline.yml');
    const main = commit(w.root, 'no recipe');
    w.github.mainHeads = [main];
    const head = w.pr(7, 'feat/13', { 'docs/x.md': 'x\n' });
    w.github.pendingFromConsoleStep(head);
    await w.judge();
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'error' })]);
  });

  it('with an invalid recipe on main, error too', async () => {
    const w = world({ '.ai-workflows/pipeline.yml': 'version: 2\n' });
    const head = w.pr(7, 'feat/13', { 'docs/x.md': 'x\n' });
    w.github.pendingFromConsoleStep(head);
    await w.judge();
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'error', description: expect.stringMatching(/receta/) })]);
  });
});

describe('CN-05: what is visible waits for the owner', () => {
  async function withComments(make: (head: string, first: string) => PullRequestComment[], extra?: (w: World) => string) {
    const w = world();
    const first = behaviorPr(w);
    let head = first;
    if (extra) head = extra(w);
    w.green(7, head);
    w.github.commentList.set(7, make(head, first));
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    return { w, head, report };
  }

  it('without a sign-off, pending, and the motive says what to write', async () => {
    const { w, head, report } = await withComments(() => []);
    expect(stageOf(report, 'owner-approval')).toEqual({
      id: 'owner-approval',
      outcome: 'waiting',
      reason: expect.stringContaining(`/visto-bueno ${head.slice(0, 7)}`),
    });
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'pending', description: expect.stringContaining(`/visto-bueno ${head.slice(0, 7)}`) })]);
  });

  const refused: [string, (head: string) => PullRequestComment][] = [
    ['from another account', (h) => byOwner(`/visto-bueno ${h.slice(0, 7)}`, { author: 'otra' })],
    ['edited', (h) => byOwner(`/visto-bueno ${h.slice(0, 7)}`, { edited: true })],
    ['through an app', (h) => byOwner(`/visto-bueno ${h.slice(0, 7)}`, { performedViaApp: true })],
    ['too short', (h) => byOwner(`/visto-bueno ${h.slice(0, 6)}`)],
    ['inside a code block', (h) => byOwner(lines('```', `/visto-bueno ${h.slice(0, 7)}`, '```'))],
    ['with the other command', (h) => byOwner(`/approve ${h.slice(0, 7)}`)],
  ];
  for (const [what, make] of refused) {
    it(`a sign-off ${what} does not count`, async () => {
      const { w, report } = await withComments((head) => [make(head)]);
      expect(stageOf(report, 'owner-approval')?.outcome).toBe('waiting');
      expect(w.github.on().map((entry) => entry.state)).toEqual(['pending']);
    });
  }

  it('a sign-off of an earlier commit with the same own changes still counts (same-fingerprint)', async () => {
    const { w, report } = await withComments(
      (_head, first) => [byOwner(`/visto-bueno ${first.slice(0, 7)}`)],
      (w) => {
        // An empty commit on top: same tree, same own changes, new head.
        git(w.root, 'switch', '-q', 'pr-7');
        const next = commit(w.root, 'empty');
        git(w.root, 'switch', '-q', 'main');
        const pr = w.github.prs.get(7);
        if (pr) pr.headSha = next;
        return next;
      },
    );
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('passed');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });

  /** Rebuilds the head of PR 7 with the same changes (amend) and returns [old head, new head]. */
  function forcePush(w: World): [string, string] {
    const old = w.github.prs.get(7)?.headSha as string;
    git(w.root, 'switch', '-q', 'pr-7');
    git(w.root, 'commit', '-q', '--amend', '-m', 'PR 7 rehecho');
    const next = git(w.root, 'rev-parse', 'HEAD');
    git(w.root, 'switch', '-q', 'main');
    const pr = w.github.prs.get(7);
    if (pr) pr.headSha = next;
    w.github.forcePushed.set(7, [old]);
    return [old, next];
  }

  it('a sign-off of a head rebuilt by force push with the same changes still counts', async () => {
    const w = world();
    behaviorPr(w);
    const [old, next] = forcePush(w);
    w.green(7, next);
    w.github.commentList.set(7, [byOwner(`/visto-bueno ${old.slice(0, 7)}`)]);
    w.github.pendingFromConsoleStep(next);
    const report = await w.judge();
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('passed');
    expect(w.fetched).toContain(old);
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });

  it('a replaced head that GitHub no longer delivers asks for a new sign-off', async () => {
    const w = world();
    behaviorPr(w);
    const [old, next] = forcePush(w);
    w.gone.add(old);
    w.green(7, next);
    w.github.commentList.set(7, [byOwner(`/visto-bueno ${old.slice(0, 7)}`)]);
    w.github.pendingFromConsoleStep(next);
    const report = await w.judge();
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('waiting');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['pending']);
  });

  it('a timeline that cannot be read leaves the approval technical', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.commentList.set(7, [byOwner('/visto-bueno 1234567')]);
    w.github.forcePushed.set(7, new Error('the timeline has another page'));
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('technical');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['error']);
  });

  it('a sign-off of an earlier commit with other changes does not', async () => {
    const { report } = await withComments(
      (_head, first) => [byOwner(`/visto-bueno ${first.slice(0, 7)}`)],
      (w) => {
        git(w.root, 'switch', '-q', 'pr-7');
        write(w.root, 'app/page.tsx', 'export const page = 99;\n');
        const next = commit(w.root, 'more');
        git(w.root, 'switch', '-q', 'main');
        const pr = w.github.prs.get(7);
        if (pr) pr.headSha = next;
        return next;
      },
    );
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('waiting');
  });

  it('a stage that is not needs-human is rejected, not waiting, without its attestation', async () => {
    const w = world({
      '.ai-workflows/pipeline.yml': RECIPE.replace('    needs-human: true\n', ''),
    });
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.commentList.set(7, []);
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('rejected');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['failure']);
  });
});

describe('§4: the switch', () => {
  async function inMode(mode: string, prepare?: (w: World, head: string) => void) {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.setCheck(head, 'todo-verde', [{ status: 'completed', conclusion: 'failure', app: 'github-actions', url: null }]);
    prepare?.(w, head);
    const report = await w.judge({ mode });
    return { w, head, report };
  }

  it('advisory: the real verdict goes to ai-workflows/advisory and the judge never touches the main status', async () => {
    const { w, head } = await inMode('advisory', (w, h) => w.github.pendingFromConsoleStep(h, 'ai-workflows/advisory'));
    expect(w.github.on('ai-workflows/advisory')).toEqual([expect.objectContaining({ sha: head, state: 'failure' })]);
    expect(w.github.on('ai-workflows')).toEqual([]);
  });

  it('on: the real verdict goes to the main status', async () => {
    const { w } = await inMode('on', (w, h) => w.github.pendingFromConsoleStep(h));
    expect(w.github.on('ai-workflows').map((entry) => entry.state)).toEqual(['failure']);
    expect(w.github.on('ai-workflows/advisory')).toEqual([]);
  });

  it('trimmed and without case: " On " is on', async () => {
    const { w } = await inMode(' On ', (w, h) => w.github.pendingFromConsoleStep(h));
    expect(w.github.on('ai-workflows').map((entry) => entry.state)).toEqual(['failure']);
  });

  for (const mode of ['', 'off', 'OFF']) {
    it(`"${mode}" is off: green «motor apagado» and nothing judged`, async () => {
      const { w, head, report } = await inMode(mode);
      expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'success', description: expect.stringMatching(/motor apagado/) })]);
      expect(report.pieces).toEqual([]);
    });
  }

  it('an unknown value is an error on the main status, naming the valid ones', async () => {
    const { w, report } = await inMode('encendido');
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'error', description: expect.stringMatching(/off.*advisory.*on/) })]);
    expect(report.pieces).toEqual([]);
  });
});

describe('§3.1: provenance', () => {
  async function withRef(overrides: Partial<JudgeInput>) {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge(overrides);
    return { w, report };
  }

  it('a workflow from another branch publishes nothing, not even green, and says why', async () => {
    const { w, report } = await withRef({ workflowRef: `${REPO}/${WORKFLOW}@refs/heads/feat/13-algo` });
    expect(w.github.published).toEqual([]);
    expect(report.notes.join('\n')).toMatch(/refs\/heads\/feat\/13-algo/);
  });

  it('a pull request into another branch publishes nothing, even with the workflow of main', async () => {
    const w = world();
    const head = behaviorPr(w);
    const pr = w.github.prs.get(7);
    if (pr) pr.baseRef = 'develop';
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    const input = w.input();
    (input.event as { pull_request: { base: { ref: string } } }).pull_request.base.ref = 'develop';
    const report = await runJudge(input, { github: w.github, fetchObjects: async () => {} });
    expect(w.github.published).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/develop/);
  });

  it('a pull request retargeted to another branch (live base) publishes nothing', async () => {
    const w = world();
    const head = behaviorPr(w);
    const pr = w.github.prs.get(7);
    if (pr) pr.baseRef = 'develop';
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    expect(w.github.published).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/develop/);
  });

  it('an action not pinned by a full SHA is an error', async () => {
    const { w } = await withRef({ actionRef: 'v1' });
    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'error', description: expect.stringMatching(/SHA/) })]);
  });

  it('the recipe comes from the live head of main, fetched, even when the event names an older base', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    // Main moves on and drops the spec stage; the event still names the old base.
    write(w.root, '.ai-workflows/pipeline.yml', RECIPE.replace(/ {2}- id: spec[\s\S]*?server: recompute\n/, '').replace('    after: spec\n', ''));
    const newer = commit(w.root, 'main moves');
    w.github.mainHeads = [newer];
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.fetched).toContain(newer);
    expect(stageOf(report, 'spec')).toBeUndefined();
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('SV-05: runs that cross', () => {
  it('(a) the head moved before publishing: no verdict on any SHA, and a note says so', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.headSequence.set(7, [head, 'b'.repeat(40)]);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(w.github.published).toEqual([]);
    expect(report.notes.join('\n')).toMatch(/cabeza|head/i);
  });

  it('(a) positive: the head did not move, the verdict is published', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.headSequence.set(7, [head, head]);
    w.github.pendingFromConsoleStep(head);
    await w.judge();
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });

  it('(b) main moved while judging: judged again with the new main', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    git(w.root, 'switch', '-q', 'main');
    write(w.root, 'README.md', 'otra\n');
    const newer = commit(w.root, 'main moves');
    w.github.mainHeads = [w.main, newer, newer];
    w.github.pendingFromConsoleStep(head);

    await w.judge();

    expect(w.fetched).toContain(newer);
    expect(w.github.on().map((entry) => entry.state)).toEqual(['success']);
  });

  it('(b) main moved twice: error, never green', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    write(w.root, 'README.md', 'otra\n');
    const second = commit(w.root, 'main moves');
    write(w.root, 'README.md', 'y otra\n');
    const third = commit(w.root, 'main moves again');
    w.github.mainHeads = [w.main, second, third, third];
    w.github.pendingFromConsoleStep(head);

    await w.judge();

    expect(w.github.on()).toEqual([expect.objectContaining({ state: 'error', description: expect.stringMatching(/principal/) })]);
  });

  it('(c) another official run published after our pending: this one stays quiet', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    w.github.runs.set(222, { path: WORKFLOW, event: 'issue_comment' });
    w.github.addStatus(head, { context: 'ai-workflows', state: 'pending', targetUrl: `https://github.com/${REPO}/actions/runs/222` });

    const report = await w.judge();

    expect(w.github.published).toEqual([]);
    expect(report.notes.join('\n')).toMatch(/222/);
  });

  it('(e) comments that cannot be read leave the approval technical: error, never green', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.commentList.set(7, new Error('403 Resource not accessible by integration'));
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    expect(stageOf(report, 'owner-approval')?.outcome).toBe('technical');
    expect(w.github.on().map((entry) => entry.state)).toEqual(['error']);
  });
});

describe('SV-03: one pull request failing does not take the others down', () => {
  it('a merge group with a technical PR fails as a group, and the report names only that PR', async () => {
    const w = world();
    const seven = behaviorPr(w, 7, 'feat/13-a');
    const eight = w.pr(8, 'feat/14-docs', { 'docs/plans/PLAN-14.md': lines('## En tres líneas', 'x', 'Tipo de cambio: docs') });
    w.green(7, seven);
    w.github.commentList.set(7, new Error('502 Bad Gateway'));
    const group = mergeGroup(w, [7, 8]);
    w.github.setCheck(group, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.setCheck(group, 'ai-workflows/red-test', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.pendingFromConsoleStep(group);

    const report = await w.judge(groupInput(w, group));

    expect(report.pieces.map((piece) => [piece.pr, piece.verdict])).toEqual([[7, 'technical'], [8, 'passed']]);
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'error' })]);
    expect(eight).toBeTruthy();
  });

  it('a docs PR is judged normally while another PR is technical', async () => {
    const w = world();
    const seven = behaviorPr(w, 7, 'feat/13-a');
    w.github.commentList.set(7, new Error('502 Bad Gateway'));
    w.green(7, seven);
    const eight = w.pr(8, 'feat/14-docs', { 'docs/plans/PLAN-14.md': lines('## En tres líneas', 'x', 'Tipo de cambio: docs') });
    w.github.setCheck(eight, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.pendingFromConsoleStep(eight);

    await w.judge();

    expect(w.github.on()).toEqual([expect.objectContaining({ sha: eight, state: 'success' })]);
  });
});

// ---------------------------------------------------------------------------------------------
// Merge groups (SV-07)

/** Builds the group commits the queue would build (each PR merged on the previous) and the queue. */
function mergeGroup(w: World, prs: number[]): string {
  let base = w.main;
  const entries: { position: number; headSha: string; baseSha: string; prNumber: number }[] = [];
  git(w.root, 'switch', '-q', '--detach', w.main);
  prs.forEach((n, index) => {
    git(w.root, 'merge', '-q', '--no-ff', '--no-edit', `pr-${n}`);
    const head = git(w.root, 'rev-parse', 'HEAD');
    entries.push({ position: index + 1, headSha: head, baseSha: base, prNumber: n });
    base = head;
  });
  git(w.root, 'switch', '-q', 'main');
  w.github.queue = entries;
  return base;
}

function groupInput(w: World, group: string): Partial<JudgeInput> {
  w.github.runs.set(RUN, { path: WORKFLOW, event: 'merge_group' });
  return {
    eventName: 'merge_group',
    event: { merge_group: { head_sha: group, base_sha: w.main, head_ref: `refs/heads/gh-readonly-queue/main/pr-8-${w.main}` }, repository: { full_name: REPO, default_branch: 'main' } },
    workflowRef: `${REPO}/${WORKFLOW}@refs/heads/gh-readonly-queue/main/pr-8-${w.main}`,
  };
}

describe('SV-07: the merge queue', () => {
  function twoPrGroup() {
    const w = world();
    const seven = behaviorPr(w, 7, 'feat/13-a');
    const eight = w.pr(8, 'feat/14-b', { 'docs/plans/PLAN-14.md': lines('## En tres líneas', 'x', 'Tipo de cambio: comportamiento'), 'lib/b.ts': 'b\n' });
    w.green(7, seven);
    w.green(8, eight);
    const group = mergeGroup(w, [7, 8]);
    return { w, seven, eight, group };
  }

  it('judges every PR of the queue list up to the group, and publishes on the group SHA', async () => {
    const { w, group } = twoPrGroup();
    w.github.setCheck(group, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.setCheck(group, 'ai-workflows/red-test', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.pendingFromConsoleStep(group);

    const report = await w.judge(groupInput(w, group));

    expect(report.pieces.map((piece) => [piece.pr, piece.piece, piece.verdict])).toEqual([[7, '13', 'passed'], [8, '14', 'passed']]);
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'success' })]);
    expect(w.github.calls).toContain('mergeQueue main');
  });

  it('a green only on the heads of the PRs does not authorize the group', async () => {
    const { w, group } = twoPrGroup();
    w.github.pendingFromConsoleStep(group);
    const report = await w.judge(groupInput(w, group));
    expect(report.pieces.every((piece) => piece.verdict === 'waiting')).toBe(true);
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'pending' })]);
  });

  it('a queue that cannot be confirmed is an error on the group', async () => {
    const { w, group } = twoPrGroup();
    w.github.queue = new Error('the queue has more than 100 entries');
    w.github.pendingFromConsoleStep(group);
    await w.judge(groupInput(w, group));
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'error' })]);
  });

  it('a group SHA that is not in the queue list is an error', async () => {
    const { w, group } = twoPrGroup();
    w.github.queue = [];
    w.github.pendingFromConsoleStep(group);
    await w.judge(groupInput(w, group));
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'error' })]);
  });

  it('a main that is not an ancestor of the group is an error', async () => {
    const { w, group } = twoPrGroup();
    write(w.root, 'README.md', 'elsewhere\n');
    const elsewhere = commit(w.root, 'main moves elsewhere');
    w.github.mainHeads = [elsewhere];
    w.github.pendingFromConsoleStep(group);
    await w.judge(groupInput(w, group));
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'error' })]);
  });

  it('a merge_group run whose workflow is not from the queue branch publishes nothing', async () => {
    const { w, group } = twoPrGroup();
    w.github.pendingFromConsoleStep(group);
    const report = await w.judge({ ...groupInput(w, group), workflowRef: `${REPO}/${WORKFLOW}@refs/heads/main` });
    expect(w.github.published).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });
});

describe('§3.2: other events', () => {
  it('issue_comment reads the live head of the PR and judges it', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'issue_comment' });
    w.github.pendingFromConsoleStep(head);
    await w.judge({ eventName: 'issue_comment', event: { issue: { number: 7, pull_request: {} }, comment: { body: '/visto-bueno' }, repository: { full_name: REPO } } });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'success' })]);
  });

  it('workflow_dispatch with a PR number does the same', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'workflow_dispatch' });
    w.github.pendingFromConsoleStep(head);
    await w.judge({ eventName: 'workflow_dispatch', event: { inputs: { pr: '7' }, repository: { full_name: REPO } } });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'success' })]);
  });

  it('workflow_run of a pull_request finds the open PRs by head SHA', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.openWithHead.set(head, [7]);
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'workflow_run' });
    w.github.pendingFromConsoleStep(head);
    await w.judge({ eventName: 'workflow_run', event: { workflow_run: { event: 'pull_request', head_sha: head, pull_requests: [] }, repository: { full_name: REPO } } });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'success' })]);
    expect(w.github.calls).toContain(`openPullRequestsWithHead ${head}`);
  });

  it('workflow_run for a SHA with no open PR publishes nothing and says so', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.github.openWithHead.set(head, []);
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'workflow_run' });
    const report = await w.judge({ eventName: 'workflow_run', event: { workflow_run: { event: 'pull_request', head_sha: head, pull_requests: [] }, repository: { full_name: REPO } } });
    expect(w.github.published).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('workflow_run whose PRs cannot be read publishes error on that SHA', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.github.openWithHead.set(head, new Error('502 Bad Gateway'));
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'workflow_run' });
    w.github.pendingFromConsoleStep(head);
    await w.judge({ eventName: 'workflow_run', event: { workflow_run: { event: 'pull_request', head_sha: head, pull_requests: [] }, repository: { full_name: REPO } } });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'error' })]);
  });

  it('workflow_run of a merge_group judges the group from the queue list', async () => {
    const w = world();
    const seven = behaviorPr(w, 7, 'feat/13-a');
    w.green(7, seven);
    const group = mergeGroup(w, [7]);
    w.github.setCheck(group, 'todo-verde', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.setCheck(group, 'ai-workflows/red-test', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    w.github.runs.set(RUN, { path: WORKFLOW, event: 'workflow_run' });
    w.github.pendingFromConsoleStep(group);
    await w.judge({ eventName: 'workflow_run', event: { workflow_run: { event: 'merge_group', head_sha: group, head_branch: `gh-readonly-queue/main/pr-7-${w.main}`, pull_requests: [] }, repository: { full_name: REPO } } });
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: group, state: 'success' })]);
  });
});

describe('§3.7: trace of imitated statuses (SV-04, R13)', () => {
  it('reports a status with a foreign target and a check-run with the judge name, and comments on the PR', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.addStatus(head, { context: 'ai-workflows', state: 'success', targetUrl: 'https://example.com/fake' });
    w.github.runs.set(333, { path: '.github/workflows/otro.yml', event: 'pull_request' });
    w.github.addStatus(head, { context: 'ai-workflows/advisory', state: 'success', targetUrl: `https://github.com/${REPO}/actions/runs/333` });
    w.github.setCheck(head, 'ai-workflows', [{ status: 'completed', conclusion: 'success', app: 'github-actions', url: 'https://github.com/x/checks/1' }]);
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(report.unofficial).toEqual(expect.arrayContaining([
      expect.objectContaining({ sha: head, context: 'ai-workflows', kind: 'status', url: 'https://example.com/fake' }),
      expect.objectContaining({ sha: head, context: 'ai-workflows/advisory', kind: 'status' }),
      expect.objectContaining({ sha: head, context: 'ai-workflows', kind: 'check-run', app: 'github-actions' }),
    ]));
    expect(w.github.traces).toEqual([{ pr: 7, body: expect.stringContaining('https://example.com/fake') }]);
    expect(report.summary).toContain('https://example.com/fake');
  });

  it('positive: statuses of official runs (also with /job/) are not reported and no comment is written', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.runs.set(100, { path: WORKFLOW, event: 'pull_request_target' });
    w.github.addStatus(head, { context: 'ai-workflows', state: 'failure', targetUrl: `https://github.com/${REPO}/actions/runs/100/job/5` });
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(report.unofficial).toEqual([]);
    expect(w.github.traces).toEqual([]);
  });
});

describe('SV-08: the judge never reads the state refs', () => {
  it('a journal written by hand in refs/ai-workflows does not change the verdict, and is never fetched', async () => {
    const w = world();
    const head = behaviorPr(w);
    w.green(7, head);
    w.github.setCheck(head, 'ai-workflows/red-test', []);
    // A hand-written journal that claims the red test passed, in the ref the engine would use.
    git(w.root, 'switch', '-q', '--orphan', 'state');
    write(w.root, 'journal.json', JSON.stringify([{ stage: 'red-test', outcome: 'passed', evidence: {} }]));
    git(w.root, 'add', 'journal.json');
    git(w.root, 'commit', '-q', '-m', 'forged journal');
    git(w.root, 'update-ref', 'refs/ai-workflows/pieces/13', 'HEAD');
    git(w.root, 'switch', '-q', '-f', 'main');
    w.github.pendingFromConsoleStep(head);

    const report = await w.judge();

    expect(stageOf(report, 'red-test')?.outcome).toBe('waiting');
    expect(w.fetched.some((ref) => ref.includes('refs/ai-workflows'))).toBe(false);
    expect(w.github.calls.some((call) => call.includes('refs/ai-workflows'))).toBe(false);
  });
});

describe('the summary', () => {
  it('escapes what comes from the pull request', async () => {
    const w = world();
    const head = w.pr(7, 'feat/13', { 'docs/plans/PLAN-13.md': PLAN('ma|gia<script>'), 'app/page.tsx': 'x\n' });
    w.green(7, head);
    w.github.pendingFromConsoleStep(head);
    const report = await w.judge();
    expect(report.summary).not.toContain('<script>');
    expect(report.summary).not.toMatch(/ma\|gia/);
  });
});
