// PLAN-13-R3 §3.6 (CN-05): `approval-comment` checked on GitHub. The judge never writes a
// comment: it reads the ones the pull request already carries and decides whether one of them is
// the owner's order for the version being judged. The order itself is read by the same rules as
// the local sign-off (locks/signoff.ts), only with the command, the code length and the validity
// the stage declares.

import type { ServerAttestContext, ServerResult } from '../blocks/definition.js';
import { evaluateOwnerOrder, type PullRequestComment } from '../locks/signoff.js';
import { describeChangeFromCommits, gitCommitsReachable } from '../recipe/facts.js';
import { languageOf } from '../recipe/applies.js';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The fingerprint of `sha` judged against the trusted commit, computed from commits only. */
async function fingerprintOf(context: ServerAttestContext, sha: string): Promise<string> {
  const facts = await describeChangeFromCommits({
    root: context.root,
    base: context.trusted,
    head: sha,
    recipe: context.recipe,
    piece: context.piece,
    ...(context.facts.declaredKind === undefined ? {} : { declaredKind: context.facts.declaredKind }),
  });
  return facts.fingerprint;
}

interface Resolution {
  readonly ok: boolean;
  /** Set when the answer could not be decided: the stage is technical, never a rejection. */
  readonly error?: string;
  /** Why a genuine order did not name an accepted version. */
  readonly reason?: string;
}

/**
 * Whether `code` names a version the stage accepts. `same-sha` only takes the head;
 * `same-fingerprint` also takes a commit reachable from the head, or from a head a force push
 * replaced, whose own changes have the same fingerprint and a non-empty one.
 */
async function resolve(
  code: string,
  context: ServerAttestContext,
  previousHeads: readonly string[],
  sameFingerprint: boolean,
  spanish: boolean,
): Promise<Resolution> {
  const lower = code.toLowerCase();
  if (!sameFingerprint) {
    return {
      ok: context.head.toLowerCase().startsWith(lower),
      reason: spanish ? 'no es la versión juzgada' : 'it is not the judged version',
    };
  }

  const seeds = [context.head];
  for (const head of previousHeads) {
    try {
      await context.fetchObjects([head]);
    } catch {
      // GitHub no longer delivers that head: the candidate simply does not exist (§3.6).
      continue;
    }
    seeds.push(head);
  }

  let reachable: string[];
  try {
    reachable = await gitCommitsReachable(context.root, [...new Set(seeds)], context.trusted);
  } catch (error) {
    return { ok: false, error: reasonOf(error) };
  }

  const matches = reachable.filter((sha) => sha.toLowerCase().startsWith(lower));
  if (matches.length > 1) {
    return {
      ok: false,
      reason: spanish ? 'el código casa con más de una versión' : 'the code matches more than one version',
    };
  }
  const candidate = matches[0];
  if (candidate === undefined) {
    return {
      ok: false,
      reason: spanish ? 'no nombra ninguna versión del cambio' : 'it names no version of the change',
    };
  }
  if (candidate === context.head) return { ok: true };

  if (context.facts.fingerprint === '') {
    return {
      ok: false,
      reason: spanish
        ? 'la versión juzgada no tiene cambios propios que comparar'
        : 'the judged version has no changes of its own to compare',
    };
  }
  let candidateFingerprint: string;
  try {
    candidateFingerprint = await fingerprintOf(context, candidate);
  } catch (error) {
    return { ok: false, error: reasonOf(error) };
  }
  return candidateFingerprint === context.facts.fingerprint
    ? { ok: true }
    : {
        ok: false,
        reason: spanish ? 'sus cambios propios no son los mismos' : 'its own changes are not the same',
      };
}

/**
 * PLAN-13-R3 §3.6: the owner's order in a comment, for the head or a candidate with the same
 * fingerprint, depending on the stage's `valid-while`. Without a valid order the stage waits when
 * a person is required and is rejected otherwise; an unreadable comment list or timeline is
 * technical, never a rejection.
 */
export async function approvalCommentAttestation(
  inputs: Record<string, unknown>,
  context: ServerAttestContext,
): Promise<ServerResult> {
  const spanish = languageOf(context.locale) === 'es';
  const order =
    typeof inputs['command'] === 'string' && inputs['command'].length > 0
      ? inputs['command']
      : '/approve';
  const codeLength =
    typeof inputs['codeLength'] === 'number' && Number.isInteger(inputs['codeLength'])
      ? inputs['codeLength']
      : 7;
  const owners = context.owner === undefined ? [] : [context.owner];

  let comments: PullRequestComment[];
  try {
    comments = await context.github.comments(context.pullRequest);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }

  const evaluations = comments.map((comment) => ({
    comment,
    order: evaluateOwnerOrder(comment, {
      order,
      minCodeLength: codeLength,
      productOwners: owners,
      locale: context.locale,
    }),
  }));

  const sameFingerprint = context.validWhile === 'same-fingerprint';
  const hasOrder = evaluations.some((entry) => entry.order.ok);
  let previousHeads: readonly string[] = [];
  if (sameFingerprint && hasOrder) {
    try {
      previousHeads = await context.github.forcePushedHeads(context.pullRequest);
    } catch (error) {
      return { outcome: 'technical', reason: reasonOf(error) };
    }
  }

  // A comment that cannot be resolved is remembered, not returned at once: a later comment may
  // still be the valid order, and a genuine one must not lose to an older unreadable candidate.
  const unresolved: string[] = [];
  let firstError: string | undefined;
  for (const entry of evaluations) {
    if (!entry.order.ok) continue;
    const resolution = await resolve(entry.order.code, context, previousHeads, sameFingerprint, spanish);
    if (resolution.ok) return { outcome: 'passed' };
    if (resolution.error !== undefined) {
      if (firstError === undefined) firstError = resolution.error;
      continue;
    }
    if (resolution.reason !== undefined) unresolved.push(`«${entry.order.code}»: ${resolution.reason}.`);
  }
  if (firstError !== undefined) return { outcome: 'technical', reason: firstError };

  // §3.6 and §3.8: in both languages the motive spells out exactly what to write, so the owner
  // can copy the order and the first `code-length` characters of the head.
  const wanted = `${order} ${context.head.slice(0, codeLength)}`;
  const base = spanish
    ? `Falta el visto bueno del dueño: se necesita un comentario con la orden ${wanted} para la versión juzgada.`
    : `The owner's approval is missing: a comment with the owner's order ${wanted} for the judged version is needed.`;
  const refusals = evaluations
    .filter((entry) => entry.order.hadOrder && !entry.order.ok)
    .map((entry) => entry.order.reason);
  const reason = [base, ...unresolved, ...refusals].join(' ');
  return { outcome: context.needsHuman ? 'waiting' : 'rejected', reason };
}
