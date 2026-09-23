import { spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';

import {
  launchWindowsGroup,
  checkWindowsQuarantine,
  windowsSurvivorAlive,
} from './process-group-windows.js';

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

/** One process the Windows launcher named as still alive when it gave up emptying its job. */
export type QuarantineSurvivor = {
  readonly pid: number;
  /** The process's creation time as FILETIME UTC text, so a reused pid is told apart. */
  readonly created: string;
};

/** How to ask the system again whether a group is empty; never a list of processes. */
export type Quarantine =
  | {
      readonly host: string;
      readonly platform: 'win32';
      readonly job: string;
      readonly confirmed: false;
      /** Processes the launcher could not end, with their creation time; absent means none. */
      readonly survivors?: readonly QuarantineSurvivor[];
    }
  | { readonly host: string; readonly platform: 'posix'; readonly pgid: number; readonly confirmed: false };

export type QuarantineCheck = { readonly empty: true } | { readonly empty: false; readonly reason: string };

/**
 * What emptying a group produced. An explicit `empty: false` is a fact the launcher (or the
 * POSIX kill) observed and is never overruled; `lost: true` means the answer was lost — the
 * Windows launcher died, left no result, or did not answer in time — so the system may be
 * asked again before quarantining.
 */
export type TerminateResult =
  | { readonly empty: true }
  | { readonly empty: false; readonly lost?: boolean };

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
  terminate(): Promise<TerminateResult>;
}

export interface ProcessGroupControl {
  launch(options: LaunchInGroupOptions): ProcessGroup;
  check(quarantine: unknown): Promise<QuarantineCheck>;
}

/** How the engine launches and re-checks groups when the project does not say otherwise. */
export const DEFAULT_PROCESS_GROUPS: ProcessGroupControl = {
  launch: (options) => launchInGroup(options),
  check: (quarantine) => checkQuarantine(quarantine),
};

/** The command block's default output limit, one mebibyte. */
export const DEFAULT_STDOUT_BYTES = 1_048_576;
/** How long `terminate` waits for the group to actually empty before reporting failure. */
export const TERMINATE_TIMEOUT_MS = 10_000;

/** What a launched process left behind, before it is classified per platform. */
export interface RawExit {
  readonly code: number | null;
  /** The signal that ended the process, when one did. */
  readonly signal: NodeJS.Signals | null;
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

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        signal,
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
      finish(null, null);
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
    child.on('close', (code, signal) => finish(code, signal));

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
  // A process killed by a signal (OOM, SIGKILL, SIGSEGV) has no exit code, or a null one.
  // Reading that as 0 would approve whatever it printed before dying.
  if (raw.signal !== null) {
    return { kind: 'technical', reason: `the command was killed by signal ${raw.signal}` };
  }
  if (raw.code === null) {
    return { kind: 'technical', reason: 'the command ended without an exit code' };
  }
  return {
    kind: 'exited',
    code: raw.code,
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

  let terminatePromise: Promise<TerminateResult> | undefined;
  const doTerminate = async (): Promise<TerminateResult> => {
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
  const terminate = (): Promise<TerminateResult> => (terminatePromise ??= doTerminate());

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
    // Survivors the launcher named are checked first, by pid AND creation time: a pid reused
    // by another process is not the survivor, and while one really lives the quarantine holds
    // whatever the job name says. Only when none is alive does the job name decide.
    const survivors = readSurvivors(record['survivors']);
    if (survivors.length > 0 && (await windowsSurvivorAlive(survivors))) {
      return { empty: false, reason: `the job object "${record['job']}" still has the processes it named` };
    }
    return checkWindowsQuarantine(record['job']);
  }
  return { empty: false, reason: 'the quarantine is not readable' };
}

/** The well-formed survivors of a Windows quarantine, ignoring anything unreadable. */
function readSurvivors(value: unknown): QuarantineSurvivor[] {
  if (!Array.isArray(value)) return [];
  const survivors: QuarantineSurvivor[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const pid = record['pid'];
    const created = record['created'];
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof created === 'string') {
      survivors.push({ pid, created });
    }
  }
  return survivors;
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
