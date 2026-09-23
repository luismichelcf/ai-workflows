import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseRecipe, type Recipe, type RecipeError } from '../src/index.js';

// PLAN-13 §3.2 and RC-01/RC-02. The recipe is what the owner reads and what the engine obeys,
// so a recipe that could be read two ways is refused with the exact place to fix it: file,
// line and column. Positions are 1-based and counted by hand from the literal fixtures below.

const FILE = 'receta.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const TEMPLATE = readFileSync(new URL('../templates/pipeline.yml', import.meta.url), 'utf8');

function errorsOf(text: string): readonly RecipeError[] {
  const result = parseRecipe(text, FILE);
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, FILE);
  if (!result.ok) {
    const shown = result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n');
    throw new Error(`expected a valid recipe, got:\n${shown}`);
  }
  return result.recipe;
}

const at = (line: number, column: number, message: RegExp) =>
  expect.objectContaining({ file: FILE, line, column, message: expect.stringMatching(message) });

describe('RC-01: a recipe that could be read two ways is rejected with its place', () => {
  it('rejects a duplicated key at the second occurrence', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    summary: "Otra vez"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(6, 5, /duplicate key "summary"/));
  });

  it('rejects anchors and aliases where they are written: reuse is done with uses:', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        '  money: &paths ["lib/calc/**"]',
        '  security: *paths',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 10, /anchor/i));
    expect(errors).toContainEqual(at(5, 13, /alias/i));
  });

  it('rejects an unknown key inside a stage at the key', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    colour: blue',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(7, 5, /unknown key "colour"/));
  });

  it('rejects an unknown key at the top of the recipe', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stagse: []',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(3, 1, /unknown key "stagse"/));
  });

  it('rejects an after that names no stage, at the after value', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: b',
        '    summary: "Paso B"',
        '    after: ghost',
        '    nature: recompute',
        '    gate:',
        '      run: node b.mjs',
      ),
    );
    expect(errors).toContainEqual(at(11, 12, /stage "b" runs after unknown stage "ghost"/));
  });

  it('rejects two stages with the same after: the pipeline is a single line', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: b',
        '    summary: "Paso B"',
        '    after: a',
        '    nature: recompute',
        '    gate:',
        '      run: node b.mjs',
        '  - id: c',
        '    summary: "Paso C"',
        '    after: a',
        '    nature: recompute',
        '    gate:',
        '      run: node c.mjs',
      ),
    );
    expect(errors).toContainEqual(at(17, 12, /"b" and "c" both run after "a"/));
  });

  it('rejects a cycle at the first stage of the cycle in the file', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: b',
        '    summary: "Paso B"',
        '    after: c',
        '    nature: recompute',
        '    gate:',
        '      run: node b.mjs',
        '  - id: c',
        '    summary: "Paso C"',
        '    after: b',
        '    nature: recompute',
        '    gate:',
        '      run: node c.mjs',
      ),
    );
    expect(errors).toContainEqual(at(11, 12, /cycle.*"b".*"c"/));
  });

  it('rejects a repeated stage id at the second id', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: a',
        '    summary: "Otra A"',
        '    after: a',
        '    nature: recompute',
        '    gate:',
        '      run: node a2.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 9, /duplicate stage id "a"/));
  });

  it('rejects a second stage without after at its id', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: c',
        '    summary: "Paso C"',
        '    nature: recompute',
        '    gate:',
        '      run: node c.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 9, /"a" and "c" both have no "after"/));
  });

  it('names the file it was given on every error', () => {
    const result = parseRecipe(lines('version: 2', 'locale: es', 'stages: []'), 'otra/ruta.yml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) expect(error.file).toBe('otra/ruta.yml');
  });

  it('positive: the example recipe of init is valid', () => {
    const recipe = recipeOf(TEMPLATE);
    expect(recipe.stages.map((stage) => stage.id)).toEqual([
      'spec',
      'red-test',
      'implementation',
      'checks',
      'review',
      'owner-approval',
      'merge',
      'after-merge',
      'cleanup',
    ]);
  });
});

describe('RC-02: YAML 1.2 keeps words as words', () => {
  it('keeps NO, no, on, off and yes as text wherever text is expected', () => {
    const recipe = recipeOf(
      lines(
        'version: 1',
        'locale: no',
        'owner: yes',
        'classify:',
        '  on: ["NO"]',
        'kinds:',
        '  names: [feature, fix]',
        '  default: feature',
        'lanes:',
        '  off: [feature]',
        '  y: [fix]',
        'stages:',
        '  - id: a',
        '    summary: NO',
        '    nature: recompute',
        '    applies-if: { touches-any: [on], lane-any: [off, y] }',
        '    gate:',
        '      run: node a.mjs',
        '      with: { flag: on, answer: no, count: 3 }',
        '  - id: merge',
        '    summary: "Se une a la versión principal"',
        '    after: a',
        '    phase: merge',
        '    nature: recompute',
        '    gate:',
        '      run: node m.mjs',
      ),
    );
    expect(recipe.locale).toBe('no');
    expect(recipe.owner).toBe('yes');
    expect(recipe.classify).toEqual({ on: ['NO'] });
    const [stage] = recipe.stages;
    expect(stage?.summary).toBe('NO');
    expect(stage?.appliesIf).toEqual({ touchesAny: ['on'], laneAny: ['off', 'y'] });
    expect(stage?.gate).toEqual({ run: 'node a.mjs', with: { flag: 'on', answer: 'no', count: 3 } });
  });

  it('does not turn yes into true where a yes/no answer is expected', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    required: yes',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(7, 15, /"required" must be true or false/));
  });

  it('does not turn a number into text where text is expected', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: 9.3',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(5, 14, /"summary" must be a string/));
  });
});

describe('what a valid recipe reads as', () => {
  it('fills the defaults a stage may omit, validity same-sha included, when not written', () => {
    const recipe = recipeOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
        '  - id: merge',
        '    summary: "Se une a la versión principal"',
        '    after: a',
        '    phase: merge',
        '    nature: recompute',
        '    gate:',
        '      run: node m.mjs',
      ),
    );
    expect(recipe.version).toBe(1);
    expect(recipe.owner).toBeUndefined();
    expect(recipe.classify).toEqual({});
    expect(recipe.kinds).toBeUndefined();
    expect(recipe.stages).toEqual([
      {
        id: 'a',
        summary: 'Paso A',
        phase: 'pre-merge',
        required: true,
        needsHuman: false,
        nature: 'recompute',
        validWhile: 'same-sha',
        gate: { run: 'node a.mjs' },
      },
      {
        id: 'merge',
        summary: 'Se une a la versión principal',
        after: 'a',
        phase: 'merge',
        required: true,
        needsHuman: false,
        nature: 'recompute',
        validWhile: 'same-sha',
        gate: { run: 'node m.mjs' },
      },
    ]);
  });

  it('reads every field of the example recipe in camelCase', () => {
    const recipe = recipeOf(TEMPLATE);
    expect(recipe.locale).toBe('es');
    expect(recipe.owner).toBe('tu-cuenta-de-github');
    expect(recipe.classify).toEqual({
      security: ['**/*auth*', '**/*permission*'],
      visible: ['app/**', 'components/**', 'public/**'],
      production: ['.github/workflows/**'],
    });
    expect(recipe.kinds).toEqual({
      names: ['behavior', 'docs'],
      default: 'behavior',
      fromPaths: { docs: ['docs/**', '**/*.md'] },
      elevate: [{ when: { touchesAny: ['security'], kindNone: ['behavior'] }, to: 'behavior' }],
    });
    expect(recipe.labels).toEqual({
      security: 'seguridad y permisos',
      visible: 'lo que se ve',
      production: 'producción',
      behavior: 'comportamiento',
      docs: 'documentación',
    });

    const byId = new Map(recipe.stages.map((stage) => [stage.id, stage]));
    expect(byId.get('spec')).toEqual({
      id: 'spec',
      summary: 'Un plan escrito con el resumen de tres líneas y criterios con identificador',
      phase: 'pre-merge',
      required: true,
      needsHuman: false,
      nature: 'structure',
      validWhile: 'same-sha',
      gate: {
        uses: 'ai-workflows/spec-structure@1',
        with: {
          file: 'docs/plans/PLAN-{piece}.md',
          sections: ['En tres líneas', 'Casos de aceptación'],
        },
      },
      server: 'recompute',
    });
    expect(byId.get('red-test')?.server).toEqual({ requireCheck: 'ai-workflows/red-test' });
    expect(byId.get('red-test')?.after).toBe('spec');
    expect(byId.get('red-test')?.appliesIf).toEqual({ kindAny: ['behavior'] });
    expect(byId.get('red-test')?.validWhile).toBe('forever');
    expect(byId.get('owner-approval')?.needsHuman).toBe(true);
    expect(byId.get('owner-approval')?.validWhile).toBe('same-fingerprint');
    expect(byId.get('owner-approval')?.gate).toEqual({
      uses: 'ai-workflows/approval-comment@1',
      with: { command: '/approve' },
    });
    expect(byId.get('merge')?.phase).toBe('merge');
    expect(byId.get('cleanup')?.phase).toBe('post-merge');
    expect(byId.get('cleanup')?.retry).toEqual({ attempts: 3, waitSeconds: 30 });
    expect(byId.get('cleanup')?.server).toBe('local-only');
  });
});

describe('shape of each field', () => {
  const oneStage = (...extra: string[]) =>
    lines(
      'version: 1',
      'locale: es',
      'classify:',
      '  money: ["lib/calc/**"]',
      'stages:',
      '  - id: a',
      '    summary: "Paso A"',
      ...extra,
    );

  it('accepts only version 1', () => {
    const errors = errorsOf(lines('version: 2', 'locale: es', 'stages: []'));
    expect(errors).toContainEqual(at(1, 10, /"version" must be 1/));
  });

  it('refuses a recipe with no stages', () => {
    const errors = errorsOf(lines('version: 1', 'locale: es', 'stages: []'));
    expect(errors).toContainEqual(at(3, 9, /"stages"/));
  });

  it('refuses a stage without summary at the stage', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 5, /missing required key "summary"/));
  });

  it('refuses a nature outside the four', () => {
    const errors = errorsOf(oneStage('    nature: judge', '    gate:', '      run: node a.mjs'));
    expect(errors).toContainEqual(
      at(8, 13, /"nature" must be one of: recompute, structure, execution-record, attest/),
    );
  });

  it('refuses a stage id that is not a lowercase word with dashes', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: Red_Test',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 9, /"id"/));
  });

  it('refuses a gate with both uses and run, at the gate', () => {
    const errors = errorsOf(
      oneStage('    nature: recompute', '    gate:', '      uses: ai-workflows/command@1', '      run: node a.mjs'),
    );
    expect(errors).toContainEqual(at(10, 7, /exactly one of "uses" or "run"/));
  });

  it('refuses a gate with neither uses nor run', () => {
    const errors = errorsOf(oneStage('    nature: recompute', '    gate:', '      with: { a: 1 }'));
    expect(errors).toContainEqual(at(10, 7, /exactly one of "uses" or "run"/));
  });

  it('refuses a uses that is neither an engine block nor a project block', () => {
    const errors = errorsOf(oneStage('    nature: recompute', '    gate:', '      uses: red-test'));
    expect(errors).toContainEqual(at(10, 13, /"uses"/));
  });

  it('accepts engine blocks with a major version and project blocks by folder', () => {
    recipeOf(oneStage('    nature: recompute', '    phase: merge', '    gate:', '      uses: ai-workflows/red-test@12'));
    recipeOf(oneStage('    nature: recompute', '    phase: merge', '    gate:', '      uses: ./.ai-workflows/blocks/fila'));
  });

  it('refuses a condition over a class that classify does not declare', () => {
    const errors = errorsOf(
      oneStage(
        '    nature: recompute',
        '    applies-if: { touches-any: [moneyy] }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 33, /unknown class "moneyy"/));
  });

  it('refuses an elevation over a class that classify does not declare', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        '  money: ["lib/calc/**"]',
        'kinds:',
        '  names: [behavior]',
        '  default: behavior',
        '  elevate:',
        '    - when: { touches-any: [security] }',
        '      to: behavior',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 29, /unknown class "security"/));
  });

  it('refuses an empty condition', () => {
    const errors = errorsOf(
      oneStage('    nature: recompute', '    applies-if: {}', '    gate:', '      run: node a.mjs'),
    );
    expect(errors).toContainEqual(at(9, 17, /at least one of/));
  });

  it('refuses an unknown condition word', () => {
    const errors = errorsOf(
      oneStage(
        '    nature: recompute',
        '    applies-if: { touches-all: [money] }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 19, /unknown key "touches-all"/));
  });

  it('refuses a repeated value in a condition list', () => {
    const errors = errorsOf(
      oneStage(
        '    nature: recompute',
        '    applies-if: { touches-any: [money, money] }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(9, 40, /"touches-any" must not repeat values/));
  });

  it('refuses glob syntax the engine does not support', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'classify:',
        '  money: ["lib/{a,b}/**"]',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(4, 11, /unsupported glob "lib\/\{a,b\}\/\*\*"/));
  });

  it('refuses a phase, a validity or a server outside their lists', () => {
    const phase = errorsOf(
      oneStage('    nature: recompute', '    phase: later', '    gate:', '      run: node a.mjs'),
    );
    expect(phase).toContainEqual(at(9, 12, /"phase" must be one of: pre-merge, merge, post-merge/));

    const validity = errorsOf(
      oneStage('    nature: recompute', '    valid-while: always', '    gate:', '      run: node a.mjs'),
    );
    expect(validity).toContainEqual(
      at(9, 18, /"valid-while" must be one of: same-sha, same-fingerprint, same-fingerprint-or-clean-update, forever/),
    );

    const server = errorsOf(
      oneStage('    nature: recompute', '    server: trust-me', '    gate:', '      run: node a.mjs'),
    );
    expect(server).toContainEqual(at(9, 13, /"server"/));
  });

  it('bounds retries: at most 5 attempts and one hour of wait', () => {
    const attempts = errorsOf(
      oneStage('    nature: recompute', '    retry: { attempts: 9 }', '    gate:', '      run: node a.mjs'),
    );
    expect(attempts).toContainEqual(at(9, 24, /"attempts"/));

    const wait = errorsOf(
      oneStage(
        '    nature: recompute',
        '    retry: { attempts: 2, wait-seconds: 3601 }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(wait).toContainEqual(at(9, 41, /"wait-seconds"/));
  });

  it('refuses explicit tags', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: !!str "Paso A"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(5, 14, /tags are not allowed/));
  });

  it('refuses an anchor or a tag on the whole document, not only inside it', () => {
    const body = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: a',
      '    summary: "Paso A"',
      '    nature: recompute',
      '    gate:',
      '      run: node a.mjs',
    ];
    expect(errorsOf(lines('&whole', ...body))).toContainEqual(at(1, 1, /anchor/i));
    expect(errorsOf(lines('--- &whole', ...body))).toContainEqual(at(1, 5, /anchor/i));
    expect(errorsOf(lines('--- !!map', ...body))).toContainEqual(at(1, 5, /tags are not allowed/));
  });

  it('names a duplicated quoted key without its quotes', () => {
    const errors = errorsOf(
      lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: a',
        '    summary: "Paso A"',
        '    "summary": "Otra vez"',
        '    nature: recompute',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(errors).toContainEqual(at(6, 5, /^duplicate key "summary"$/));
  });

  it('says a stage that is not a map is a stage, not the list', () => {
    const errors = errorsOf(lines('version: 1', 'locale: es', 'stages:', '  - hola'));
    expect(errors).toContainEqual(at(4, 5, /^each stage must be a map$/));
  });

  it('refuses more than one document in the file', () => {
    const errors = errorsOf(lines('version: 1', '---', 'locale: es'));
    expect(errors).toContainEqual(at(2, 1, /one document/));
  });

  it('refuses an empty file at its first position', () => {
    expect(errorsOf('')).toContainEqual(at(1, 1, /empty/));
    expect(errorsOf('# solo un comentario\n')).toContainEqual(at(1, 1, /empty/));
  });

  it('reports broken YAML as invalid YAML with its place', () => {
    const errors = errorsOf(lines('version: 1', 'locale: [es'));
    expect(errors.some((e) => e.file === FILE && /^invalid YAML/.test(e.message))).toBe(true);
  });
});
