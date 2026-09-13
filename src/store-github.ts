import { createGhRunner, type GhRun, type GhRunner } from './gh-runner.js';
import type { StatePort, StateRef } from './store-git.js';

export interface GitHubStatePortOptions {
  readonly owner: string;
  readonly repo: string;
  /**
   * The ref prefix every state ref lives under, like `refs/ai-workflows/pieces/997`. Never
   * `refs/heads` or `refs/tags`.
   */
  readonly namespace?: string;
  /** Defaults to `createGhRunner()`: the real `gh`, resolved without a shell, with a timeout. */
  readonly run?: GhRunner;
}

export const DEFAULT_STATE_NAMESPACE = 'refs/ai-workflows';

// A plain GitHub name: letters, digits, dot, underscore and hyphen. GitHub also lets names be
// `.` or `..` in some URL positions, which would escape the path, so those two are excluded.
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// A ref outside branches and tags: it must be rooted at `refs/` and only use characters git
// permits in a ref path. Empty and `..` segments are checked separately below.
const NAMESPACE_PATTERN = /^refs\/[A-Za-z0-9._/-]+$/;
// One state-name segment. A state name is used verbatim inside a REST URL and as a ref path, so
// the character set is narrower than a ref's on purpose: no dot, slash or space can escape it.
const STATE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
// A full lowercase git object id, SHA-1 (40) or SHA-256 (64). Anything shorter would build a
// URL like `git/trees/c1` that GitHub answers with a different resource or an error.
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Keeping one tree per commit forever would grow without bound over a long run. Sixteen is
// enough for a read of a piece's four files plus the trees a commit layers on, and the oldest
// listing is dropped once the cache is full.
const TREE_CACHE_LIMIT = 16;

// The GitHub GraphQL mutation that moves a ref. `updateRefs` is the only API that compares the
// old commit (REST `PATCH git/refs` does not, measured on 13-sep-2026), and `force: false` makes
// GitHub refuse the write when `beforeOid` no longer matches.
const UPDATE_REFS_MUTATION =
  'mutation UpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }';

type TreeChange =
  | { readonly path: string; readonly mode: '100644'; readonly type: 'blob'; readonly content: string }
  | { readonly path: string; readonly mode: '100644'; readonly type: 'blob'; readonly sha: null };

interface TreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
}

// The root SHA is kept with the entries: `commit` layers its tree over that SHA, and taking it
// from the listing already read is what avoids a second GET of `git/commits/{parent}`.
interface TreeListing {
  readonly rootSha: string;
  readonly entries: readonly TreeEntry[];
}

interface GhFailure {
  readonly status: number | undefined;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  const parsed = tryParse(text);
  if (parsed === undefined && text.trim().length > 0) {
    throw new Error(`gh returned output that is not JSON: ${text.trim().slice(0, 500)}`);
  }
  return parsed;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[field];
  return typeof found === 'string' ? found : undefined;
}

// GitHub reports the HTTP status in stderr (`gh: ... (HTTP 404)`) or, on some paths, only in a
// JSON `status` field on stdout. Both are read so a 404 is never mistaken for a real failure.
function statusOf(result: GhRun): number | undefined {
  const stderrMatch = /\(HTTP (\d{3})\)/.exec(result.stderr);
  const stderrStatus = stderrMatch?.[1];
  if (stderrStatus !== undefined) return Number(stderrStatus);
  const stdoutMatch = /"status"\s*:\s*"?(\d{3})"?/.exec(result.stdout);
  const stdoutStatus = stdoutMatch?.[1];
  return stdoutStatus === undefined ? undefined : Number(stdoutStatus);
}

// The human-readable reason GitHub gave. GraphQL errors carry it under `errors[0].message`;
// REST failures under `message`. Falling back to raw stderr/stdout keeps a real failure from
// being reported as an empty string.
function failureOf(result: GhRun): GhFailure {
  const parsed = tryParse(result.stdout);
  let message: string | undefined;
  if (isRecord(parsed)) {
    const errors = parsed['errors'];
    const firstError = Array.isArray(errors) ? errors[0] : undefined;
    message = stringField(firstError, 'message');
    if (message === undefined) message = stringField(parsed, 'message');
  }
  if (message === undefined) {
    const stderr = result.stderr.trim();
    message = stderr.length > 0 ? stderr : result.stdout.trim();
  }
  if (message.length === 0) message = `gh exited with code ${String(result.exitCode)}`;
  return { status: statusOf(result), message };
}

// The single success shape of `updateRefs`: an exit 0, no GraphQL errors, and a `data.updateRefs`
// object. A reply missing that object is a failed write, never a landed one.
function updateRefsLanded(stdout: string): boolean {
  const parsed = tryParse(stdout);
  if (!isRecord(parsed)) return false;
  const data = parsed['data'];
  return isRecord(data) && isRecord(data['updateRefs']);
}

function validateOwnerRepo(kind: 'owner' | 'repo', value: string): void {
  if (!NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(
      `The ${kind} "${value}" is not a plain GitHub name: use only letters, digits, dot, ` +
        'underscore or hyphen, and never "." or "..".',
    );
  }
}

// The namespace is the prefix every state ref hangs from. It has to be a well-formed ref prefix
// (git's own rules: rooted at `refs/`, no empty or dot segments, no trailing slash), and it must
// stay clear of branches and tags: writing one of those fires deployments and push workflows,
// which is never the intent of a state ref. Both checks run before any network call.
function validateNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace) || namespace.endsWith('/')) {
    throw new Error(
      `The namespace "${namespace}" is not a well-formed ref prefix: it must start with ` +
        '"refs/", use only letters, digits, dot, underscore, hyphen and slashes, and not end ' +
        'with a slash.',
    );
  }
  const segments = namespace.slice('refs/'.length).split('/');
  if (segments.some((segment) => segment.length === 0) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(
      `The namespace "${namespace}" has an empty, "." or ".." segment, which is not a valid ref.`,
    );
  }
  if (
    namespace === 'refs/heads' ||
    namespace.startsWith('refs/heads/') ||
    namespace === 'refs/tags' ||
    namespace.startsWith('refs/tags/')
  ) {
    throw new Error(
      `Refusing the namespace "${namespace}": a branch or a tag is a live part of the ` +
        'repository, and writing one fires deployment and push workflows. The state must live ' +
        'outside refs/heads and refs/tags.',
    );
  }
}

// A state name like `pieces/997`: slash-separated segments of letters, digits, underscore or
// hyphen. The narrower set keeps a name from escaping its own path when it becomes a REST URL
// and a ref. Thrown before any call, so a bad name never reaches GitHub.
function validateStateName(name: string): void {
  const segments = name.split('/');
  if (segments.some((segment) => !STATE_SEGMENT_PATTERN.test(segment))) {
    throw new Error(
      `The state name "${name}" is not valid: use slash-separated segments of letters, digits, ` +
        'underscore or hyphen, with no empty, "." or ".." segment.',
    );
  }
}

// A listing prefix like `pieces/`: one or more slash-separated segments of letters, digits,
// underscore or hyphen, terminated by a slash. The trailing slash keeps the match on a segment
// boundary (`pieces/` never matches `piecesX/`), and the character set keeps the prefix from
// escaping the namespace path once it is pasted into a REST URL. Thrown before any call.
function validateRefPrefix(prefix: string): void {
  if (!prefix.endsWith('/')) {
    throw new Error(
      `The prefix "${prefix}" is not valid: use one or more slash-separated segments of letters, ` +
        'digits, underscore or hyphen, and end it with a slash.',
    );
  }
  // The trailing slash leaves one empty segment, which is the terminator, not a name.
  const segments = prefix.split('/').slice(0, -1);
  if (segments.length === 0 || segments.some((segment) => !STATE_SEGMENT_PATTERN.test(segment))) {
    throw new Error(
      `The prefix "${prefix}" is not valid: use one or more slash-separated segments of letters, ` +
        'digits, underscore or hyphen, and end it with a slash.',
    );
  }
}

// A commit that reaches a URL or a comparison must be a full lowercase object id. A partial or
// crafted value (`../..`) would otherwise be pasted into the request path.
function validateSha(what: string, value: string): void {
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`The ${what} "${value}" is not a full lowercase SHA (40 or 64 hex digits).`);
  }
}

export function createGitHubStatePort(options: GitHubStatePortOptions): StatePort {
  const { owner, repo } = options;
  validateOwnerRepo('owner', owner);
  validateOwnerRepo('repo', repo);
  const namespace = options.namespace ?? DEFAULT_STATE_NAMESPACE;
  validateNamespace(namespace);

  const run = options.run ?? createGhRunner();
  const base = `repos/${owner}/${repo}`;
  // The REST ref endpoint wants the namespace without its leading `refs/`.
  const namespacePath = namespace.slice('refs/'.length);

  // The tree at a commit is immutable, so it is fetched at most once per instance until it is
  // evicted; the cache is bounded so a long run cannot grow it without bound.
  const trees = new Map<string, TreeListing>();
  let repositoryId: string | undefined;

  function readApi(endpoint: string): Promise<GhRun> {
    return run(['api', endpoint]);
  }

  function writeApi(endpoint: string, body: unknown): Promise<GhRun> {
    // Writes carry the JSON body on stdin (`--input -`) so arguments never hold it.
    return run(['api', endpoint, '-X', 'POST', '--input', '-'], JSON.stringify(body));
  }

  function graphqlApi(body: unknown): Promise<GhRun> {
    return run(['api', 'graphql', '--input', '-'], JSON.stringify(body));
  }

  function ensureOk(result: GhRun): unknown {
    if (result.exitCode !== 0) throw new Error(failureOf(result).message);
    return parseJson(result.stdout);
  }

  async function repositoryIdentifier(): Promise<string> {
    if (repositoryId !== undefined) return repositoryId;
    const parsed = ensureOk(await readApi(base));
    const id = stringField(parsed, 'node_id');
    if (id === undefined) throw new Error('gh did not report the repository node_id.');
    repositoryId = id;
    return id;
  }

  async function head(name: string): Promise<string | undefined> {
    validateStateName(name);
    const result = await readApi(`${base}/git/ref/${namespacePath}/${name}`);
    if (result.exitCode !== 0) {
      const failure = failureOf(result);
      if (failure.status === 404) {
        // GitHub answers 404 both for a missing ref and for a repository the gh account cannot
        // see. Confirming the repository keeps a typo in the owner or a private repo without
        // access from reading as «no state yet».
        try {
          await repositoryIdentifier();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `The repository ${owner}/${repo} does not exist or the gh account cannot see it: ${reason}`,
          );
        }
        return undefined;
      }
      throw new Error(failure.message);
    }
    const parsed = parseJson(result.stdout);
    const object = isRecord(parsed) ? parsed['object'] : undefined;
    const commitSha = stringField(object, 'sha');
    if (commitSha === undefined) {
      throw new Error(`gh did not report the commit ${namespace}/${name} points at.`);
    }
    return commitSha;
  }

  async function loadTree(commit: string): Promise<TreeListing> {
    const cached = trees.get(commit);
    if (cached !== undefined) return cached;
    const parsed = ensureOk(await readApi(`${base}/git/trees/${commit}?recursive=1`));
    if (!isRecord(parsed)) throw new Error(`gh returned an unexpected tree at ${commit}.`);
    const rootSha = stringField(parsed, 'sha');
    if (rootSha === undefined) throw new Error(`gh did not report the tree SHA at ${commit}.`);
    // A truncated tree omits entries, and a missing entry would later read as an absent file,
    // so the tree is refused whole instead of answered from.
    if (parsed['truncated'] === true) {
      throw new Error(
        `GitHub truncated the tree at ${commit}: a missing entry would read as absent, so no ` +
          'answer is given.',
      );
    }
    const rawTree = parsed['tree'];
    if (!Array.isArray(rawTree)) {
      throw new Error(`gh did not report a tree listing at ${commit}.`);
    }
    const entries: TreeEntry[] = [];
    for (const item of rawTree) {
      const path = stringField(item, 'path');
      const type = stringField(item, 'type');
      const sha = stringField(item, 'sha');
      if (path === undefined || type === undefined || sha === undefined) {
        throw new Error(
          `gh returned a tree entry at ${commit} without a path, type and sha; refusing to ` +
            'read every file as absent.',
        );
      }
      entries.push({ path, type, sha });
    }
    const listing: TreeListing = { rootSha, entries };
    trees.set(commit, listing);
    if (trees.size > TREE_CACHE_LIMIT) {
      const oldest = trees.keys().next().value;
      if (oldest !== undefined) trees.delete(oldest);
    }
    return listing;
  }

  async function read(commit: string, path: string): Promise<string | undefined> {
    validateSha('commit', commit);
    const { entries } = await loadTree(commit);
    const entry = entries.find((candidate) => candidate.type === 'blob' && candidate.path === path);
    if (entry === undefined) return undefined;
    const parsed = ensureOk(await readApi(`${base}/git/blobs/${entry.sha}`));
    const content = stringField(parsed, 'content');
    if (content === undefined) throw new Error(`gh returned no content for blob ${entry.sha}.`);
    // GitHub may wrap the base64 content at column 60; whitespace is not part of the payload.
    return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
  }

  async function refs(prefix: string): Promise<readonly StateRef[]> {
    validateRefPrefix(prefix);
    const listingPrefix = `${namespace}/${prefix}`;
    // GraphQL `refs(refPrefix:)` lists only branches and tags, so it answered `totalCount: 0`
    // for state refs even with two in place (measured on 13-sep-2026). REST `git/matching-refs`
    // does list them and answers `[]` when none match; `--paginate` follows every page and joins
    // them into a single JSON array.
    const result = await run([
      'api',
      '--paginate',
      `${base}/git/matching-refs/${namespacePath}/${prefix}`,
    ]);
    const parsed = ensureOk(result);
    if (!Array.isArray(parsed)) {
      throw new Error(`gh did not report a list of refs under ${listingPrefix}.`);
    }
    const listed: StateRef[] = [];
    for (const item of parsed) {
      const ref = stringField(item, 'ref');
      const object = isRecord(item) ? item['object'] : undefined;
      const commit = stringField(object, 'sha');
      if (ref === undefined || commit === undefined) {
        throw new Error(`gh returned a ref under ${listingPrefix} without a name and commit.`);
      }
      // `matching-refs` matches on a segment boundary, so a shorter prefix would also answer
      // sibling prefixes; keeping only the exact prefix the caller asked for avoids reading
      // another kind of state.
      if (!ref.startsWith(listingPrefix)) continue;
      listed.push({ name: ref.slice(`${namespace}/`.length), commit });
    }
    return listed;
  }

  // Compares two commits after a lost `updateRefs`. `ahead` and `identical` mean the new commit
  // is an ancestor of (or the same as) the head, so this write did land and another write came
  // after it — the store must not repeat it. Anything else is a different, newer history.
  async function comparisonStatus(newCommit: string, headCommit: string): Promise<string | undefined> {
    const parsed = ensureOk(await readApi(`${base}/compare/${newCommit}...${headCommit}`));
    return stringField(parsed, 'status');
  }

  async function moveRef(name: string, parent: string, newCommit: string): Promise<string | undefined> {
    const fullRef = `${namespace}/${name}`;
    const id = await repositoryIdentifier();
    const body = {
      query: UPDATE_REFS_MUTATION,
      variables: {
        input: {
          repositoryId: id,
          refUpdates: [{ name: fullRef, beforeOid: parent, afterOid: newCommit, force: false }],
        },
      },
    };

    // A failed `updateRefs` answers a generic «Something went wrong» rather than a conflict
    // code, so the only way to tell a lost race from a landed write from a real failure is to
    // re-read the ref.
    let failureMessage = 'GitHub refused to update the state ref.';
    try {
      const result = await graphqlApi(body);
      if (updateRefsLanded(result.stdout) && result.exitCode === 0) return newCommit;
      failureMessage = failureOf(result).message;
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    const moved = await head(name);
    if (moved === newCommit) return newCommit;
    if (moved === parent) throw new Error(failureMessage);
    if (moved === undefined) return undefined;
    const status = await comparisonStatus(newCommit, moved);
    return status === 'ahead' || status === 'identical' ? newCommit : undefined;
  }

  async function commit(
    name: string,
    parent: string | undefined,
    changes: Readonly<Record<string, string | null>>,
    message: string,
  ): Promise<string | undefined> {
    validateStateName(name);
    if (parent !== undefined) validateSha('parent commit', parent);

    const tree: TreeChange[] = Object.entries(changes).map(([path, content]): TreeChange =>
      content === null
        ? { path, mode: '100644', type: 'blob', sha: null }
        : { path, mode: '100644', type: 'blob', content },
    );

    const treeBody: { base_tree?: string; tree: TreeChange[] } = { tree };
    if (parent !== undefined) {
      // The new tree is layered over the tree the parent already points at. Taking its root SHA
      // from the tree listing avoids a second GET of `git/commits/{parent}`.
      const listing = await loadTree(parent);
      treeBody.base_tree = listing.rootSha;
    }

    const createdTree = ensureOk(await writeApi(`${base}/git/trees`, treeBody));
    const treeSha = stringField(createdTree, 'sha');
    if (treeSha === undefined) throw new Error('gh did not report the created tree.');

    const createdCommit = ensureOk(
      await writeApi(`${base}/git/commits`, {
        message,
        tree: treeSha,
        parents: parent === undefined ? [] : [parent],
      }),
    );
    const newCommit = stringField(createdCommit, 'sha');
    if (newCommit === undefined) throw new Error('gh did not report the created commit.');

    if (parent === undefined) {
      // Creating the ref is the race-free path: POST either creates it or answers 422, which
      // means someone else got there first, so the caller retries instead of failing.
      const refResult = await writeApi(`${base}/git/refs`, { ref: `${namespace}/${name}`, sha: newCommit });
      if (refResult.exitCode !== 0) {
        const failure = failureOf(refResult);
        if (failure.status === 422 && /already exists/i.test(failure.message)) return undefined;
        throw new Error(failure.message);
      }
      return newCommit;
    }

    return moveRef(name, parent, newCommit);
  }

  return { head, refs, read, commit };
}
