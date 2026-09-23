import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { classifyFiles } from './glob.js';
import { effectiveKind } from './kind.js';
import { gitEnvironment } from '../git-env.js';
import type { Recipe } from './types.js';

// PLAN-13-R2 §4.1: the facts of a change come from git, never from what a piece says about
// itself. Everything runs through `execFile` (never a shell, never a console), with a per-command
// time limit and a wide buffer; any failure throws instead of returning half the facts.

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface ChangeBuilder {
  readonly provider: string;
  readonly model: string;
  readonly session: string;
}

export interface ChangeDeclared {
  readonly kind?: string;
  readonly builder?: ChangeBuilder;
}

export interface ChangeFacts {
  readonly piece: string;
  readonly sha: string;
  readonly snapshot: string;
  readonly base: string;
  readonly mergeBase: string;
  readonly files: readonly string[];
  readonly fingerprint: string;
  readonly classes: readonly string[];
  readonly declaredKind?: string;
  readonly kind: string;
  readonly lane?: string;
  readonly clean: boolean;
  readonly builder?: ChangeBuilder;
}

export interface DescribeChangeFromGitOptions {
  readonly root: string;
  readonly baseRef: string;
  readonly recipe: Recipe;
  readonly piece: string;
  readonly declared: ChangeDeclared;
}

/** A piece id that can safely be part of a file path, a branch name or a label. */
const PIECE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requirePieceId(piece: string): void {
  if (!PIECE_ID.test(piece) || piece.includes('..')) {
    throw new Error(`invalid piece id "${piece}"`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Raw bytes of `git <args>`, so the fingerprint never depends on decoding. */
function runGit(root: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): Promise<Buffer> {
  const options = {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'buffer' as const,
    env: gitEnvironment(extraEnv),
  };
  return new Promise((resolve, reject) => {
    execFile('git', [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        const reason = stderr.length > 0 ? stderr.toString('utf8').trim() : error.message;
        reject(new Error(reason));
        return;
      }
      resolve(stdout);
    });
  });
}

function text(buffer: Buffer): string {
  return buffer.toString('utf8').trim();
}

/**
 * The tree id of the whole working state (HEAD + unsaved edits + new non-ignored files),
 * computed with a temporary index so the real one is never touched. `.gitignore` is respected.
 */
async function snapshotTree(root: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aiw-index-'));
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(directory, 'index') };
    await runGit(root, ['read-tree', 'HEAD'], env);
    await runGit(root, ['add', '-A'], env);
    return text(await runGit(root, ['write-tree'], env));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Committed, unsaved and new files, once each, in the default sort order, without renames. */
async function changedFiles(root: string, mergeBase: string, snapshot: string): Promise<string[]> {
  const raw = await runGit(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase, snapshot]);
  const paths = raw.toString('utf8').split('\0').filter((path) => path.length > 0);
  return [...new Set(paths)].sort();
}

/**
 * sha256 of the bytes of the diff from the merge base to the snapshot: it covers everything
 * judged, including unsaved work, and keeps the position of each change. Empty when nothing
 * changed. The explicit options make it independent of any diff settings the user configured.
 */
async function fingerprintOf(root: string, mergeBase: string, snapshot: string): Promise<string> {
  const raw = await runGit(root, [
    '-c', 'core.quotepath=false',
    '-c', 'diff.noprefix=false',
    '-c', 'color.ui=never',
    'diff',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--full-index',
    '--binary',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U3',
    mergeBase,
    snapshot,
  ]);
  return raw.length === 0 ? '' : createHash('sha256').update(raw).digest('hex');
}

export interface DescribeChangeFromCommitsOptions {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly recipe: Recipe;
  readonly piece: string;
  readonly declaredKind?: string;
}

/** The files the server judge reads: from the judged commit, never from the working tree. */
export interface ProjectFiles {
  read(path: string): Promise<string | undefined>;
  list(): Promise<string[]>;
}

/** PLAN-13-R3 §1.3: a project file is read whole, and 1 MB is the most that is read. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * A path a block or a declaration may read stays inside the project: no absolute path, no drive
 * letter and no `..` segment. Anything else is refused before a single file is opened.
 */
function requireProjectPath(path: string): void {
  const segments = path.split(/[\\/]+/);
  if (isAbsolute(path) || path.startsWith('/') || DRIVE_LETTER.test(path) || segments.includes('..')) {
    throw new Error(`invalid path "${path}": it must stay inside the project`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function describeChangeFromGit(
  options: DescribeChangeFromGitOptions,
): Promise<ChangeFacts> {
  const { root, baseRef, recipe, piece, declared } = options;

  // Refused before any git command runs: a piece id is a plain identifier (no path pieces, no
  // `..`, no leading dash), so it can never point a later command somewhere else.
  requirePieceId(piece);

  let sha: string;
  try {
    sha = text(await runGit(root, ['rev-parse', 'HEAD']));
  } catch (error) {
    throw new Error(`cannot read HEAD in "${root}": ${reasonOf(error)}`);
  }

  let base: string;
  try {
    base = text(await runGit(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]));
  } catch (error) {
    throw new Error(`cannot resolve base "${baseRef}": ${reasonOf(error)}`);
  }

  const mergeBase = text(await runGit(root, ['merge-base', 'HEAD', base]));
  const snapshot = await snapshotTree(root);
  const files = await changedFiles(root, mergeBase, snapshot);
  const fingerprint = await fingerprintOf(root, mergeBase, snapshot);
  const headTree = text(await runGit(root, ['rev-parse', 'HEAD^{tree}']));

  const classes = classifyFiles(recipe.classify, files);
  const effective = effectiveKind(recipe, declared.kind, files);
  const builder = declared.builder;

  return {
    piece,
    sha,
    snapshot,
    base,
    mergeBase,
    files,
    fingerprint,
    classes,
    ...(declared.kind === undefined ? {} : { declaredKind: declared.kind }),
    kind: effective.kind,
    ...(effective.lane === undefined ? {} : { lane: effective.lane }),
    clean: snapshot === headTree,
    ...(builder === undefined ? {} : { builder }),
  };
}

/**
 * PLAN-13-R3 §2: the same facts of a change, computed from commit objects only, because on
 * GitHub the judge never has the piece's working tree. `snapshot` is the tree of `head`, the
 * fingerprint covers `<mergeBase> <head>` with the very same bytes function, and the working
 * tree and the active branch are never read.
 */
export async function describeChangeFromCommits(
  options: DescribeChangeFromCommitsOptions,
): Promise<ChangeFacts> {
  const { root, base, head, recipe, piece, declaredKind } = options;

  requirePieceId(piece);

  let headSha: string;
  try {
    headSha = text(await runGit(root, ['rev-parse', '--verify', `${head}^{commit}`]));
  } catch (error) {
    throw new Error(`cannot resolve head "${head}": ${reasonOf(error)}`);
  }

  let baseSha: string;
  try {
    baseSha = text(await runGit(root, ['rev-parse', '--verify', `${base}^{commit}`]));
  } catch (error) {
    throw new Error(`cannot resolve base "${base}": ${reasonOf(error)}`);
  }

  const mergeBase = text(await runGit(root, ['merge-base', baseSha, headSha]));
  const snapshot = text(await runGit(root, ['rev-parse', `${headSha}^{tree}`]));
  const files = await changedFiles(root, mergeBase, headSha);
  const fingerprint = await fingerprintOf(root, mergeBase, headSha);

  const classes = classifyFiles(recipe.classify, files);
  const effective = effectiveKind(recipe, declaredKind, files);

  return {
    piece,
    sha: headSha,
    snapshot,
    base: baseSha,
    mergeBase,
    files,
    fingerprint,
    classes,
    ...(declaredKind === undefined ? {} : { declaredKind }),
    kind: effective.kind,
    ...(effective.lane === undefined ? {} : { lane: effective.lane }),
    clean: true,
  };
}

/**
 * Whether `<sha>:<path>` names an entry in the commit's own tree. The commit is verified first,
 * so the only thing this answer can mean when it is empty is that the path is not in that tree:
 * an unresolvable commit, or a folder that is not a repository, throws before this is ever asked.
 */
async function pathInTree(root: string, sha: string, path: string): Promise<boolean> {
  const raw = await runGit(root, ['ls-tree', '-z', sha, '--', `:(literal)${path}`]);
  return raw.length > 0;
}

function splitNullNames(raw: Buffer): string[] {
  return raw
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0)
    .sort();
}

/** PLAN-13-R3 §1.3: the project files at a commit, read with git, never from the disk. */
export function gitProjectFiles(root: string, sha: string): ProjectFiles {
  return {
    async read(path: string): Promise<string | undefined> {
      requireProjectPath(path);
      // The commit must exist: a git failure to resolve it is an error, never an absent file.
      await runGit(root, ['rev-parse', '--verify', `${sha}^{commit}`]);
      if (!(await pathInTree(root, sha, path))) return undefined;
      const spec = `${sha}:${path}`;
      const size = Number.parseInt(text(await runGit(root, ['cat-file', '-s', spec])), 10);
      if (size > MAX_PROJECT_FILE_BYTES) {
        throw new Error(`file "${path}" is larger than 1 MB`);
      }
      return (await runGit(root, ['cat-file', 'blob', spec])).toString('utf8');
    },
    async list(): Promise<string[]> {
      const raw = await runGit(root, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', sha]);
      return splitNullNames(raw);
    },
  };
}

/** PLAN-13-R3 §1.3: the project files of the working tree, with the same reading rules. */
export function diskProjectFiles(root: string): ProjectFiles {
  return {
    async read(path: string): Promise<string | undefined> {
      requireProjectPath(path);
      const full = join(root, path);
      let info;
      try {
        info = await stat(full);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      if (!info.isFile()) return undefined;
      if (info.size > MAX_PROJECT_FILE_BYTES) {
        throw new Error(`file "${path}" is larger than 1 MB`);
      }
      return await readFile(full, 'utf8');
    },
    async list(): Promise<string[]> {
      const found: string[] = [];
      const walk = async (directory: string, prefix: string): Promise<void> => {
        const entries = await readdir(join(root, directory), { withFileTypes: true });
        for (const entry of entries) {
          const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            await walk(join(directory, entry.name), relative);
          } else if (entry.isFile()) {
            found.push(relative);
          }
        }
      };
      await walk('', '');
      return found.sort();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PLAN-13-R3 §3.1 and §3.6: the few git facts the judge needs about the checkout it works in.
// They go through the same `runGit` as everything else, so they inherit its time limit, its
// wide buffer and its environment without the inherited `GIT_*` variables.

/** The commit the checkout is at, so the judge knows whether it has to move it. */
export async function gitHead(root: string): Promise<string> {
  return text(await runGit(root, ['rev-parse', 'HEAD']));
}

/** Moves the checkout to a commit, detached and quiet: the judge's own trustworthy base. */
export async function gitCheckoutDetach(root: string, sha: string): Promise<void> {
  await runGit(root, ['checkout', '--detach', '-q', sha]);
}

/** Whether `ancestor` is reachable from `descendant`. A failure to tell is not an answer. */
export async function gitIsAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** The commits reachable from `from` and not from `notFrom`, as git lists them (newest first). */
export async function gitCommitsReachable(
  root: string,
  from: readonly string[],
  notFrom: string,
): Promise<string[]> {
  if (from.length === 0) return [];
  const raw = await runGit(root, ['rev-list', ...from, '--not', notFrom]);
  return raw
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
