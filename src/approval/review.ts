// PLAN-13-R4 §3.2 (R21): the owner approves with GitHub's own "Approve" button. One decision
// serves the engine next to the agent and the judge on GitHub, so both answer the same for the
// same reviews. The owner's LAST decisive review counts; a plain comment does not; the approved
// commit must be a version the stage's validity accepts.

import type { ServerResult } from '../blocks/definition.js';
import type { ValidWhile } from '../blocks/manifest.js';

/** One pull request review, as the owner's approval reads it. */
export interface PullRequestReview {
  readonly author: string;
  readonly authorType: 'User' | 'Bot';
  readonly state: string;
  readonly commitId: string;
  readonly submittedAt: string;
}

export interface ReviewApprovalOptions {
  readonly reviews: readonly PullRequestReview[];
  /** The account whose approval counts (the recipe's `owner`). */
  readonly owner: string;
  /** The head of the pull request. */
  readonly head: string;
  readonly validWhile: ValidWhile;
  /** Whether waiting for a person is the right answer instead of rejecting. */
  readonly needsHuman: boolean;
  readonly locale: string;
  readonly prUrl: string;
  /** Whether an approved commit carries the head's own changes (`same-fingerprint`). */
  sameFingerprint(commit: string): Promise<boolean>;
}

/** The states that decide: a plain `COMMENTED` review never does. */
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/**
 * Reads the owner's reviews of one pull request and decides. A pass happens only when the last
 * decisive review is an approval of a version the stage accepts; otherwise the stage waits (or
 * is rejected when no person is required). A fingerprint that cannot be computed is technical,
 * never a rejection.
 */
export async function decideReviewApproval(options: ReviewApprovalOptions): Promise<ServerResult> {
  const spanish = isSpanish(options.locale);
  const owner = options.owner.toLowerCase();

  const decisive = options.reviews
    .filter(
      (review) =>
        review.authorType === 'User'
        && review.author.toLowerCase() === owner
        && DECISIVE.has(review.state),
    )
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const last = decisive[decisive.length - 1];

  const outcome = last?.state === 'APPROVED' ? 'approved' : 'not-approved';
  if (outcome === 'approved' && last !== undefined) {
    const same = last.commitId.toLowerCase() === options.head.toLowerCase();
    if (same) {
      return {
        outcome: 'passed',
        evidence: { reviewedCommit: last.commitId, submittedAt: last.submittedAt },
      };
    }
    if (options.validWhile === 'same-fingerprint') {
      let sameOwn = false;
      try {
        sameOwn = await options.sameFingerprint(last.commitId);
      } catch (error) {
        return { outcome: 'technical', reason: reasonOf(error) };
      }
      if (sameOwn) {
        return {
          outcome: 'passed',
          evidence: { reviewedCommit: last.commitId, submittedAt: last.submittedAt },
        };
      }
    }
    return waiting(spanish, options, 'other-version');
  }

  return waiting(spanish, options, last === undefined ? 'none' : 'not-approved');
}

function waiting(
  spanish: boolean,
  options: ReviewApprovalOptions,
  why: 'none' | 'not-approved' | 'other-version',
): ServerResult {
  const outcome = options.needsHuman ? 'waiting' : 'rejected';
  let reason: string;
  if (why === 'other-version') {
    reason = spanish
      ? `La última aprobación del dueño es de otra versión: vuelve a aprobar con el botón "Approve": ${options.prUrl}`
      : `The owner's last approval is of another version: approve again with the "Approve" button: ${options.prUrl}`;
  } else {
    reason = spanish
      ? `Aprueba el cambio en GitHub con el botón "Approve": ${options.prUrl}`
      : `Approve the change on GitHub with the "Approve" button: ${options.prUrl}`;
  }
  return { outcome, reason };
}
