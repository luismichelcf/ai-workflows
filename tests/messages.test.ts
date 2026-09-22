import { describe, expect, it } from 'vitest';

import { DEFAULT_BANNED_TERMS, findBannedTerms } from '../src/index.js';

// PLAN-13 §1.1 (D54 of PLAN-997): what the owner reads is checked against a list of words he
// should never have to decode. The default list is the one Socialabs already enforces.

const DEFAULT_LIST = [
  'sha',
  'pipeline',
  'deployment',
  'workflow',
  'commit',
  'merge',
  'branch',
  'cli',
  'stack trace',
  'build',
  'runner',
  'refactor',
  'rollback',
  'endpoint',
];

describe('the default list of words the owner never reads', () => {
  it('is exactly the list in force', () => {
    expect([...DEFAULT_BANNED_TERMS]).toEqual(DEFAULT_LIST);
  });
});

describe('finding banned words in a message', () => {
  it('reports each word found, in the order of the list', () => {
    expect(findBannedTerms('Hice un merge y luego un commit.', DEFAULT_BANNED_TERMS)).toEqual([
      'commit',
      'merge',
    ]);
  });

  it('ignores case and accents', () => {
    expect(findBannedTerms('El SHÁ cambió', DEFAULT_BANNED_TERMS)).toEqual(['sha']);
  });

  it('matches whole words only', () => {
    expect(findBannedTerms('shampoo, merged, rebuilding', DEFAULT_BANNED_TERMS)).toEqual([]);
  });

  it('treats a dash as a word edge', () => {
    expect(findBannedTerms('el gancho pre-commit', DEFAULT_BANNED_TERMS)).toEqual(['commit']);
  });

  it('matches a term of several words across any spacing', () => {
    expect(findBannedTerms('mira el stack \n  trace', DEFAULT_BANNED_TERMS)).toEqual(['stack trace']);
  });

  it('reports a word once however many times it appears', () => {
    expect(findBannedTerms('build, build y build', DEFAULT_BANNED_TERMS)).toEqual(['build']);
  });

  it('finds nothing in plain words', () => {
    expect(findBannedTerms('La pieza espera tu decisión.', DEFAULT_BANNED_TERMS)).toEqual([]);
  });

  it('reports a word once even if the list repeats it', () => {
    expect(findBannedTerms('un merge', ['merge', 'MERGE', 'merge'])).toEqual(['merge']);
  });

  it('uses the list it is given', () => {
    expect(findBannedTerms('un diff grande', ['diff'])).toEqual(['diff']);
  });
});
