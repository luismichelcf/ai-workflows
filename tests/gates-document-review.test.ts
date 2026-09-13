import { describe, expect, it } from 'vitest';

import { countDistinctSources, findSections, requireSections, requireSources } from '../src/index.js';

// Adversarial review of the document gates (13-sep-2026). Every case below fooled them.
// They still check SHAPE and never quality — but the shape they check has to be real.

const links = (...urls: string[]) => urls.map((url) => `- [x](${url})\n`).join('');

describe('one vendor is one source, however the link is written', () => {
  it('a query string does not make a new source', () => {
    const doc = links('https://productive.io?a', 'https://productive.io?b', 'https://productive.io?c', 'https://productive.io?d', 'https://productive.io?e');

    expect(countDistinctSources(doc)).toBe(1);
    expect(requireSources(doc, { min: 5 }).ok).toBe(false);
  });

  it('a fragment does not make a new source', () => {
    const doc = links('https://scoro.com#a', 'https://scoro.com#b', 'https://scoro.com#c', 'https://scoro.com#d', 'https://scoro.com#e');

    expect(countDistinctSources(doc)).toBe(1);
  });

  it('quotes, bold and code marks around a link do not make a new source', () => {
    const doc = '«https://scoro.com» y **https://scoro.com/x** y `https://scoro.com/y` y https://scoro.com/z';

    expect(countDistinctSources(doc)).toBe(1);
  });

  it('a table row with two links counts two', () => {
    expect(countDistinctSources('|https://a.com|https://b.com|')).toBe(2);
  });

  it('an upper-case scheme still counts', () => {
    expect(countDistinctSources('ver HTTPS://SCORO.COM/precios')).toBe(1);
  });

  it('an international domain and its punycode form are one source', () => {
    expect(countDistinctSources('https://español.com/a y https://xn--espaol-zwa.com/b')).toBe(1);
  });
});

describe('subdomains belong to their vendor', () => {
  it('five subdomains of one vendor are one source', () => {
    const doc = links('https://scoro.com', 'https://docs.scoro.com', 'https://help.scoro.com', 'https://blog.scoro.com', 'https://app.scoro.com');

    expect(countDistinctSources(doc)).toBe(1);
    expect(requireSources(doc, { min: 5 }).ok).toBe(false);
  });

  it('a subdomain of a known vendor is not "from outside"', () => {
    const known = ['productive.io', 'scoro.com', 'runn.io', 'ruddr.io', 'forecast.app'];
    const doc = links(...known.map((host) => `https://${host}`), 'https://help.scoro.com', 'https://blog.runn.io');

    expect(requireSources(doc, { min: 5, outside: { min: 2, of: known } }).ok).toBe(false);
  });

  it('two different companies under the same national suffix are two sources', () => {
    expect(countDistinctSources('https://empresa-uno.com.mx y https://empresa-dos.com.mx')).toBe(2);
  });
});

describe('what is not a source at all', () => {
  it('local addresses and private IPs are not sources', () => {
    const doc = links('http://localhost:3000', 'http://127.0.0.1', 'http://192.168.0.10', 'http://[::1]:8080', 'http://10.0.0.1');

    expect(countDistinctSources(doc)).toBe(0);
  });

  it('links inside a code block are not sources', () => {
    expect(countDistinctSources('```\nhttps://a.com\nhttps://b.com\n```\n')).toBe(0);
  });

  it('links inside an HTML comment are not sources', () => {
    expect(countDistinctSources('<!--\nhttps://a.com\nhttps://b.com\nhttps://c.com\n-->')).toBe(0);
  });
});

describe('a section needs real content under it', () => {
  // A template left unfilled, with its placeholders in comments, passed as "has content".
  const invisible: Array<[string, string]> = [
    ['an HTML comment', '<!-- TODO: completar -->'],
    ['a multi-line HTML comment', '<!--\nTODO\ncompletar\n-->'],
    ['an HTML heading tag', '<h2>Decisiones</h2>'],
    ['a zero-width space', '​'],
    ['a non-breaking space entity', '&nbsp;'],
    ['an empty list marker', '- '],
    ['a lone asterisk', '*'],
    ['a thematic break', '---'],
    ['an empty code block', '```\n```'],
  ];

  for (const [label, filler] of invisible) {
    it(`does not count ${label} as content`, () => {
      const doc = `## Benchmark\n${filler}\n## Otra\n\ntexto\n`;

      expect(requireSections(doc, ['Benchmark']).ok).toBe(false);
    });
  }

  it('does not count a heading hidden inside an HTML comment as a section', () => {
    const doc = '<!--\n## Benchmark\ncontenido escondido\n-->\n## Otra\n\ntexto\n';

    expect(requireSections(doc, ['Benchmark']).ok).toBe(false);
  });

  it('counts content that lives in subsections', () => {
    // A well-organised benchmark — one subsection per vendor — was reported as missing.
    const doc = '## Benchmark\n### Productive\nMuy completo.\n### Scoro\nOtra cosa.\n';

    expect(requireSections(doc, ['Benchmark']).ok).toBe(true);
  });

  it('still refuses a section whose next heading is a sibling, not a child', () => {
    expect(requireSections('## Benchmark\n\n## Decisiones\n\ntexto', ['Benchmark']).ok).toBe(false);
  });
});

describe('code blocks, as Markdown actually defines them', () => {
  it('a tilde fence hides a heading inside it, even when it contains backticks', () => {
    const doc = '## Real\n\ntexto\n~~~~\n```\n## Falsa\n~~~~\n';

    expect(findSections(doc)).toEqual(['Real']);
  });

  it('a four-backtick fence is closed only by four backticks or more', () => {
    const doc = '## Real\n\ntexto\n````\n```\n## Falsa\n````\n';

    expect(findSections(doc)).toEqual(['Real']);
  });

  it('an indented code line is not a heading', () => {
    expect(findSections('## Real\n\ntexto\n\n    ## Indentado\n')).toEqual(['Real']);
  });

  it('backticks used inline on a line do not open a block that swallows later headings', () => {
    const doc = '## Real\n```js``` es un ejemplo\n## Benchmark\n\ntexto\n';

    expect(requireSections(doc, ['Benchmark']).ok).toBe(true);
  });
});

describe('the same title written slightly differently', () => {
  for (const [label, heading] of [
    ['numbered', '## 1. Benchmark'],
    ['in bold', '## **Benchmark**'],
    ['with a trailing colon', '## Benchmark:'],
  ] as const) {
    it(`finds the section when the title is ${label}`, () => {
      expect(requireSections(`${heading}\n\ncontenido\n`, ['Benchmark']).ok).toBe(true);
    });
  }

  it('finds a setext heading', () => {
    expect(requireSections('Benchmark\n---------\n\ncontenido\n', ['Benchmark']).ok).toBe(true);
  });
});
