// The owner's sign-off and the merge check: layer 3 of the locks (see ../locks.ts).

import { requireDifferentBuilder, requireFreshVerdicts } from '../identity.js';
import type { ExecutionIdentity, Verdict } from '../identity.js';

export interface PullRequestComment {
  readonly body: string;
  readonly author: string;
  /** GitHub's `user.type`: `User`, `Bot` or `Organization`. */
  readonly authorType: string;
  /** Whether GitHub reports it as posted through an app (`performed_via_github_app`). */
  readonly performedViaApp: boolean;
  /** Whether it was edited after posting: anyone with write access can edit a comment. */
  readonly edited: boolean;
}

export interface SignOffRules {
  /** GitHub logins allowed to sign off. */
  readonly productOwners: readonly string[];
  /** The head of the pull request right now. */
  readonly headSha: string;
}

/** An order alone on its line: optional command, one token, nothing else. */
const SIGN_OFF_LINE = /^\/visto-bueno\s+(\S+)$/;

/** An ATX fence opener/closer, the same shape `gates.ts` uses for code blocks. */
const SIGN_OFF_FENCE = /^(?:`{3,}|~{3,})/;

/** A SHA truncated to what GitHub shows in the conversation: enough to name a version. */
const SHA_LENGTH = /^[0-9a-fA-F]{7,40}$/;

/**
 * The SHA after `/visto-bueno`, or `undefined` when the comment carries no genuine order.
 * Only a line that is exactly the command counts: a quote (`>`), a fenced code block, or a
 * command buried in prose is someone talking about the order, not giving it.
 */
function findSignOffSha(body: string): string | undefined {
  let inFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();

    if (SIGN_OFF_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // A quoted line documents someone else's words; quoting an order never gives one.
    if (line.startsWith('>')) continue;

    const match = SIGN_OFF_LINE.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * `/visto-bueno <sha>` on its own line, from a product owner, naming the current head.
 * The SHA matters: a sign-off of an older version does not cover a newer one.
 */
export function parseSignOff(
  comment: PullRequestComment,
  rules: SignOffRules,
): { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string } {
  const sha = findSignOffSha(comment.body);

  // No genuine order is a valid answer: the caller must be able to tell "nobody signed off"
  // from "someone tried and was rejected", so each gets its own message.
  if (sha === undefined) {
    return {
      ok: false,
      reason: 'No hay ninguna orden /visto-bueno en su propia línea en este comentario.',
    };
  }

  // Too short cannot pick one version out of the history, and non-hex cannot be a SHA at all.
  if (!SHA_LENGTH.test(sha)) {
    return {
      ok: false,
      reason: `"${sha}" no es un SHA válido: debe ser hexadecimal de 7 a 40 caracteres.`,
    };
  }

  const currentHead = rules.headSha.toLowerCase();
  if (!currentHead.startsWith(sha.toLowerCase())) {
    // Name both versions: the author sees which one they approved and which one is live now.
    return {
      ok: false,
      reason:
        `El visto bueno es para ${sha}, pero la versión actual es ${rules.headSha.slice(0, 7)}: ` +
        'un visto bueno no cubre una versión posterior.',
    };
  }

  // Compared without case because GitHub logins are case-insensitive; only the owner's
  // verdict counts, since the pipeline posts through his account.
  const owners = rules.productOwners.map((owner) => owner.toLowerCase());
  if (!owners.includes(comment.author.toLowerCase())) {
    return {
      ok: false,
      reason: `El autor "${comment.author}" no es un product owner: su visto bueno no cuenta.`,
    };
  }

  return { ok: true, sha };
}

export interface MergeCheckInput {
  readonly headSha: string;
  readonly builder: ExecutionIdentity;
  readonly verdicts: readonly Verdict[];
  readonly requiredAngles?: readonly string[];
  readonly differentProvider?: boolean;
  /** Whether this piece has something visible, and so needs the owner's sign-off. */
  readonly needsSignOff: boolean;
  readonly comments: readonly PullRequestComment[];
  readonly productOwners: readonly string[];
}

export interface MergeCheckResult {
  readonly conclusion: 'success' | 'failure';
  /** Every reason it failed, not just the first. */
  readonly summary: string;
  /** What this check cannot prove even when it passes, said out loud. */
  readonly limits: readonly string[];
}

/** What the server check concludes, composed from the identity and sign-off rules. */
export function concludeMergeCheck(input: MergeCheckInput): MergeCheckResult {
  // Every rule is evaluated before deciding, so one report lists the whole task instead of
  // making the author fix the reasons one run at a time. The gate functions are reused, not
  // reimplemented, so the verdict cannot drift from the identity rules.
  const reasons: string[] = [];

  // 1. Nobody approves their own work, judged by execution and not by GitHub account.
  // Optional fields are only set when present: `exactOptionalPropertyTypes` treats an
  // explicit `undefined` as different from an absent key.
  const independence = requireDifferentBuilder(
    input.verdicts,
    input.builder,
    input.differentProvider === undefined ? undefined : { differentProvider: input.differentProvider },
  );
  if (!independence.ok) reasons.push(independence.reason);

  // 2. The reviews must be of the code as it is now and cover every required angle.
  const freshness = requireFreshVerdicts(
    input.verdicts,
    input.headSha,
    input.requiredAngles === undefined ? undefined : { angles: input.requiredAngles },
  );
  if (!freshness.ok) reasons.push(freshness.reason);

  // 3. Something visible needs the owner's sign-off for the current version. One valid
  //    comment is enough: an older sign-off followed by a newer one is exactly the normal
  //    case of a re-review, and each comment is judged on its own.
  if (input.needsSignOff) {
    const signed = input.comments.some(
      (comment) =>
        parseSignOff(comment, { productOwners: input.productOwners, headSha: input.headSha }).ok,
    );
    if (!signed) {
      // Name the order so the report says what to do, not just what is missing.
      reasons.push(
        'Falta el visto bueno del dueño: se necesita un comentario con la orden ' +
          '/visto-bueno <sha> que apunte a la versión actual.',
      );
    }
  }

  if (reasons.length === 0) {
    return { conclusion: 'success', summary: 'Todo en orden: revisiones válidas y, si hacía falta, el visto bueno del dueño.', limits: [] };
  }

  return { conclusion: 'failure', summary: reasons.join(' '), limits: [] };
}
