import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

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

/** A reason has to stay readable in a terminal; 3900 leaves room for the truncation note. */
const MAX_REASON_CHARS = 3900;

const TRUNCATION_NOTE = '...[output truncated; keeping the end, where the failure is]...\n';

/**
 * Runs a command and turns it into a check. This is what "recompute" means in practice:
 * the engine produces the result now instead of believing a report. Output is kept, but
 * trimmed to something a person can read — keeping the END, since that is where the
 * failure is.
 */
export function runGateCommand(command: GateCommand): Promise<CheckResult> {
  return new Promise((resolve) => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Resolved by exactly one of error/close; the other must stay silent so that an error
    // arriving after a timeout does not overwrite the timeout's reason.
    let settled = false;
    let timedOut = false;

    const options: SpawnOptions = { shell: false };
    if (command.cwd !== undefined) options.cwd = command.cwd;

    let child: ChildProcess;
    try {
      // Arguments are passed as an array, never concatenated into a shell line: the command
      // and its args come from project config and must not be reinterpreted by a shell.
      child = spawn(command.command, [...command.args], options);
    } catch (error) {
      resolve({ ok: false, reason: describeStartFailure(command.command, error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill it for real. Reporting a timeout while the process keeps running would leak a
      // live process and make the gate a lie.
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: CheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({
        ok: false,
        reason: timedOut
          ? timeoutReason(command.command, timeoutMs)
          : describeStartFailure(command.command, error),
      });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ ok: false, reason: timeoutReason(command.command, timeoutMs) });
        return;
      }

      if (code === 0) {
        finish({ ok: true });
        return;
      }

      finish({
        ok: false,
        reason: failureReason(command.command, code, signal, stdout, stderr),
      });
    });
  });
}

/** The command never started (missing binary, bad cwd): report it, do not throw. */
function describeStartFailure(command: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return clip(`Command "${command}" could not be started${code ? ` (${code})` : ''}: ${message}`);
}

function timeoutReason(command: string, timeoutMs: number): string {
  // The word "tiempo" is required by the contract; the command is killed, not merely abandoned.
  return clip(`Command "${command}" ran out of tiempo after ${timeoutMs}ms and was killed.`);
}

function failureReason(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): string {
  const detail = [stdout, stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream.length > 0)
    .join('\n');
  const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
  const body = detail.length > 0 ? detail : '(no output)';
  return clip(`Command "${command}" failed with ${status}:\n${body}`);
}

/**
 * Keeps the END of a long message. The head of a test/command log is setup noise; the tail
 * is where the failure lands. Says so when it trims, so nobody reads a clipped log as whole.
 */
function clip(text: string): string {
  if (text.length <= MAX_REASON_CHARS) return text;
  const keep = MAX_REASON_CHARS - TRUNCATION_NOTE.length;
  return TRUNCATION_NOTE + text.slice(text.length - keep);
}

export interface TestRun {
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
