import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type GateContext,
} from '../contract.js';
import { resolveExecutable, type ExecutableEnvironment } from '../exec.js';
import { gitEnvironment } from '../git-env.js';
import { classifyFiles } from '../recipe/glob.js';
import {
  DEFAULT_PROCESS_GROUPS,
  TEST_STDOUT_BYTES,
} from '../process-group.js';
import { confirmEmptyGroup } from './confirm-empty.js';

// PLAN-13-R2 §3.4 and §3.5: `red-test@1` and `build-verify@1` both launch the project's test
// command over the test files of the change and read what it printed. This module holds the
// pieces they share — expanding `{tests}`, matching a file against the `tests` globs, hashing a
// file, and running the command inside a group that is always terminated and confirmed empty,
// exactly like `command@1`. Nothing here reads a locale: the motives live in each block.

/** The command exited; `output` is standard output then standard error, as one text. */
export interface TestGroupExit {
  readonly kind: 'exited';
  readonly code: number;
  readonly output: string;
  readonly truncated: boolean;
}

/** The command never really ran: not found, out of time, too much output, cancelled. */
export interface TestGroupTechnical {
  readonly kind: 'technical';
  readonly reason: string;
}

export type TestGroupResult = TestGroupExit | TestGroupTechnical;

export interface RunTestsOptions {
  readonly command: string;
  readonly root: string;
  /** The test files, in order; `{tests}` becomes one argument per file. */
  readonly tests: readonly string[];
  readonly timeoutMs: number;
  readonly piece: string;
  readonly signal: AbortSignal;
  /**
   * PLAN-13-R3 §5: when given, the test processes run with exactly this environment and inherit
   * nothing else. The unprivileged `red-test` job hands in a copy of its own environment with
   * every token, secret, password and key removed, so a test can neither read nor leak them.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Launches the group with an environment that replaces the process's own. The process group
 * always lays its extra variables over `process.env`; to remove variables the process's own
 * environment is swapped for the filtered one for the one synchronous moment the launch reads
 * it, then restored at once. Nothing else of the engine ever sees the swap.
 */
function launchWithEnvironment(
  options: Parameters<typeof DEFAULT_PROCESS_GROUPS.launch>[0],
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof DEFAULT_PROCESS_GROUPS.launch> {
  const saved = process.env;
  process.env = environment;
  try {
    return DEFAULT_PROCESS_GROUPS.launch(options);
  } finally {
    process.env = saved;
  }
}

/** The real environment `resolveExecutable` needs, so the resolver stays a pure function. */
function executableEnvironment(): ExecutableEnvironment {
  const pathExt = process.env['PATHEXT'];
  return {
    platform: process.platform,
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    ...(pathExt !== undefined ? { pathExt } : {}),
    nodePath: process.execPath,
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** Splits the command into arguments; `{tests}` becomes one argument per test file. */
function expandedArguments(
  command: string,
  piece: string,
  tests: readonly string[],
): { readonly program: string; readonly args: string[] } {
  const tokens = command.split(' ').filter((token) => token.length > 0);
  const program = (tokens[0] ?? piece).replaceAll('{piece}', piece);
  const args: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token === '{tests}') {
      args.push(...tests);
      continue;
    }
    args.push(token.replaceAll('{piece}', piece));
  }
  return { program, args };
}

/** The output a person reads: standard output first, then standard error. */
function combinedOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((part) => part.length > 0).join('\n');
}

/** Whether `file` matches any of the recipe's globs, with the same matcher the recipe uses. */
export function matchesGlobs(globs: readonly string[], file: string): boolean {
  return classifyFiles({ match: globs }, [file]).includes('match');
}

/** The files of `files` that exist in the working tree, in order. */
export function existingFiles(root: string, files: readonly string[]): string[] {
  return files.filter((file) => existsSync(join(root, file)));
}

/** The files of `files`, in order, that match the `tests` globs. */
export function filesMatching(globs: readonly string[], files: readonly string[]): string[] {
  return files.filter((file) => matchesGlobs(globs, file));
}

const GIT_TIMEOUT_MS = 60_000;

/** The id of the blob git itself would store for a working-tree file, filters included. */
function gitBlobId(root: string, file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['hash-object', '--path', file, file],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error, stdout) => resolve(error === null ? stdout.trim() : undefined),
    );
  });
}

/**
 * The blob id git would give each file, applying `core.autocrlf` and the attribute filters —
 * the same id a commit will hold. build-verify compares these against history, so a test that
 * merely gains CRLF on disk is not read as a change. Outside a repository the ids are missing
 * and build-verify falls back to the content hashes.
 */
export async function hashBlobs(
  root: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const blobs: Record<string, string> = {};
  for (const file of files) {
    const id = await gitBlobId(root, file);
    if (id !== undefined && id.length > 0) blobs[file] = id;
  }
  return blobs;
}

/** sha256 of each file's current content. A file that cannot be read is left out. */
export async function hashFiles(
  root: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readFile(join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    hashes[file] = createHash('sha256').update(content).digest('hex');
  }
  return hashes;
}

/**
 * A rehearsal must not launch anything. Going through `runEffect` makes the engine refuse it
 * with its own dry-run path, which reports the stage as not rehearsable.
 */
export async function refuseDryRun(context: GateContext, operationId: string): Promise<void> {
  if (context.mode !== 'dry-run') return;
  await context.runEffect(operationId, async () => null);
  throw new Error('a dry run must not launch a command block');
}

/**
 * Runs the test command without a console, inside a group that is always terminated and
 * confirmed empty before returning. `{tests}` is replaced by one argument per test file. A
 * command that cannot be launched comes back as `technical`; a cancellation empties the group
 * first. A group that cannot be confirmed empty raises `ProcessTreeSurvived`.
 */
export async function runTests(options: RunTestsOptions): Promise<TestGroupResult> {
  // `{tests}` only ever names files that still exist: a test the piece deleted is no longer a
  // test file, and passing its name to the runner would only make the runner fail to load it.
  const tests = existingFiles(options.root, options.tests);
  const { program, args } = expandedArguments(options.command, options.piece, tests);
  const resolved = resolveExecutable(program, executableEnvironment());
  if (!resolved.ok) return { kind: 'technical', reason: `could not start ${program}: ${resolved.reason}` };

  const launchOptions = {
    command: resolved.command,
    args: [...resolved.prefixArgs, ...args],
    cwd: options.root,
    stdin: '',
    ...(resolved.env === undefined ? {} : { env: resolved.env }),
    timeoutMs: options.timeoutMs,
    stdoutBytes: TEST_STDOUT_BYTES,
  };
  const group =
    options.environment === undefined
      ? DEFAULT_PROCESS_GROUPS.launch(launchOptions)
      : launchWithEnvironment(launchOptions, options.environment);

  // Cancellation must be honoured at once: the wait races the signal, and on abort the group
  // is terminated and confirmed right there.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    if (options.signal.aborted) {
      resolve('aborted');
      return;
    }
    onAbort = () => resolve('aborted');
    options.signal.addEventListener('abort', onAbort, { once: true });
  });

  const confirmEmpty = (): Promise<void> =>
    confirmEmptyGroup(group, DEFAULT_PROCESS_GROUPS, program);

  try {
    const raced = await Promise.race([
      group.wait().then((exit) => ({ exit })),
      aborted.then(() => 'aborted' as const),
    ]);

    if (raced === 'aborted') await confirmEmpty();
    const exit = raced === 'aborted' ? await group.wait() : raced.exit;
    if (exit.kind === 'technical') return { kind: 'technical', reason: exit.reason };
    return {
      kind: 'exited',
      code: exit.code,
      output: combinedOutput(exit.stdout, exit.stderr),
      truncated: exit.truncated,
    };
  } finally {
    if (onAbort !== undefined) options.signal.removeEventListener('abort', onAbort);
    await confirmEmpty();
  }
}
