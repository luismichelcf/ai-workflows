import { describe, expect, it } from 'vitest';

import { waitForMergeQueue } from '../src/judge/checks.js';

// Found by the real negative suite, part 5 (COLA-6): with six pull requests armed at once, GitHub
// listed some merge groups more than a minute after their event; the red-test check gave up after
// about a minute, failed, and GitHub took a piece out of the queue. The judge and the red-test check
// now wait for the list up to about five minutes (still failing closed after that).

const GROUP = 'a'.repeat(40);

function queueListingAfter(ms: number) {
  let clock = 0;
  const github = {
    mergeQueue: async () => (clock >= ms ? [{ position: 1, headSha: GROUP, baseSha: 'b'.repeat(40), prNumber: 7 }] : []),
  };
  const sleep = async (pause: number) => {
    clock += pause;
  };
  return { github, sleep, elapsed: () => clock };
}

describe('the wait for the merge queue to list a group', () => {
  it('a group listed after three minutes is found', async () => {
    const t = queueListingAfter(3 * 60_000);
    const read = await waitForMergeQueue(t.github as never, 'main', GROUP, t.sleep);
    expect(read.ok).toBe(true);
  });

  it('a group never listed fails after about five minutes, not before four, not after seven', async () => {
    const t = queueListingAfter(Number.POSITIVE_INFINITY);
    const read = await waitForMergeQueue(t.github as never, 'main', GROUP, t.sleep);
    expect(read).toEqual({ ok: false, readFailed: false });
    expect(t.elapsed()).toBeGreaterThanOrEqual(4 * 60_000);
    expect(t.elapsed()).toBeLessThanOrEqual(7 * 60_000);
  });
});
