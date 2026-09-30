import { describe, expect, it } from 'vitest';

import { explainRecipe, parseRecipe, recipeSchema, type Recipe } from '../src/index.js';

// PLAN-13-R6 §1.1 (R27): the recipe declares the branches that receive pieces and the promotions
// from one branch to another. `validate` rejects a bad section with file, line and column, and
// `explain` says it in plain words.
//
// Interface fixed here:
//   - YAML: `branches: { into: [<name>, …], promotions: [{ from: <name>, to: <name> }, …] }`.
//   - `Recipe.branches?: { into: readonly string[]; promotions: readonly { from: string; to: string }[] }`,
//     present only when the section is; `promotions` is `[]` when the section leaves it out.
//   - `recipeSchema.properties.branches` exists (the published schema is the exported one).
//   - Rules: `into` is a non-empty list of simple branch names (git's rules, no wildcard, no
//     `refs/`), without repeats; each promotion names two simple branches, both in `into`, and
//     `from` differs from `to`.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const FILE = '.ai-workflows/pipeline.yml';

/** A recipe whose `branches:` section, if any, starts at line 5. */
function withBranches(...section: string[]): string {
  return lines(
    'version: 1',
    'locale: es',
    'pieces:',
    '  branch: ["*/{piece}-*"]',
    ...section,
    'stages:',
    '  - id: merge',
    '    summary: "Se une"',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
  );
}

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, FILE);
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

describe('§1.1: the branches section is read', () => {
  it('into and promotions, as the design writes them', () => {
    const recipe = recipeOf(withBranches('branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }'));
    expect((recipe as unknown as { branches?: unknown }).branches).toEqual({
      into: ['staging', 'main'],
      promotions: [{ from: 'staging', to: 'main' }],
    });
  });

  it('without promotions, they are an empty list', () => {
    const recipe = recipeOf(withBranches('branches:', '  into: [staging, main]'));
    expect((recipe as unknown as { branches?: unknown }).branches).toEqual({ into: ['staging', 'main'], promotions: [] });
  });

  // Guards (green today, they must stay green): a recipe without the section is as it was.
  it('without the section, the recipe carries none (the principal alone, decided by whoever knows it)', () => {
    const recipe = recipeOf(withBranches());
    expect((recipe as unknown as { branches?: unknown }).branches).toBeUndefined();
  });

  it('the published schema declares the section', () => {
    expect(Object.keys(recipeSchema.properties)).toContain('branches');
  });
});

describe('§1.5 (8): validate rejects a bad section with file, line and column', () => {
  const cases: [string, string[], number, RegExp | undefined][] = [
    ['an empty into', ['branches:', '  into: []'], 6, undefined],
    ['a name with a wildcard', ['branches:', '  into: [staging, "feat/*"]'], 6, /feat\/\*/],
    ['a name with refs/', ['branches:', '  into: ["refs/heads/main"]'], 6, /refs\/heads\/main/],
    ['a repeated name', ['branches:', '  into: [main, main]'], 6, undefined],
    ['a from that is not in into (the example of the design: into [main] with staging → main)', ['branches:', '  into: [main]', '  promotions:', '    - { from: staging, to: main }'], 8, /staging/],
    ['a to that is not in into', ['branches:', '  into: [staging]', '  promotions:', '    - { from: staging, to: main }'], 8, /main/],
    ['a from equal to its to', ['branches:', '  into: [staging, main]', '  promotions:', '    - { from: main, to: main }'], 8, /main/],
    ['a from with a wildcard', ['branches:', '  into: [staging, main]', '  promotions:', '    - { from: "rel/*", to: main }'], 8, /rel\/\*/],
  ];
  for (const [name, section, line, message] of cases) {
    it(name, () => {
      const result = parseRecipe(withBranches(...section), FILE);
      expect(result.ok).toBe(false);
      const errors = result.ok ? [] : result.errors;
      const onLine = errors.filter((error) => error.line === line);
      expect(onLine.length, JSON.stringify(errors)).toBeGreaterThan(0);
      for (const error of onLine) {
        expect(error.file).toBe(FILE);
        expect(error.column).toBeGreaterThan(0);
      }
      if (message !== undefined) expect(onLine.map((error) => error.message).join('\n')).toMatch(message);
    });
  }
});

describe('§1.1: explain says it in plain words', () => {
  it('names the branches that receive pieces and what a promotion is', () => {
    const text = explainRecipe(recipeOf(withBranches('branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }')));
    expect(text).toContain('Las piezas entran a staging o a main.');
    expect(text).toContain('Un paso de staging a main no es una pieza: solo se revisa que no toque los archivos del motor');
  });

  it('without the section it says nothing about branches', () => {
    const text = explainRecipe(recipeOf(withBranches()));
    expect(text).not.toContain('Las piezas entran a');
    expect(text).not.toContain('no es una pieza');
  });
});
