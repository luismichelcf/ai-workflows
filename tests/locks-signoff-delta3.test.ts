import { describe, expect, it } from 'vitest';

import { parseSignOff, type PullRequestComment } from '../src/index.js';

// Third review of the part 4 fixes (13-sep-2026). What GitHub shows, confirmed with a
// CommonMark renderer (markdown-it 4.0):
//   - The last tag on a line decides: `<details>a</details><details>` leaves a details open.
//   - A list item keeps its fence and its quote: `- ```` and `- > cita` swallow what follows.
//   - A heading or a closed fence ends a quote, so the order after them is visible.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const rules = { productOwners: ['luismichelcf'], headSha: head };

const counts = (body: string) => {
  const comment: PullRequestComment = { body, author: 'luismichelcf', authorType: 'User', performedViaApp: false, edited: false };
  return parseSignOff(comment, rules).ok;
};

describe('an order left inside an open region does not count', () => {
  const hidden: Record<string, string> = {
    'after <details>a</details><details> on one line': `<details>a</details><details>\n/visto-bueno ${head}\n</details>`,
    'after <pre>a</pre> y <pre> on one line': `<pre>a</pre> y <pre>\n/visto-bueno ${head}\n</pre>`,
    'after an uppercase <DETAILS>': `<DETAILS>\n/visto-bueno ${head}\n</DETAILS>`,
    'indented with a tab': `Texto\n\n\t/visto-bueno ${head}`,
    'inside a fence opened in a list item': `- \`\`\`\n  /visto-bueno ${head}\n  \`\`\``,
    'on the lazy line of a quote in a list item': `- > cita\n/visto-bueno ${head}`,
    'after a comment that opens again on the same line': `<!-- a --> b <!--\n/visto-bueno ${head}\n-->`,
  };

  for (const [name, body] of Object.entries(hidden)) {
    it(`refuses the order ${name}`, () => {
      expect(counts(body)).toBe(false);
    });
  }
});

describe('an order GitHub shows after a quote counts', () => {
  it('after a quote ended by a heading', () => {
    expect(counts(`> cita\n# Título\n/visto-bueno ${head}`)).toBe(true);
  });

  it('after a quote ended by a closed fence', () => {
    expect(counts(`> cita\n\`\`\`\ncodigo\n\`\`\`\n/visto-bueno ${head}`)).toBe(true);
  });
});
