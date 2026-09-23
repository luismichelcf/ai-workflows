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
    '    phase: merge',
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

describe('one problem never hides another', () => {
  it('reports an anchor and a non-text key together', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        '  money: &m ["lib/**"]',
        '  1: ["a/**"]',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 10, /anchor/));
    expect(errors).toContainEqual(at(5, 3, /keys must be text/));
  });

  it('reports a duplicated key and a non-text key together', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'owner: a',
        'owner: b',
        '1: x',
        'stages: []',
      ),
    );
    expect(errors).toContainEqual(at(4, 1, /duplicate key "owner"/));
    expect(errors).toContainEqual(at(5, 1, /keys must be text/));
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
        '    phase: merge',
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
        '  names: [behavior, docs]',
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
    expect(errors).toContainEqual(at(7, 12, /^unsupported glob "\.\/docs\/\*\*"/));
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

  it('a realistic recipe against a large pull request of long paths', () => {
    const classify: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) {
      classify[`c${i}`] = [`lib/m${i}/**`, `**/*n${i}*`, `app/**/*.x${i}`, `docs/**/*-${i}.md`, `k${i}/*/*.ts`];
    }
    const files = Array.from({ length: 3000 }, (_, i) => `src/${'a'.repeat(2000)}/f${i}.ts`);
    const started = performance.now();
    expect(classifyFiles(classify, files)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(6000);
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

describe('nothing in any error or explanation can steer the terminal or reorder what it shows', () => {
  // C0, DEL, C1, the bidirectional controls and the line/paragraph separators.
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

  it('never echoes control characters from a second document', () => {
    const result = parseRecipe('version: 1\n---\n"\\x1b[2J": 1\n"\\x1b[2J": 2\n', FILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const error of result.errors) expect(error.message).not.toMatch(unsafe);
  });

  it('refuses bidirectional and separator characters in text, without echoing them', () => {
    for (const [line, escape] of [
      ['    summary: "abc\\u202Edef"', '\u202e'],
      ['    summary: "abc\\u2028def"', '\u2028'],
      ['    summary: "abc\\u2066def"', '\u2066'],
    ] as const) {
      const errors = errorsOf(
        lines(
          'version: 1',
          'locale: es',
          'stages:',
          '  - id: a',
          line,
          '    nature: recompute',
          '    gate:',
          '      run: node a.mjs',
        ),
      );
      expect(errors).toContainEqual(at(5, 14, /characters are not allowed/));
      for (const error of errors) expect(error.message).not.toContain(escape);
    }
  });

  it('refuses a bidirectional character in a key, without echoing it', () => {
    const errors = errorsOf(lines('"\\u202Eevil": 1', 'version: 1'));
    expect(errors).toContainEqual(at(1, 1, /characters are not allowed/));
    for (const error of errors) expect(error.message).not.toMatch(unsafe);
  });

  it('never echoes unsafe characters from a YAML library message', () => {
    const result = parseRecipe('%FOO\u202e bar\n---\nversion: 1\n', FILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const error of result.errors) expect(error.message).not.toMatch(unsafe);
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

// Built from code points so no editor or tool can turn them into the raw characters.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ESC = cp(0x1b);
const RLO = cp(0x202e);
const BEL = cp(0x07);

/** Every line a person reads must be free of controls, format characters and separators. */
const unsafeLine = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

describe('status never passes on what a piece declares about itself', () => {
  const recipeStages = (): StageConfig[] => {
    const parsed = parseRecipe(
      lines(
        'version: 1',
        'locale: es',
        'kinds:',
        '  names: [behavior]',
        '  default: behavior',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: b',
        '    summary: "Solo para comportamiento"',
        '    after: a',
        '    nature: recompute',
        '    applies-if: { kind-any: [behavior] }',
        '    gate:',
        '      run: node b.mjs',
        '  - id: merge',
        '    summary: "Se une a la versión principal"',
        '    after: b',
        '    phase: merge',
        '    nature: recompute',
        '    gate:',
        '      run: node m.mjs',
      ),
      FILE,
    );
    if (!parsed.ok) throw new Error('fixture must be valid');
    return parsed.recipe.stages.map((stage) => {
      const appliesWhen = appliesIfFor(parsed.recipe, stage.id);
      return {
        name: stage.id,
        summary: stage.summary,
        nature: stage.nature,
        ...(stage.after === undefined ? {} : { after: stage.after }),
        ...(appliesWhen === undefined ? {} : { appliesWhen }),
        gate: () => ({ ok: true }),
      };
    });
  };

  it('neutralises controls and direction marks in a skip reason built from the declared kind', async () => {
    const store = createMemoryStore();
    const config = { locale: 'es', stages: recipeStages() };
    const kind = `x${ESC}[2J${ESC}]0;pwned${BEL}${RLO}roivaheb\n  - Revisión — aprobada`;
    const { createEngine } = await import('../src/index.js');
    const engine = createEngine({ config, store, describeChange: () => ({ files: [], kind }) });
    await engine.run('p1');

    const output = await runCommand(['status', 'p1'], { config, store });
    const shown = output.text.split('\n');
    for (const line of shown) expect(line).not.toMatch(unsafeLine);
    expect(shown).not.toContain('  - Revisión — aprobada');
    expect(output.text).toContain('Pasos omitidos');
  });

  it('neutralises them in the reason of the piece line too', async () => {
    const store = createMemoryStore();
    await store.saveStatus(
      { piece: 'p1', state: 'blocked:technical', stage: 'a', reason: `fallo${ESC}[2J${RLO}\nfalso` },
      undefined,
    );
    const output = await runCommand(['status', 'p1'], { config: { locale: 'es', stages: recipeStages() }, store });
    for (const line of output.text.split('\n')) expect(line).not.toMatch(unsafeLine);
    expect(output.text.split('\n')).not.toContain('falso');

    const all = await runCommand(['status'], { config: { locale: 'es', stages: recipeStages() }, store });
    for (const line of all.text.split('\n')) expect(line).not.toMatch(unsafeLine);
  });
});

describe('invisible and look-alike characters never reach a recipe', () => {
  const withSummary = (summary: string) =>
    lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: a',
      `    summary: ${JSON.stringify(summary)}`,
      '    nature: recompute',
      '    phase: merge',
      '    gate:',
      '      run: node a.mjs',
    );

  for (const [name, code] of [
    ['zero width space', 0x200b],
    ['byte order mark inside text', 0xfeff],
    ['word joiner', 0x2060],
    ['soft hyphen', 0x00ad],
    ['interlinear annotation', 0xfff9],
    ['tag character', 0xe0041],
  ] as const) {
    it(`refuses a ${name} in text`, () => {
      const errors = errorsOf(withSummary(`Paso${cp(code)}A`));
      expect(errors).toContainEqual(at(5, 14, /characters are not allowed/));
      for (const error of errors) expect(error.message).not.toMatch(unsafeLine);
    });
  }

  it('refuses a full-width slash that only looks like a folder separator in a glob', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        `  money: ["lib/pay${cp(0xff0f)}x/**"]`,
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 11, /^unsupported glob /));
  });

  it('positive: accents and spaces are ordinary text', () => {
    expect(parseRecipe(withSummary('Revisión del cálculo de nómina'), FILE).ok).toBe(true);
  });
});

describe('each problem is reported once', () => {
  it('never repeats the same error at the same place', () => {
    for (const text of ['a: [[\n', `a: 1\n---\n${'['.repeat(70)}\n`, '? : v\n']) {
      const result = parseRecipe(text, FILE);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const seen = result.errors.map((e) => `${e.line}:${e.column}:${e.message}`);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });
});
