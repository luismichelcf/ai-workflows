import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { explainRecipe, parseRecipe, type Recipe } from '../src/index.js';

// PLAN-13 §3.5 and RC-05: `explain` is what the owner reads. It lists every step in order, in
// the recipe's language, saying when each one applies and what happens if it is not met —
// without block names, stage ids or any word from the default banned list.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const TEMPLATE = readFileSync(new URL('../templates/pipeline.yml', import.meta.url), 'utf8');

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

// Written out here, not imported: the test must not trust the list it is checking against.
const BANNED = [
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
const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const bannedIn = (text: string) =>
  BANNED.filter((term) =>
    new RegExp(`(^|[^a-z0-9])${term.replace(/ /g, '\\s+')}([^a-z0-9]|$)`).test(plain(text)),
  );

const EXPECTED_TEMPLATE_ES = [
  'Proceso de este proyecto: 9 pasos, en este orden.',
  '',
  'Antes de fusionar',
  '1. Un plan escrito con el resumen de tres líneas y criterios con identificador.',
  '   Cuándo: siempre.',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '2. Primero una prueba que falla por la razón correcta.',
  '   Cuándo: solo si el tipo de cambio es «behavior».',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '3. La prueba pasa y vuelve a fallar si se retira solo el código nuevo.',
  '   Cuándo: solo si el tipo de cambio es «behavior».',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '4. Tipos y todas las pruebas en verde.',
  '   Cuándo: siempre.',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '5. Revisores independientes aprueban el cambio final.',
  '   Cuándo: solo si el cambio toca «security» o «production».',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '6. El dueño aprueba lo que se ve.',
  '   Cuándo: solo si el cambio toca «visible».',
  '   Si falta: la pieza espera tu decisión; las demás siguen.',
  '',
  'Al fusionar',
  '7. Entra a la cola de GitHub y la observa hasta el final.',
  '   Cuándo: siempre.',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '',
  'Después de fusionar',
  '8. Lo publicado queda en verde.',
  '   Cuándo: siempre.',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '9. Se limpia la carpeta de trabajo y se liberan las reservas de la pieza.',
  '   Cuándo: siempre.',
  '   Si no se cumple: la pieza se detiene hasta corregirlo.',
  '   Se intenta hasta 3 veces, con 30 segundos entre intentos.',
].join('\n');

describe('RC-05: explain on the example recipe', () => {
  it('reads every step in order, in Spanish', () => {
    expect(explainRecipe(recipeOf(TEMPLATE))).toBe(EXPECTED_TEMPLATE_ES);
  });

  it('uses no word from the default banned list', () => {
    expect(bannedIn(explainRecipe(recipeOf(TEMPLATE)))).toEqual([]);
  });

  it('never shows block names or stage ids', () => {
    const text = explainRecipe(recipeOf(TEMPLATE));
    expect(text).not.toContain('ai-workflows/');
    expect(text).not.toContain('owner-approval');
    expect(text).not.toContain('red-test');
  });
});

describe('explain, piece by piece', () => {
  const one = (locale: string, ...extra: string[]) =>
    recipeOf(
      lines(
        'version: 1',
        `locale: ${locale}`,
        'classify:',
        '  money: ["lib/calc/**"]',
        '  visible: ["app/**"]',
        '  production: [".github/workflows/**"]',
        'stages:',
        '  - id: a',
        '    summary: "Paso único"',
        '    nature: recompute',
        ...extra,
        '    gate:',
        '      run: node a.mjs',
      ),
    );

  it('says one step in the singular', () => {
    expect(explainRecipe(one('es')).split('\n')[0]).toBe('Proceso de este proyecto: 1 paso, en este orden.');
    expect(explainRecipe(one('en')).split('\n')[0]).toBe("This project's process: 1 step, in this order.");
  });

  it('keeps the closing punctuation a summary already has', () => {
    const text = explainRecipe(
      recipeOf(
        lines(
          'version: 1',
          'locale: es',
          'stages:',
          '  - id: a',
          '    summary: "¿Está listo?"',
          '    nature: recompute',
          '    gate:',
          '      run: node a.mjs',
        ),
      ),
    );
    expect(text).toContain('\n1. ¿Está listo?\n');
  });

  it('joins every clause of a condition, in the fixed order of §3.4', () => {
    const text = explainRecipe(
      one(
        'es',
        '    applies-if: { lane-any: [fast], kind-none: [docs, prototype], touches-none: [money], kind-any: [behavior], touches-any: [visible, production, money] }',
      ),
    );
    expect(text).toContain(
      '   Cuándo: solo si el cambio toca «visible», «production» o «money» y el cambio no toca «money» y el tipo de cambio es «behavior» y el tipo de cambio no es «docs» ni «prototype» y el carril es «fast».',
    );
  });

  it('says an optional step only warns', () => {
    expect(explainRecipe(one('es', '    required: false'))).toContain(
      '   Si no se cumple: se avisa y la pieza sigue.',
    );
  });

  it('says a retry without a wait as tries in a row, and adds nothing for a single attempt', () => {
    expect(explainRecipe(one('es', '    retry: { attempts: 2 }'))).toContain('   Se intenta hasta 2 veces seguidas.');
    expect(explainRecipe(one('es', '    retry: { attempts: 1 }'))).not.toContain('Se intenta');
  });

  it('marks each phase only when it changes', () => {
    const text = explainRecipe(one('es'));
    expect(text.split('\n').filter((line) => line === 'Antes de fusionar')).toHaveLength(1);
    expect(text).not.toContain('Al fusionar');
    expect(text).not.toContain('Después de fusionar');
  });
});

describe('explain in English', () => {
  it('reads a whole recipe in English', () => {
    const recipe = recipeOf(
      lines(
        'version: 1',
        'locale: en',
        'classify:',
        '  money: ["lib/calc/**"]',
        '  visible: ["app/**"]',
        'stages:',
        '  - id: spec',
        '    summary: "A written plan"',
        '    nature: structure',
        '    applies-if: { touches-none: [money, visible], kind-none: [docs] }',
        '    gate:',
        '      run: node spec.mjs',
        '  - id: approval',
        '    summary: "The owner approves what is visible"',
        '    after: spec',
        '    nature: attest',
        '    needs-human: true',
        '    applies-if: { touches-any: [visible, money], kind-any: [behavior, ui-behavior], lane-any: [full] }',
        '    gate:',
        '      run: node approval.mjs',
        '  - id: land',
        '    summary: "It goes into the queue"',
        '    after: approval',
        '    phase: merge',
        '    nature: recompute',
        '    gate:',
        '      run: node land.mjs',
        '  - id: tidy',
        '    summary: "The work folder is cleaned"',
        '    after: land',
        '    phase: post-merge',
        '    required: false',
        '    retry: { attempts: 4, wait-seconds: 10 }',
        '    nature: recompute',
        '    gate:',
        '      run: node tidy.mjs',
      ),
    );
    expect(explainRecipe(recipe)).toBe(
      [
        "This project's process: 4 steps, in this order.",
        '',
        'Before joining the main line',
        '1. A written plan.',
        '   When: only if the change touches none of "money", "visible" and the kind of change is not "docs".',
        '   If it fails: the piece stops until it is fixed.',
        '2. The owner approves what is visible.',
        '   When: only if the change touches "visible" or "money" and the kind of change is "behavior" or "ui-behavior" and the lane is "full".',
        '   If it is missing: the piece waits for your decision; the others carry on.',
        '',
        'When joining the main line',
        '3. It goes into the queue.',
        '   When: always.',
        '   If it fails: the piece stops until it is fixed.',
        '',
        'After joining the main line',
        '4. The work folder is cleaned.',
        '   When: always.',
        '   If it fails: you are told and the piece carries on.',
        '   It is tried up to 4 times, 10 seconds apart.',
      ].join('\n'),
    );
  });

  it('says a retry without a wait as tries in a row', () => {
    const recipe = recipeOf(
      lines(
        'version: 1',
        'locale: en',
        'stages:',
        '  - id: a',
        '    summary: "One step"',
        '    nature: recompute',
        '    retry: { attempts: 3 }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(explainRecipe(recipe)).toContain('   It is tried up to 3 times in a row.');
  });

  it('says a single excluded kind or class without "none of"', () => {
    const recipe = recipeOf(
      lines(
        'version: 1',
        'locale: en',
        'classify:',
        '  money: ["lib/calc/**"]',
        'stages:',
        '  - id: a',
        '    summary: "One step"',
        '    nature: recompute',
        '    applies-if: { touches-none: [money], kind-none: [docs, prototype] }',
        '    gate:',
        '      run: node a.mjs',
      ),
    );
    expect(explainRecipe(recipe)).toContain(
      '   When: only if the change does not touch "money" and the kind of change is none of "docs", "prototype".',
    );
  });
});
