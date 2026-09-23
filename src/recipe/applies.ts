import type { Applicability, GateContext } from '../contract.js';

import { classifyFiles } from './glob.js';
import type { Recipe, RecipeCondition } from './types.js';

export type Language = 'es' | 'en';

export const CONDITION_ORDER: readonly (keyof RecipeCondition)[] = [
  'touchesAny',
  'touchesNone',
  'kindAny',
  'kindNone',
  'laneAny',
];

export function languageOf(locale: string): Language {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function quoted(items: readonly string[], es: boolean): string[] {
  return items.map((item) => es ? `«${item}»` : `"${item}"`);
}

function joinQuoted(items: readonly string[], language: Language, lastWord: string): string {
  const words = quoted(items, language === 'es');
  if (words.length < 2) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} ${lastWord} ${words[words.length - 1]}`;
}

export function joined(items: readonly string[], es: boolean, negative = false): string {
  const language = es ? 'es' : 'en';
  const lastWord = es ? (negative ? 'ni' : 'o') : 'or';
  return joinQuoted(items, language, lastWord);
}

interface MotiveWords {
  readonly prefix: string;
  readonly noTouch: (classes: readonly string[]) => string;
  readonly touched: (classes: readonly string[]) => string;
  readonly wrongKind: (actual: string, expected: readonly string[]) => string;
  readonly excludedKind: (actual: string) => string;
  readonly wrongLane: (actual: string, expected: readonly string[]) => string;
}

const MOTIVE_WORDS: Record<Language, MotiveWords> = {
  es: {
    prefix: 'No aplica',
    noTouch: (classes) => `el cambio no toca ${joinQuoted(classes, 'es', 'ni')}`,
    touched: (classes) => `el cambio toca ${joinQuoted(classes, 'es', 'y')}`,
    wrongKind: (actual, expected) =>
      `el tipo de cambio es «${actual}», no ${joinQuoted(expected, 'es', 'ni')}`,
    excludedKind: (actual) => `el tipo de cambio es «${actual}»`,
    wrongLane: (actual, expected) =>
      `el carril es «${actual}», no ${joinQuoted(expected, 'es', 'ni')}`,
  },
  en: {
    prefix: 'Does not apply',
    noTouch: (classes) => `the change does not touch ${joinQuoted(classes, 'en', 'or')}`,
    touched: (classes) => `the change touches ${joinQuoted(classes, 'en', 'and')}`,
    wrongKind: (actual, expected) =>
      `the kind of change is "${actual}", not ${joinQuoted(expected, 'en', 'or')}`,
    excludedKind: (actual) => `the kind of change is "${actual}"`,
    wrongLane: (actual, expected) =>
      `the lane is "${actual}", not ${joinQuoted(expected, 'en', 'or')}`,
  },
};

function changeFact(context: GateContext, key: string): unknown {
  const change = context.change;
  if (typeof change !== 'object' || change === null) return undefined;
  return (change as Record<string, unknown>)[key];
}

function missingFact(stageId: string, fact: 'files' | 'kind' | 'lane'): Error {
  return new Error(
    `cannot decide whether stage "${stageId}" applies: the change has no valid "${fact}"`,
  );
}

function requireFiles(context: GateContext, stageId: string): string[] {
  const files = changeFact(context, 'files');
  if (!Array.isArray(files) || !files.every(isCanonicalFile)) {
    throw missingFact(stageId, 'files');
  }
  return files;
}

function isCanonicalFile(file: unknown): file is string {
  if (typeof file !== 'string' || file.length === 0) return false;
  if (file.startsWith('/') || file.startsWith('"') || file.endsWith('/')) return false;
  return file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function requireTextFact(
  context: GateContext,
  stageId: string,
  key: 'kind' | 'lane',
): string {
  const result = changeFact(context, key);
  if (typeof result !== 'string') throw missingFact(stageId, key);
  return result;
}

export function appliesIfFor(
  recipe: Recipe,
  stageId: string,
): ((context: GateContext) => Applicability) | undefined {
  const stage = recipe.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Unknown stage "${stageId}"`);
  const condition = stage.appliesIf;
  if (!condition) return undefined;

  const words = MOTIVE_WORDS[languageOf(recipe.locale)];
  const skip = (message: string): Applicability => ({
    skip: `${words.prefix}: ${message}.`,
  });

  return (context): Applicability => {
    let touched: string[] | undefined;
    const classes = (): string[] => {
      if (touched !== undefined) return touched;
      touched = classifyFiles(recipe.classify, requireFiles(context, stageId));
      return touched;
    };

    // Clause order is contractual: the first failed fact supplies the skip motive.
    const touchesAny = condition.touchesAny;
    if (touchesAny && !touchesAny.some((name) => classes().includes(name))) {
      return skip(words.noTouch(touchesAny));
    }

    const touchesNone = condition.touchesNone;
    if (touchesNone) {
      const matching = touchesNone.filter((name) => classes().includes(name));
      if (matching.length > 0) return skip(words.touched(matching));
    }

    const kindAny = condition.kindAny;
    if (kindAny) {
      const actual = requireTextFact(context, stageId, 'kind');
      if (!kindAny.includes(actual)) return skip(words.wrongKind(actual, kindAny));
    }

    const kindNone = condition.kindNone;
    if (kindNone) {
      const actual = requireTextFact(context, stageId, 'kind');
      if (kindNone.includes(actual)) return skip(words.excludedKind(actual));
    }

    const laneAny = condition.laneAny;
    if (laneAny) {
      const actual = requireTextFact(context, stageId, 'lane');
      if (!laneAny.includes(actual)) return skip(words.wrongLane(actual, laneAny));
    }
    return true;
  };
}
