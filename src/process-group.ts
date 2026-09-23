import { spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';

import { launchWindowsGroup, checkWindowsQuarantine } from './process-group-windows.js';

// PLAN-13-R2 §2.2 (RC-10): a block's processes live inside one group the operating system
// keeps together — a named job object on Windows, a process group elsewhere — so ending the
// block ends every descendant, even an orphaned grandchild. Whether the group is empty is
// never guessed from a list of processes: it is asked again of the system, and only an
// affirmative answer lifts a quarantine. Everything is launched without a console.

export type GroupExit =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly truncated: boolean;
    }
  | { readonly kind: 'technical'; readonly reason: string };

/** How to ask the system again whether a group is empty; never a list of processes. */
export type Quarantine =
  | { readonly host: string; readonly platform: 'win32'; readonly job: string; readonly confirmed: false }
  | { readonly host: string; readonly platform: 'posix'; readonly pgid: number; readonly confirmed: false };

export type QuarantineCheck = { readonly empty: true } | { readonly empty: false; readonly reason: string };

export interface LaunchInGroupOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the group is given up on. Absent means no limit. */
  readonly timeoutMs?: number;
  /** Most stdout kept, in bytes. More than this is a technical failure. */
  readonly stdoutBytes?: number;
}

export interface ProcessGroup {
  readonly quarantine: Quarantine;
  wait(): Promise<GroupExit>;
  /** Empties the whole group and confirms it (up to 10 s). Safe to call more than once. */
  terminate(): Promise<{ readonly empty: boolean }>;
}

export interface ProcessGroupControl {
  launch(options: LaunchInGroupOptions): ProcessGroup;
  check(quarantine: unknown): Promise<QuarantineCheck>;
}

/** The command block's default output limit, one mebibyte. */
export const DEFAULT_STDOUT_BYTES = 1_048_576;
/** How long `terminate` waits for the group to actually empty before reporting failure. */
export const TERMINATE_TIMEOUT_MS = 10_000;

/** What a launched process left behind, before it is classified per platform. */
export interface RawExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly overLimit: boolean;
  readonly startError?: string;
}

interface CollectOptions {
  readonly timeoutMs?: number;
  readonly stdoutBytes: number;
  /** Empties the group when a limit is reached, so the wait can settle. */
  readonly kill: () => void;
}

/**
 * Reads a child's output while it runs and settles once it closes. A start failure resolves
 * here too (as `startError`) instead of throwing: a missing program is an answer, not a crash.
 */
export function collectExit(child: ChildProcess, options: CollectOptions): Promise<RawExit> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let overLimit = false;
    let timedOut = false;
    let startError: string | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        truncated: false,
        timedOut,
        overLimit,
        ...(startError === undefined ? {} : { startError }),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (overLimit) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > options.stdoutBytes) {
        overLimit = true;
        options.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      // stderr is kept only for the failure motive, so it is bounded far below the output cap.
      if (stderr.length < options.stdoutBytes * 2) stderr += chunk;
    });

    child.on('error', (error) => {
      startError = error instanceof Error ? error.message : String(error);
      finish(null);
    });
    // Node holds the child's stdin pipe open until this side ends it, and `close` waits for
    // every stdio stream. For the Windows launcher, stdin is the kill channel and is never
    // written on a natural exit, so it is ended here to let `close` fire.
    child.on('exit', () => {
      try {
        child.stdin?.end();
      } catch {
        // The stream may already be closed or errored; that is the goal either way.
      }
    });
    child.on('close', (code) => finish(code));

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        options.kill();
      }, options.timeoutMs);
      timer.unref();
    }
  });
}

function startFailure(command: string, detail: string): GroupExit {
  return { kind: 'technical', reason: `could not start ${command}: ${detail}` };
}

function posixExit(
  command: string,
  timeoutMs: number | undefined,
  stdoutBytes: number,
  raw: RawExit,
): GroupExit {
  if (raw.startError !== undefined) return startFailure(command, raw.startError);
  if (raw.timedOut) return { kind: 'technical', reason: `ran out of time after ${timeoutMs ?? 0} ms` };
  if (raw.overLimit) return { kind: 'technical', reason: `printed more than ${stdoutBytes} bytes` };
  return {
    kind: 'exited',
    code: raw.code ?? 0,
    stdout: raw.stdout,
    stderr: raw.stderr,
    truncated: raw.truncated,
  };
}

function launchPosix(options: LaunchInGroupOptions): ProcessGroup {
  const stdoutBytes = options.stdoutBytes ?? DEFAULT_STDOUT_BYTES;
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  // A stream error on a child that never started must not crash the engine.
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  const pgid = child.pid ?? 0;
  const quarantine: Quarantine = { host: hostname(), platform: 'posix', pgid, confirmed: false };

  let terminatePromise: Promise<{ empty: boolean }> | undefined;
  const doTerminate = async (): Promise<{ empty: boolean }> => {
    if (pgid <= 0) return { empty: true };
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group is already gone, or cannot be signalled: the check below decides.
    }
    const deadline = Date.now() + TERMINATE_TIMEOUT_MS;
    for (;;) {
      try {
        process.kill(-pgid, 0);
      } catch (error) {
        return { empty: (error as NodeJS.ErrnoException).code === 'ESRCH' };
      }
      if (Date.now() >= deadline) return { empty: false };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const terminate = (): Promise<{ empty: boolean }> => (terminatePromise ??= doTerminate());

  const raw = collectExit(child, { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), stdoutBytes, kill: () => void terminate() });

  let waitPromise: Promise<GroupExit> | undefined;
  const wait = (): Promise<GroupExit> => {
    waitPromise ??= (async () => {
      try {
        child.stdin?.end(options.stdin);
      } catch {
        // A child that never started has nowhere to read the input from.
      }
      return posixExit(options.command, options.timeoutMs, stdoutBytes, await raw);
    })();
    return waitPromise;
  };

  return { quarantine, wait, terminate };
}

export function launchInGroup(options: LaunchInGroupOptions): ProcessGroup {
  return process.platform === 'win32' ? launchWindowsGroup(options) : launchPosix(options);
}

export async function checkQuarantine(quarantine: unknown): Promise<QuarantineCheck> {
  if (typeof quarantine !== 'object' || quarantine === null) {
    return { empty: false, reason: 'the quarantine is not readable' };
  }
  const record = quarantine as Record<string, unknown>;
  const host = record['host'];
  if (typeof host !== 'string' || host.length === 0) {
    return { empty: false, reason: 'the quarantine is not readable' };
  }
  if (host !== hostname()) {
    return { empty: false, reason: `processes to confirm on another machine: ${host}` };
  }
  if (record['platform'] === 'posix') return checkPosix(record['pgid']);
  if (record['platform'] === 'win32' && typeof record['job'] === 'string') {
    return checkWindowsQuarantine(record['job']);
  }
  return { empty: false, reason: 'the quarantine is not readable' };
}

function checkPosix(pgid: unknown): QuarantineCheck {
  if (typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 0) {
    return { empty: false, reason: 'the quarantine is not readable' };
  }
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { empty: true };
    return { empty: false, reason: `the process group ${pgid} could not be checked` };
  }
  return { empty: false, reason: `the process group ${pgid} still has processes` };
}
