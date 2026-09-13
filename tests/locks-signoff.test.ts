import { describe, expect, it } from 'vitest';

import {
  concludeMergeCheck,
  parseSignOff,
  type ExecutionIdentity,
  type MergeCheckInput,
  type PullRequestComment,
  type Verdict,
} from '../src/index.js';

// The owner's sign-off and what the server check concludes. Decided with the owner on
// 12-sep-2026: GitHub does not let the author of a pull request approve it, and the pipeline
// opens pull requests with his account, so his sign-off is a comment — `/visto-bueno <sha>`
// — tied to the exact version he looked at.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const older = '1234567aaaa0b1c2d3e4f5061728394a5b6c7d8e';
const rules = { productOwners: ['luismichelcf'], headSha: head };

const comment = (body: string, over: Partial<PullRequestComment> = {}): PullRequestComment => ({
  body,
  author: 'luismichelcf',
  authorType: 'User',
  performedViaApp: false,
  edited: false,
  ...over,
});

describe('reading the owner s sign-off', () => {
  it('accepts it on its own line, naming the current version', () => {
    expect(parseSignOff(comment(`/visto-bueno ${head}`), rules)).toEqual({ ok: true, sha: head });
  });

  it('accepts it among other lines of the comment', () => {
    const body = `Se ve bien en el preview.\n/visto-bueno ${head}\nGracias`;

    expect(parseSignOff(comment(body), rules).ok).toBe(true);
  });

  it('ignores letter case in the login and the SHA', () => {
    expect(parseSignOff(comment(`/visto-bueno ${head.toUpperCase()}`, { author: 'LuisMichelCF' }), rules).ok).toBe(true);
  });

  it('refuses a sign-off of an older version, naming both', () => {
    const result = parseSignOff(comment(`/visto-bueno ${older}`), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(older.slice(0, 7));
    expect(result.ok === false && result.reason).toContain(head.slice(0, 7));
  });

  it('refuses a sign-off from someone who is not a product owner, naming them', () => {
    const result = parseSignOff(comment(`/visto-bueno ${head}`, { author: 'un-agente' }), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('un-agente');
  });

  it('refuses a SHA too short to identify one version', () => {
    expect(parseSignOff(comment('/visto-bueno 9f42'), rules).ok).toBe(false);
  });

  it('refuses something that is not a SHA', () => {
    expect(parseSignOff(comment('/visto-bueno este'), rules).ok).toBe(false);
  });

  it('does not count the command inside a quote', () => {
    // Quoting someone's sign-off to discuss it is not signing off.
    expect(parseSignOff(comment(`> /visto-bueno ${head}`), rules).ok).toBe(false);
  });

  it('does not count the command inside a code block', () => {
    const body = `Así se escribe:\n\`\`\`\n/visto-bueno ${head}\n\`\`\``;

    expect(parseSignOff(comment(body), rules).ok).toBe(false);
  });

  it('does not count the command in the middle of a sentence', () => {
    expect(parseSignOff(comment(`cuando escribas /visto-bueno ${head} se mergea`), rules).ok).toBe(false);
  });

  it('says there is no sign-off in a comment without one', () => {
    const result = parseSignOff(comment('Me gusta'), rules);

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
    comments: [comment(`/visto-bueno ${head}`)],
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
    expect(concludeMergeCheck(input({ comments: [comment(`/visto-bueno ${older}`)] })).conclusion).toBe('failure');
  });

  it('passes when an older sign-off is followed by one for the current version', () => {
    const result = concludeMergeCheck(
      input({ comments: [comment(`/visto-bueno ${older}`), comment(`/visto-bueno ${head}`)] }),
    );

    expect(result.conclusion).toBe('success');
  });

  it('fails when the builder reviewed its own work', () => {
    expect(concludeMergeCheck(input({ verdicts: [approved({ by: builder })] })).conclusion).toBe('failure');
  });

  it('fails when the review is of an older version', () => {
    const result = concludeMergeCheck(input({ verdicts: [approved({ sha: older })] }));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain(older.slice(0, 7));
  });

  it('fails when a required angle was never reviewed', () => {
    const result = concludeMergeCheck(input({ requiredAngles: ['dinero', 'permisos'], verdicts: [approved({ angle: 'dinero' })] }));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('permisos');
  });

  it('lists every reason it failed, not only the first', () => {
    const result = concludeMergeCheck(input({ verdicts: [approved({ by: builder, sha: older })], comments: [] }));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('deepseek');
    expect(result.summary).toContain(older.slice(0, 7));
    expect(result.summary.toLowerCase()).toContain('visto-bueno');
  });
});
