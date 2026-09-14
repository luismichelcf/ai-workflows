import { describe, expect, it } from 'vitest';

import {
  concludeMergeCheck,
  parseSignOff,
  type ExecutionIdentity,
  type MergeCheckInput,
  type PullRequestComment,
} from '../src/index.js';

// The owner signs off with the code GitHub displays for a version (ai-workflows#9, decided with
// the owner on 14-sep-2026). Nobody copies a 40-character SHA by hand, and GitHub cuts the line
// that asks for it, so the order names the head by a prefix of at least 7 characters.
//
// Risk accepted, and why. Two commits can share their first 7 characters: the review of part 4
// fabricated such a pair in 57 seconds. Only someone cheating on purpose does that, and while the
// agents post with the owner's account that someone can already write the comment itself, a
// limit every check result declares. Against a mistake the code is enough: two versions share it
// by chance about once in 268 million.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const older = '64a2caf8795d0e1f2a3b4c5d6e7f8091a2b3c4d5';
const rules = { productOwners: ['luismichelcf'], headSha: head };

const comment = (body: string, over: Partial<PullRequestComment> = {}): PullRequestComment => ({
  body,
  author: 'luismichelcf',
  authorType: 'User',
  performedViaApp: false,
  edited: false,
  ...over,
});

const counts = (body: string, signOffRules = rules) => parseSignOff(comment(body), signOffRules).ok;

describe('the owner names the version by its code', () => {
  it('accepts the 7 characters GitHub displays, reporting the full head as the approved version', () => {
    expect(parseSignOff(comment(`/visto-bueno ${head.slice(0, 7)}`), rules)).toEqual({ ok: true, sha: head });
  });

  it('accepts any longer prefix of the current head, up to the full SHA', () => {
    for (const length of [8, 12, 39, 40]) {
      expect(counts(`/visto-bueno ${head.slice(0, length)}`)).toBe(true);
    }
  });

  it('ignores letter case in the code', () => {
    expect(counts(`/visto-bueno ${head.slice(0, 7).toUpperCase()}`)).toBe(true);
  });

  it('refuses 6 characters, even of the current head, and says the minimum is 7', () => {
    const result = parseSignOff(comment(`/visto-bueno ${head.slice(0, 6)}`), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/\b7\b/);
  });

  it('refuses the code of another version, naming both', () => {
    const result = parseSignOff(comment(`/visto-bueno ${older.slice(0, 7)}`), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(older.slice(0, 7));
    expect(result.ok === false && result.reason).toContain(head.slice(0, 7));
  });

  it('refuses a code that starts like the head and then differs', () => {
    // The first 7 characters match; the eighth of the head is `c`, not `0`.
    expect(counts(`/visto-bueno ${head.slice(0, 7)}0000`)).toBe(false);
  });

  it('refuses a code longer than the head', () => {
    expect(counts(`/visto-bueno ${head}0`)).toBe(false);
  });

  it('refuses characters that are not hexadecimal', () => {
    expect(counts(`/visto-bueno ${head.slice(0, 6)}g`)).toBe(false);
  });

  it('accepts the 7-character code of a SHA-256 head', () => {
    const head256 = '3b7e0f5a9c1d2e4f6a8b0c1d3e5f7a9b1c2d4e6f8a0b2c3d5e7f9a1b3c4d6e8f';

    expect(counts(`/visto-bueno ${head256.slice(0, 7)}`, { productOwners: ['luismichelcf'], headSha: head256 })).toBe(true);
  });
});

describe('the merge check asks for the code', () => {
  const builder: ExecutionIdentity = { provider: 'opencode', model: 'deepseek/deepseek-flash', session: 'ses_1' };
  const reviewer: ExecutionIdentity = { provider: 'claude', model: 'claude-opus-5', session: 's-2' };

  const input = (comments: readonly PullRequestComment[]): MergeCheckInput => ({
    headSha: head,
    builder,
    verdicts: [{ by: reviewer, sha: head, approved: true }],
    needsSignOff: true,
    comments,
    productOwners: ['luismichelcf'],
  });

  it('passes with the 7-character code of the current head', () => {
    expect(concludeMergeCheck(input([comment(`/visto-bueno ${head.slice(0, 7)}`)])).conclusion).toBe('success');
  });

  it('without a sign-off, names the exact order to write for the current head', () => {
    expect(concludeMergeCheck(input([])).summary).toContain(`/visto-bueno ${head.slice(0, 7)}`);
  });
});
