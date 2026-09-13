import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import type { CheckResult } from './gates.js';

export interface GateCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Milliseconds before the command is given up on. Default is generous but finite. */
  readonly timeoutMs?: number;
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
}

/** Markers that mean the runner never got as far as executing tests. */
const BROKEN_ENVIRONMENT_MARKERS = ['Failed to load url', 'ERR_MODULE_NOT_FOUND', 'SyntaxError'];

/** Reads what a test run actually did. Never trusts the exit code alone. */
export function parseTestRun(run: TestRun): TestRunSummary {
  const { output } = run;

  // A failure is only a failure if it is named. Keep the test name after `FAIL`.
  const failures = [...output.matchAll(/^[^\S\n]*FAIL\s+(.+?)\s*$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );

  // The assertion message is what proves the test failed for the reason it was written for.
  const assertions = [...output.matchAll(/AssertionError:[^\n]*/g)].map((match) =>
    (match[0] ?? '').trim(),
  );

  const summary = /^[^\S\n]*Tests\s+(.+)$/m.exec(output);
  const summaryLine = summary?.[1] ?? '';
  const failedFromSummary = countInSummary(summaryLine, 'failed');
  const passed = countInSummary(summaryLine, 'passed');

  // The output rules the exit code, not the other way around: a run that says "failed" is
  // failed even when it exits zero. When there is no summary line, the named failures are
  // the only count available.
  const failed = summary ? failedFromSummary : failures.length;

  const empty = output.trim().length === 0;
  const brokenEnvironment =
    empty || BROKEN_ENVIRONMENT_MARKERS.some((marker) => output.includes(marker));

  return { passed, failed, failures, assertions, brokenEnvironment };
}

/** Reads `N failed` / `N passed` out of the `Tests ...` summary line only. */
function countInSummary(line: string, word: 'failed' | 'passed'): number {
  const match = new RegExp(`(\\d+)\\s+${word}`).exec(line);
  return match ? Number(match[1] ?? 0) : 0;
}
