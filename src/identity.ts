import type { CheckResult } from './gates.js';

/**
 * Who actually did a piece of work. NOT the GitHub account: every model in this house
 * publishes through the owner's account, so comparing accounts would reject valid reviews
 * and accept a model approving itself. What tells them apart is what the CLI reports.
 */
export interface ExecutionIdentity {
  readonly provider: string;
  readonly model: string;
  readonly session: string;
}

export interface Verdict {
  readonly by: ExecutionIdentity;
  /** The exact code this verdict is about. */
  readonly sha: string;
  /** Undefined means the review never finished, which is not the same as a refusal. */
  readonly approved?: boolean;
  readonly reason?: string;
  /** Which angle this reviewer was asked to cover. */
  readonly angle?: string;
}

export interface IndependenceOptions {
  /** Require a different provider, not merely a different session. */
  readonly differentProvider?: boolean;
}

export interface FreshnessOptions {
  /** Every one of these angles must be covered by a fresh, approving verdict. */
  readonly angles?: readonly string[];
}

export function sameExecution(_a: ExecutionIdentity, _b: ExecutionIdentity): boolean {
  throw new Error('sameExecution: not implemented');
}

/** Nobody approves their own work, judged by execution identity and not by account. */
export function requireDifferentBuilder(
  _verdicts: readonly Verdict[],
  _builder: ExecutionIdentity,
  _options?: IndependenceOptions,
): CheckResult {
  throw new Error('requireDifferentBuilder: not implemented');
}

/**
 * Every verdict is about the code as it is now, finished, and approving. A review of what
 * the code used to be is not a review of what it is.
 */
export function requireFreshVerdicts(
  _verdicts: readonly Verdict[],
  _currentSha: string,
  _options?: FreshnessOptions,
): CheckResult {
  throw new Error('requireFreshVerdicts: not implemented');
}
