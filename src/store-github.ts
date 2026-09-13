import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { resolveExecutable, type ExecutableEnvironment } from './exec.js';
import type { StatePort } from './store-git.js';

export interface GhRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` with these arguments, feeding `input` to its stdin when given. Never through a shell. */
export type GhRunner = (args: readonly string[], input?: string) => Promise<GhRun>;

export interface GitHubStatePortOptions {
  readonly owner: string;
  readonly repo: string;
  /** Where the state lives. Never under `refs/heads/` or `refs/tags/`. */
  readonly ref?: string;
  /** Defaults to the real `gh`, resolved without a shell. */
  readonly run?: GhRunner;
}

export const DEFAULT_STATE_REF = 'refs/ai-workflows/state';

// A plain GitHub name: letters, digits, dot, underscore and hyphen. GitHub also lets names be
// `.` or `..` in some URL positions, which would escape the path, so those two are excluded.
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// A ref outside branches and tags: it must be rooted at `refs/` and only use characters git
// permits in a ref path. Empty and `..` segments are checked separately below.
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]+$/;

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

// A GraphQL reply can exit 0 and still carry an `errors` array, so the exit code alone is not
// enough to call the write landed.
function hasGraphQlErrors(stdout: string): boolean {
  const parsed = tryParse(stdout);
  if (!isRecord(parsed)) return false;
  const errors = parsed['errors'];
  return Array.isArray(errors) && errors.length > 0;
}

function validateName(kind: 'owner' | 'repo', value: string): void {
  if (!NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(
      `The ${kind} "${value}" is not a plain GitHub name: use only letters, digits, dot, ` +
        'underscore or hyphen, and never "." or "..".',
    );
  }
}

function validateRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(
      `The ref "${ref}" is not a well-formed name outside branches and tags: it must start ` +
        'with "refs/" and use only letters, digits, dot, underscore, hyphen and slashes.',
    );
  }
  const segments = ref.slice('refs/'.length).split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`The ref "${ref}" has an empty segment; every ref segment must be non-empty.`);
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`The ref "${ref}" contains a "." or ".." segment, which is not a valid ref.`);
  }
  // A branch or a tag is a live part of the repository: writing one fires deployments and push
  // workflows, which is never the intent of a state ref. Refuse before any network call.
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) {
    throw new Error(
      `Refusing to write the ref "${ref}": writing a branch or a tag fires deployment and ` +
        'push workflows. The state ref must live outside refs/heads/ and refs/tags/.',
    );
  }
}

/** The real environment `resolveExecutable` needs, so the resolver stays a pure function. */
function executableEnvironment(): ExecutableEnvironment {
  const pathExt = process.env['PATHEXT'];
  return {
    platform: process.platform,
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    // `exactOptionalPropertyTypes` forbids an explicit `undefined`: omit it instead.
    ...(pathExt !== undefined ? { pathExt } : {}),
    nodePath: process.execPath,
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        // A shim that cannot be read is skipped by the resolver, which keeps walking the PATH.
        return undefined;
      }
    },
  };
}

/**
 * The environment a shim would have exported, laid over the engine's own. NODE_PATH is special:
 * the shim's value goes in front of any the engine already had, separated the way the platform
 * separates PATH entries, mirroring the shim's own `%NODE_PATH%` reference.
 */
function mergeShimEnvironment(shimEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const separator = process.platform === 'win32' ? ';' : ':';
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(shimEnv)) {
    const existing = merged[name];
    merged[name] =
      name.toUpperCase() === 'NODE_PATH' && existing !== undefined && existing.length > 0
        ? `${value}${separator}${existing}`
        : value;
  }
  return merged;
}

/** The real `gh`, resolved and launched without a shell, with `input` fed to its stdin. */
function defaultRunner(): GhRunner {
  return (args, input) =>
    new Promise<GhRun>((resolve, reject) => {
      const resolved = resolveExecutable('gh', executableEnvironment());
      if (!resolved.ok) {
        reject(new Error(resolved.reason));
        return;
      }
      const options: SpawnOptions = { shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
      if (resolved.env !== undefined) options.env = mergeShimEnvironment(resolved.env);

      const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], options);
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));

      // A closed stdin is what lets `gh --input -` finish reading the body.
      if (child.stdin !== null) child.stdin.end(input ?? '');
    });
}

export function createGitHubStatePort(options: GitHubStatePortOptions): StatePort {
  const { owner, repo } = options;
  validateName('owner', owner);
  validateName('repo', repo);
  const ref = options.ref ?? DEFAULT_STATE_REF;
  validateRef(ref);

  const run = options.run ?? defaultRunner();
  const base = `repos/${owner}/${repo}`;
  // The REST ref endpoint wants the name without the leading `refs/`.
  const refPath = ref.replace(/^refs\//, '');

  // The tree at a commit is immutable, so it is fetched at most once per instance.
  const trees = new Map<string, readonly TreeEntry[]>();
  let repositoryId: string | undefined;

  function readApi(endpoint: string): Promise<GhRun> {
    return run(['api', endpoint]);
  }

  function writeApi(endpoint: string, method: string, body: unknown): Promise<GhRun> {
    // Writes carry the JSON body on stdin (`--input -`) so arguments never hold it.
    return run(['api', endpoint, '-X', method, '--input', '-'], JSON.stringify(body));
  }

  function ensureOk(result: GhRun): unknown {
    if (result.exitCode !== 0) throw new Error(failureOf(result).message);
    return parseJson(result.stdout);
  }

  async function head(): Promise<string | undefined> {
    const result = await readApi(`${base}/git/ref/${refPath}`);
    if (result.exitCode !== 0) {
      const failure = failureOf(result);
      if (failure.status === 404) {
        // GitHub answers 404 both for a missing ref and for a repository the gh account cannot
        // see. Confirming the repository through the cached node_id lookup keeps a typo in the
        // owner or a private repo without access from reading as «no state yet».
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
      throw new Error(`gh did not report the commit ${ref} points at.`);
    }
    return commitSha;
  }

  async function loadTree(commit: string): Promise<readonly TreeEntry[]> {
    const cached = trees.get(commit);
    if (cached !== undefined) return cached;
    const result = await readApi(`${base}/git/trees/${commit}?recursive=1`);
    const parsed = ensureOk(result);
    if (!isRecord(parsed)) throw new Error(`gh returned an unexpected tree at ${commit}.`);
    // A truncated tree omits entries, and a missing entry would later read as an absent file,
    // so the tree is refused whole instead of answered from.
    if (parsed['truncated'] === true) {
      throw new Error(
        `GitHub truncated the tree at ${commit}: a missing entry would read as absent, so no ` +
          'answer is given.',
      );
    }
    const rawTree = parsed['tree'];
    const entries: TreeEntry[] = [];
    if (Array.isArray(rawTree)) {
      for (const item of rawTree) {
        const path = stringField(item, 'path');
        const type = stringField(item, 'type');
        const sha = stringField(item, 'sha');
        if (path === undefined || type === undefined || sha === undefined) continue;
        entries.push({ path, type, sha });
      }
    }
    trees.set(commit, entries);
    return entries;
  }

  async function read(commit: string, path: string): Promise<string | undefined> {
    const entries = await loadTree(commit);
    const entry = entries.find((candidate) => candidate.type === 'blob' && candidate.path === path);
    if (entry === undefined) return undefined;
    const result = await readApi(`${base}/git/blobs/${entry.sha}`);
    const parsed = ensureOk(result);
    const content = stringField(parsed, 'content');
    if (content === undefined) throw new Error(`gh returned no content for blob ${entry.sha}.`);
    // GitHub may wrap the base64 content at column 60; whitespace is not part of the payload.
    return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
  }

  async function list(commit: string, dir: string): Promise<readonly string[]> {
    const entries = await loadTree(commit);
    const prefix = `${dir}/`;
    return entries
      .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
      .map((entry) => entry.path);
  }

  async function repositoryIdentifier(): Promise<string> {
    if (repositoryId !== undefined) return repositoryId;
    const parsed = ensureOk(await readApi(base));
    const id = stringField(parsed, 'node_id');
    if (id === undefined) throw new Error('gh did not report the repository node_id.');
    repositoryId = id;
    return id;
  }

  async function moveRef(parent: string, newCommit: string): Promise<string | undefined> {
    const id = await repositoryIdentifier();
    const body = {
      query: UPDATE_REFS_MUTATION,
      variables: {
        input: {
          repositoryId: id,
          refUpdates: [{ name: ref, beforeOid: parent, afterOid: newCommit, force: false }],
        },
      },
    };

    // A failed `updateRefs` answers a generic «Something went wrong» rather than a conflict
    // code, so the only way to tell a lost race from a landed write from a real failure is to
    // re-read the ref.
    let failureMessage = 'GitHub refused to update the state ref.';
    try {
      const result = await writeApi('graphql', 'POST', body);
      if (result.exitCode === 0 && !hasGraphQlErrors(result.stdout)) return newCommit;
      failureMessage = failureOf(result).message;
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    const moved = await head();
    if (moved === newCommit) return newCommit;
    if (moved !== parent) return undefined;
    throw new Error(failureMessage);
  }

  async function commit(
    parent: string | undefined,
    changes: Readonly<Record<string, string | null>>,
    message: string,
  ): Promise<string | undefined> {
    const tree: TreeChange[] = Object.entries(changes).map(([path, content]): TreeChange =>
      content === null
        ? { path, mode: '100644', type: 'blob', sha: null }
        : { path, mode: '100644', type: 'blob', content },
    );

    const treeBody: { base_tree?: string; tree: TreeChange[] } = { tree };
    if (parent !== undefined) {
      // The new tree is layered over the parent's tree, so unchanged files are not rewritten.
      const parentCommit = ensureOk(await readApi(`${base}/git/commits/${parent}`));
      const parentTree = isRecord(parentCommit) ? parentCommit['tree'] : undefined;
      const baseTree = stringField(parentTree, 'sha');
      if (baseTree === undefined) throw new Error(`gh did not report the tree of commit ${parent}.`);
      treeBody.base_tree = baseTree;
    }

    const createdTree = ensureOk(await writeApi(`${base}/git/trees`, 'POST', treeBody));
    const treeSha = stringField(createdTree, 'sha');
    if (treeSha === undefined) throw new Error('gh did not report the created tree.');

    const createdCommit = ensureOk(
      await writeApi(`${base}/git/commits`, 'POST', {
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
      const refResult = await writeApi(`${base}/git/refs`, 'POST', { ref, sha: newCommit });
      if (refResult.exitCode !== 0) {
        const failure = failureOf(refResult);
        if (failure.status === 422 && /already exists/i.test(failure.message)) return undefined;
        throw new Error(failure.message);
      }
      return newCommit;
    }

    return moveRef(parent, newCommit);
  }

  return { head, read, list, commit };
}
