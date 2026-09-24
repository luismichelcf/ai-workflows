import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type AgentGitHub,
  type AgentPullRequest,
  type BlockDefinition,
  type CheckRunSummary,
  type CommitStatus,
  type IssueComment,
  type JournalEntry,
  type PullRequestHistoryItem,
  type PullRequestReview,
  type RemoteGit,
  type RunOutcome,
  type Store,
} from '../src/index.js';

import { commit, git, repository, write } from './git-fixtures.js';

// PLAN-13-R4 §3: a GitHub that the final blocks can talk to without a network. It keeps the
// state the reconciliation of §3.0.1 reads — branches with their activity, pull requests with
// their history, issue comments, reviews, checks and deployments — and lets a test make any call
// fail BEFORE doing anything or AFTER doing it (the crash between an effect and its record).
// Everything the engine does to GitHub goes through `AgentGitHub` and `RemoteGit`, so this is the
// whole external edge; git itself stays real.

export const AGENT = 'mi-motor[bot]';
export const OWNER = 'duena';
export const REPO = 'duena/proyecto';
export const BRANCH = 'feat/13-algo';
export const PIECE = '13';

type Mutation =
  | 'push'
  | 'deleteBranch'
  | 'createDraftPullRequest'
  | 'markReady'
  | 'enableAutoMerge'
  | 'commentOnIssue';

export interface Failure {
  readonly when: 'before' | 'after';
  /** How many calls of this kind succeed first. */
  readonly skip?: number;
}

export class FakeGitHub implements AgentGitHub, RemoteGit {
  readonly branches = new Map<string, string>();
  readonly activity: { branch: string; type: string; actor: string; before: string; after: string; at: string }[] = [];
  readonly prs: AgentPullRequest[] = [];
  readonly history = new Map<number, PullRequestHistoryItem[]>();
  readonly issueCommentsOf = new Map<number, IssueComment[]>();
  readonly reviewsOf = new Map<number, PullRequestReview[]>();
  readonly checkRunsOf = new Map<string, CheckRunSummary[]>();
  readonly statusesOf = new Map<string, CommitStatus[]>();
  readonly deploymentsOf: { id: number; sha: string; environment: string; creator: string; state?: string; url?: string | null }[] = [];
  readonly calls: Record<Mutation, number> = {
    push: 0,
    deleteBranch: 0,
    createDraftPullRequest: 0,
    markReady: 0,
    enableAutoMerge: 0,
    commentOnIssue: 0,
  };
  readonly failures = new Map<Mutation, Failure>();
  /** Read errors to raise, by method name, one per call, before answering. */
  readonly readErrors = new Map<string, number>();
  /** Called on every `pullRequestDetail`, to move the pull request forward as GitHub would. */
  onDetail: ((pr: AgentPullRequest, reads: number) => void) | undefined;
  private detailReads = 0;
  private clock = Date.parse('2026-09-24T10:00:00Z');
  private nextNumber = 100;
  private nextComment = 1000;

  at(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private mutate<T>(kind: Mutation, perform: () => T): T {
    const failure = this.failures.get(kind);
    const count = this.calls[kind];
    if (failure !== undefined && count >= (failure.skip ?? 0)) {
      this.failures.delete(kind);
      if (failure.when === 'before') throw new Error(`connection lost before ${kind}`);
      this.calls[kind] += 1;
      perform();
      throw new Error(`connection lost after ${kind}`);
    }
    this.calls[kind] += 1;
    return perform();
  }

  private read(method: string): void {
    const pending = this.readErrors.get(method) ?? 0;
    if (pending > 0) {
      this.readErrors.set(method, pending - 1);
      throw new Error(`gh could not read ${method}`);
    }
  }

  // RemoteGit ----------------------------------------------------------------------------------

  async branchHead(branch: string): Promise<string | undefined> {
    this.read('branchHead');
    return this.branches.get(branch);
  }

  async push(branch: string, sha: string): Promise<void> {
    this.mutate('push', () => {
      const before = this.branches.get(branch) ?? '0'.repeat(40);
      this.branches.set(branch, sha);
      this.activity.push({ branch, type: before === '0'.repeat(40) ? 'branch_creation' : 'push', actor: AGENT, before, after: sha, at: this.at() });
    });
  }

  async deleteBranch(branch: string, sha: string): Promise<void> {
    this.mutate('deleteBranch', () => {
      if (this.branches.get(branch) !== sha) throw new Error('stale info: the branch moved');
      this.branches.delete(branch);
      this.activity.push({ branch, type: 'branch_deletion', actor: AGENT, before: sha, after: '0'.repeat(40), at: this.at() });
    });
  }

  /** A person moves or recreates a branch by hand. */
  humanPush(branch: string, sha: string | undefined): void {
    const before = this.branches.get(branch) ?? '0'.repeat(40);
    if (sha === undefined) this.branches.delete(branch);
    else this.branches.set(branch, sha);
    this.activity.push({ branch, type: sha === undefined ? 'branch_deletion' : 'push', actor: OWNER, before, after: sha ?? '0'.repeat(40), at: this.at() });
  }

  // AgentGitHub: reads ---------------------------------------------------------------------------

  async defaultBranch(): Promise<string> {
    return 'main';
  }

  async branchActivity(branch: string) {
    this.read('branchActivity');
    return this.activity
      .filter((item) => item.branch === branch)
      .map(({ type, actor, before, after, at }) => ({ type, actor, before, after, at }));
  }

  async pullRequestsOfBranch(branch: string): Promise<AgentPullRequest[]> {
    this.read('pullRequestsOfBranch');
    return this.prs.filter((pr) => pr.headRef === branch).map((pr) => ({ ...pr }));
  }

  async pullRequestDetail(n: number): Promise<AgentPullRequest> {
    this.read('pullRequestDetail');
    const pr = this.prs.find((item) => item.number === n);
    if (pr === undefined) throw new Error(`no pull request ${n}`);
    this.detailReads += 1;
    this.onDetail?.(pr, this.detailReads);
    return { ...pr };
  }

  async pullRequestHistory(n: number): Promise<PullRequestHistoryItem[]> {
    this.read('pullRequestHistory');
    return [...(this.history.get(n) ?? [])];
  }

  async issueTitle(n: number): Promise<string> {
    return `Pieza ${n}`;
  }

  async issueComments(n: number): Promise<IssueComment[]> {
    this.read('issueComments');
    return [...(this.issueCommentsOf.get(n) ?? [])];
  }

  async comments(n: number) {
    return (this.issueCommentsOf.get(n) ?? []).map((item) => ({
      id: item.id,
      body: item.body,
      author: item.author,
      authorType: item.authorType,
      viaApp: item.viaApp !== null,
      createdAt: item.createdAt,
      edited: item.createdAt !== item.updatedAt,
    })) as never;
  }

  async reviews(n: number): Promise<PullRequestReview[]> {
    this.read('reviews');
    return [...(this.reviewsOf.get(n) ?? [])];
  }

  /** Check runs by `<sha>|<name>`, newest last, as a test sets them. */
  async checkRuns(sha: string, name: string): Promise<CheckRunSummary[]> {
    return [...(this.checkRunsOf.get(`${sha}|${name}`) ?? [])];
  }

  async statuses(sha: string): Promise<CommitStatus[]> {
    return [...(this.statusesOf.get(sha) ?? [])];
  }

  async forcePushedHeads(): Promise<string[]> {
    return [];
  }

  async deployments(sha: string, environment: string) {
    this.read('deployments');
    return this.deploymentsOf
      .filter((item) => item.sha === sha && item.environment === environment)
      .map(({ id, sha: itemSha, creator }) => ({ id, sha: itemSha, creator }));
  }

  async deploymentState(id: number) {
    const found = this.deploymentsOf.find((item) => item.id === id);
    if (found?.state === undefined) return undefined;
    return { state: found.state, url: found.url ?? null };
  }

  // AgentGitHub: writes --------------------------------------------------------------------------

  async createDraftPullRequest(o: { branch: string; base: string; title: string; body: string }): Promise<number> {
    return this.mutate('createDraftPullRequest', () => {
      const number = this.nextNumber++;
      this.prs.push({
        number,
        url: `https://github.com/${REPO}/pull/${number}`,
        state: 'OPEN',
        isDraft: true,
        headSha: this.branches.get(o.branch) ?? '',
        headRef: o.branch,
        headRepo: REPO,
        baseRef: o.base,
        author: AGENT,
        body: o.body,
        mergeCommit: null,
        autoMerge: false,
        inMergeQueue: false,
      });
      this.history.set(number, [{ type: 'head-changed', actor: AGENT, at: this.at() }]);
      return number;
    });
  }

  async markReady(pr: number): Promise<void> {
    this.mutate('markReady', () => {
      const found = this.prs.find((item) => item.number === pr);
      if (found === undefined) throw new Error('no such pull request');
      Object.assign(found, { isDraft: false });
      this.history.get(pr)?.push({ type: 'ready', actor: AGENT, at: this.at() });
    });
  }

  async enableAutoMerge(pr: number, o: { method: string; headSha: string }): Promise<void> {
    this.mutate('enableAutoMerge', () => {
      const found = this.prs.find((item) => item.number === pr);
      if (found === undefined) throw new Error('no such pull request');
      if (found.headSha !== o.headSha) throw new Error('head moved');
      Object.assign(found, { autoMerge: true, mergeMethod: o.method });
      this.history.get(pr)?.push({ type: 'auto-merge-enabled', actor: AGENT, at: this.at() });
    });
  }

  async commentOnIssue(n: number, body: string): Promise<number> {
    return this.mutate('commentOnIssue', () => {
      const id = this.nextComment++;
      const at = this.at();
      const list = this.issueCommentsOf.get(n) ?? [];
      list.push({ id, author: AGENT, authorType: 'Bot', viaApp: 'mi-motor', body, createdAt: at, updatedAt: at });
      this.issueCommentsOf.set(n, list);
      return id;
    });
  }

  // Helpers for tests ------------------------------------------------------------------------------

  /** GitHub merges the pull request: its state, merge commit and history. */
  merge(pr: AgentPullRequest, mergeSha = 'f'.repeat(40)): void {
    const found = this.prs.find((item) => item.number === pr.number) ?? pr;
    Object.assign(found, { state: 'MERGED', mergeCommit: mergeSha, autoMerge: false, inMergeQueue: false });
    this.history.get(found.number)?.push({ type: 'merged', actor: null, at: this.at() });
  }

  addPullRequest(over: Partial<AgentPullRequest> & { number: number }): AgentPullRequest {
    const pr: AgentPullRequest = {
      url: `https://github.com/${REPO}/pull/${over.number}`,
      state: 'OPEN',
      isDraft: false,
      headSha: '',
      headRef: BRANCH,
      headRepo: REPO,
      baseRef: 'main',
      author: AGENT,
      body: `Refs #${PIECE}`,
      mergeCommit: null,
      autoMerge: false,
      inMergeQueue: false,
      ...over,
    };
    this.prs.push(pr);
    this.history.set(pr.number, [{ type: 'head-changed', actor: pr.author, at: this.at() }]);
    return pr;
  }
}

// ---------------------------------------------------------------------------------------------
// A piece on its branch, and a run of the recipe over it

/** A repository on `feat/13-algo` with one commit of its own over `main`. */
export function pieceRepository(files: Readonly<Record<string, string>> = { 'src/algo.ts': 'export const algo = 2;\n' }): { root: string; head: string } {
  const root = repository({ 'src/algo.ts': 'export const algo = 1;\n', 'docs/plans/PLAN-13.md': '# Plan\n\n## Casos de aceptación\n\n- CA-01 entra\n- CA-02 sale\n' });
  git(root, 'switch', '-q', '-c', BRANCH);
  git(root, 'branch', '-q', '-D', 'piece');
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  return { root, head: commit(root, 'la pieza') };
}

export const HEADER = [
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  `agent-account: "${AGENT}"`,
  'pieces: { branch: ["*/{piece}-*"] }',
];

const hold: BlockDefinition = {
  manifest: { name: 'hold', kind: 'module', natures: ['recompute'], server: [], inputs: {} },
  create: () => () => ({ ok: false, reason: 'held on purpose' }),
};

export interface FinalRun {
  readonly outcome: RunOutcome;
  readonly journal: readonly JournalEntry[];
  entryOf(stage: string): JournalEntry | undefined;
  again(): Promise<FinalRun>;
}

export interface FinalRunOptions {
  readonly store?: Store;
  readonly declared?: Record<string, unknown>;
  readonly locale?: string;
  /** The waits of retries and polls; by default they return at once and advance a fake clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Runs `stages` (YAML rows under `stages:`) for piece 13 over `root`, talking to `github`. */
export async function runFinal(
  root: string,
  github: FakeGitHub,
  stages: readonly string[],
  options: FinalRunOptions = {},
): Promise<FinalRun> {
  const text = `${[...HEADER.map((row) => (row === 'locale: es' ? `locale: ${options.locale ?? 'es'}` : row)), 'stages:', ...stages].join('\n')}\n`;
  const parsed = parseRecipe(text, 'receta.yml');
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  const store = options.store ?? createMemoryStore();
  // The waits of polls and retries advance a clock of their own, so a time limit is reached
  // without sleeping; a test can still watch or interrupt each wait.
  let clock = Date.parse('2026-09-24T10:00:00Z');
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    clock += ms;
    await options.sleep?.(ms, signal);
  };
  const now = (): number => clock;
  const compiled = await compileRecipe(parsed.recipe, {
    root,
    baseRef: 'main',
    declared: () => options.declared ?? {},
    store,
    extraBlocks: { 'ai-workflows/hold@1': hold },
    agent: { github, remote: github, sleep, now, repository: REPO },
  });
  const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, sleep });
  const once = async (): Promise<FinalRun> => {
    const outcome = await engine.run(PIECE);
    const journal = await store.journal(PIECE);
    return {
      outcome,
      journal,
      entryOf: (stage) => [...journal].reverse().find((item) => item.stage === stage),
      again: once,
    };
  };
  return once();
}

/** The merge stage alone, held afterwards so a pass ends at `after`. */
export const MERGE_STAGES = (withRow = '      with: { method: squash }') => [
  '  - id: merge',
  '    summary: "Se fusiona"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  withRow,
  '  - id: after',
  '    summary: "Espera"',
  '    after: merge',
  '    phase: post-merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/hold@1',
  '    server: local-only',
];
