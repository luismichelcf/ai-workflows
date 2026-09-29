import { describe, expect, it } from 'vitest';

import type { PieceEvent } from '../src/agent/events.js';
import { decideIndependentReview } from '../src/blocks/reviews.js';

// Found by the real negative suite, part 5 (CN-03): the verdict was of an older version H1 and the
// agent pushed H2. The judge refused, as it must, but said only "the verdict is missing". PLAN-13-R5
// §2 (CN-03) promises that the refusal names H1 and H2, so the owner sees why a verdict that exists
// does not count.

const H1 = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE = '0000000ccccccccccccccccccccccccccccccccc';

const builder: PieceEvent = {
  type: 'builder',
  op: `build:${BASE}`,
  piece: '7',
  sha: BASE,
  identity: { provider: 'deepseek', model: 'deepseek-flash', session: 'constructor' },
  result: 'arbol-del-constructor',
  at: '2026-09-26T01:00:00Z',
};

const verdictOf = (sha: string, at: string, approved = true): PieceEvent => ({
  type: 'verdict',
  op: `review:${sha}:correctness:revisor`,
  piece: '7',
  sha,
  identity: { provider: 'claude', model: 'claude-opus', session: 'revisor' },
  angle: 'correctness',
  approved,
  workspace: { before: 't', after: 't' },
  at,
});

const decide = (events: PieceEvent[], spanish: boolean) =>
  decideIndependentReview({
    events,
    angles: ['correctness'],
    forbidSameFamily: false,
    accepts: async (sha) => sha === H2,
    treeOf: async () => 'otro-arbol',
    head: H2,
    spanish,
  });

describe('a verdict of an older version names both versions (CN-03)', () => {
  it('in Spanish the refusal names the version reviewed and the current one', async () => {
    const decision = await decide([builder, verdictOf(H1, '2026-09-26T01:05:00Z')], true);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toContain('«correctness»');
    expect(decision.reason).toContain('1111111');
    expect(decision.reason).toContain('2222222');
  });

  it('in English too', async () => {
    const decision = await decide([builder, verdictOf(H1, '2026-09-26T01:05:00Z')], false);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toContain('"correctness"');
    expect(decision.reason).toContain('1111111');
    expect(decision.reason).toContain('2222222');
  });

  it('with several older verdicts it names the newest one, whatever the order they come in', async () => {
    const H0 = '9999999ddddddddddddddddddddddddddddddddd';
    for (const events of [
      [builder, verdictOf(H1, '2026-09-26T01:09:00Z'), verdictOf(H0, '2026-09-26T01:02:00Z')],
      [builder, verdictOf(H0, '2026-09-26T01:02:00Z'), verdictOf(H1, '2026-09-26T01:09:00Z')],
    ]) {
      const decision = await decide(events, true);
      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.reason).toContain('1111111');
      expect(decision.reason).not.toContain('9999999');
    }
  });

  it('a verdict of another angle is never the one named', async () => {
    const other = { ...verdictOf(H1, '2026-09-26T01:05:00Z'), angle: 'security', op: `review:${H1}:security:revisor` } as PieceEvent;
    const decision = await decide([builder, other], true);
    expect(decision).toEqual({ ok: false, reason: 'Falta el veredicto del ángulo «correctness».' });
  });

  it('an unreadable verdict is never the one named', async () => {
    const decision = await decideIndependentReview({
      events: [builder, verdictOf(H1, '2026-09-26T01:05:00Z')],
      angles: ['correctness'],
      forbidSameFamily: false,
      accepts: async (sha) => sha === H2,
      treeOf: async () => 'otro-arbol',
      unavailable: new Set([H1]),
      head: H2,
      spanish: true,
    });
    expect(decision).toEqual({ ok: false, reason: 'Falta el veredicto del ángulo «correctness».' });
  });

  // Flock round 8: `accepts` may refuse a verdict of the head itself (another reason than its
  // version); then naming "version X, not the current X" would mislead: it is simply missing.
  it('a refused verdict of the head itself is not named as another version', async () => {
    const decision = await decideIndependentReview({
      events: [builder, verdictOf(H2, '2026-09-26T01:05:00Z')],
      angles: ['correctness'],
      forbidSameFamily: false,
      accepts: async () => false,
      treeOf: async () => 'otro-arbol',
      head: H2,
      spanish: true,
    });
    expect(decision).toEqual({ ok: false, reason: 'Falta el veredicto del ángulo «correctness».' });
  });

  it('with no verdict at all for the angle it still says the verdict is missing', async () => {
    const decision = await decide([builder], true);
    expect(decision).toEqual({ ok: false, reason: 'Falta el veredicto del ángulo «correctness».' });
  });

  it('a verdict of the current version still approves', async () => {
    const decision = await decide([builder, verdictOf(H1, '2026-09-26T01:05:00Z'), verdictOf(H2, '2026-09-26T01:06:00Z')], true);
    expect(decision.ok).toBe(true);
  });
});
