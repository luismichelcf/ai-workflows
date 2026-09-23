import { describe, expect, it } from 'vitest';

import {
  appliesIfFor,
  explainRecipe,
  parseRecipe,
  type GateContext,
  type Recipe,
  type RecipeError,
} from '../src/index.js';

// PLAN-13 R14, R15, R16 and the `validate` rules that PLAN-13-R2 §1.3 and §1.4 bring into
// slice 2 (RC-08). Every rejection names the place to fix it. Positions are 1-based; the
// `place` helper finds the literal token in the literal fixture row, it never asks the code.

const FILE = 'receta.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

/** A recipe that exercises every word of the vocabulary. Rows are replaced one at a time. */
const BASE = [
  'version: 1', //                                                    1
  'locale: es', //                                                    2
  'classify:', //                                                     3
  '  security: ["**/*auth*"]', //                                     4
  '  visible: ["app/**"]', //                                         5
  'kinds:', //                                                        6
  '  names: [behavior, visual-only, docs]', //                        7
  '  default: behavior', //                                           8
  '  from-paths:', //                                                 9
  '    docs: ["docs/**"]', //                                        10
  '  elevate:', //                                                   11
  '    - when: { touches-any: [security], kind-any: [visual-only] }', // 12
  '      to: behavior', //                                           13
  'lanes:', //                                                       14
  '  full: [behavior]', //                                           15
  '  light: [visual-only, docs]', //                                 16
  'labels:', //                                                      17
  '  security: "permisos y datos"', //                               18
  '  behavior: "comportamiento"', //                                 19
  '  full: "completo"', //                                           20
  'stages:', //                                                      21
  '  - id: tests', //                                                22
  '    summary: "Pruebas en verde"', //                              23
  '    nature: recompute', //                                        24
  '    applies-if: { kind-any: [behavior], lane-any: [full] }', //   25
  '    gate:', //                                                    26
  '      run: node t.mjs', //                                        27
  '  - id: merge', //                                                28
  '    summary: "Se une a la versión principal"', //                 29
  '    after: tests', //                                             30
  '    phase: merge', //                                             31
  '    nature: recompute', //                                        32
  '    gate:', //                                                    33
  '      run: node m.mjs', //                                        34
];

/** BASE with row `row` (1-based) replaced by `text`; `null` deletes it. */
function withRow(rows: readonly string[], row: number, text: string | null): string[] {
  const copy = [...rows];
  if (text === null) copy.splice(row - 1, 1);
  else copy[row - 1] = text;
  return copy;
}

/** Rows appended after BASE, for stages that follow the merge. */
const after = (...extra: string[]): string[] => [...BASE, ...extra];

function errorsOf(rows: readonly string[]): readonly RecipeError[] {
  const result = parseRecipe(lines(...rows), FILE);
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

function recipeOf(rows: readonly string[]): Recipe {
  const result = parseRecipe(lines(...rows), FILE);
  if (!result.ok) {
    const shown = result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n');
    throw new Error(`expected a valid recipe, got:\n${shown}`);
  }
  return result.recipe;
}

/** The place of the `occurrence`-th `token` in row `row` of `rows`. */
function place(rows: readonly string[], row: number, token: string, occurrence = 1) {
  const text = rows[row - 1] ?? '';
  let index = -1;
  for (let found = 0; found < occurrence; found += 1) {
    index = text.indexOf(token, index + 1);
    if (index < 0) throw new Error(`fixture: "${token}" not found in row ${row}`);
  }
  return { line: row, column: index + 1 };
}

const at = (where: { line: number; column: number }, message: RegExp) =>
  expect.objectContaining({ file: FILE, ...where, message: expect.stringMatching(message) });

describe('R15: the recipe declares its kinds and lanes once', () => {
  it('positive: a recipe that uses only declared words is valid and reads them', () => {
    const recipe = recipeOf(BASE);
    expect(recipe.kinds?.names).toEqual(['behavior', 'visual-only', 'docs']);
    expect(recipe.lanes).toEqual({ full: ['behavior'], light: ['visual-only', 'docs'] });
    expect(recipe.labels).toEqual({
      security: 'permisos y datos',
      behavior: 'comportamiento',
      full: 'completo',
    });
  });

  it('requires kinds.names whenever there is a kinds section', () => {
    const rows = withRow(BASE, 7, null);
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 7, 'default'), /missing required key "names"/));
  });

  it('rejects a misspelt kind in kind-any, where it is written', () => {
    const rows = withRow(BASE, 25, '    applies-if: { kind-any: [behaviour], lane-any: [full] }');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 25, 'behaviour'), /unknown kind "behaviour"/));
  });

  it('rejects an undeclared kind in kind-none', () => {
    const rows = withRow(BASE, 25, '    applies-if: { kind-none: [prototype] }');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 25, 'prototype'), /unknown kind "prototype"/));
  });

  it('rejects an undeclared default kind', () => {
    const rows = withRow(BASE, 8, '  default: feature');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 8, 'feature'), /unknown kind "feature"/));
  });

  it('rejects an undeclared kind as a from-paths key', () => {
    const rows = withRow(BASE, 10, '    papers: ["docs/**"]');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 10, 'papers'), /unknown kind "papers"/));
  });

  it('rejects an undeclared kind in elevate, both in when and in to', () => {
    const rows = withRow(
      withRow(BASE, 12, '    - when: { touches-any: [security], kind-any: [visual] }'),
      13,
      '      to: feature',
    );
    const errors = errorsOf(rows);
    expect(errors).toContainEqual(at(place(rows, 12, 'visual'), /unknown kind "visual"/));
    expect(errors).toContainEqual(at(place(rows, 13, 'feature'), /unknown kind "feature"/));
  });

  it('rejects kind-any when the recipe declares no kinds at all', () => {
    const rows = withRow(
      [...BASE.slice(0, 5), ...BASE.slice(16)],
      25 - 11,
      '    applies-if: { kind-any: [behavior] }',
    );
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 14, 'behavior'), /unknown kind "behavior"/));
  });

  it('rejects an undeclared lane in lane-any', () => {
    const rows = withRow(BASE, 25, '    applies-if: { lane-any: [fast] }');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 25, 'fast'), /unknown lane "fast"/));
  });

  it('rejects lane-any when the recipe declares no lanes', () => {
    const rows = [...BASE.slice(0, 13), ...BASE.slice(16)].map((row) =>
      row === '  full: "completo"' ? '  visible: "lo que se ve"' : row,
    );
    const row = rows.indexOf('    applies-if: { kind-any: [behavior], lane-any: [full] }') + 1;
    expect(errorsOf(rows)).toContainEqual(at(place(rows, row, 'full'), /unknown lane "full"/));
  });

  it('rejects a lane that lists an undeclared kind', () => {
    const rows = withRow(BASE, 16, '  light: [visual-only, docs, prototype]');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 16, 'prototype'), /unknown kind "prototype"/));
  });

  it('rejects a kind placed in two lanes, at its second place', () => {
    const rows = withRow(BASE, 15, '  full: [behavior, docs]');
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 16, 'docs'), /kind "docs" is in lanes "full" and "light"/),
    );
  });

  it('rejects a declared kind that no lane holds, at the lanes', () => {
    const rows = withRow(BASE, 16, '  light: [visual-only]');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 15, 'full'), /kind "docs" has no lane/));
  });
});

describe('R16: names in the owner language', () => {
  it('rejects a label for a name the recipe does not declare, at the label', () => {
    const rows = withRow(BASE, 20, '  money: "dinero"');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 20, 'money'), /unknown name "money" in labels/));
  });

  it('rejects an empty label', () => {
    const rows = withRow(BASE, 20, '  full: ""');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 20, '""'), /must not be empty/));
  });

  it('positive: a class and a kind may share a name and one label', () => {
    const rows = [
      ...withRow(BASE, 4, '  docs: ["docs/**"]'),
    ].map((row) => (row === '  security: "permisos y datos"' ? '  docs: "papeles"' : row))
      .map((row) => row.replace('touches-any: [security]', 'touches-any: [docs]'));
    expect(recipeOf(rows).labels).toMatchObject({ docs: 'papeles' });
  });

  it('explain uses the label where there is one and the word where there is none', () => {
    const rows = withRow(BASE, 25, '    applies-if: { touches-any: [security, visible], kind-any: [behavior], lane-any: [full] }');
    const text = explainRecipe(recipeOf(rows));
    expect(text).toContain(
      '   Cuándo: solo si el cambio toca «permisos y datos» o «visible» y el tipo de cambio es «comportamiento» y el carril es «completo».',
    );
  });

  it('the motive of a skipped stage uses the label too', async () => {
    const recipe = recipeOf(BASE);
    const appliesWhen = appliesIfFor(recipe, 'tests');
    if (appliesWhen === undefined) throw new Error('expected a condition');
    const context = { change: { files: ['docs/a.md'], kind: 'docs', lane: 'light' } } as unknown as GateContext;
    expect(await appliesWhen(context)).toEqual({
      skip: 'No aplica: el tipo de cambio es «docs», no «comportamiento».',
    });
  });
});

describe('R14: a stage that does not say how long its evidence lasts', () => {
  it('reads as same-sha', () => {
    expect(recipeOf(BASE).stages.map((stage) => stage.validWhile)).toEqual(['same-sha', 'same-sha']);
  });

  it('keeps what the stage writes', () => {
    const rows = withRow(BASE, 24, '    nature: recompute\n    valid-while: forever');
    expect(recipeOf(rows.join('\n').split('\n')).stages[0]?.validWhile).toBe('forever');
  });

  const validity = (value: string, locale: string): string => {
    const rows = withRow(withRow(BASE, 2, `locale: ${locale}`), 24, `    nature: recompute\n    valid-while: ${value}`);
    return explainRecipe(recipeOf(rows.join('\n').split('\n')));
  };

  it('explain says in plain words how long each step stays valid, in Spanish', () => {
    expect(validity('same-sha', 'es')).toContain('   Vale mientras el código no cambie.');
    expect(validity('same-fingerprint', 'es')).toContain(
      '   Vale mientras los cambios propios de la pieza sigan iguales.',
    );
    expect(validity('same-fingerprint-or-clean-update', 'es')).toContain(
      '   Vale mientras el código no cambie, salvo por actualizaciones sin conflictos con la versión principal.',
    );
    expect(validity('forever', 'es')).toContain('   Vale siempre, una vez cumplido.');
  });

  it('and in English', () => {
    expect(validity('same-sha', 'en')).toContain('   Valid while the code does not change.');
    expect(validity('same-fingerprint', 'en')).toContain(
      "   Valid while the piece's own changes stay the same.",
    );
    expect(validity('same-fingerprint-or-clean-update', 'en')).toContain(
      '   Valid while the code does not change, except for conflict-free updates from the main line.',
    );
    expect(validity('forever', 'en')).toContain('   Valid for good once met.');
  });

  it('puts the validity line right after the when line', () => {
    const shown = explainRecipe(recipeOf(BASE)).split('\n');
    const when = shown.findIndex((row) => row.startsWith('   Cuándo:'));
    expect(shown[when + 1]).toBe('   Vale mientras el código no cambie.');
  });
});

describe('RC-08: exactly one stage joins the main line, in its place', () => {
  it('rejects a recipe with no merge stage, at the stages list', () => {
    const rows = BASE.slice(0, 27);
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 22, '-'), /exactly one stage must have phase: merge; found none/),
    );
  });

  it('rejects a second merge stage, at its phase', () => {
    const rows = after(
      '  - id: merge-again',
      '    summary: "Otra vez"',
      '    after: merge',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m2.mjs',
    );
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 38, 'merge'), /only one stage may have phase: merge; "merge" already does/),
    );
  });

  it('rejects a pre-merge stage placed after the merge, at its id', () => {
    const rows = after(
      '  - id: late',
      '    summary: "Tarde"',
      '    after: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node l.mjs',
    );
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 35, 'late'), /stage "late" is pre-merge but comes after the merge stage "merge"/),
    );
  });

  it('rejects a post-merge stage placed before the merge, at its phase', () => {
    const rows = withRow(BASE, 24, '    phase: post-merge\n    nature: recompute').join('\n').split('\n');
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 24, 'post-merge'), /stage "tests" is post-merge but comes before the merge stage "merge"/),
    );
  });

  it('positive: a post-merge stage after the merge is valid', () => {
    const rows = after(
      '  - id: cleanup',
      '    summary: "Limpieza"',
      '    after: merge',
      '    phase: post-merge',
      '    nature: recompute',
      '    gate:',
      '      run: node c.mjs',
    );
    expect(recipeOf(rows).stages).toHaveLength(3);
  });
});

describe('RC-08: server: local-only never guards a required step before the merge', () => {
  it('rejects it on a required pre-merge stage, at the value', () => {
    const rows = withRow(BASE, 24, '    nature: recompute\n    server: local-only').join('\n').split('\n');
    expect(errorsOf(rows)).toContainEqual(
      at(place(rows, 25, 'local-only'), /local-only is only allowed in post-merge stages or with required: false/),
    );
  });

  it('positive: on a post-merge stage', () => {
    const rows = after(
      '  - id: cleanup',
      '    summary: "Limpieza"',
      '    after: merge',
      '    phase: post-merge',
      '    nature: recompute',
      '    server: local-only',
      '    gate:',
      '      run: node c.mjs',
    );
    expect(recipeOf(rows).stages[2]?.server).toBe('local-only');
  });

  it('positive: on an optional pre-merge stage', () => {
    const rows = withRow(BASE, 24, '    nature: recompute\n    required: false\n    server: local-only')
      .join('\n')
      .split('\n');
    expect(recipeOf(rows).stages[0]?.server).toBe('local-only');
  });
});

describe('RC-08: a command (run:) can only recompute or check structure', () => {
  for (const nature of ['attest', 'execution-record']) {
    it(`rejects run: declared ${nature}, at the nature`, () => {
      const rows = withRow(BASE, 24, `    nature: ${nature}`);
      expect(errorsOf(rows)).toContainEqual(
        at(place(rows, 24, nature), /a command \(run:\) can only be recompute or structure/),
      );
    });
  }

  it('positive: run: declared structure', () => {
    expect(recipeOf(withRow(BASE, 24, '    nature: structure')).stages[0]?.nature).toBe('structure');
  });
});

describe('§1.4: a command line is never read by a shell', () => {
  const forbidden = ['"', "'", '$', '`', '|', ';', '&', '<', '>', '(', ')', '*', '?', '~'];
  for (const character of forbidden) {
    it(`rejects ${character} in run:, at the command`, () => {
      const rows = withRow(BASE, 27, `      run: node t.mjs a${character}b`);
      expect(errorsOf(rows)).toContainEqual(
        at(place(rows, 27, 'node'), /cannot contain shell characters/),
      );
    });
  }

  it('rejects {tests} glued to other text: it must be a whole argument', () => {
    const rows = withRow(BASE, 27, '      run: node t.mjs --files={tests}');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 27, 'node'), /"\{tests\}" must be a whole argument/));
  });

  it('rejects a placeholder the engine does not know', () => {
    const rows = withRow(BASE, 27, '      run: node t.mjs {branch}');
    expect(errorsOf(rows)).toContainEqual(at(place(rows, 27, 'node'), /unknown placeholder "\{branch\}"/));
  });

  it('positive: {tests} as an argument and {piece} inside one', () => {
    const rows = withRow(BASE, 27, '      run: node t.mjs {tests} --piece={piece}');
    expect(recipeOf(rows).stages[0]?.gate.run).toBe('node t.mjs {tests} --piece={piece}');
  });
});
