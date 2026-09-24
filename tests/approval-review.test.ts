import { describe, expect, it } from 'vitest';

import { decideReviewApproval, type PullRequestReview } from '../src/index.js';

// PLAN-13-R4 §3.2 (R21): the owner approves with GitHub's "Approve" button. One decision serves
// the engine next to the agent and the judge on GitHub, so both answer the same for the same
// reviews. The owner's LAST decisive review (APPROVED, CHANGES_REQUESTED or DISMISSED) counts; a
// plain comment does not; the approved commit must be a version the stage's validity accepts.

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const SAME = 'e'.repeat(40); // a commit whose own changes have the head's fingerprint
const URL = 'https://github.com/duena/proyecto/pull/7';

const review = (over: Partial<PullRequestReview> = {}): PullRequestReview => ({
  author: 'duena',
  authorType: 'User',
  state: 'APPROVED',
  commitId: HEAD,
  submittedAt: '2026-09-24T10:00:00Z',
  ...over,
});

async function decide(
  reviews: PullRequestReview[],
  over: Partial<Parameters<typeof decideReviewApproval>[0]> = {},
) {
  return decideReviewApproval({
    reviews,
    owner: 'duena',
    head: HEAD,
    validWhile: 'same-sha',
    needsHuman: true,
    locale: 'es',
    prUrl: URL,
    sameFingerprint: async (commit) => commit === SAME,
    ...over,
  });
}

describe('decideReviewApproval', () => {
  it('passes with the owner\'s approval of the head', async () => {
    expect(await decide([review()])).toEqual({ outcome: 'passed', evidence: { reviewedCommit: HEAD, submittedAt: '2026-09-24T10:00:00Z' } });
  });

  it('waits, pointing at the pull request and the button, when nobody approved', async () => {
    expect(await decide([])).toEqual({
      outcome: 'waiting',
      reason: expect.stringMatching(new RegExp(`Approve.*${URL.replace(/[/.]/g, '\\$&')}`)),
    });
  });

  it('is rejected instead of waiting when the stage does not need a person', async () => {
    expect(await decide([], { needsHuman: false })).toMatchObject({ outcome: 'rejected' });
  });

  it('an approval of another version waits, and says so', async () => {
    expect(await decide([review({ commitId: OLD })])).toEqual({
      outcome: 'waiting',
      reason: expect.stringMatching(/otra versión/),
    });
  });

  it('a later request for changes cancels an earlier approval', async () => {
    const reviews = [review(), review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-24T11:00:00Z' })];
    expect(await decide(reviews)).toMatchObject({ outcome: 'waiting' });
  });

  it('a later dismissal cancels an earlier approval', async () => {
    const reviews = [review(), review({ state: 'DISMISSED', submittedAt: '2026-09-24T11:00:00Z' })];
    expect(await decide(reviews)).toMatchObject({ outcome: 'waiting' });
  });

  it('a later plain comment does not cancel the approval', async () => {
    const reviews = [review(), review({ state: 'COMMENTED', submittedAt: '2026-09-24T11:00:00Z', commitId: OLD })];
    expect(await decide(reviews)).toMatchObject({ outcome: 'passed' });
  });

  it('the order is by submission time, not by position in the list', async () => {
    const reviews = [review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-24T09:00:00Z' }), review()];
    expect(await decide(reviews)).toMatchObject({ outcome: 'passed' });
    const reversed = [review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-24T11:00:00Z' }), review()];
    expect(await decide(reversed)).toMatchObject({ outcome: 'waiting' });
  });

  it('an approval from another account, or from a bot, does not count', async () => {
    expect(await decide([review({ author: 'otra' })])).toMatchObject({ outcome: 'waiting' });
    expect(await decide([review({ author: 'duena', authorType: 'Bot' })])).toMatchObject({ outcome: 'waiting' });
    expect(await decide([review({ author: 'mi-motor[bot]', authorType: 'Bot' })])).toMatchObject({ outcome: 'waiting' });
  });

  it('matches the owner\'s login without regard to case, as GitHub does', async () => {
    expect(await decide([review({ author: 'Duena' })])).toMatchObject({ outcome: 'passed' });
  });

  it('same-fingerprint accepts an approved commit with the same own changes, same-sha does not', async () => {
    expect(await decide([review({ commitId: SAME })], { validWhile: 'same-fingerprint' })).toMatchObject({ outcome: 'passed' });
    expect(await decide([review({ commitId: SAME })], { validWhile: 'same-sha' })).toMatchObject({ outcome: 'waiting' });
    expect(await decide([review({ commitId: OLD })], { validWhile: 'same-fingerprint' })).toMatchObject({ outcome: 'waiting' });
  });

  it('same-fingerprint-or-clean-update accepts only the head (§3.6 of slice 3)', async () => {
    expect(await decide([review({ commitId: SAME })], { validWhile: 'same-fingerprint-or-clean-update' })).toMatchObject({ outcome: 'waiting' });
    expect(await decide([review()], { validWhile: 'same-fingerprint-or-clean-update' })).toMatchObject({ outcome: 'passed' });
  });

  it('a fingerprint that cannot be computed is technical, never a rejection', async () => {
    const outcome = await decide([review({ commitId: OLD })], {
      validWhile: 'same-fingerprint',
      sameFingerprint: async () => {
        throw new Error('git no respondió');
      },
    });
    expect(outcome).toEqual({ outcome: 'technical', reason: expect.stringMatching(/git no respondió/) });
  });

  it('speaks English when the locale is English', async () => {
    expect(await decide([], { locale: 'en' })).toEqual({ outcome: 'waiting', reason: expect.stringMatching(/Approve/) });
    expect(await decide([review({ commitId: OLD })], { locale: 'en' })).toEqual({ outcome: 'waiting', reason: expect.stringMatching(/another version/) });
  });
});
