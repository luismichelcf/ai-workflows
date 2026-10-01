import { join } from 'node:path';

import { runJudge, type JudgeGitHub, type JudgeInput, type PullRequestComment } from '../src/index.js';

import { commit, emptyFolder, git, repository, write } from './git-fixtures.js';

// PLAN-13-R6 §1: a world with several working branches for the judge. Git is real (one temporary
// repository holds `main`, `staging` and every pull request head, so every object the judge would
// fetch is already there); GitHub is the external edge, a fake port that keeps one head per branch
// (a sequence, the last one repeats, like the head of main in judge-core), the open and closed pull
// requests, the check-runs and the statuses, and records what the judge publishes.
//
// Interface these tests fix for the builder (PLAN-13-R6 §1.2):
//   - `JudgeInput.branches?: readonly string[]` — the action input `branches` (the CLI reads it
//     from `AI_WORKFLOWS_BRANCHES`, split like `also-protect`). Absent or empty means "only the
//     principal", exactly like a recipe without `branches:`.
//   - The recipe section `branches: { into: [...], promotions: [{ from, to }] }` is read from the
//     recipe of the PRINCIPAL; the stages and the merge base of a pull request come from the tip of
//     its own target branch.

export const REPO = 'duena/proyecto';
export const FORK = 'extrana/proyecto';
export const OWNER = 'duena';
export const RUN = 111;
export const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
export const WORKFLOW = '.github/workflows/ai-workflows.yml';
export const ACTION_REF = 'a'.repeat(40);
export const MISMATCH = 'el workflow del juez y la receta no declaran las mismas ramas';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

/** The section of §1.1, as the design writes it. */
export const BRANCHES = ['branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }'];
/** The same branches, without any promotion. */
export const BRANCHES_NO_PROMOTION = ['branches:', '  into: [staging, main]'];

/**
 * A recipe whose pre-merge stages are one `require-check` per name, in order (the stage id is the
 * check name), then the merge. `branches` are the rows of the `branches:` section, if any.
 */
export function recipe(checks: readonly string[], branches: readonly string[] = []): string {
  const rows = [
    'version: 1',
    'locale: es',
    `owner: ${OWNER}`,
    'pieces:',
    '  branch: ["*/{piece}-*"]',
    ...branches,
    'stages:',
  ];
  let previous: string | undefined;
  for (const check of checks) {
    rows.push(
      `  - id: ${check}`,
      `    summary: "El check ${check} en verde"`,
      ...(previous === undefined ? [] : [`    after: ${previous}`]),
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/command@1',
      '      with: { command: "node ran.mjs" }',
      `    server: { require-check: ${check} }`,
    );
    previous = check;
  }
  rows.push(
    '  - id: merge',
    '    summary: "Se une"',
    ...(previous === undefined ? [] : [`    after: ${previous}`]),
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
  );
  return lines(...rows);
}

// ---------------------------------------------------------------------------------------------
// The fake GitHub port

export interface Published {
  readonly sha: string;
  readonly context: string;
  readonly state: string;
  readonly description: string;
  readonly targetUrl: string;
}

export interface FakePullRequest {
  number: number;
  state: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  headRepo: string;
}

interface CheckRun { id?: number; status: string; conclusion: string | null; app: string; url: string | null }
interface Status { context: string; state: string; targetUrl: string | null; createdAt: string }

export class BranchesGitHub implements JudgeGitHub {
  readonly published: Published[] = [];
  readonly calls: string[] = [];
  readonly prs = new Map<number, FakePullRequest>();
  /** Successive answers for the head of each branch: the last one repeats. */
  readonly heads = new Map<string, string[]>();
  readonly commentList = new Map<number, PullRequestComment[]>();
  readonly checks = new Map<string, CheckRun[]>();
  readonly statusList = new Map<string, Status[]>();
  private clock = 0;

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 8, 29, 12, 0, this.clock)).toISOString();
  }

  addStatus(sha: string, status: Omit<Status, 'createdAt'>): void {
    const list = this.statusList.get(sha) ?? [];
    list.unshift({ ...status, createdAt: this.stamp() });
    this.statusList.set(sha, list);
  }

  setCheck(sha: string, name: string, conclusion: 'success' | 'failure'): void {
    this.checks.set(`${sha} ${name}`, [{ status: 'completed', conclusion, app: 'github-actions', url: null }]);
  }

  async defaultBranch(): Promise<string> {
    this.calls.push('defaultBranch');
    return 'main';
  }

  async branchHead(branch: string): Promise<string> {
    this.calls.push(`branchHead ${branch}`);
    const sequence = this.heads.get(branch);
    if (sequence === undefined || sequence.length === 0) throw new Error(`no branch ${branch}`);
    return (sequence.length > 1 ? sequence.shift() : sequence[0]) as string;
  }

  async pullRequest(n: number): Promise<FakePullRequest> {
    this.calls.push(`pullRequest ${n}`);
    const pr = this.prs.get(n);
    if (pr === undefined) throw new Error(`no PR ${n}`);
    return { ...pr };
  }

  private open(): FakePullRequest[] {
    return [...this.prs.values()].filter((pr) => pr.state === 'open');
  }

  async openPullRequestsWithHead(sha: string): Promise<number[]> {
    this.calls.push(`openPullRequestsWithHead ${sha}`);
    return this.open().filter((pr) => pr.headSha === sha).map((pr) => pr.number);
  }

  async openPullRequests() {
    this.calls.push('openPullRequests');
    return this.open().map((pr) => ({ number: pr.number, headRef: pr.headRef, headSha: pr.headSha, baseRef: pr.baseRef }));
  }

  async mergeQueue(branch: string) {
    this.calls.push(`mergeQueue ${branch}`);
    return [];
  }

  async comments(n: number): Promise<PullRequestComment[]> {
    this.calls.push(`comments ${n}`);
    return this.commentList.get(n) ?? [];
  }

  async issueComments() {
    return [];
  }

  async reviews() {
    return [];
  }

  async checkRuns(sha: string, name: string): Promise<CheckRun[]> {
    this.calls.push(`checkRuns ${sha} ${name}`);
    return this.checks.get(`${sha} ${name}`) ?? [];
  }

  async statuses(sha: string): Promise<Status[]> {
    this.calls.push(`statuses ${sha}`);
    return [...(this.statusList.get(sha) ?? [])];
  }

  async workflowRun(id: number) {
    this.calls.push(`workflowRun ${id}`);
    return id === RUN ? { path: WORKFLOW, event: 'pull_request_target' } : undefined;
  }

  async forcePushedHeads(): Promise<string[]> {
    return [];
  }

  async publishStatus(sha: string, status: { context: string; state: string; description: string; targetUrl: string }) {
    this.published.push({ sha, ...status });
    this.addStatus(sha, { context: status.context, state: status.state, targetUrl: status.targetUrl });
  }

  async upsertTraceComment(): Promise<void> {}

  /** What the judge published on one SHA, without the in-progress `pending` of any step. */
  verdicts(sha: string, context = 'ai-workflows'): Published[] {
    return this.published.filter((entry) => entry.sha === sha && entry.context === context && entry.state !== 'pending');
  }
}

// ---------------------------------------------------------------------------------------------
// The world

export const byOwner = (body: string): PullRequestComment => ({
  body,
  author: OWNER,
  authorType: 'User',
  performedViaApp: false,
  edited: false,
});

export interface BranchWorld {
  readonly root: string;
  /** The tip of main, with the main recipe. */
  readonly main: string;
  readonly github: BranchesGitHub;
  readonly fetched: string[];
  /**
   * One commit over `from` (a SHA) that writes `files`; a `null` content deletes the file. The
   * commit is not registered anywhere: use it as a branch tip or a pull request head.
   */
  commitOn(from: string, files: Readonly<Record<string, string | null>>, message?: string): string;
  /**
   * Only with `remote: true`. One commit over `from` that writes `files`, made in a separate clone
   * and pushed to the bare remote, never into the judge's checkout: its objects arrive only through
   * `fetchObjects`, like a tip that moved on GitHub while the judge was judging. With `merge`, the
   * commit first merges that SHA into `from` (`--no-ff`), then writes `files` on top.
   */
  commitRemote(from: string, files: Readonly<Record<string, string | null>>, message?: string, merge?: string): string;
  /** Whether the judge's checkout holds the commit `sha`. */
  hasObject(sha: string): boolean;
  /** Registers the tips GitHub reports for `branch`, in order (the last one repeats). */
  setBranch(branch: string, ...tips: string[]): void;
  /** Registers pull request `n`. The head repository is this one unless said otherwise. */
  pr(n: number, pr: { head: string; headRef: string; baseRef: string; headRepo?: string; state?: string }): void;
  /** Every named check of `sha` completed with `conclusion`. */
  checks(sha: string, conclusion: 'success' | 'failure', ...names: string[]): void;
  /** The `pull_request_target` payload of pull request `n`, as it is now. */
  prEvent(n: number, action?: string, extra?: Record<string, unknown>): unknown;
  input(eventName: string, event: unknown, overrides?: Partial<JudgeInput>): JudgeInput;
  judge(eventName: string, event: unknown, overrides?: Partial<JudgeInput>): ReturnType<typeof runJudge>;
  /** Judges the `pull_request_target` event of pull request `n`. */
  judgePr(n: number, action?: string, overrides?: Partial<JudgeInput>): ReturnType<typeof runJudge>;
}

export interface WorldOptions {
  /** The recipe of main. */
  readonly mainRecipe: string;
  /** The action input `branches`; by default the branches of §1.1. `null` leaves it out. */
  readonly branches?: readonly string[] | null;
  /**
   * B1 (delta review of the flock fixes): `fetchObjects` really runs `git fetch <bare> <sha>…`
   * from a separate bare remote, instead of only recording the SHAs. Every object of the checkout
   * is reachable there (the bare remote borrows the checkout's objects); `commitRemote` adds
   * commits that only the remote has.
   */
  readonly remote?: boolean;
}

export function branchWorld(options: WorldOptions): BranchWorld {
  const root = repository({
    '.ai-workflows/pipeline.yml': options.mainRecipe,
    'ran.mjs': 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", "ran");\n',
    'app/page.tsx': 'export const page = 1;\n',
    'README.md': 'proyecto\n',
  });
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const github = new BranchesGitHub();
  github.heads.set('main', [main]);
  const fetched: string[] = [];
  const branches = options.branches === undefined ? ['staging', 'main'] : options.branches;
  let bare: string | undefined;
  let work: string | undefined;
  if (options.remote === true) {
    bare = join(emptyFolder(), 'remote.git');
    git(root, 'clone', '-q', '--bare', '--shared', root, bare);
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    work = join(emptyFolder(), 'work');
    git(root, 'clone', '-q', '--shared', '-c', 'core.autocrlf=false', root, work);
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'core.autocrlf', 'false');
    git(work, 'config', 'commit.gpgsign', 'false');
  }
  let remoteCommits = 0;

  const self: BranchWorld = {
    root,
    main,
    github,
    fetched,
    commitOn(from, files, message = 'cambio') {
      git(root, 'switch', '-q', '--detach', from);
      for (const [path, content] of Object.entries(files)) {
        if (content === null) git(root, 'rm', '-q', path);
        else write(root, path, content);
      }
      const sha = commit(root, message);
      git(root, 'switch', '-q', 'main');
      return sha;
    },
    commitRemote(from, files, message = 'cambio remoto', merge) {
      if (bare === undefined || work === undefined) throw new Error('commitRemote needs remote: true');
      git(work, 'switch', '-q', '--detach', from);
      if (merge !== undefined) git(work, 'merge', '-q', '--no-ff', '--no-edit', merge);
      for (const [path, content] of Object.entries(files)) {
        if (content === null) git(work, 'rm', '-q', path);
        else write(work, path, content);
      }
      const sha = commit(work, message);
      remoteCommits += 1;
      git(work, 'push', '-q', bare, `HEAD:refs/heads/remote-${remoteCommits}`);
      return sha;
    },
    hasObject(sha) {
      try {
        git(root, 'cat-file', '-e', `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    setBranch(branch, ...tips) {
      github.heads.set(branch, [...tips]);
    },
    pr(n, pr) {
      github.prs.set(n, {
        number: n,
        state: pr.state ?? 'open',
        headSha: pr.head,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        headRepo: pr.headRepo ?? REPO,
      });
    },
    checks(sha, conclusion, ...names) {
      for (const name of names) github.setCheck(sha, name, conclusion);
    },
    prEvent(n, action = 'synchronize', extra = {}) {
      const pr = github.prs.get(n);
      if (pr === undefined) throw new Error(`no PR ${n}`);
      return {
        action,
        number: n,
        pull_request: {
          number: n,
          state: pr.state,
          head: { sha: pr.headSha, ref: pr.headRef, repo: { full_name: pr.headRepo } },
          base: { ref: pr.baseRef, sha: github.heads.get(pr.baseRef)?.[0] ?? main },
        },
        repository: { full_name: REPO, default_branch: 'main' },
        ...extra,
      };
    },
    input(eventName, event, overrides = {}) {
      return {
        eventName,
        event,
        mode: 'on',
        context: 'ai-workflows',
        repository: REPO,
        workflowRef: `${REPO}/${WORKFLOW}@refs/heads/main`,
        actionRef: ACTION_REF,
        runId: RUN,
        serverUrl: 'https://github.com',
        alsoProtect: [],
        root,
        ...(branches === null ? {} : { branches }),
        ...overrides,
      } as JudgeInput;
    },
    judge(eventName, event, overrides = {}) {
      return runJudge(self.input(eventName, event, overrides), {
        github,
        sleep: async () => {},
        fetchObjects: async (shas) => {
          fetched.push(...shas);
          if (bare !== undefined && shas.length > 0) git(root, 'fetch', '-q', '--no-tags', bare, ...shas);
        },
      });
    },
    judgePr(n, action = 'synchronize', overrides = {}) {
      return self.judge('pull_request_target', self.prEvent(n, action), overrides);
    },
  };
  return self;
}
