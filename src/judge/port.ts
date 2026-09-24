// The judge's edge with GitHub (PLAN-13-R3 §3.2, §3.4, §3.7 and §6): the port through which the
// judge reads pull requests, the merge queue, comments, check-runs, statuses and runs, and through
// which it publishes a status and keeps its trace comment. Everything goes through a `GhRunner`,
// never a console. What can go wrong in the translation is caught here: a queue list that cannot be
// confirmed, unreadable JSON, a comment that does not say who wrote it, a status description longer
// than GitHub allows, and values that reach GraphQL as variables instead of spliced into the query.

import { createGhRunner, type GhRun, type GhRunner } from '../gh-runner.js';
import type { IssueComment } from '../agent/events.js';
import type { PullRequestReview } from '../approval/review.js';
import type { PullRequestComment } from '../locks/signoff.js';

/** A pull request as the judge reads it. Every field is text: a missing one is refused, not guessed. */
export interface JudgePullRequest {
  readonly number: number;
  readonly state: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headRepo: string;
}

/** One entry of the merge queue, in the shape the judge compares against a group. */
export interface MergeQueueEntry {
  readonly position: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly prNumber: number;
}

/**
 * Thrown when a merge queue entry already exists but the queue is still assembling it: the entry
 * does not yet carry its head or base commit (PLAN-13-R3 §3.2). It is not a list that cannot be
 * confirmed, but a list that is not ready yet, so the caller reads it again.
 */
export class MergeQueueNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeQueueNotReady';
  }
}

/** One check-run of the name the judge asked for. */
export interface CheckRunSummary {
  /**
   * The check-run's own id: among several runs of one name, the most recent is the one with the
   * greatest id. The GitHub API always sends it; a fixture may omit it, and a run that cannot be
   * placed by id is only ever tolerated when it is the single run of that name.
   */
  readonly id?: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app: string;
  readonly url: string | null;
}

/** One commit status, as `require-check` reads it. */
export interface CommitStatus {
  readonly context: string;
  readonly state: string;
  readonly targetUrl: string | null;
  readonly createdAt: string;
}

/**
 * The judge's whole edge with GitHub. Implemented over `createGhRunner`, tested over a fake
 * runner: the runner is the only external thing the port touches.
 */
export interface JudgeGitHub {
  defaultBranch(): Promise<string>;
  branchHead(branch: string): Promise<string>;
  pullRequest(n: number): Promise<JudgePullRequest>;
  openPullRequestsWithHead(sha: string): Promise<number[]>;
  /** Throws when the queue list cannot be confirmed. An empty queue is `[]`. */
  mergeQueue(branch: string): Promise<MergeQueueEntry[]>;
  comments(n: number): Promise<PullRequestComment[]>;
  /** Every comment on an issue, with the fields the event rules depend on. */
  issueComments(n: number): Promise<IssueComment[]>;
  /** Every review of a pull request, in submission order. */
  reviews(n: number): Promise<PullRequestReview[]>;
  checkRuns(sha: string, name: string): Promise<CheckRunSummary[]>;
  /** Newest first, by `created_at`. */
  statuses(sha: string): Promise<CommitStatus[]>;
  workflowRun(id: number): Promise<{ path: string; event: string; headBranch?: string } | undefined>;
  /** Throws when the timeline cannot be confirmed. */
  forcePushedHeads(n: number): Promise<string[]>;
  publishStatus(
    sha: string,
    s: { readonly context: string; readonly state: string; readonly description: string; readonly targetUrl: string },
  ): Promise<void>;
  upsertTraceComment(n: number, body: string): Promise<void>;
}

export interface JudgeGitHubOptions {
  /** `owner/name`, as GitHub reports it. */
  readonly repository: string;
  /** Defaults to `createGhRunner()`. */
  readonly runner?: GhRunner;
}

/** GitHub's own limit on a commit status description. */
const STATUS_DESCRIPTION_LIMIT = 140;

/** The mark that names the judge's trace comment, so its own comment can be found and updated. */
const TRACE_MARKER = '<!-- ai-workflows:trace -->';

// The queue list. `owner`, `name` and `branch` are GraphQL variables: the query text carries none
// of the values the caller supplies, so a value with quotes or braces cannot shape the query.
const MERGE_QUEUE_QUERY = `query MergeQueue($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          position
          headCommit { oid }
          baseCommit { oid }
          pullRequest { number }
        }
      }
    }
  }
}`;

// The heads a force push replaced, read off the pull request timeline so an approval can survive a
// rebuild with the same fingerprint (§3.6).
const FORCE_PUSH_TIMELINE_QUERY = `query ForcePushedHeads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on HeadRefForcePushedEvent {
            beforeCommit { oid }
          }
        }
      }
    }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[field];
  return typeof found === 'string' ? found : undefined;
}

function recordField(value: unknown, field: string): Record<string, unknown> | undefined {
  const found = isRecord(value) ? value[field] : undefined;
  return isRecord(found) ? found : undefined;
}

function arrayField(value: unknown, field: string): unknown[] | undefined {
  const found = isRecord(value) ? value[field] : undefined;
  return Array.isArray(found) ? found : undefined;
}

/** The reason a failed call carries, never an empty message. */
function failureMessage(result: GhRun): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  const stdout = result.stdout.trim();
  if (stdout.length > 0) return stdout;
  return `gh exited with code ${String(result.exitCode)}`;
}

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`gh returned output that is not JSON for ${what}: ${stdout.trim().slice(0, 200)}`);
  }
}

/** A call must have succeeded and answered JSON: anything else is a failure, never a silent one. */
function ensureOk(result: GhRun, what: string): unknown {
  if (result.exitCode !== 0) {
    throw new Error(`gh failed while reading ${what}: ${failureMessage(result)}`);
  }
  return parseJson(result.stdout, what);
}

/** Flattens the pages `--paginate --slurp` produces: the answer is a list of lists. */
function flattenPages(parsed: unknown, what: string): unknown[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`gh did not return a list of pages for ${what}.`);
  }
  const items: unknown[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) {
      throw new Error(`gh returned a page for ${what} that is not a list.`);
    }
    for (const item of page) items.push(item);
  }
  return items;
}

/** A description cut to GitHub's limit, counted in code points so no surrogate pair is split. */
function truncateCodePoints(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : points.slice(0, limit).join('');
}

function parseRepository(repository: string): { readonly owner: string; readonly name: string } {
  const parts = repository.split('/');
  const owner = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`The repository "${repository}" is not "owner/name".`);
  }
  return { owner, name };
}

export function createJudgeGitHub(options: JudgeGitHubOptions): JudgeGitHub {
  const { owner, name } = parseRepository(options.repository);
  const run = options.runner ?? createGhRunner();
  const base = `repos/${owner}/${name}`;

  /** The raw comment, with its id and author: `comments` drops both, but the trace needs them. */
  interface RawComment {
    readonly id: string;
    readonly body: string;
    readonly author: string | undefined;
    readonly authorType: string | undefined;
  }

  async function readRawComments(n: number): Promise<RawComment[]> {
    const parsed = ensureOk(
      await run(['api', `${base}/issues/${n}/comments`, '--paginate', '--slurp']),
      `the comments of pull request ${String(n)}`,
    );
    const comments: RawComment[] = [];
    for (const item of flattenPages(parsed, `the comments of pull request ${String(n)}`)) {
      const body = textField(item, 'body');
      if (body === undefined) {
        throw new Error(`gh returned a comment on pull request ${String(n)} without a body.`);
      }
      const id = isRecord(item) ? item['id'] : undefined;
      if (typeof id !== 'number' && typeof id !== 'string') {
        throw new Error(`gh returned a comment on pull request ${String(n)} without an id.`);
      }
      const user = recordField(item, 'user');
      comments.push({
        id: String(id),
        body,
        author: user === undefined ? undefined : textField(user, 'login'),
        authorType: user === undefined ? undefined : textField(user, 'type'),
      });
    }
    return comments;
  }

  async function graphql(
    query: string,
    variables: readonly [string, string][],
    intVariables: readonly [string, number][],
    what: string,
  ): Promise<unknown> {
    const args: string[] = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of variables) args.push('-f', `${key}=${value}`);
    for (const [key, value] of intVariables) args.push('-F', `${key}=${String(value)}`);
    return ensureOk(await run(args), what);
  }

  return {
    async defaultBranch(): Promise<string> {
      const parsed = ensureOk(await run(['api', base]), 'the default branch');
      const branch = textField(parsed, 'default_branch');
      if (branch === undefined) {
        throw new Error('gh did not report the default branch of the repository.');
      }
      return branch;
    },

    async branchHead(branch: string): Promise<string> {
      const parsed = ensureOk(await run(['api', `${base}/branches/${branch}`]), `the head of ${branch}`);
      const sha = textField(recordField(parsed, 'commit'), 'sha');
      if (sha === undefined) {
        throw new Error(`gh did not report the head commit of ${branch}.`);
      }
      return sha;
    },

    async pullRequest(n: number): Promise<JudgePullRequest> {
      const parsed = ensureOk(await run(['api', `${base}/pulls/${String(n)}`]), `pull request ${String(n)}`);
      const number = isRecord(parsed) ? parsed['number'] : undefined;
      const state = textField(parsed, 'state');
      const head = recordField(parsed, 'head');
      const headSha = textField(head, 'sha');
      const headRef = textField(head, 'ref');
      const headRepo = textField(recordField(head, 'repo'), 'full_name');
      const baseRef = textField(recordField(parsed, 'base'), 'ref');
      if (typeof number !== 'number') {
        throw new Error(`gh did not report the number of pull request ${String(n)}.`);
      }
      if (state === undefined || headSha === undefined || headRef === undefined || headRepo === undefined || baseRef === undefined) {
        throw new Error(`gh returned pull request ${String(n)} without its state or head and base references.`);
      }
      return { number, state, headSha, headRef, baseRef, headRepo };
    },

    async openPullRequestsWithHead(sha: string): Promise<number[]> {
      const parsed = ensureOk(
        await run(['api', `${base}/commits/${sha}/pulls`, '--paginate', '--slurp']),
        `the pull requests with head ${sha}`,
      );
      const numbers: number[] = [];
      for (const item of flattenPages(parsed, `the pull requests with head ${sha}`)) {
        if (!isRecord(item) || item['state'] !== 'open') continue;
        if (textField(recordField(item, 'head'), 'sha') !== sha) continue;
        const number = item['number'];
        if (typeof number !== 'number') {
          throw new Error(`gh returned a pull request with head ${sha} without a number.`);
        }
        numbers.push(number);
      }
      return numbers;
    },

    async mergeQueue(branch: string): Promise<MergeQueueEntry[]> {
      const parsed = await graphql(
        MERGE_QUEUE_QUERY,
        [
          ['owner', owner],
          ['name', name],
          ['branch', branch],
        ],
        [],
        `the merge queue of ${branch}`,
      );
      const entries = recordField(recordField(recordField(recordField(parsed, 'data'), 'repository'), 'mergeQueue'), 'entries');
      const pageInfo = recordField(entries, 'pageInfo');
      const hasNextPage = pageInfo === undefined ? undefined : pageInfo['hasNextPage'];
      if (typeof hasNextPage !== 'boolean') {
        throw new Error(`gh did not report whether the merge queue of ${branch} has another page.`);
      }
      if (hasNextPage) {
        throw new Error(
          `The merge queue of ${branch} does not fit in one page: the list cannot be confirmed, so it is refused.`,
        );
      }
      const nodes = entries === undefined ? undefined : entries['nodes'];
      if (!Array.isArray(nodes)) {
        throw new Error(`gh did not report a list of merge queue entries for ${branch}.`);
      }
      const seen = new Set<number>();
      const result: MergeQueueEntry[] = [];
      for (const node of nodes) {
        const position = isRecord(node) ? node['position'] : undefined;
        if (typeof position !== 'number' || !Number.isInteger(position) || position <= 0) {
          throw new Error(`The merge queue of ${branch} has an entry whose position is not a positive integer.`);
        }
        if (seen.has(position)) {
          throw new Error(`The merge queue of ${branch} repeats the position ${String(position)}: the list cannot be confirmed.`);
        }
        seen.add(position);
        const prNumber = recordField(node, 'pullRequest')?.['number'];
        if (typeof prNumber !== 'number') {
          throw new Error(`A merge queue entry of ${branch} is missing its pull request.`);
        }
        // The queue can list an entry before it has finished building it: an entry without its head
        // or base commit is not a list that cannot be confirmed, but one that is not ready yet.
        const headSha = textField(recordField(node, 'headCommit'), 'oid');
        const baseSha = textField(recordField(node, 'baseCommit'), 'oid');
        if (headSha === undefined || baseSha === undefined) {
          throw new MergeQueueNotReady(
            `A merge queue entry of ${branch} does not carry its head or base commit yet.`,
          );
        }
        result.push({ position, headSha, baseSha, prNumber });
      }
      result.sort((a, b) => a.position - b.position);
      return result;
    },

    async comments(n: number): Promise<PullRequestComment[]> {
      const parsed = ensureOk(
        await run(['api', `${base}/issues/${String(n)}/comments`, '--paginate', '--slurp']),
        `the comments of pull request ${String(n)}`,
      );
      const comments: PullRequestComment[] = [];
      for (const item of flattenPages(parsed, `the comments of pull request ${String(n)}`)) {
        const body = textField(item, 'body');
        const user = recordField(item, 'user');
        const author = textField(user, 'login');
        const authorType = textField(user, 'type');
        const createdAt = textField(item, 'created_at');
        const updatedAt = textField(item, 'updated_at');
        if (body === undefined || author === undefined || authorType === undefined || createdAt === undefined || updatedAt === undefined) {
          throw new Error(
            `gh returned a comment on pull request ${String(n)} without its body, author or dates: refusing to guess.`,
          );
        }
        const app = isRecord(item) ? item['performed_via_github_app'] : undefined;
        comments.push({
          body,
          author,
          authorType,
          performedViaApp: app !== null && app !== undefined,
          edited: updatedAt !== createdAt,
        });
      }
      return comments;
    },

    async issueComments(n: number): Promise<IssueComment[]> {
      const parsed = ensureOk(
        await run(['api', `${base}/issues/${String(n)}/comments`, '--paginate', '--slurp']),
        `the comments of issue ${String(n)}`,
      );
      const comments: IssueComment[] = [];
      for (const item of flattenPages(parsed, `the comments of issue ${String(n)}`)) {
        const body = textField(item, 'body');
        const id = isRecord(item) ? item['id'] : undefined;
        const user = recordField(item, 'user');
        const author = textField(user, 'login');
        const authorType = textField(user, 'type');
        const createdAt = textField(item, 'created_at');
        const updatedAt = textField(item, 'updated_at');
        if (
          body === undefined
          || typeof id !== 'number'
          || author === undefined
          || authorType === undefined
          || createdAt === undefined
          || updatedAt === undefined
        ) {
          throw new Error(`gh returned a comment on issue ${String(n)} without its id, body, author or dates.`);
        }
        const viaApp = textField(isRecord(item) ? item['performed_via_github_app'] : undefined, 'slug');
        comments.push({
          id,
          author,
          authorType: authorType === 'Bot' ? 'Bot' : 'User',
          viaApp: viaApp ?? null,
          body,
          createdAt,
          updatedAt,
        });
      }
      return comments;
    },

    async reviews(n: number): Promise<PullRequestReview[]> {
      const parsed = ensureOk(
        await run(['api', `${base}/pulls/${String(n)}/reviews`, '--paginate', '--slurp']),
        `the reviews of pull request ${String(n)}`,
      );
      const reviews: PullRequestReview[] = [];
      for (const item of flattenPages(parsed, `the reviews of pull request ${String(n)}`)) {
        const user = recordField(item, 'user');
        const author = textField(user, 'login');
        const authorType = textField(user, 'type');
        const state = textField(item, 'state');
        const commitId = textField(item, 'commit_id');
        const submittedAt = textField(item, 'submitted_at');
        if (
          author === undefined
          || authorType === undefined
          || state === undefined
          || commitId === undefined
          || submittedAt === undefined
        ) {
          throw new Error(`gh returned a review of pull request ${String(n)} without its author, state, commit or date.`);
        }
        reviews.push({
          author,
          authorType: authorType === 'Bot' ? 'Bot' : 'User',
          state,
          commitId,
          submittedAt,
        });
      }
      reviews.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
      return reviews;
    },

    async checkRuns(sha: string, checkName: string): Promise<CheckRunSummary[]> {
      const parsed = ensureOk(
        await run([
          'api',
          `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=latest&per_page=100`,
          '--paginate',
          '--slurp',
        ]),
        `the check runs named ${checkName}`,
      );
      if (!Array.isArray(parsed)) {
        throw new Error(`gh did not return a list of pages for the check runs named ${checkName}.`);
      }
      const runs: CheckRunSummary[] = [];
      for (const page of parsed) {
        const pageRuns = arrayField(page, 'check_runs');
        if (pageRuns === undefined) continue;
        for (const runItem of pageRuns) {
          const name = textField(runItem, 'name');
          if (name !== checkName) continue;
          const status = textField(runItem, 'status');
          const app = textField(recordField(runItem, 'app'), 'slug');
          if (status === undefined || app === undefined) {
            throw new Error(`gh returned a check run named ${checkName} without its status or app.`);
          }
          const rawId = isRecord(runItem) ? runItem['id'] : undefined;
          if (rawId !== undefined && rawId !== null && (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0)) {
            throw new Error(`gh returned a check run named ${checkName} with an id that is not a positive integer.`);
          }
          const id = typeof rawId === 'number' ? rawId : undefined;
          const conclusion = isRecord(runItem) ? runItem['conclusion'] : undefined;
          if (conclusion !== null && conclusion !== undefined && typeof conclusion !== 'string') {
            throw new Error(`gh returned a check run named ${checkName} with a conclusion that is not text.`);
          }
          const url = textField(runItem, 'html_url');
          runs.push({
            ...(id === undefined ? {} : { id }),
            status,
            conclusion: typeof conclusion === 'string' ? conclusion : null,
            app,
            url: url === undefined ? null : url,
          });
        }
      }
      // Several runs of one name must be ordered by id to tell which is the most recent: a run
      // without an id leaves that undecidable, so the list is refused rather than guessed.
      if (runs.length > 1 && runs.some((entry) => entry.id === undefined)) {
        throw new Error(
          `gh returned several check runs named ${checkName} and at least one without an id: the most recent cannot be decided.`,
        );
      }
      return runs;
    },

    async statuses(sha: string): Promise<CommitStatus[]> {
      const parsed = ensureOk(
        await run(['api', `${base}/commits/${sha}/statuses`, '--paginate', '--slurp']),
        `the statuses of ${sha}`,
      );
      const statuses: CommitStatus[] = [];
      for (const item of flattenPages(parsed, `the statuses of ${sha}`)) {
        const context = textField(item, 'context');
        const state = textField(item, 'state');
        const createdAt = textField(item, 'created_at');
        if (context === undefined || state === undefined || createdAt === undefined) {
          throw new Error(`gh returned a status of ${sha} without its context, state or date.`);
        }
        const targetUrl = isRecord(item) ? item['target_url'] : undefined;
        statuses.push({
          context,
          state,
          targetUrl: typeof targetUrl === 'string' ? targetUrl : null,
          createdAt,
        });
      }
      statuses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return statuses;
    },

    async workflowRun(id: number): Promise<{ path: string; event: string; headBranch?: string } | undefined> {
      const result = await run(['api', `${base}/actions/runs/${String(id)}`]);
      if (result.exitCode !== 0) {
        const detail = result.stderr;
        if (/404/.test(detail) || /not found/i.test(detail)) return undefined;
        throw new Error(`gh failed while reading run ${String(id)}: ${failureMessage(result)}`);
      }
      const parsed = parseJson(result.stdout, `run ${String(id)}`);
      const path = textField(parsed, 'path');
      const event = textField(parsed, 'event');
      if (path === undefined || event === undefined) {
        throw new Error(`gh did not report the path and event of run ${String(id)}.`);
      }
      const headBranch = textField(parsed, 'head_branch');
      return headBranch === undefined ? { path, event } : { path, event, headBranch };
    },

    async forcePushedHeads(n: number): Promise<string[]> {
      const parsed = await graphql(
        FORCE_PUSH_TIMELINE_QUERY,
        [
          ['owner', owner],
          ['name', name],
        ],
        [['number', n]],
        `the force-pushed heads of pull request ${String(n)}`,
      );
      const repositoryNode = recordField(recordField(parsed, 'data'), 'repository');
      const pr = repositoryNode === undefined ? undefined : recordField(repositoryNode, 'pullRequest');
      if (pr === undefined) {
        throw new Error(`gh did not report pull request ${String(n)} while reading its timeline.`);
      }
      const timeline = recordField(pr, 'timelineItems');
      const pageInfo = recordField(timeline, 'pageInfo');
      const hasNextPage = pageInfo === undefined ? undefined : pageInfo['hasNextPage'];
      if (typeof hasNextPage !== 'boolean') {
        throw new Error(`gh did not report whether the timeline of pull request ${String(n)} has another page.`);
      }
      if (hasNextPage) {
        throw new Error(
          `The timeline of pull request ${String(n)} does not fit in one page: the list cannot be confirmed.`,
        );
      }
      const nodes = timeline === undefined ? undefined : timeline['nodes'];
      if (!Array.isArray(nodes)) {
        throw new Error(`gh did not report the timeline of pull request ${String(n)}.`);
      }
      const heads: string[] = [];
      for (const node of nodes) {
        if (!isRecord(node)) continue;
        const before = node['beforeCommit'];
        if (before === null || before === undefined) continue;
        const oid = textField(before, 'oid');
        if (oid === undefined) {
          throw new Error(`A force-push event of pull request ${String(n)} has a previous head without an oid.`);
        }
        heads.push(oid);
      }
      return heads;
    },

    async publishStatus(
      sha: string,
      s: { readonly context: string; readonly state: string; readonly description: string; readonly targetUrl: string },
    ): Promise<void> {
      const description = truncateCodePoints(s.description, STATUS_DESCRIPTION_LIMIT);
      ensureOk(
        await run([
          'api',
          `${base}/statuses/${sha}`,
          '--method',
          'POST',
          '-f',
          `state=${s.state}`,
          '-f',
          `context=${s.context}`,
          '-f',
          `description=${description}`,
          '-f',
          `target_url=${s.targetUrl}`,
        ]),
        `the status of ${sha}`,
      );
    },

    async upsertTraceComment(n: number, body: string): Promise<void> {
      const fullBody = `${TRACE_MARKER}\n${body}`;
      // Only the judge's own comment (the mark, written by the Actions bot) is reused; a planted
      // comment with the mark is ignored and a new one is created.
      const existing = (await readRawComments(n)).find(
        (comment) =>
          comment.body.startsWith(TRACE_MARKER) &&
          comment.author === 'github-actions[bot]' &&
          comment.authorType === 'Bot',
      );
      if (existing !== undefined) {
        ensureOk(
          await run([
            'api',
            `${base}/issues/comments/${existing.id}`,
            '--method',
            'PATCH',
            '-f',
            `body=${fullBody}`,
          ]),
          `the trace comment of pull request ${String(n)}`,
        );
        return;
      }
      ensureOk(
        await run([
          'api',
          `${base}/issues/${String(n)}/comments`,
          '--method',
          'POST',
          '-f',
          `body=${fullBody}`,
        ]),
        `the trace comment of pull request ${String(n)}`,
      );
    },
  };
}
