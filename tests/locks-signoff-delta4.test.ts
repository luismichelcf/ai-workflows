import { describe, expect, it } from 'vitest';

import { parseSignOff, type PullRequestComment } from '../src/index.js';

// Fourth review of the part 4 fixes (13-sep-2026), each case compared with markdown-it 4.0 and
// html5lib. A fence opened in a list item belongs to that item: it closes with a fence indented
// up to the item's content column plus three, or when a non-blank line less indented than that
// column ends the item. Reading it as a top-level fence got both directions wrong.

const head = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const rules = { productOwners: ['luismichelcf'], headSha: head };

const counts = (body: string) => {
  const comment: PullRequestComment = { body, author: 'luismichelcf', authorType: 'User', performedViaApp: false, edited: false };
  return parseSignOff(comment, rules).ok;
};

describe('a fence in a list item ends with the item', () => {
  const inCode: Record<string, string> = {
    'a bullet fence ended by an unindented line, then a new top-level fence': `- \`\`\`\nx\n\`\`\`\n/visto-bueno ${head}`,
    'a numbered fence ended by an unindented fence': `1. \`\`\`\n\`\`\`\n/visto-bueno ${head}`,
    'after a quote, a numbered fence ended the same way': `> cita\n2. \`\`\`\nx\n\`\`\`\n/visto-bueno ${head}`,
  };

  for (const [name, body] of Object.entries(inCode)) {
    it(`does not count an order GitHub shows inside code: ${name}`, () => {
      expect(counts(body)).toBe(false);
    });
  }

  const visible: Record<string, string> = {
    'a fence in "10." closed at its content column': `10. \`\`\`\n    pnpm test\n    \`\`\`\n\n/visto-bueno ${head}`,
    'a fence in a nested bullet closed at its content column': `- a\n  - \`\`\`\n    code\n    \`\`\`\n\n/visto-bueno ${head}`,
    'an unclosed fence in a bullet ended by an unindented line': `- \`\`\`\n  code\n\n/visto-bueno ${head}`,
    'a fence in a "1)" item closed at its content column': `1) \`\`\`\n   code\n   \`\`\`\n\n/visto-bueno ${head}`,
  };

  for (const [name, body] of Object.entries(visible)) {
    it(`counts an order GitHub shows as text: ${name}`, () => {
      expect(counts(body)).toBe(true);
    });
  }
});

describe('what GitHub hides stays hidden', () => {
  it('a space and a tab before the order make it indented code', () => {
    expect(counts(`Texto\n\n \t/visto-bueno ${head}`)).toBe(false);
  });

  it('a self-closing <details/> still opens a details', () => {
    expect(counts(`<details/>\n/visto-bueno ${head}\n</details>`)).toBe(false);
  });

  it('a nested details closes only the inner one', () => {
    expect(counts(`<details>\n<details>\nx\n</details>\n/visto-bueno ${head}\n</details>`)).toBe(false);
  });

  it('a #5 that is not a heading does not end the quote', () => {
    expect(counts(`> cita\n#5\n/visto-bueno ${head}`)).toBe(false);
  });
});
