import type { JsonValue } from '../contract.js';
import type { ExecutionIdentity, Verdict } from '../identity.js';
import { familyOf, requireDifferentBuilder, requireFreshVerdicts } from '../identity.js';
import { selectVerdicts, type PieceEvent } from '../agent/events.js';

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
  readonly head: string;
  readonly spanish: boolean;
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
  const selected = await selectVerdicts({
    events: options.events,
    angles: options.angles,
    accepts: options.accepts,
    treeOf: options.treeOf,
  });

  if (selected.builders.length === 0 || !selected.knownBuilder) {
    return { ok: false, reason: noBuilderReason(spanish) };
  }

  const builders = selected.builders.map(identityOf);
  const verdicts: Verdict[] = [];
  const evidenceVerdicts: JsonValue[] = [];

  for (const angle of options.angles) {
    const event = selected.deciding.get(angle);
    if (event === undefined) return { ok: false, reason: missingAngleReason(angle, spanish) };
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
