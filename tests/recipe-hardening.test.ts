import { describe, expect, it } from 'vitest';

import {
  appliesIfFor,
  classifyFiles,
  createMemoryStore,
  parseRecipe,
  runCommand,
  type GateContext,
  type RecipeError,
  type StageConfig,
} from '../src/index.js';

// Findings of the review flock on slice 1 (PLAN-13 §3.2, RC-01): a recipe must never be
// readable two ways, never hang the engine on a file name, never paint the owner's terminal and
// never crash instead of answering with a reason.

const FILE = 'receta.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function errorsOf(text: string): readonly RecipeError[] {
  const result = parseRecipe(text, FILE);
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

const at = (line: number, column: number, message: RegExp) =>
  expect.objectContaining({ file: FILE, line, column, message: expect.stringMatching(message) });

/** A valid one-stage recipe with `extra` lines appended inside the stage, before `gate`. */
const stageWith = (...extra: string[]) =>
  lines(
    'version: 1',
    'locale: es',
    'classify:',
    '  money: ["lib/calc/**"]',
    'stages:',
    '  - id: a',
    '    summary: "Paso A"',
    '    nature: recompute',
    ...extra,
    '    gate:',
    '      run: node a.mjs',
  );

describe('a key is always text', () => {
  it('rejects a key written as a list, which would otherwise be dropped in silence', () => {
    const errors = errorsOf(stageWith('    ? [required]', '    : false'));
    expect(errors).toContainEqual(at(9, 7, /keys must be text/));
  });

  it('rejects a list key that shadows a real field instead of reading one of the two', () => {
    const errors = errorsOf(stageWith('    valid-while: forever', '    ? [valid-while]', '    : same-sha'));
    expect(errors).toContainEqual(at(10, 7, /keys must be text/));
  });

  it('rejects number, null and boolean keys where names are expected', () => {
    for (const key of ['1', '~', 'true']) {
      const errors = errorsOf(
        lines(
          'version: 1',
          'locale: es',
          'classify:',
          `  ${key}: ["a/**"]`,
          'stages:',
          '  - id: a',
          '    summary: "Paso A"',
          '    nature: recompute',
          '    gate:',
          '      run: node a.mjs',
        ),
      );
      expect(errors).toContainEqual(at(4, 3, /keys must be text/));
    }
  });
});

describe('names inherited by every object are not fields', () => {
  it('rejects them as unknown keys at every level', () => {
    expect(errorsOf(stageWith('    constructor: 5'))).toContainEqual(at(9, 5, /unknown key "constructor"/));
    expect(errorsOf(stageWith('    toString: [1]'))).toContainEqual(at(9, 5, /unknown key "toString"/));
    expect(errorsOf(stageWith('    applies-if: { constructor: [x] }'))).toContainEqual(
      at(9, 19, /unknown key "constructor"/),
    );
    expect(errorsOf(stageWith('    retry: { attempts: 2, hasOwnProperty: 9 }'))).toContainEqual(
      at(9, 27, /unknown key "hasOwnProperty"/),
    );
    expect(errorsOf(lines('__proto__: { x: 1 }', 'version: 1'))).toContainEqual(at(1, 1, /unknown key "__proto__"/));

    const gate = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate: { run: node a.mjs, valueOf: 1 }',
      ),
    );
    expect(gate).toContainEqual(at(7, 30, /unknown key "valueOf"/));
  });

  it('refuses a condition over an inherited name that classify never declared', () => {
    expect(errorsOf(stageWith('    applies-if: { touches-any: [constructor] }'))).toContainEqual(
      at(9, 33, /unknown class "constructor"/),
    );
  });

  it('positive: a class that happens to be called constructor works like any other', async () => {
    const result = parseRecipe(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        '  constructor: ["lib/**"]',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    applies-if: { touches-any: [constructor] }',
        '    gate:',
        '      run: node a.mjs',
      ),
      FILE,
    );
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
    const appliesWhen = appliesIfFor(result.recipe, 'a');
    const context = (files: string[]) => ({ change: { files } }) as unknown as GateContext;
    expect(await appliesWhen?.(context(['lib/x.ts']))).toBe(true);
    expect(await appliesWhen?.(context(['app/x.ts']))).toEqual({
      skip: 'No aplica: el cambio no toca «constructor».',
    });
  });
});

describe('globs the engine cannot honour are refused, never silently unmatched', () => {
  const classifyWith = (pattern: string) =>
    lines(
      'version: 1',
      'locale: es',
      'classify:',
      `  money: [${JSON.stringify(pattern)}]`,
      'stages:',
      '  - id: a',
      '    summary: "Paso A"',
      '    nature: recompute',
      '    gate:',
      '      run: node a.mjs',
    );

  for (const pattern of ['./app/**', '../x/*', 'app/./x', '/abs/**', '!app/**', 'a**b', 'a//b', '[ab].ts', 'a\\b', 'app/']) {
    it(`refuses ${pattern}`, () => {
      expect(errorsOf(classifyWith(pattern))).toContainEqual(at(4, 11, /^unsupported glob /));
    });
  }

  it('checks the globs of kinds.from-paths too', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'kinds:',
        '  default: behavior',
        '  from-paths:',
        '    docs: ["./docs/**"]',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(6, 12, /^unsupported glob "\.\/docs\/\*\*"/));
  });

  it('checks the classes of touches-none too', () => {
    expect(errorsOf(stageWith('    applies-if: { touches-none: [moneyy] }'))).toContainEqual(
      at(9, 34, /unknown class "moneyy"/),
    );
  });
});

describe('matching a path costs time proportional to the path, whatever the file is called', () => {
  const quick = (patterns: readonly string[], file: string, expected: readonly string[]) => {
    const started = performance.now();
    expect(classifyFiles({ c: patterns }, [file])).toEqual(expected);
    expect(performance.now() - started).toBeLessThan(1000);
  };

  it('a normal-looking pattern against a hostile file name from a pull request', () => {
    quick(['**/*-*-*-*-*.md'], `${'-'.repeat(250)}.txt`, []);
    quick(['**/*-*-*-*-*.md'], `docs/${'-'.repeat(250)}.md`, ['c']);
  });

  it('many stars in one segment', () => {
    quick(['*a*a*a*a*a*a*a*a*b'], 'a'.repeat(200), []);
    quick(['*a*a*a*a*a*a*a*a*b'], `${'a'.repeat(200)}b`, ['c']);
  });

  it('many ** segments against a deep path', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
    quick(['**/**/**/**/**/**/**/**/**/**/zzz'], `${deep}/x`, []);
    quick(['**/**/**/**/**/**/**/**/**/**/zzz'], `${deep}/zzz`, ['c']);
  });
});

describe('the owner terminal only ever receives plain text', () => {
  const escapes = /[\u0000-\u001f\u007f-\u009f]/;

  it('refuses control characters in any text of the recipe, without echoing them', () => {
    const cases = [
      ['    summary: "Paso \\x1b[31mrojo\\x1b[0m"', 7, 14],
      ['    summary: "Paso\\tA"', 7, 14],
      ['    summary: "\\x07"', 7, 14],
    ] as const;
    for (const [summaryLine, line, column] of cases) {
      const errors = errorsOf(
        lines(
          'version: 1',
          'locale: es',
          'classify:',
          '  money: ["lib/calc/**"]',
          'stages:',
          '  - id: a',
          summaryLine,
          '    nature: recompute',
          '    gate:',
          '      run: node a.mjs',
        ),
      );
      expect(errors).toContainEqual(at(line, column, /control characters are not allowed/));
      for (const error of errors) expect(error.message).not.toMatch(escapes);
    }
  });

  it('refuses a summary on several lines', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: |',
        '      Linea uno.',
        '      Linea dos.',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(5, 14, /control characters are not allowed/));
  });

  it('refuses control characters in a key, without echoing them', () => {
    const errors = errorsOf(lines('"bad\\x1b[2Jkey": 1', 'version: 1'));
    expect(errors).toContainEqual(at(1, 1, /control characters are not allowed/));
    for (const error of errors) expect(error.message).not.toMatch(escapes);
  });
});

describe('an absurd recipe is answered with a reason, never with a crash', () => {
  it('a deeply nested list', () => {
    const text = `x: ${'['.repeat(5000)}${']'.repeat(5000)}\n`;
    const result = parseRecipe(text, FILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ file: FILE, line: 1 });
  });

  it('a deeply nested map', () => {
    const text = `x: ${'{a: '.repeat(5000)}1${'}'.repeat(5000)}\n`;
    const result = parseRecipe(text, FILE);
    expect(result.ok).toBe(false);
  });
});

describe('what Windows editors write', () => {
  it('reads CRLF line endings with the same positions', () => {
    const text = stageWith('    colour: blue').replace(/\n/g, '\r\n');
    expect(errorsOf(text)).toContainEqual(at(9, 5, /unknown key "colour"/));
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parseRecipe(`﻿${stageWith()}`, FILE).ok).toBe(true);
  });
});

describe('status options', () => {
  const stages: StageConfig[] = [
    { name: 'spec', nature: 'structure', gate: () => ({ ok: true }) },
    { name: 'mutants', after: 'spec', nature: 'recompute', gate: () => ({ ok: true }) },
  ];

  it('reads --verbose as an option, not as a piece, when no piece is named', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: 'p1', state: 'done' }, undefined);
    const output = await runCommand(['status', '--verbose'], { config: { locale: 'es', stages }, store });
    expect(output.text).toContain('- p1');
    expect(output.text).not.toContain('--verbose');
  });

  it('trims a long skip reason to the terminal, and keeps it whole with --verbose', async () => {
    const store = createMemoryStore();
    const reason = `No aplica: ${'motivo largo '.repeat(20)}fin.`;
    await store.saveStatus({ piece: 'p1', state: 'done' }, undefined);
    await store.append('p1', { stage: 'mutants', outcome: 'skipped', reason, at: 1, runId: 'r1', pipeline: '[]' });
    const config = { locale: 'es', stages };

    const short = await runCommand(['status', 'p1'], { config, store });
    for (const line of short.text.split('\n')) expect(line.length).toBeLessThanOrEqual(120);

    const whole = await runCommand(['status', 'p1', '--verbose'], { config, store });
    expect(whole.text).toContain(`  - mutants — ${reason}`);
  });
});
