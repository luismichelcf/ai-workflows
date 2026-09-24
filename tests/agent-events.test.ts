import { describe, expect, it } from 'vitest';

import {
  parseEventComment,
  renderEventComment,
  selectVerdicts,
  type IssueComment,
  type PieceEvent,
} from '../src/index.js';

// PLAN-13-R4 §2: builder and verdict events are comments on the piece's issue, published as the
// agents' own identity. §2 decides whether a comment IS a valid event; §2.2 decides which version
// each event covers, with one rule for the engine and the judge. Expected values come from the
// rules as written, never from re-running the code's own formula.

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TREE_A = '1'.repeat(40);
const TREE_B = '2'.repeat(40);

const builderEvent = (over: Partial<Record<string, unknown>> = {}) => ({
  version: 1,
  type: 'builder',
  op: 'op-builder-1',
  piece: '13',
  sha: SHA_A,
  identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_builder' },
  result: TREE_B,
  source: 'provider-cli',
  ...over,
});

const verdictEvent = (over: Partial<Record<string, unknown>> = {}) => ({
  version: 1,
  type: 'verdict',
  op: 'op-verdict-1',
  piece: '13',
  sha: SHA_B,
  identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_review' },
  angle: 'seguridad',
  approved: true,
  workspace: { before: 'w1', after: 'w1' },
  source: 'provider-cli',
  ...over,
});

function comment(event: unknown, over: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 1,
    author: 'mi-motor[bot]',
    authorType: 'Bot',
    viaApp: 'mi-motor',
    body: `Veredicto publicado.\n<!-- ai-workflows:event ${JSON.stringify(event)} -->`,
    createdAt: '2026-09-24T10:00:00Z',
    updatedAt: '2026-09-24T10:00:00Z',
    ...over,
  };
}

const RULES = { agentAccount: 'mi-motor[bot]', piece: '13' };

describe('parseEventComment (§2)', () => {
  it('reads a valid builder event and a valid verdict event', () => {
    expect(parseEventComment(comment(builderEvent()), RULES)).toEqual({
      type: 'builder', op: 'op-builder-1', piece: '13', sha: SHA_A,
      identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_builder' },
      result: TREE_B,
      at: '2026-09-24T10:00:00Z',
    });
    expect(parseEventComment(comment(verdictEvent()), RULES)).toMatchObject({
      type: 'verdict', sha: SHA_B, angle: 'seguridad', approved: true, at: '2026-09-24T10:00:00Z',
    });
  });

  it('a comment without the marker is not an event at all', () => {
    expect(parseEventComment(comment(null, { body: 'solo texto' }), RULES)).toBeUndefined();
  });

  const invalid: [string, IssueComment][] = [
    ['edited', comment(verdictEvent(), { updatedAt: '2026-09-24T10:05:00Z' })],
    ['from another account', comment(verdictEvent(), { author: 'duena', authorType: 'User', viaApp: null })],
    ['from the right login but another app', comment(verdictEvent(), { viaApp: 'otra-app' })],
    ['from the right login but not through an app', comment(verdictEvent(), { viaApp: null })],
    ['with an extra field', comment(verdictEvent({ extra: 1 }))],
    ['without a field', comment((({ op: _op, ...rest }) => rest)(verdictEvent()))],
    ['of another piece', comment(verdictEvent({ piece: '14' }))],
    ['with a short SHA', comment(verdictEvent({ sha: 'abc1234' }))],
    ['a verdict whose tree changed during the review', comment(verdictEvent({ workspace: { before: 'w1', after: 'w2' } }))],
    ['a verdict whose approval is not a boolean', comment(verdictEvent({ approved: 'true' }))],
    ['of an unknown version', comment(verdictEvent({ version: 2 }))],
    ['a builder carrying verdict fields', comment(builderEvent({ angle: 'x' }))],
    ['JSON that does not parse', comment(null, { body: '<!-- ai-workflows:event {"version":1, -->' })],
  ];
  for (const [what, value] of invalid) {
    it(`an event ${what} does not count, and says why`, () => {
      expect(parseEventComment(value, RULES)).toEqual({ invalid: expect.any(String) });
    });
  }
});

describe('renderEventComment', () => {
  it('writes a line for people and the marker the parser reads back exactly', () => {
    const event = { ...(builderEvent() as unknown as PieceEvent) };
    const body = renderEventComment(event, 'es');
    expect(body.split('\n')[0]).not.toContain('ai-workflows:event');
    const round = parseEventComment(comment(null, { body }), RULES);
    expect(round).toMatchObject({ type: 'builder', sha: SHA_A, op: 'op-builder-1' });
  });
});

describe('selectVerdicts (§2.2)', () => {
  const parsed = (value: IssueComment) => {
    const result = parseEventComment(value, RULES);
    if (result === undefined || 'invalid' in result) throw new Error('fixture: invalid event');
    return result;
  };

  const trees: Record<string, string> = { [SHA_A]: TREE_A, [SHA_B]: TREE_B };
  const treeOf = async (sha: string) => {
    const tree = trees[sha];
    if (tree === undefined) throw new Error(`unknown commit ${sha}`);
    return tree;
  };

  it('every builder event of the issue excludes, whatever its version; a builder that changed something makes it known', async () => {
    const first = parsed(comment(builderEvent()));
    const second = parsed(comment(builderEvent({ op: 'op-builder-2', sha: SHA_B, result: TREE_B, identity: { provider: 'codex', model: 'gpt-6-sol', effort: 'high', session: 'ses_other' } })));
    const result = await selectVerdicts({ events: [first, second], angles: [], accepts: async () => true, treeOf });

    expect(result.builders.map((builder) => builder.session)).toEqual(['ses_builder', 'ses_other']);
    expect(result.knownBuilder).toBe(true);
  });

  it('a builder that left the tree as it found it is recorded but does not make the builder known', async () => {
    const idle = parsed(comment(builderEvent({ result: TREE_A })));
    const result = await selectVerdicts({ events: [idle], angles: [], accepts: async () => true, treeOf });

    expect(result.builders).toHaveLength(1);
    expect(result.knownBuilder).toBe(false);
  });

  it('only verdicts whose version the stage accepts count, and per angle the newest decides', async () => {
    const approved = parsed(comment(verdictEvent({ op: 'v1' }), { createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }));
    const revise = parsed(comment(verdictEvent({ op: 'v2', approved: false }), { createdAt: '2026-09-24T11:00:00Z', updatedAt: '2026-09-24T11:00:00Z' }));
    const stale = parsed(comment(verdictEvent({ op: 'v3', sha: SHA_A, angle: 'arquitectura' }), { createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00Z' }));

    const result = await selectVerdicts({
      events: [approved, revise, stale],
      angles: ['seguridad', 'arquitectura'],
      accepts: async (sha) => sha === SHA_B,
      treeOf,
    });

    expect(result.deciding.get('seguridad')?.op).toBe('v2');
    expect(result.deciding.get('seguridad')?.approved).toBe(false);
    expect(result.deciding.has('arquitectura')).toBe(false);
  });

  it('a newer APPROVED after a REVISE of the same angle decides', async () => {
    const revise = parsed(comment(verdictEvent({ op: 'v1', approved: false }), { createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }));
    const approved = parsed(comment(verdictEvent({ op: 'v2' }), { createdAt: '2026-09-24T11:00:00Z', updatedAt: '2026-09-24T11:00:00Z' }));
    const result = await selectVerdicts({ events: [approved, revise], angles: ['seguridad'], accepts: async () => true, treeOf });
    expect(result.deciding.get('seguridad')?.op).toBe('v2');
  });

  it('verdicts of an angle nobody asked for do not appear', async () => {
    const other = parsed(comment(verdictEvent({ angle: 'estilo' })));
    const result = await selectVerdicts({ events: [other], angles: ['seguridad'], accepts: async () => true, treeOf });
    expect([...result.deciding.keys()]).toEqual([]);
  });
});
