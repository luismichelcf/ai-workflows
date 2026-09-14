import { describe, expect, it } from 'vitest';

import {
  concludeMergeCheck,
  parseSignOff,
  type ExecutionIdentity,
  type MergeCheckInput,
  type PullRequestComment,
  type Verdict,
} from '../src/index.js';

// Review of part 4 (13-sep-2026). Which comment really is the owner's sign-off.
//   - Two different commits sharing their first 7 characters were fabricated in 57 seconds.
//     The owner still chose the 7-character code on 14-sep-2026 (ai-workflows#9); the risk and
//     why it is accepted are in locks-signoff-short.test.ts.
//   - GitHub lets anyone with write access edit a comment; the author stays the same.
//   - An order hidden in an HTML comment is invisible on the page but was accepted.
// What it cannot prove is declared: while the agents post with the owner's account, a
// comment proves which account wrote it, not which person.

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

const counts = (body: string, over: Partial<PullRequestComment> = {}, signOffRules = rules) =>
  parseSignOff(comment(body, over), signOffRules).ok;

describe('the full SHA still names a version', () => {
  it('accepts the full 40-character SHA', () => {
    expect(counts(`/visto-bueno ${head}`)).toBe(true);
  });

  it('accepts a 64-character SHA in a SHA-256 repository', () => {
    const head256 = '3b7e0f5a9c1d2e4f6a8b0c1d3e5f7a9b1c2d4e6f8a0b2c3d5e7f9a1b3c4d6e8f';

    expect(counts(`/visto-bueno ${head256}`, {}, { productOwners: ['luismichelcf'], headSha: head256 })).toBe(true);
  });

  it('refuses the full SHA of another version, naming the current one', () => {
    const result = parseSignOff(comment(`/visto-bueno ${older}`), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(head.slice(0, 7));
  });
});

describe('the comment must be exactly as the owner posted it', () => {
  it('refuses an edited comment, since anyone with write access can edit it', () => {
    const result = parseSignOff(comment(`/visto-bueno ${head}`, { edited: true }), rules);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.toLowerCase()).toMatch(/editad/);
  });

  it('refuses a comment posted through an app', () => {
    expect(counts(`/visto-bueno ${head}`, { performedViaApp: true })).toBe(false);
  });

  it('refuses a comment from a bot account', () => {
    expect(counts(`/visto-bueno ${head}`, { authorType: 'Bot' })).toBe(false);
  });

  it('refuses an author whose login only folds into an owner s', () => {
    // U+212A KELVIN SIGN lower-cases to "k"; GitHub logins are plain ASCII.
    expect(counts(`/visto-bueno ${head}`, { author: 'Kurt' }, { productOwners: ['kurt'], headSha: head })).toBe(false);
  });

  it('refuses an empty author even when the owner list has an empty entry', () => {
    expect(counts(`/visto-bueno ${head}`, { author: '' }, { productOwners: [''], headSha: head })).toBe(false);
  });
});

describe('an order that is not really given does not count', () => {
  const hidden: Record<string, string> = {
    'inside an HTML comment, invisible on the page': `Todo bien.\n<!--\n/visto-bueno ${head}\n-->`,
    'inside <details>': `<details>\n\n/visto-bueno ${head}\n\n</details>`,
    'inside <pre>': `<pre>\n/visto-bueno ${head}\n</pre>`,
    'in an indented code block': `Ejemplo:\n\n    /visto-bueno ${head}`,
    'inside a four-backtick fence holding a three-backtick line': `\`\`\`\`\n\`\`\`\n/visto-bueno ${head}\n\`\`\`\``,
    'inside a backtick fence holding a tilde line': `\`\`\`\n~~~\n/visto-bueno ${head}\n\`\`\``,
    'in instructions posted for the owner to copy': `Para dar el visto bueno copia esta línea:\n\n\`\`\`\n/visto-bueno ${head}\n\`\`\``,
  };

  for (const [name, body] of Object.entries(hidden)) {
    it(`refuses the order ${name}`, () => {
      expect(counts(body)).toBe(false);
    });
  }

  it('refuses a comment with two orders, even if one names the current head', () => {
    expect(counts(`/visto-bueno ${older}\n/visto-bueno ${head}`)).toBe(false);
  });

  it('still accepts the order after a closed code block', () => {
    expect(counts(`\`\`\`\nnpm test\n\`\`\`\n/visto-bueno ${head}`)).toBe(true);
  });
});

describe('what the merge check says about the sign-off', () => {
  const builder: ExecutionIdentity = { provider: 'opencode', model: 'deepseek/deepseek-flash', session: 'ses_1' };
  const reviewer: ExecutionIdentity = { provider: 'claude', model: 'claude-opus-5', session: 's-2' };
  const verdict: Verdict = { by: reviewer, sha: head, approved: true };

  const input = (comments: readonly PullRequestComment[]): MergeCheckInput => ({
    headSha: head,
    builder,
    verdicts: [verdict],
    needsSignOff: true,
    comments,
    productOwners: ['luismichelcf'],
  });

  it('says the sign-off was for an older version', () => {
    const result = concludeMergeCheck(input([comment(`/visto-bueno ${older}`)]));

    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain(older.slice(0, 7));
  });

  it('says the sign-off was edited', () => {
    const result = concludeMergeCheck(input([comment(`/visto-bueno ${head}`, { edited: true })]));

    expect(result.conclusion).toBe('failure');
    expect(result.summary.toLowerCase()).toMatch(/editad/);
  });

  it('declares what a sign-off by comment cannot prove, even when it passes', () => {
    const result = concludeMergeCheck(input([comment(`/visto-bueno ${head}`)]));

    expect(result.conclusion).toBe('success');
    expect(result.limits.join(' ').toLowerCase()).toMatch(/cuenta/);
  });
});
