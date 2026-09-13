import { describe, expect, it } from 'vitest';

import {
  concludeMergeCheck,
  parseSignOff,
  type ExecutionIdentity,
  type MergeCheckInput,
  type Verdict,
} from '../src/index.js';

// The owner's sign-off and what the server check concludes. Decided with the owner on
// 12-sep-2026: GitHub does not let the author of a pull request approve it, and the pipeline
// opens pull requests with his account, so his sign-off is a comment — `/visto-bueno <sha>`
// — tied to the exact version he looked at.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const rules = { productOwners: ['luismichelcf'], headSha: head };

describe('reading the owner s sign-off', () => {
  it('accepts it on its own line, naming the current version', () => {
    expect(parseSignOff({ body: '/visto-bueno 9f420f5', author: 'luismichelcf' }, rules)).toEqual({
      ok: true,
      sha: '9f420f5',
    });
  });

  it('accepts the full SHA', () => {
    expect(parseSignOff({ body: `/visto-bueno ${head}`, author: 'luismichelcf' }, rules).ok).toBe(true);
  });

  it('accepts it among other lines of the comment', () => {
    const body = 'Se ve bien en el preview.\n/visto-bueno 9f420f5\nGracias';

    expect(parseSignOff({ body, author: 'luismichelcf' }, rules).ok).toBe(true);
  });

  it('ignores letter case in the login and the SHA', () => {
    expect(parseSignOff({ body: '/visto-bueno 9F420F5', author: 'LuisMichelCF' }, rules).ok).toBe(true);
  });

  it('refuses a sign-off of an older version, naming both', () => {
    const result = parseSignOff({ body: '/visto-bueno 1234567', author: 'luismichelcf' }, rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('1234567');
    expect(result.ok === false && result.reason).toContain('9f420f5');
  });

  it('refuses a sign-off from someone who is not a product owner, naming them', () => {
    const result = parseSignOff({ body: '/visto-bueno 9f420f5', author: 'un-agente-bot' }, rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('un-agente-bot');
  });

  it('refuses a SHA too short to identify one version', () => {
    expect(parseSignOff({ body: '/visto-bueno 9f42', author: 'luismichelcf' }, rules).ok).toBe(false);
  });

  it('refuses something that is not a SHA', () => {
    expect(parseSignOff({ body: '/visto-bueno este', author: 'luismichelcf' }, rules).ok).toBe(false);
  });

  it('does not count the command inside a quote', () => {
    // Quoting someone's sign-off to discuss it is not signing off.
    expect(parseSignOff({ body: '> /visto-bueno 9f420f5', author: 'luismichelcf' }, rules).ok).toBe(false);
  });

  it('does not count the command inside a code block', () => {
    const body = 'Así se escribe:\n```\n/visto-bueno 9f420f5\n```';

    expect(parseSignOff({ body, author: 'luismichelcf' }, rules).ok).toBe(false);
  });

  it('does not count the command in the middle of a sentence', () => {
    expect(parseSignOff({ body: 'cuando escribas /visto-bueno 9f420f5 se mergea', author: 'luismichelcf' }, rules).ok).toBe(false);
  });

  it('says there is no sign-off in a comment without one', () => {
    const result = parseSignOff({ body: 'Me gusta', author: 'luismichelcf' }, rules);

    expect(result.ok === false && result.reason.length).toBeGreaterThan(5);
  });
});

describe('what the merge check concludes', () => {
  const builder: ExecutionIdentity = { provider: 'opencode', model: 'deepseek/deepseek-flash', session: 'ses_1' };
  const reviewer: ExecutionIdentity = { provider: 'claude', model: 'claude-opus-5', session: 's-2' };
  const approved = (over: Partial<Verdict> = {}): Verdict => ({ by: reviewer, sha: head, approved: true, ...over });

  const input = (over: Partial<MergeCheckInput> = {}): MergeCheckInput => ({
    headSha: head,
    builder,
    verdicts: [approved()],
    needsSignOff: true,
    comments: [{ body: '/visto-bueno 9f420f5', author: 'luismichelcf' }],
    productOwners: ['luismichelcf'],
    ...over,
  });

  it('passes with an independent, current review and the owner s sign-off', () => {
    expect(concludeMergeCheck(input()).conclusion).toBe('success');
  });

  it('passes without a sign-off when the piece has nothing visible', () => {
    expect(concludeMergeCheck(input({ needsSignOff: false, comments: [] })).conclusion).toBe('success');
  });

  it('fails without the sign-off when the piece has something visible', () => {
    expect(concludeMergeCheck(input({ comments: [] })).conclusion).toBe('failure');
  });

  it('fails when the only sign-off is for an older version', () => {
    const result = concludeMergeCheck(input({ comments: [{ body: '/visto-bueno 1234567', author: 'luismichelcf' }] }));

    expect(result.conclusion).toBe('failure');
  });

  it('passes when an older sign-off is followed by one for the current version', () => {
    const result = concludeMergeCheck(
      input({
        comments: [
          { body: '/visto-bueno 1234567', author: 'luismichelcf' },
          { body: '/visto-bueno 9f420f5', author: 'luismichelcf' },
        ],
      }),
    );

    expect(result.conclusion).toBe('success');
  });

  it('fails when the builder reviewed its own work', () => {
    expect(concludeMergeCheck(input({ verdicts: [approved({ by: builder })] })).conclusion).toBe('failure');
  });

  it('fails when the review is of an older version', () => {
    expect(concludeMergeCheck(input({ verdicts: [approved({ sha: '1234567aaaa' })] })).conclusion).toBe('failure');
  });

  it('fails when a required angle was never reviewed', () => {
    const result = concludeMergeCheck(input({ requiredAngles: ['dinero', 'permisos'], verdicts: [approved({ angle: 'dinero' })] }));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('permisos');
  });

  it('lists every reason it failed, not only the first', () => {
    const result = concludeMergeCheck(input({ verdicts: [approved({ by: builder, sha: 'viejo1234' })], comments: [] }));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('deepseek');
    expect(result.summary).toContain('viejo1234');
    expect(result.summary.toLowerCase()).toContain('visto-bueno');
  });
});
