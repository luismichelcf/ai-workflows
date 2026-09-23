import { describe, expect, it } from 'vitest';

import { classifyFiles } from '../src/index.js';

// PLAN-13 §3.3: `classify` names path tables, and a condition asks whether a change touches
// one of them. The glob language is deliberately small: `**` as a whole segment (zero or more
// folders), `*` and `?` inside one segment, everything else literal and case-sensitive.

const classify = {
  money: ['lib/calc/**', '**/*nomina*'],
  visible: ['app/**'],
  production: ['.github/workflows/**'],
};

describe('which classes a change touches', () => {
  it('answers in the order classify declares them', () => {
    expect(classifyFiles(classify, ['.github/workflows/ci.yml', 'app/page.tsx'])).toEqual([
      'visible',
      'production',
    ]);
  });

  it('matches ** as any number of folders, including none', () => {
    expect(classifyFiles(classify, ['lib/calc/tax.ts'])).toEqual(['money']);
    expect(classifyFiles(classify, ['lib/calc/deep/er/x.ts'])).toEqual(['money']);
    expect(classifyFiles(classify, ['src/pay/pre-nomina-mensual.ts'])).toEqual(['money']);
    expect(classifyFiles(classify, ['nomina.ts'])).toEqual(['money']);
  });

  it('does not let a folder prefix match a longer name', () => {
    expect(classifyFiles(classify, ['lib/calculator.ts'])).toEqual([]);
  });

  it('keeps * and ? inside one folder', () => {
    const top = { top: ['*.md'], one: ['a?.ts'] };
    expect(classifyFiles(top, ['README.md'])).toEqual(['top']);
    expect(classifyFiles(top, ['docs/README.md'])).toEqual([]);
    expect(classifyFiles(top, ['ab.ts'])).toEqual(['one']);
    expect(classifyFiles(top, ['abc.ts'])).toEqual([]);
    expect(classifyFiles(top, ['a/.ts'])).toEqual([]);
  });

  it('matches names that start with a dot like any other', () => {
    expect(classifyFiles({ any: ['**/*'] }, ['.env'])).toEqual(['any']);
  });

  it('is case-sensitive', () => {
    expect(classifyFiles(classify, ['App/page.tsx'])).toEqual([]);
  });

  it('reads Windows separators as folders', () => {
    expect(classifyFiles(classify, ['app\\page.tsx'])).toEqual(['visible']);
  });

  it('treats regular-expression characters in a pattern as literal', () => {
    expect(classifyFiles({ plus: ['a+b.ts'] }, ['a+b.ts'])).toEqual(['plus']);
    expect(classifyFiles({ plus: ['a+b.ts'] }, ['aab.ts'])).toEqual([]);
    expect(classifyFiles({ dot: ['a.ts'] }, ['abts'])).toEqual([]);
  });

  it('lets a star in the pattern match a star in the file name, as any other character', () => {
    expect(classifyFiles({ md: ['*.md'] }, ['*notes.md'])).toEqual(['md']);
    expect(classifyFiles({ ts: ['src/*.ts'] }, ['src/*evil.ts'])).toEqual(['ts']);
    expect(classifyFiles({ sql: ['**/*.sql'] }, ['m/*drop.sql'])).toEqual(['sql']);
    expect(classifyFiles({ all: ['*'] }, ['*b'])).toEqual(['all']);
    expect(classifyFiles({ all: ['**/*'] }, ['*b'])).toEqual(['all']);
    expect(classifyFiles({ mid: ['a*b*c'] }, ['a*xb*yc'])).toEqual(['mid']);
  });

  it('lets a question mark match a literal question mark or star', () => {
    expect(classifyFiles({ q: ['a?c'] }, ['a*c'])).toEqual(['q']);
    expect(classifyFiles({ q: ['a?c'] }, ['a?c'])).toEqual(['q']);
  });

  it('touches nothing when nothing changed', () => {
    expect(classifyFiles(classify, [])).toEqual([]);
  });
});
