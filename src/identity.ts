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

/**
 * A model label is a real name only if it is a full hexadecimal commit SHA: git's short
 * form and symbolic refs like HEAD are not versions, and two of them agreeing proves
 * nothing about which code was reviewed. SHA-1 is 40 chars, SHA-256 is 64.
 */
const FULL_SHA = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/**
 * An alias can only be recognised, not listed in advance. A snapshot label is the requested
 * label with a version/date suffix ("claude-opus-5" -> "claude-opus-5-20260901"), so the
 * shorter label is a prefix of the longer one up to a separator. The separator matters:
 * "deepseek-flash" and "deepseek-pro" share a prefix character-wise but are different
 * models, and no amount of string cleverness should merge them.
 */
function modelLabelsMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  // A missing label cannot be shown to be the same model, only refused for being unprovable.
  if (!a || !b) {
    return false;
  }
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  return longer.startsWith(`${shorter}-`) || longer.startsWith(`${shorter}:`);
}

export function sameExecution(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  // An empty provider or session is not an identity. Two unknown sessions cannot be shown
  // to be the same run, so the only safe reading is "not the same execution".
  if (!a.provider || !b.provider || !a.session || !b.session) {
    return false;
  }

  // Same provider and same non-empty session is one execution even when the model label
  // differs. Reachable in practice: when a CLI does not report the model, the system fills
  // in the model that was REQUESTED, so resuming the builder's session under an alias only
  // rewrites the label and must not launder a self-approval.
  return a.provider === b.provider && a.session === b.session && modelLabelsMatch(a.model, b.model);
}

/** A human-readable name for the execution, so a rejection can name the offender. */
function describe(identity: ExecutionIdentity): string {
  return `${identity.provider}/${identity.model}@${identity.session}`;
}

/** The first fields of an identity that make it indistinguishable, or undefined if complete. */
function missingIdentityField(identity: ExecutionIdentity): string | undefined {
  if (!identity.provider) {
    return 'provider';
  }
  if (!identity.model) {
    return 'model';
  }
  if (!identity.session) {
    return 'session';
  }
  return undefined;
}

/** Only the first seven characters, enough to name a version in a rejection. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
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

  // An identity with a blank field cannot be compared against anything: it might as well be
  // the builder. Accepting it would let a reviewer omit its session or model and slip past
  // the self-approval check, so independence is refused as unprovable.
  const builderMissing = missingIdentityField(builder);
  if (builderMissing) {
    return {
      ok: false,
      reason:
        `The builder identity is missing its ${builderMissing}; ` +
        `no reviewer's independence can be proven against it.`,
    };
  }

  for (const verdict of verdicts) {
    const reviewerMissing = missingIdentityField(verdict.by);
    if (reviewerMissing) {
      return {
        ok: false,
        reason:
          `Reviewer ${describe(verdict.by)} is missing its ${reviewerMissing}; ` +
          `its independence from the builder cannot be proven.`,
      };
    }

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

  // The code under review must itself have a real version. A blank or symbolic current ref
  // means the gate cannot know what it is guarding, so it refuses rather than guess.
  if (!isFullSha(currentSha)) {
    return {
      ok: false,
      reason:
        `The current revision "${currentSha}" is not a full hexadecimal SHA, ` +
        `so no review can be tied to it.`,
    };
  }

  for (const verdict of verdicts) {
    // A verdict that does not name a real version cannot be tied to this code either.
    if (!isFullSha(verdict.sha)) {
      return {
        ok: false,
        reason:
          `Review by ${describe(verdict.by)} names "${verdict.sha}", which is not a full ` +
          `hexadecimal SHA, so it cannot be tied to the code under review.`,
      };
    }

    // The real case this catches: reviewed as A, pushed, now B, and A's approval waves B
    // through. Compare case-insensitively (git may render the same sha either way) but by
    // exact equality, and name both versions so the report says exactly what went stale.
    if (verdict.sha.toLowerCase() !== currentSha.toLowerCase()) {
      return {
        ok: false,
        reason:
          `Review by ${describe(verdict.by)} is of ${shortSha(verdict.sha)}, ` +
          `but the code is now ${shortSha(currentSha)}.`,
      };
    }

    // A verdict is read at runtime, so its approval can be any JSON value despite the type.
    // Only the literal boolean true is a real yes.
    const approved: unknown = verdict.approved;

    // An undefined approval means the review never finished, which is not a refusal and must
    // not pass as a clean review.
    if (approved === undefined) {
      return {
        ok: false,
        reason: `Review by ${describe(verdict.by)} of ${shortSha(verdict.sha)} never finished.`,
      };
    }

    // A blocking finding means the review failed; carry its reason through rather than
    // flattening it to a generic message.
    if (approved === false) {
      const why = verdict.reason ? `: ${verdict.reason}` : '';
      return {
        ok: false,
        reason: `Review by ${describe(verdict.by)} found something blocking${why}`,
      };
    }

    // Anything else ("false", "no", 1, "true") is not a verdict this gate can trust. The
    // classic trick is the string "false", which is truthy and would otherwise read as yes.
    if (approved !== true) {
      return {
        ok: false,
        reason:
          `Review by ${describe(verdict.by)} of ${shortSha(verdict.sha)} returned a ` +
          `malformed approval (${JSON.stringify(approved)}); only true approves.`,
      };
    }
  }

  // Each required angle needs its own fresh, approving verdict. A stale verdict was already
  // rejected above; this guards against a required angle simply never having been reviewed.
  for (const angle of options?.angles ?? []) {
    const covered = verdicts.some(
      (verdict) =>
        verdict.angle === angle &&
        isFullSha(verdict.sha) &&
        verdict.sha.toLowerCase() === currentSha.toLowerCase() &&
        verdict.approved === true,
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
