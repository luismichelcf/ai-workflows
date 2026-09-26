import type { JsonValue } from '../contract.js';
import type { ExecutionIdentity, Verdict } from '../identity.js';
import { familyOf, requireDifferentBuilder, requireFreshVerdicts } from '../identity.js';
import { selectVerdicts, type PieceEvent, type VerdictEvent } from '../agent/events.js';

// PLAN-13-R4 §2.2 and §3.1: one decision for the independent review next to the agent and on
// the server. It blends the events of the piece's issue into builders and a deciding verdict per
// angle, then requires every deciding verdict to be fresh, approving, from another execution
// than every builder and — when asked — from another family.

export interface ReviewDecisionOptions {
  readonly events: readonly PieceEvent[];
  readonly angles: readonly string[];
  readonly forbidSameFamily: boolean;
  accepts(sha: string): Promise<boolean>;
  treeOf(sha: string): Promise<string>;
  /** The shas whose commit cannot be read; see `SelectVerdictsOptions.unavailable`. */
  readonly unavailable?: ReadonlySet<string>;
  readonly head: string;
  readonly spanish: boolean;
  /**
   * For a `sandboxed-review`, the stage whose own published verdict counts; a verdict tagged
   * with another stage is never evidence here. Omitted means the independent review of the
   * piece, which counts only verdicts that no stage published (PLAN-13-R4 §3.1).
   */
  readonly stage?: string;
}

export type ReviewDecision =
  | { readonly ok: true; readonly evidence: JsonValue }
  | { readonly ok: false; readonly reason: string };

function noBuilderReason(spanish: boolean): string {
  return spanish
    ? 'No se sabe quién construyó la pieza, así que no se puede juzgar la independencia de la revisión.'
    : 'Nobody knows who built the piece, so the independence of the review cannot be judged.';
}

function missingAngleReason(angle: string, spanish: boolean): string {
  return spanish
    ? `Falta el veredicto del ángulo «${angle}».`
    : `The verdict of the angle "${angle}" is missing.`;
}

function olderVersionReason(
  angle: string,
  reviewed: string,
  head: string,
  spanish: boolean,
): string {
  const reviewedShort = reviewed.slice(0, 7);
  const headShort = head.slice(0, 7);
  return spanish
    ? `El veredicto del ángulo «${angle}» es de la versión ${reviewedShort}, no de la actual ${headShort}.`
    : `The verdict of the angle "${angle}" is of version ${reviewedShort}, not of the current ${headShort}.`;
}

function revisedReason(angle: string, spanish: boolean): string {
  return spanish
    ? `El revisor del ángulo «${angle}» pidió cambios.`
    : `The reviewer of the angle "${angle}" asked for changes.`;
}

function sameFamilyReason(family: string, spanish: boolean): string {
  return spanish
    ? `El revisor y el constructor son de la misma familia (${family}).`
    : `The reviewer and the builder are from the same family (${family}).`;
}

function unreadableVerdictReason(angle: string, spanish: boolean): string {
  return spanish
    ? `El veredicto del ángulo «${angle}» no se pudo leer y es más reciente que el que decide; no se puede aprobar a ciegas.`
    : `The verdict of the angle "${angle}" could not be read and is newer than the deciding one; it cannot be approved blind.`;
}

function identityOf(identity: ExecutionIdentity): ExecutionIdentity {
  return { provider: identity.provider, model: identity.model, session: identity.session };
}

/**
 * Decides an independent review from the published events. A `REVISE` that decides rejects with
 * its own angle; the verdicts that count per angle are the newest the stage's validity accepts.
 */
export async function decideIndependentReview(
  options: ReviewDecisionOptions,
): Promise<ReviewDecision> {
  const { spanish } = options;
  // A verdict published by a stage (a `sandboxed-review`) never covers an angle of the piece's
  // independent review; the stage that published it reads it through its own `stage`.
  const events = options.events.filter(
    (event) =>
      event.type !== 'verdict'
      || (options.stage === undefined ? event.stage === undefined : event.stage === options.stage),
  );
  const selected = await selectVerdicts({
    events,
    angles: options.angles,
    accepts: options.accepts,
    treeOf: options.treeOf,
    ...(options.unavailable === undefined ? {} : { unavailable: options.unavailable }),
  });

  // PLAN-13-R4 §7: an unreadable verdict never decides. But if one of a requested angle is newer
  // than the one that does, the angle cannot be settled: the newest word on it might be a REVISE
  // nobody can read. That is technical, never an approval that ignores it.
  for (const event of events) {
    if (event.type !== 'verdict' || !options.angles.includes(event.angle)) continue;
    if (options.unavailable?.has(event.sha) !== true) continue;
    const deciding = selected.deciding.get(event.angle);
    if (deciding !== undefined && event.at >= deciding.at) {
      throw new Error(unreadableVerdictReason(event.angle, spanish));
    }
  }

  if (selected.builders.length === 0 || !selected.knownBuilder) {
    return { ok: false, reason: noBuilderReason(spanish) };
  }

  const builders = selected.builders.map(identityOf);
  const verdicts: Verdict[] = [];
  const evidenceVerdicts: JsonValue[] = [];

  for (const angle of options.angles) {
    const event = selected.deciding.get(angle);
    if (event === undefined) {
      // No readable verdict of the angle counted: every readable one was of another version than
      // the head (`accepts` refused it), so name the newest by `at` and the head (PLAN-13-R5 §2,
      // CN-03). Unreadable verdicts stay out of this, as they do everywhere else.
      let newest: VerdictEvent | undefined;
      for (const candidate of events) {
        if (candidate.type !== 'verdict' || candidate.angle !== angle) continue;
        if (options.unavailable?.has(candidate.sha) === true) continue;
        if (newest === undefined || candidate.at >= newest.at) newest = candidate;
      }
      if (newest !== undefined) {
        return { ok: false, reason: olderVersionReason(angle, newest.sha, options.head, spanish) };
      }
      return { ok: false, reason: missingAngleReason(angle, spanish) };
    }
    if (!event.approved) return { ok: false, reason: revisedReason(angle, spanish) };

    const reviewer = identityOf(event.identity);
    for (const builder of builders) {
      const check = requireDifferentBuilder(
        [{ by: reviewer, sha: event.sha, approved: true, angle }],
        builder,
      );
      if (!check.ok) return { ok: false, reason: check.reason };
      if (options.forbidSameFamily && familyOf(reviewer) === familyOf(builder)) {
        return { ok: false, reason: sameFamilyReason(familyOf(reviewer), spanish) };
      }
    }

    // The version relation was proved by `accepts`; freshness compares against the head exactly.
    verdicts.push({ by: reviewer, sha: options.head, approved: true, angle });
    evidenceVerdicts.push({
      angle,
      provider: reviewer.provider,
      model: reviewer.model,
      session: reviewer.session,
      sha: options.head,
    });
  }

  const fresh = requireFreshVerdicts(verdicts, options.head, { angles: options.angles });
  if (!fresh.ok) return { ok: false, reason: fresh.reason };

  return {
    ok: true,
    evidence: {
      builders: builders.map((builder) => ({
        provider: builder.provider,
        model: builder.model,
        session: builder.session,
      })) as JsonValue,
      verdicts: evidenceVerdicts,
    },
  };
}
