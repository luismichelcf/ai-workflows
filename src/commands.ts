import type { CheckResult } from './gates.js';

export interface GateCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Milliseconds before the command is given up on. Default is generous but finite. */
  readonly timeoutMs?: number;
}

/**
 * Runs a command and turns it into a check. This is what "recompute" means in practice:
 * the engine produces the result now instead of believing a report. Output is kept, but
 * trimmed to something a person can read — keeping the END, since that is where the
 * failure is.
 */
export function runGateCommand(_command: GateCommand): Promise<CheckResult> {
  throw new Error('runGateCommand: not implemented');
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

/** Reads what a test run actually did. Never trusts the exit code alone. */
export function parseTestRun(_run: TestRun): TestRunSummary {
  throw new Error('parseTestRun: not implemented');
}
