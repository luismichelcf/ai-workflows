import { describe, expect, it } from 'vitest';

import { countDistinctSources, findSections, requireSections, requireSources } from '../src/index.js';

// The first real gates. They read a document and check its SHAPE — never its truth, and
// never whether it is any good. That distinction is the whole point of the spec's four
// natures: saying "the benchmark is sufficient" would be a promise no predicate can keep.
// Sufficiency is judged by the cross review; these check that there is something to judge.

const withSections = (...titles: string[]) =>
  titles.map((title) => `## ${title}\n\ncontenido de ${title}.\n`).join('\n');

describe('finding the sections of a document', () => {
  it('finds a section by its heading', () => {
    expect(findSections('## Benchmark\n\ntexto')).toContain('Benchmark');
  });

  it('finds sections at any heading level', () => {
    const found = findSections('# Uno\n## Dos\n### Tres\n');

    expect(found).toEqual(['Uno', 'Dos', 'Tres']);
  });

  it('ignores case and accents when matching', () => {
    expect(findSections('## Investigación')).toContain('Investigacion');
  });

  it('does not mistake a heading inside a code block for a section', () => {
    const doc = '## Real\n\n```\n## Falsa\n```\n';

    expect(findSections(doc)).toEqual(['Real']);
  });

  it('finds nothing in an empty document', () => {
    expect(findSections('')).toEqual([]);
  });
});

describe('requiring sections', () => {
  it('passes when every required section is there', () => {
    const result = requireSections(withSections('Benchmark', 'Decisiones'), [
      'Benchmark',
      'Decisiones',
    ]);

    expect(result.ok).toBe(true);
  });

  it('names exactly what is missing, so the report says what to do', () => {
    const result = requireSections(withSections('Benchmark'), ['Benchmark', 'Decisiones']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('Decisiones');
  });

  it('does not complain about the sections that are there', () => {
    const result = requireSections(withSections('Benchmark'), ['Benchmark', 'Decisiones']);

    expect(result.ok === false && result.reason).not.toContain('Benchmark');
  });

  it('names all the missing ones at once, not one at a time', () => {
    const result = requireSections(withSections('Uno'), ['Uno', 'Dos', 'Tres']);

    expect(result.ok === false && result.reason).toContain('Dos');
    expect(result.ok === false && result.reason).toContain('Tres');
  });

  it('rejects a section that is only a heading with nothing under it', () => {
    // A heading with no content is the cheapest way to satisfy a checker without doing
    // the work. The gate is structural, but empty is structure too.
    const result = requireSections('## Benchmark\n\n## Decisiones\n\ntexto', ['Benchmark']);

    expect(result.ok).toBe(false);
  });
});

describe('counting sources', () => {
  const link = (url: string) => `- [fuente](${url})\n`;

  it('counts links by their domain', () => {
    const doc = link('https://productive.io/a') + link('https://scoro.com/b');

    expect(countDistinctSources(doc)).toBe(2);
  });

  it('counts two links to the same domain once', () => {
    // Five pages of one vendor is one vendor. The rule says distinct providers because
    // one vendor's docs cannot tell you what the industry does.
    const doc = link('https://productive.io/a') + link('https://productive.io/b');

    expect(countDistinctSources(doc)).toBe(1);
  });

  it('ignores the www prefix', () => {
    const doc = link('https://www.scoro.com/a') + link('https://scoro.com/b');

    expect(countDistinctSources(doc)).toBe(1);
  });

  it('ignores anything that is not a link', () => {
    expect(countDistinctSources('hablé con Productive y con Scoro')).toBe(0);
  });

  it('finds bare urls, not only markdown links', () => {
    expect(countDistinctSources('ver https://runn.io/pricing y https://ruddr.io/docs')).toBe(2);
  });
});

describe('requiring sources', () => {
  const sources = (...urls: string[]) => urls.map((url) => `- [x](${url})\n`).join('');

  const five = sources(
    'https://productive.io/a',
    'https://scoro.com/b',
    'https://runn.io/c',
    'https://ruddr.io/d',
    'https://forecast.app/e',
  );

  it('passes with enough distinct sources', () => {
    expect(requireSources(five, { min: 5 }).ok).toBe(true);
  });

  it('rejects when there are fewer, saying how many it found and how many it needs', () => {
    const result = requireSources(sources('https://productive.io/a'), { min: 5 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('1');
    expect(result.ok === false && result.reason).toContain('5');
  });

  it('rejects five links to the same place', () => {
    const same = sources(
      'https://productive.io/a',
      'https://productive.io/b',
      'https://productive.io/c',
      'https://productive.io/d',
      'https://productive.io/e',
    );

    expect(requireSources(same, { min: 5 }).ok).toBe(false);
  });

  it('can require sources from outside a given list, for the non-PSA ones', () => {
    // The rule asks for five tools of the trade AND two or three from outside it: the
    // interesting answers come from people solving the problem differently.
    const doc =
      five + sources('https://linear.app/x', 'https://notion.so/y');

    const result = requireSources(doc, {
      min: 5,
      outside: { min: 2, of: ['productive.io', 'scoro.com', 'runn.io', 'ruddr.io', 'forecast.app'] },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects when the outside ones are missing', () => {
    const result = requireSources(five, {
      min: 5,
      outside: { min: 2, of: ['productive.io', 'scoro.com', 'runn.io', 'ruddr.io', 'forecast.app'] },
    });

    expect(result.ok).toBe(false);
  });

  it('says what it is missing in words, not as a number alone', () => {
    const result = requireSources(sources('https://productive.io/a'), { min: 5 });

    expect((result.ok === false ? result.reason : '').length).toBeGreaterThan(20);
  });
});

describe('what these gates deliberately do not claim', () => {
  it('passes a document whose sources are real but useless', () => {
    // Written down on purpose. A structural gate cannot tell a good benchmark from five
    // unrelated links, and the spec says so: sufficiency is judged by the cross review.
    // Anything else would be the engine promising more than it can check.
    const junk = [
      'https://example.com/a',
      'https://example.org/b',
      'https://example.net/c',
      'https://test.com/d',
      'https://nowhere.io/e',
    ]
      .map((url) => `- [x](${url})\n`)
      .join('');

    expect(requireSources(junk, { min: 5 }).ok).toBe(true);
  });
});
