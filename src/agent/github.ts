// PLAN-13-R4 §9: the engine's edge with GitHub next to the agent, over `gh`. Every call carries
// the agents' token in its own environment (never in an argument), values reach GraphQL as
// variables, and a list that cannot be confirmed (another page, a missing field) throws instead
// of returning part of the truth. The methods the judge already knows are reused from its port.

import type { GhRunner, GhRunnerWithEnv, GhRun } from '../gh-runner.js';
import { createJudgeGitHub, type JudgeGitHub } from '../judge/port.js';

/** One pull request as the reconciliation of §3.0.1 reads it. */
export interface AgentPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepo: string;
  readonly baseRef: string;
  readonly author: string;
  readonly body: string;
  readonly mergeCommit: string | null;
  readonly autoMerge: boolean;
  readonly inMergeQueue: boolean;
}

/** One pull request timeline event the reconciliation reads. */
export interface PullRequestHistoryItem {
  readonly type: 'ready' | 'auto-merge-enabled' | 'added-to-queue' | 'merged' | 'head-changed';
  readonly actor: string | null;
  readonly at: string;
}

/** The git side the agents drive next to GitHub: push a branch, delete it, read its head. */
export interface RemoteGit {
  branchHead(branch: string): Promise<string | undefined>;
  push(branch: string, sha: string): Promise<void>;
  deleteBranch(branch: string, sha: string): Promise<void>;
}

/** Everything the agent blocks read from GitHub, plus everything the judge already reads. */
export interface AgentGitHub
  extends Pick<
    JudgeGitHub,
    'defaultBranch' | 'reviews' | 'issueComments' | 'comments' | 'checkRuns' | 'statuses' | 'forcePushedHeads'
  > {
  pullRequestsOfBranch(branch: string): Promise<AgentPullRequest[]>;
  pullRequestDetail(n: number): Promise<AgentPullRequest>;
  pullRequestHistory(n: number): Promise<PullRequestHistoryItem[]>;
  branchActivity(
    branch: string,
  ): Promise<{ readonly type: string; readonly actor: string | null; readonly before: string; readonly after: string; readonly at: string }[]>;
  createDraftPullRequest(o: {
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<number>;
  issueTitle(n: number): Promise<string>;
  markReady(pr: number): Promise<void>;
  enableAutoMerge(pr: number, o: { readonly method: string; readonly headSha: string }): Promise<void>;
  deployments(sha: string, environment: string): Promise<{ readonly id: number; readonly sha: string; readonly creator: string }[]>;
  deploymentState(id: number): Promise<{ readonly state: string; readonly url: string | null } | undefined>;
  commentOnIssue(n: number, body: string): Promise<number>;
}

export interface AgentGitHubOptions {
  /** `owner/name`, as GitHub reports it. */
  readonly repository: string;
  readonly runner: GhRunnerWithEnv;
  /** The agents' token for one call at a time; absent means the account `gh` is logged in as. */
  readonly token?: () => Promise<string>;
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record_ | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return isRecord(found) ? found : undefined;
}

function arrayField(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return Array.isArray(found) ? found : undefined;
}

function textField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
}

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
  if (result.exitCode !== 0) throw new Error(`gh failed while reading ${what}: ${failureMessage(result)}`);
  return parseJson(result.stdout, what);
}

/** Flattens the pages `--paginate --slurp` produces: the answer is a list of lists. */
function flattenPages(parsed: unknown, what: string): unknown[] {
  if (!Array.isArray(parsed)) throw new Error(`gh did not return a list of pages for ${what}.`);
  const items: unknown[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) throw new Error(`gh returned a page for ${what} that is not a list.`);
    for (const item of page) items.push(item);
  }
  return items;
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

/** A bot login as REST writes it: GraphQL omits the `[bot]` suffix GitHub shows. */
function authorLogin(actor: unknown): string {
  const login = textField(actor, 'login');
  if (login === undefined) throw new Error('a comment or event has no author login.');
  const type = textField(actor, '__typename');
  return type === 'Bot' && !login.endsWith('[bot]') ? `${login}[bot]` : login;
}

const PR_STATES: readonly string[] = ['OPEN', 'CLOSED', 'MERGED'];

function pullRequestNode(node: unknown, what: string): AgentPullRequest {
  const number = isRecord(node) ? node['number'] : undefined;
  const url = textField(node, 'url');
  const state = textField(node, 'state');
  const isDraft = isRecord(node) ? node['isDraft'] : undefined;
  const headSha = textField(node, 'headRefOid');
  const headRef = textField(node, 'headRefName');
  const headRepo = textField(recordField(node, 'headRepository'), 'nameWithOwner');
  const baseRef = textField(node, 'baseRefName');
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error(`gh returned a ${what} without its number.`);
  }
  if (state === undefined || !PR_STATES.includes(state)) {
    throw new Error(`gh returned a ${what} with a state it does not know (${state ?? 'unknown'}).`);
  }
  if (typeof isDraft !== 'boolean') throw new Error(`gh returned a ${what} without its draft flag.`);
  if (headSha === undefined || headRef === undefined || headRepo === undefined || baseRef === undefined || url === undefined) {
    throw new Error(`gh returned a ${what} without its head or base references.`);
  }
  const author = authorLogin(isRecord(node) ? node['author'] : undefined);
  const body = textField(node, 'body') ?? '';
  const mergeCommit = recordField(node, 'mergeCommit');
  const mergeOid = mergeCommit === undefined ? null : textField(mergeCommit, 'oid');
  const autoMerge = recordField(node, 'autoMergeRequest') !== undefined;
  const inMergeQueue = isRecord(node) ? node['isInMergeQueue'] === true : false;
  return {
    number,
    url,
    state: state as AgentPullRequest['state'],
    isDraft,
    headSha,
    headRef,
    headRepo,
    baseRef,
    author,
    body,
    mergeCommit: mergeOid ?? null,
    autoMerge,
    inMergeQueue,
  };
}

const BRANCH_PRS_QUERY = `query BranchPullRequests($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, CLOSED, MERGED], first: 100) {
      pageInfo { hasNextPage }
      nodes {
        number url state isDraft headRefOid headRefName baseRefName body
        headRepository { nameWithOwner }
        author { login __typename }
        mergeCommit { oid }
        autoMergeRequest { enabledAt }
        isInMergeQueue
      }
    }
  }
}`;

const PR_DETAIL_QUERY = `query PullRequestDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url state isDraft headRefOid headRefName baseRefName body
      headRepository { nameWithOwner }
      author { login __typename }
      mergeCommit { oid }
      autoMergeRequest { enabledAt }
      isInMergeQueue
    }
  }
}`;

const TIMELINE_QUERY = `query PullRequestHistory($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [PULL_REQUEST_COMMIT, READY_FOR_REVIEW_EVENT, AUTO_MERGE_ENABLED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, MERGED_EVENT], first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on PullRequestCommit { commit { oid committedDate } }
          ... on ReadyForReviewEvent { actor { login __typename } createdAt }
          ... on AutoMergeEnabledEvent { actor { login __typename } createdAt }
          ... on AddedToMergeQueueEvent { actor { login __typename } createdAt }
          ... on HeadRefForcePushedEvent { actor { login __typename } createdAt }
          ... on MergedEvent { actor { login __typename } createdAt }
        }
      }
    }
  }
}`;

const ENABLE_AUTO_MERGE_MUTATION = `mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) {
    pullRequest { number }
  }
}`;

export function createAgentGitHub(options: AgentGitHubOptions): AgentGitHub {
  const { owner, name } = parseRepository(options.repository);
  const base = `repos/${owner}/${name}`;

  const run: GhRunner = (args, input) => {
    if (options.token === undefined) return options.runner(args, input);
    return options.token().then((token) => options.runner(args, input, { GH_TOKEN: token }));
  };

  const judge = createJudgeGitHub({ repository: options.repository, runner: run });

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
    ...judge,

    async pullRequestsOfBranch(branch: string): Promise<AgentPullRequest[]> {
      const parsed = await graphql(
        BRANCH_PRS_QUERY,
        [
          ['owner', owner],
          ['name', name],
          ['branch', branch],
        ],
        [],
        `the pull requests of ${branch}`,
      );
      const list = recordField(recordField(recordField(parsed, 'data'), 'repository'), 'pullRequests');
      if (list === undefined) throw new Error(`gh did not report the pull requests of ${branch}.`);
      const hasNextPage = recordField(list, 'pageInfo')?.['hasNextPage'];
      if (typeof hasNextPage !== 'boolean') {
        throw new Error(`gh did not report whether the pull requests of ${branch} have another page.`);
      }
      if (hasNextPage) {
        throw new Error(`The pull requests of ${branch} do not fit in one page: the list cannot be confirmed.`);
      }
      const nodes = arrayField(list, 'nodes');
      if (nodes === undefined) throw new Error(`gh did not report a list of pull requests for ${branch}.`);
      return nodes.map((node) => pullRequestNode(node, `pull request of ${branch}`));
    },

    async pullRequestDetail(n: number): Promise<AgentPullRequest> {
      const parsed = await graphql(
        PR_DETAIL_QUERY,
        [
          ['owner', owner],
          ['name', name],
        ],
        [['number', n]],
        `pull request ${String(n)}`,
      );
      const node = recordField(recordField(recordField(parsed, 'data'), 'repository'), 'pullRequest');
      if (node === undefined) throw new Error(`gh did not report pull request ${String(n)}.`);
      return pullRequestNode(node, `pull request ${String(n)}`);
    },

    async pullRequestHistory(n: number): Promise<PullRequestHistoryItem[]> {
      const parsed = await graphql(
        TIMELINE_QUERY,
        [
          ['owner', owner],
          ['name', name],
        ],
        [['number', n]],
        `the timeline of pull request ${String(n)}`,
      );
      const pr = recordField(recordField(recordField(parsed, 'data'), 'repository'), 'pullRequest');
      const timeline = pr === undefined ? undefined : recordField(pr, 'timelineItems');
      if (timeline === undefined) throw new Error(`gh did not report the timeline of pull request ${String(n)}.`);
      const hasNextPage = recordField(timeline, 'pageInfo')?.['hasNextPage'];
      if (typeof hasNextPage !== 'boolean') {
        throw new Error(`gh did not report whether the timeline of pull request ${String(n)} has another page.`);
      }
      if (hasNextPage) {
        throw new Error(`The timeline of pull request ${String(n)} does not fit in one page: it cannot be confirmed.`);
      }
      const nodes = arrayField(timeline, 'nodes');
      if (nodes === undefined) throw new Error(`gh did not report the timeline of pull request ${String(n)}.`);
      const items: PullRequestHistoryItem[] = [];
      for (const node of nodes) {
        const typename = textField(node, '__typename');
        if (typename === 'PullRequestCommit') {
          const at = textField(recordField(node, 'commit'), 'committedDate');
          if (at === undefined) throw new Error('a commit event has no date.');
          items.push({ type: 'head-changed', actor: null, at });
          continue;
        }
        const at = textField(node, 'createdAt');
        if (at === undefined) throw new Error(`a timeline event (${typename ?? 'unknown'}) has no date.`);
        const actor = isRecord(node) && node['actor'] === null ? null : authorLogin(isRecord(node) ? node['actor'] : undefined);
        if (typename === 'ReadyForReviewEvent') items.push({ type: 'ready', actor, at });
        else if (typename === 'AutoMergeEnabledEvent') items.push({ type: 'auto-merge-enabled', actor, at });
        else if (typename === 'AddedToMergeQueueEvent') items.push({ type: 'added-to-queue', actor, at });
        else if (typename === 'HeadRefForcePushedEvent') items.push({ type: 'head-changed', actor, at });
        else if (typename === 'MergedEvent') items.push({ type: 'merged', actor, at });
        else throw new Error(`gh returned a timeline event it does not know (${typename ?? 'unknown'}).`);
      }
      return items;
    },

    async branchActivity(branch: string) {
      const parsed = ensureOk(
        await run(['api', `${base}/activity?ref=refs/heads/${branch}`, '--paginate', '--slurp']),
        `the activity of ${branch}`,
      );
      const items: { type: string; actor: string | null; before: string; after: string; at: string }[] = [];
      for (const item of flattenPages(parsed, `the activity of ${branch}`)) {
        const type = textField(item, 'activity_type');
        const before = textField(item, 'before');
        const after = textField(item, 'after');
        const at = textField(item, 'timestamp');
        if (type === undefined || before === undefined || after === undefined || at === undefined) {
          throw new Error(`gh returned an activity of ${branch} without its type, before, after or date.`);
        }
        if (!isRecord(item) || !Object.prototype.hasOwnProperty.call(item, 'actor')) {
          throw new Error(`gh returned an activity of ${branch} without its actor.`);
        }
        const rawActor = item['actor'];
        const actor = rawActor === null ? null : authorLogin(rawActor);
        items.push({ type, actor, before, after, at });
      }
      return items;
    },

    async createDraftPullRequest(o): Promise<number> {
      const parsed = ensureOk(
        await run(['api', `${base}/pulls`, '--method', 'POST', '--input', '-'], JSON.stringify({
          head: o.branch,
          base: o.base,
          title: o.title,
          body: o.body,
          draft: true,
        })),
        'the new draft pull request',
      );
      const number = isRecord(parsed) ? parsed['number'] : undefined;
      if (typeof number !== 'number') throw new Error('gh did not report the number of the new pull request.');
      return number;
    },

    async issueTitle(n: number): Promise<string> {
      const parsed = ensureOk(await run(['api', `${base}/issues/${String(n)}`]), `issue ${String(n)}`);
      const title = textField(parsed, 'title');
      if (title === undefined) throw new Error(`gh did not report the title of issue ${String(n)}.`);
      return title;
    },

    async markReady(pr: number): Promise<void> {
      ensureOk(await run(['pr', 'ready', String(pr)]), `pull request ${String(pr)}`);
    },

    async enableAutoMerge(pr: number, o): Promise<void> {
      const detail = ensureOk(await run(['api', `${base}/pulls/${String(pr)}`]), `pull request ${String(pr)}`);
      const nodeId = textField(detail, 'node_id');
      if (nodeId === undefined) throw new Error(`gh did not report the node id of pull request ${String(pr)}.`);
      ensureOk(
        await run([
          'api', 'graphql',
          '-f', `query=${ENABLE_AUTO_MERGE_MUTATION}`,
          '-f', `pullRequestId=${nodeId}`,
          '-f', `mergeMethod=${o.method.toUpperCase()}`,
          '-f', `expectedHeadOid=${o.headSha}`,
        ]),
        `the auto-merge of pull request ${String(pr)}`,
      );
    },

    async deployments(sha: string, environment: string) {
      const parsed = ensureOk(
        await run(['api', `${base}/deployments?sha=${sha}&environment=${environment}`, '--paginate', '--slurp']),
        `the deployments of ${sha}`,
      );
      const deployments: { id: number; sha: string; creator: string }[] = [];
      for (const item of flattenPages(parsed, `the deployments of ${sha}`)) {
        const id = isRecord(item) ? item['id'] : undefined;
        const itemSha = textField(item, 'sha');
        const creator = textField(recordField(item, 'creator'), 'login');
        if (typeof id !== 'number' || itemSha === undefined || creator === undefined) {
          throw new Error(`gh returned a deployment of ${sha} without its id, sha or creator.`);
        }
        deployments.push({ id, sha: itemSha, creator });
      }
      return deployments;
    },

    async deploymentState(id: number) {
      const parsed = ensureOk(
        await run(['api', `${base}/deployments/${String(id)}/statuses`, '--paginate', '--slurp']),
        `the statuses of deployment ${String(id)}`,
      );
      const first = flattenPages(parsed, `the statuses of deployment ${String(id)}`)[0];
      if (first === undefined) return undefined;
      const state = textField(first, 'state');
      if (state === undefined) throw new Error(`gh returned a deployment status without its state.`);
      const environmentUrl = textField(first, 'environment_url');
      const targetUrl = textField(first, 'target_url');
      return { state, url: environmentUrl ?? targetUrl ?? null };
    },

    async commentOnIssue(n: number, body: string): Promise<number> {
      const parsed = ensureOk(
        await run(['api', `${base}/issues/${String(n)}/comments`, '--method', 'POST', '--input', '-'], JSON.stringify({ body })),
        `the comment on issue ${String(n)}`,
      );
      const id = isRecord(parsed) ? parsed['id'] : undefined;
      if (typeof id !== 'number') throw new Error(`gh did not report the id of the comment on issue ${String(n)}.`);
      return id;
    },
  };
}
