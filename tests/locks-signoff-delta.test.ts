import { describe, expect, it } from 'vitest';

import { parseSignOff, type PullRequestComment } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026). The rule is what GitHub shows: an order the owner
// sees on the page counts, and one GitHub renders inside a quote or a code block does not.
//   - A <details> or <pre> opened and closed on one line hid every order after it.
//   - A line with text after the backticks does not close a fence, but closed it here.
//   - A line right after a quote, with no blank line between, belongs to the quote.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const older = '64a2caf8795d0e1f2a3b4c5d6e7f8091a2b3c4d5';
const rules = { productOwners: ['luismichelcf'], headSha: head };

const counts = (body: string) => {
  const comment: PullRequestComment = { body, author: 'luismichelcf', authorType: 'User', performedViaApp: false, edited: false };
  return parseSignOff(comment, rules).ok;
};

describe('an order the owner sees on the page counts', () => {
  it('after a <details> that opens and closes on one line', () => {
    expect(counts(`<details><summary>Capturas</summary>ok</details>\n/visto-bueno ${head}`)).toBe(true);
  });

  it('after a <pre> that opens and closes on one line', () => {
    expect(counts(`Salida: <pre>ok</pre>\n/visto-bueno ${head}`)).toBe(true);
  });

  it('after a word that only starts with pre', () => {
    expect(counts(`Revisé el <preview> en Vercel.\n/visto-bueno ${head}`)).toBe(true);
  });

  it('after an HTML comment marker written as inline code', () => {
    expect(counts(`Los comentarios se abren con \`<!--\`.\n/visto-bueno ${head}`)).toBe(true);
  });

  it('after a quote followed by a blank line', () => {
    expect(counts(`> El preview se ve bien.\n\n/visto-bueno ${head}`)).toBe(true);
  });
});

describe('an order GitHub renders inside a quote or a code block does not count', () => {
  it('inside a fence whose would-be closer has text after the backticks', () => {
    expect(counts(`\`\`\`\n\`\`\` no cierra\n/visto-bueno ${head}\n\`\`\``)).toBe(false);
  });

  it('on the line right after a quote, which continues the quote', () => {
    expect(counts(`> El dueño dijo en el chat:\n/visto-bueno ${head}`)).toBe(false);
  });

  it('inside a fence opened with one to three spaces', () => {
    expect(counts(`   \`\`\`\n/visto-bueno ${head}\n   \`\`\``)).toBe(false);
  });

  it('when a comment carries two orders, whichever comes first', () => {
    expect(counts(`/visto-bueno ${head}\n/visto-bueno ${older}`)).toBe(false);
  });
});
