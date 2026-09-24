import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Gate,
  type GateContext,
  type GateResult,
  type JsonValue,
} from '../contract.js';
import { resolveExecutable, type ExecutableEnvironment } from '../exec.js';
import { childEnvironment } from '../git-env.js';
import { DEFAULT_STDOUT_BYTES, type GroupExit, type ProcessGroupControl } from '../process-group.js';
import { confirmEmptyGroup } from './confirm-empty.js';

// PLAN-13-R2 §2.2 (RC-03, RC-10): a command block is a separate program with a strict
// contract. It is never read by a console: the text is split on spaces, `{tests}` becomes one
// argument per test file and `{piece}` is substituted inside an argument. It receives the
// change as JSON on standard input and must print exactly one JSON object with `ok`, `reason`
// and `evidence`. Anything else — non-zero exit, extra text, missing or unknown key, timeout,
// too much output, a program that does not exist — throws, so the engine blocks it technically.
// The group is always terminated; a group that cannot be confirmed empty raises
// `ProcessTreeSurvived` with its quarantine.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MINUTES_MS = 60_000;
const PLACEHOLDER = /^\{[^{}]*\}$/;

export interface CommandLimits {
  readonly commandTimeoutMs?: number;
  readonly stdoutBytes?: number;
}

export interface CommandGateOptions {
  readonly run: string;
  readonly root: string;
  readonly groups: ProcessGroupControl;
  readonly limits: CommandLimits;
  /** The recipe's raw `with:`, handed to the command as `with`. */
  readonly withValue: unknown;
  /** Absolute folder of a project command block; its script argument resolves there. */
  readonly blockDir?: string;
  /** `timeout-minutes` of a project block, in minutes, when no limit is configured. */
  readonly timeoutMinutes?: number;
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

/** The program, or the first non-flag non-marker argument after it (PLAN-13-R2 §2.2). */
function scriptArgument(run: string): string | undefined {
  const args = run.split(' ').filter((argument) => argument.length > 0);
  const first = args[0];
  if (first === undefined) return undefined;
  if (first.includes('/') || first.includes('\\') || first.startsWith('.')) return first;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument.startsWith('-') || PLACEHOLDER.test(argument)) continue;
    return argument;
  }
  return undefined;
}

/** Files of the change that are tests, in the order the facts list them. */
function testFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.filter(
    (file): file is string =>
      typeof file === 'string' && (file.endsWith('.test.ts') || file.endsWith('.test.tsx')),
  );
}

function expandedArguments(
  run: string,
  piece: string,
  tests: readonly string[],
  blockDir: string | undefined,
): { readonly program: string; readonly args: string[] } {
  const tokens = run.split(' ').filter((token) => token.length > 0);
  const program = (tokens[0] ?? piece).replaceAll('{piece}', piece);
  const script = scriptArgument(run);
  const args: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token === '{tests}') {
      args.push(...tests);
      continue;
    }
    if (blockDir !== undefined && script !== undefined && token === script) {
      args.push(join(blockDir, token));
      continue;
    }
    args.push(token.replaceAll('{piece}', piece));
  }
  return { program, args };
}

function readChange(context: GateContext): Record<string, unknown> {
  const change = context.change;
  return typeof change === 'object' && change !== null ? (change as Record<string, unknown>) : {};
}

function standardInput(context: GateContext, withValue: unknown): string {
  const change = readChange(context);
  return JSON.stringify({
    piece: context.piece,
    sha: change['sha'] ?? null,
    base: change['base'] ?? null,
    files: change['files'] ?? [],
    classes: change['classes'] ?? [],
    kind: change['kind'] ?? null,
    lane: change['lane'] ?? null,
    mode: context.mode,
    with: withValue ?? null,
    journal: context.journal,
  });
}

interface CommandAnswer {
  readonly ok: true | false | 'skipped';
  readonly reason?: unknown;
  readonly evidence?: unknown;
}

function parseAnswer(output: string): CommandAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('the command output is not a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the command output is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'ok' && key !== 'reason' && key !== 'evidence') {
      throw new Error(`unknown key "${key}"`);
    }
  }
  if (!Object.hasOwn(record, 'ok')) throw new Error('"ok" is missing');
  const ok = record['ok'];
  if (ok !== true && ok !== false && ok !== 'skipped') {
    throw new Error('"ok" must be true, false or "skipped"');
  }
  if (ok !== true && (typeof record['reason'] !== 'string' || record['reason'].trim().length === 0)) {
    throw new Error('"reason" is required');
  }
  return { ok, reason: record['reason'], evidence: record['evidence'] };
}

function gateResultOf(answer: CommandAnswer): GateResult {
  if (answer.ok === true) {
    return answer.evidence === undefined
      ? { ok: true }
      : { ok: true, evidence: answer.evidence as JsonValue };
  }
  const reason = answer.reason as string;
  return answer.ok === 'skipped' ? { ok: 'skipped', reason } : { ok: false, reason };
}

export function createCommandGate(options: CommandGateOptions): Gate {
  const timeoutMs =
    options.limits.commandTimeoutMs ??
    (options.timeoutMinutes === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMinutes * MINUTES_MS);
  const stdoutBytes = options.limits.stdoutBytes ?? DEFAULT_STDOUT_BYTES;

  return async (context): Promise<GateResult> => {
    // A rehearsal must not launch anything. Going through `runEffect` makes the engine refuse
    // it with its own dry-run path, which reports the stage as not rehearsable without
    // recording a failure.
    if (context.mode === 'dry-run') {
      await context.runEffect('command-block', async () => null);
      throw new Error('a dry run must not launch a command block');
    }

    const change = readChange(context);
    const { program, args } = expandedArguments(
      options.run,
      context.piece,
      testFiles(change['files']),
      options.blockDir,
    );
    const resolved = resolveExecutable(program, executableEnvironment());
    if (!resolved.ok) throw new Error(`could not start ${program}: ${resolved.reason}`);

    const group = options.groups.launch({
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: options.root,
      stdin: standardInput(context, options.withValue),
      // The agents' own credentials never reach a command the piece runs (PLAN-13-R4 §8).
      environment: childEnvironment(),
      ...(resolved.env === undefined ? {} : { env: resolved.env }),
      timeoutMs,
      stdoutBytes,
    });

    // Cancellation must be honoured at once, not when the process decides to end: the wait
    // races the signal, and on abort the group is terminated and confirmed there and then.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolve) => {
      if (context.signal.aborted) {
        resolve('aborted');
        return;
      }
      onAbort = () => resolve('aborted');
      context.signal.addEventListener('abort', onAbort, { once: true });
    });

    // Ends the group and confirms it is empty. An explicit "not empty" is quarantined at once,
    // whatever the command's exit code; only a lost answer is settled by asking the system
    // again (PLAN-13-R2 §11).
    const confirmEmpty = (): Promise<void> =>
      confirmEmptyGroup(group, options.groups, program);

    try {
      const raced = await Promise.race([
        group.wait().then((exit) => ({ exit })),
        aborted.then(() => 'aborted' as const),
      ]);

      let exit: GroupExit;
      if (raced === 'aborted') {
        await confirmEmpty();
        exit = await group.wait();
      } else {
        exit = raced.exit;
      }

      if (exit.kind === 'technical') throw new Error(exit.reason);
      if (exit.code !== 0) throw new Error(`the command exited with code ${exit.code}`);
      return gateResultOf(parseAnswer(exit.stdout));
    } finally {
      if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
      await confirmEmpty();
    }
  };
}
