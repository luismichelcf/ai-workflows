import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { resolveExecutable, type ExecutableEnvironment, type ResolvedExecutable } from './exec.js';
import type { CheckResult } from './gates.js';

export interface GateCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Milliseconds before the command is given up on. Default is generous but finite. */
  readonly timeoutMs?: number;
  /**
   * How to read what the command did. Without it, exit code 0 is success — which is only
   * honest for commands whose exit code is the whole truth. A test run is not one of them.
   */
  readonly interpret?: (run: TestRun) => CheckResult;
}

/** Generous but finite: a hung gate must never hang the whole engine. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The largest delay `setTimeout` can represent in 32 bits. Above it — and for `Infinity` or
 * `NaN` — Node silently treats the value as 1ms, which would kill every command instantly and
 * read as a timeout. Such a limit is refused before anything is launched, never obeyed.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** A reason has to stay readable in a terminal; 3900 leaves room for the truncation note. */
const MAX_REASON_CHARS = 3900;

/**
 * The most output kept in memory. Only the tail matters (the failure is at the end), and a
 * command that prints gigabytes must not crash the engine by growing one string without bound.
 */
const MAX_OUTPUT_CHARS = 64 * 1024;

const TRUNCATION_NOTE = '...[output truncated; keeping the end, where the failure is]...\n';

/** ANSI OSC sequences (window titles, hyperlinks): ESC ] … BEL, or ESC ] … ESC backslash. */
const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
/** ANSI CSI sequences: the colour and cursor codes a test runner emits. */
const ANSI_CSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
/** Any remaining two-character ANSI escape (ESC followed by a byte in 0x40–0x5F). */
const ANSI_ESCAPE = /\u001B[\u0040-\u005F]/g;
/** Control characters other than newline and tab; they have no place in a reason a person reads. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Runs a command and turns it into a check. This is what "recompute" means in practice:
 * the engine produces the result now instead of believing a report. The command is launched
 * directly, never through a shell, so its arguments are never re-parsed; a hung or runaway
 * process is bounded by a timeout that kills the whole tree and answers at once.
 */
export function runGateCommand(command: GateCommand): Promise<CheckResult> {
  return new Promise((resolve) => {
    // Rule: validate the limit before doing anything else. `NaN`/`Infinity`/negative/fractional
    // values would otherwise become a 1ms delay and kill the command instantly; a value past 32
    // bits cannot be represented. Refuse rather than obey, and never start the command.
    const configured = command.timeoutMs;
    const timeoutProblem = validateTimeout(configured);
    if (timeoutProblem !== undefined) {
      resolve({ ok: false, reason: clip(timeoutProblem) });
      return;
    }
    const timeoutMs = configured ?? DEFAULT_TIMEOUT_MS;

    // Rule: resolve to a real executable without a shell. A `.cmd` shim cannot be spawned by
    // Node on Windows, and going through a shell would re-parse the arguments.
    const resolved = resolveGateCommand(command.command);
    if (!resolved.ok) {
      resolve({ ok: false, reason: clip(resolved.reason) });
      return;
    }

    const options: SpawnOptions = {
      // Never a shell: the command and its args come from project config and run as-is.
      shell: false,
      // stdin is closed so a command waiting for input that will never come cannot hang.
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (command.cwd !== undefined) options.cwd = command.cwd;
    // On POSIX, a new process group lets a timeout kill grandchildren, not only the child.
    if (process.platform !== 'win32') options.detached = true;

    let child: ChildProcess;
    try {
      // Arguments are passed as an array, never concatenated into a shell line. The shim's
      // target (if any) goes first, then the caller's args.
      child = spawn(resolved.command, [...resolved.prefixArgs, ...command.args], options);
    } catch (error) {
      resolve({ ok: false, reason: describeStartFailure(command.command, error) });
      return;
    }

    // One buffer, filled in arrival order from both pipes, bounded to the tail. `setEncoding`
    // decodes UTF-8 across chunk boundaries, so a multi-byte character split between two
    // writes (the `ñ` case) is not mangled into a replacement character.
    let output = '';
    const append = (chunk: string): void => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append(chunk));
    child.stderr?.on('data', (chunk: string) => append(chunk));

    // Settled by exactly one of timeout/error/close; the others must stay silent so a later
    // event cannot overwrite the first answer.
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: CheckResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree, then answer at once. Destroying the pipes means a grandchild that
      // inherited them and is still alive cannot hold the answer open: `close` need never come.
      killProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ ok: false, reason: timeoutReason(command.command, timeoutMs) });
    }, timeoutMs);

    child.on('error', (error) => {
      finish({
        ok: false,
        reason: timedOut
          ? timeoutReason(command.command, timeoutMs)
          : describeStartFailure(command.command, error),
      });
    });

    // `close` — not `exit` — is when all output has been read. If the direct child exits while
    // a grandchild keeps the pipes open, this waits until the timeout, which then treats it as
    // unfinished: a command that leaves live processes behind did not end cleanly.
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ ok: false, reason: timeoutReason(command.command, timeoutMs) });
        return;
      }

      // Rule: a gate that knows how to read the output decides, even when the exit code is 0.
      // A timeout or a start failure never reaches here, so it can never be interpreted away.
      if (command.interpret !== undefined) {
        try {
          finish(command.interpret({ output, exitCode: code ?? 1 }));
        } catch (error) {
          finish({ ok: false, reason: describeInterpretFailure(command.command, error) });
        }
        return;
      }

      if (code === 0) {
        finish({ ok: true });
        return;
      }

      finish({ ok: false, reason: failureReason(command.command, code, signal, output) });
    });
  });
}

/** True when `timeoutMs` is a usable delay: an integer in `(0, 2^31 - 1]`. */
function validateTimeout(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return (
      `Invalid timeoutMs ${String(timeoutMs)}: the timeout must be a positive integer ` +
      `no greater than ${MAX_TIMEOUT_MS} milliseconds.`
    );
  }
  return undefined;
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
 * The command as a program that can be launched without a shell. An absolute path that exists
 * is used as-is; anything else is a name looked up on the PATH, where a `.cmd` shim is read
 * and replaced by the program behind it.
 */
function resolveGateCommand(command: string): ResolvedExecutable {
  if (isAbsolute(command) && existsSync(command)) {
    return { ok: true, command, prefixArgs: [] };
  }
  return resolveExecutable(command, executableEnvironment());
}

/** Kills the command and everything it started, so a timeout does not leak a live process. */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    // `/T` walks the tree and `/F` forces it, which a wedged grandchild needs. Spawned
    // directly, never through a shell.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    // The child was started detached, so `pid` is the process-group id and the negative pid
    // reaches every process in the group, grandchildren included.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone, or was never created: there is nothing left to kill.
  }
}

/** The command never started (missing binary, bad cwd): report it, do not throw. */
function describeStartFailure(command: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return clip(`Command "${command}" could not be started${code ? ` (${code})` : ''}: ${message}`);
}

/** A gate's own reader threw: that is a failure of the check, not a reason to hang. */
function describeInterpretFailure(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return clip(`Command "${command}" finished but its output could not be read: ${message}`);
}

function timeoutReason(command: string, timeoutMs: number): string {
  // The word "tiempo" is required by the contract; the command is killed, not merely abandoned.
  return clip(`Command "${command}" ran out of tiempo after ${timeoutMs}ms and was killed.`);
}

function failureReason(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): string {
  // The two pipes are already one interleaved stream, so the reason shows what actually
  // happened, in the order it happened.
  const detail = sanitize(output).trim();
  const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  const body = detail.length > 0 ? detail : '(no output)';
  return clip(`Command "${command}" failed with ${status}:\n${body}`);
}

/** Removes terminal escape codes and control characters, keeping newlines and tabs. */
function sanitize(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARS, '');
}

/**
 * Keeps the END of a long message. The head of a test/command log is setup noise; the tail
 * is where the failure lands. Says so when it trims, so nobody reads a clipped log as whole.
 */
function clip(text: string): string {
  const clean = sanitize(text);
  if (clean.length <= MAX_REASON_CHARS) return clean;
  const keep = MAX_REASON_CHARS - TRUNCATION_NOTE.length;
  return TRUNCATION_NOTE + clean.slice(clean.length - keep);
}

export interface TestRun {
  /**
   * True when the output was too large to keep whole. A cut-off output may hide a failure, so
   * it is never read as green nor as red evidence.
   */
  readonly truncated?: boolean;
  readonly output: string;
  readonly exitCode: number;
}

export interface TestRunSummary {
  readonly passed: number;
  readonly failed: number;
  /** Names of the tests that failed. */
  readonly failures: readonly string[];
  /** The assertion messages, which are what prove a test failed for its own reason. */
  readonly assertions: readonly string[];
  /**
   * True when the run could not really run: a broken import, a missing module, a syntax
   * error, or no output at all. A red test is only evidence when it failed its assertion;
   * a suite that never loaded is a broken environment, and authorising a build on that
   * would be authorising it on nothing.
   */
  readonly brokenEnvironment: boolean;
  /** Errors outside any test (an unhandled rejection, a failing setup file). */
  readonly errors: number;
  /** Nothing actually ran: every test skipped or todo, or no tests at all. Never green. */
  readonly ranNothing: boolean;
  /** The process exit code, kept so a non-zero exit with nothing explaining it is never green. */
  readonly exitCode: number | null;
}

/**
 * Strips ANSI CSI sequences. Colour is the normal case on Windows when output is piped, and
 * an unstripped `\u001b[31m1 failed` never matches a count: a red run would read as "nothing
 * failed". Every rule below reads this plain text, never the raw output.
 */
const ANSI_CSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}

/** Reads what a test run actually did. Never trusts the exit code alone. */
export function parseTestRun(run: TestRun): TestRunSummary {
  const output = stripAnsi(run.output);

  // Every `Tests ...` line, not just the first. Chained runs (`a && b`) print one summary
  // each, and reading only the first turned a red second run green. Rule 2.
  const summaryLines = [...output.matchAll(/^[^\S\n]*Tests\s+(.+?)\s*$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );
  const passed = sumSummaryCounts(summaryLines, 'passed');
  const failedFromSummary = sumSummaryCounts(summaryLines, 'failed');

  // A named failing test is the only thing that counts as a red test. `FAIL  file [ file ]`
  // is a suite that never loaded, not a test: it is skipped here and marks the environment
  // broken below. Rule 3.
  const failures: string[] = [];
  let failedSuite = false;
  for (const match of output.matchAll(/^[^\S\n]*FAIL\s+([^\n]+)$/gm)) {
    const detail = (match[1] ?? '').trim();
    if (/\[[^\]]*\]\s*$/.test(detail)) {
      failedSuite = true;
      continue;
    }
    const separator = detail.indexOf('>');
    if (separator === -1) continue;
    failures.push(detail.slice(separator + 1).trim());
  }

  // The assertion message is what proves the test failed for the reason it was written for.
  // Rule 4.
  const assertions = [...output.matchAll(/AssertionError:[^\n]*/g)].map((match) =>
    (match[0] ?? '').trim(),
  );

  // Rule 5: never fewer failed tests than the ones named. Even with no summary (the process
  // was killed mid-run) the names are evidence, so the named count is a floor.
  const failed = Math.max(failedFromSummary, failures.length);

  const errors = countErrors(output);

  // Rule 7: broken means the runner never got as far as executing tests. The loose markers
  // (`SyntaxError`, `Failed to load url`, `ERR_MODULE_NOT_FOUND`) deliberately do NOT decide
  // this on their own: a test whose own assertion mentions "SyntaxError" is still a valid red
  // test, and the missing-import markers only mean something when the structure is empty.
  const empty = output.trim().length === 0;
  const noSummary = summaryLines.length === 0;
  const noTests = summaryLines.some((line) => line === 'no tests');
  const noTestFiles = output.includes('No test files found');
  // No summary is only readable when a failing test was still named; silence with neither a
  // summary nor a name is a broken environment, never a pass.
  const brokenEnvironment =
    empty || noTests || failedSuite || noTestFiles || (noSummary && failures.length === 0);

  // Rule 8: the run is intact but nothing ran — every test skipped or todo (or none at all).
  const ranNothing = !brokenEnvironment && passed + failed === 0;

  return {
    passed,
    failed,
    failures,
    assertions,
    brokenEnvironment,
    errors,
    ranNothing,
    exitCode: run.exitCode,
  };
}

/** Sums `N passed` / `N failed` across every summary line. Rule 2. */
function sumSummaryCounts(lines: readonly string[], word: 'passed' | 'failed'): number {
  const pattern = new RegExp(`(\\d+)\\s+${word}`);
  return lines.reduce((total, line) => {
    const match = pattern.exec(line);
    return total + (match ? Number(match[1] ?? 0) : 0);
  }, 0);
}

/**
 * Errors are failures outside any test: an unhandled rejection or a failing setup file. The
 * `Errors  N error(s)` line is authoritative; the `Unhandled Errors` block header alone is
 * one error, for the case where the count line is absent. Rule 6.
 */
function countErrors(output: string): number {
  let fromLine = 0;
  for (const match of output.matchAll(/^[^\S\n]*Errors\s+(\d+)\s+errors?\s*$/gm)) {
    fromLine += Number(match[1] ?? 0);
  }
  if (fromLine === 0 && output.includes('Unhandled Errors')) return 1;
  return fromLine;
}

/**
 * Rule 10: green means it ran, it loaded, nothing failed, nothing errored outside the tests,
 * at least one test ran, and the process agreed. Silence, skipped-only runs, a non-zero exit
 * and an unhandled error are all never green.
 */
export function isGreenRun(summary: TestRunSummary): boolean {
  return (
    !summary.brokenEnvironment &&
    !summary.ranNothing &&
    summary.failed === 0 &&
    summary.errors === 0 &&
    summary.passed > 0 &&
    summary.exitCode === 0
  );
}

/**
 * Rule 11: a red test is evidence only when a test failed its own assertion. A suite that
 * never loaded is a broken environment, and authorising a build on it is authorising it on
 * nothing.
 */
export function isRedEvidence(summary: TestRunSummary): boolean {
  return !summary.brokenEnvironment && summary.failed > 0 && summary.assertions.length > 0;
}
