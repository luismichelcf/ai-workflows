import { spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';

import { childEnvironment } from './git-env.js';
import {
  launchWindowsGroup,
  checkWindowsQuarantine,
  currentWindowsSessionId,
  windowsSurvivorStatus,
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

/**
 * The processes a Windows quarantine names, or `'unreadable'` when the launcher could not list
 * them. Reading failures as "no survivors" is how a live process is called gone, so unreadable
 * is its own answer and keeps the quarantine.
 */
export type QuarantineSurvivors = readonly QuarantineSurvivor[] | 'unreadable';

/** How to ask the system again whether a group is empty; never a list of processes. */
export type Quarantine =
  | {
      readonly host: string;
      readonly platform: 'win32';
      readonly job: string;
      readonly confirmed: false;
      /**
       * The logon session the launcher ran in. A group of another session cannot be asked from
       * this one, so the quarantine must hold; absent means the session was never recorded.
       */
      readonly session?: number;
      /**
       * Processes the launcher could not end, with their creation time; absent means none and
       * `'unreadable'` means they could not be listed.
       */
      readonly survivors?: QuarantineSurvivors;
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
  | {
      readonly empty: false;
      readonly lost?: boolean;
      /**
       * The processes the launcher named as still alive, or `'unreadable'` when its list could
       * not be read; absent means it named none.
       */
      readonly survivors?: QuarantineSurvivors;
    };

export interface LaunchInGroupOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The whole environment of the group when given: the process's own is not inherited, and the
   * `env` of a shim, if any, is laid over this one. Absent means the process's own is inherited.
   */
  readonly environment?: NodeJS.ProcessEnv;
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

/** How long a killed POSIX group is given to let its pipes close before the wait gives up. */
const KILL_SETTLE_MS = 2_000;

/** The command block's default output limit, one mebibyte. */
export const DEFAULT_STDOUT_BYTES = 1_048_576;
/** The output limit for a test suite or a coding CLI, whose report can be large (32 MiB). */
export const TEST_STDOUT_BYTES = 33_554_432;
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
  readonly kill: (limit: 'timeout' | 'overLimit') => void;
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
        options.kill('overLimit');
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
        options.kill('timeout');
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
    // The agents' credentials never reach a child the piece runs (PLAN-13-R4 §8).
    env: { ...(options.environment ?? childEnvironment()), ...(options.env ?? {}) },
  });
  // A stream error on a child that never started must not crash the engine.
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  const pgid = child.pid ?? 0;
  const quarantine: Quarantine = { host: hostname(), platform: 'posix', pgid, confirmed: false };

  let killReason: 'timeout' | 'overLimit' | undefined;
  let terminatePromise: Promise<TerminateResult> | undefined;
  let notifyTerminated: (() => void) | undefined;
  const terminated = new Promise<void>((resolve) => {
    notifyTerminated = resolve;
  });
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
  const terminate = (): Promise<TerminateResult> => {
    const promise = (terminatePromise ??= doTerminate());
    void promise.then(
      () => notifyTerminated?.(),
      () => notifyTerminated?.(),
    );
    return promise;
  };

  const raw = collectExit(child, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    stdoutBytes,
    kill: (limit) => {
      killReason = limit;
      void terminate();
    },
  });

  let waitPromise: Promise<GroupExit> | undefined;
  const wait = (): Promise<GroupExit> => {
    waitPromise ??= (async () => {
      try {
        child.stdin?.end(options.stdin);
      } catch {
        // A child that never started has nowhere to read the input from.
      }
      // An escaped process (a `setsid` grandchild) keeps the inherited pipes open, so the child
      // never emits `close` and waiting forever would hang the engine. Once the group was
      // killed, the streams are given a short grace and then destroyed by hand.
      const settled = await Promise.race([
        raw,
        terminated.then(
          () =>
            new Promise<'killed'>((resolve) => {
              const timer = setTimeout(() => resolve('killed'), KILL_SETTLE_MS);
              timer.unref?.();
            }),
        ),
      ]);
      if (settled === 'killed') {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        if (killReason === 'overLimit') {
          return { kind: 'technical', reason: `printed more than ${stdoutBytes} bytes` };
        }
        if (killReason === 'timeout') {
          return { kind: 'technical', reason: `ran out of time after ${options.timeoutMs ?? 0} ms` };
        }
        return {
          kind: 'technical',
          reason: `the command of "${options.command}" was stopped before it reported an exit code`,
        };
      }
      return posixExit(options.command, options.timeoutMs, stdoutBytes, settled);
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
    const job = record['job'];
    // A group of another logon session cannot be asked from this one, so it stays quarantined.
    // The current session is read once and kept, because asking is slow and it cannot change.
    const session = record['session'];
    if (typeof session === 'number' && Number.isInteger(session)) {
      const current = await currentWindowsSessionId();
      if (current === undefined) {
        return { empty: false, reason: `the session of the job object "${job}" could not be confirmed` };
      }
      if (current !== session) {
        return { empty: false, reason: `processes to confirm in another session: ${session}` };
      }
    }
    // A launcher that could not list what is left is never "empty": the answer it could not
    // give is exactly the one that would have lifted the quarantine.
    if (record['survivors'] === 'unreadable') {
      return {
        empty: false,
        reason: `the processes of the job object "${job}" could not be listed`,
      };
    }
    // Survivors the launcher named are checked first, by pid AND creation time: a pid reused
    // by another process is not the survivor, and while one really lives the quarantine holds
    // whatever the job name says. Only when every one is really gone does the job name decide.
    // An entry that cannot be read is not ignored: unknown keeps the quarantine.
    const named = inspectReportSurvivors(record['survivors']);
    if (named.malformed) {
      return { empty: false, reason: `the job object "${job}" named processes that cannot be read` };
    }
    if (named.survivors.length > 0) {
      const state = await windowsSurvivorStatus(named.survivors);
      if (state === 'alive') {
        return { empty: false, reason: `the job object "${job}" still has the processes it named` };
      }
      if (state === 'unknown') {
        return { empty: false, reason: `the processes of the job object "${job}" could not be confirmed gone` };
      }
    }
    return checkWindowsQuarantine(job);
  }
  return { empty: false, reason: 'the quarantine is not readable' };
}

/**
 * The survivors of a Windows quarantine. Unlike the old reader, an unreadable entry is not
 * dropped in silence: it is reported so the caller keeps the quarantine instead of asking a
 * job name that may have been reused.
 */
function inspectReportSurvivors(value: unknown): {
  readonly survivors: QuarantineSurvivor[];
  readonly malformed: boolean;
} {
  if (value === undefined) return { survivors: [], malformed: false };
  if (!Array.isArray(value)) return { survivors: [], malformed: true };
  const survivors: QuarantineSurvivor[] = [];
  let malformed = false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      malformed = true;
      continue;
    }
    const record = item as Record<string, unknown>;
    const pid = record['pid'];
    const created = record['created'];
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof created === 'string') {
      survivors.push({ pid, created });
    } else {
      malformed = true;
    }
  }
  return { survivors, malformed };
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
