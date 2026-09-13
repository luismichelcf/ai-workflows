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

export function sameExecution(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.session === b.session;
}

/** A human-readable name for the execution, so a rejection can name the offender. */
function describe(identity: ExecutionIdentity): string {
  return `${identity.provider}/${identity.model}@${identity.session}`;
}

/** Nobody approves their own work, judged by execution identity and not by account. */
export function requireDifferentBuilder(
  verdicts: readonly Verdict[],
  builder: ExecutionIdentity,
  options?: IndependenceOptions,
): CheckResult {
  // No review is not a clean review: silence cannot stand in for scrutiny.
  if (verdicts.length === 0) {
    return { ok: false, reason: 'No review was recorded, so nobody can vouch for this work.' };
  }

  for (const verdict of verdicts) {
    // The same session that wrote the code reviewing it is self-approval, whatever the
    // GitHub account says: here every model posts through the owner's account.
    if (sameExecution(verdict.by, builder)) {
      return {
        ok: false,
        reason: `Reviewer ${describe(verdict.by)} is the builder and cannot approve its own work.`,
      };
    }

    // A different session of the same model still shares the model's blind spots. When the
    // rule asks for a different family, only a different provider counts.
    if (options?.differentProvider && verdict.by.provider === builder.provider) {
      return {
        ok: false,
        reason:
          `Reviewer ${describe(verdict.by)} is from the same provider as the builder ` +
          `(${builder.provider}) and a different provider is required.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Every verdict is about the code as it is now, finished, and approving. A review of what
 * the code used to be is not a review of what it is.
 */
export function requireFreshVerdicts(
  verdicts: readonly Verdict[],
  currentSha: string,
  options?: FreshnessOptions,
): CheckResult {
  // No review is not a clean review.
  if (verdicts.length === 0) {
    return { ok: false, reason: 'No review was recorded, so nothing vouches for this code.' };
  }

  for (const verdict of verdicts) {
    // The real case this catches: reviewed as A, pushed, now B, and A's approval waves B
    // through. Name both shas so the report says exactly what went stale.
    if (verdict.sha !== currentSha) {
      return {
        ok: false,
        reason:
          `Review by ${describe(verdict.by)} is of ${verdict.sha}, but the code is now ${currentSha}.`,
      };
    }

    // An undefined approval means the review never finished, which is not a refusal and must
    // not pass as a clean review.
    if (verdict.approved === undefined) {
      return {
        ok: false,
        reason: `Review by ${describe(verdict.by)} of ${verdict.sha} never finished.`,
      };
    }

    // A blocking finding means the review failed; carry its reason through rather than
    // flattening it to a generic message.
    if (!verdict.approved) {
      const why = verdict.reason ? `: ${verdict.reason}` : '';
      return {
        ok: false,
        reason: `Review by ${describe(verdict.by)} found something blocking${why}`,
      };
    }
  }

  // Each required angle needs its own fresh, approving verdict. A stale verdict was already
  // rejected above; this guards against a required angle simply never having been reviewed.
  for (const angle of options?.angles ?? []) {
    const covered = verdicts.some(
      (verdict) =>
        verdict.angle === angle && verdict.sha === currentSha && verdict.approved === true,
    );
    if (!covered) {
      return {
        ok: false,
        reason: `No fresh, approving review covers the required angle "${angle}".`,
      };
    }
  }

  return { ok: true };
}
