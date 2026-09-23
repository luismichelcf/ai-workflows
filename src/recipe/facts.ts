import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
