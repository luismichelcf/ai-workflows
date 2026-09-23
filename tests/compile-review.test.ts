import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileRecipe, createEngine, createMemoryStore, explainRecipe, parseRecipe, type Recipe } from '../src/index.js';

import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// Review round 1 of PR #17: compileRecipe must stand on its own. It is the last door before a
// block runs, so it re-checks what validate checks instead of trusting that validate ran, and
// it refuses a folder that is not the top of the repository.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const oneStage = (nature: string, uses: string, ...extra: string[]) => recipeOf(lines(
  'version: 1',
  'locale: es',
  'stages:',
  '  - id: only',
  '    summary: "Uno"',
  '    phase: merge',
  `    nature: ${nature}`,
  ...extra,
  '    gate:',
  `      uses: ${uses}`,
));

const compile = (root: string, recipe: Recipe) =>
  compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store: createMemoryStore() });

describe('compileRecipe re-checks the recipe against the manifests', () => {
  it('refuses a nature the block does not allow', async () => {
    await expect(compile(repository(), oneStage('attest', 'ai-workflows/scope-reconcile@1'))).rejects.toThrow(/cannot be attest/);
  });

  it('refuses a validity the block does not allow', async () => {
    await expect(compile(repository(), oneStage('recompute', 'ai-workflows/browser-qa@1', '    valid-while: forever')))
      .rejects.toThrow(/cannot use valid-while: forever/);
  });

  it('refuses a block.yml that does not validate, instead of guessing its kind', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/odd/block.yml', lines('kind: plugin', 'natures: [recompute]', 'main: index.mjs'));
    write(root, '.ai-workflows/blocks/odd/index.mjs', 'export default () => ({ ok: true });\n');
    commit(root, 'odd block');
    await expect(compile(root, oneStage('recompute', './.ai-workflows/blocks/odd'))).rejects.toThrow(/kind/);
  });

  it.skipIf(process.platform === 'win32')('refuses a main that became a link out of its folder after validation', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/out/block.yml', lines('kind: module', 'natures: [recompute]', 'main: index.mjs'));
    write(root, 'elsewhere.mjs', 'export default () => ({ ok: true });\n');
    mkdirSync(join(root, '.ai-workflows/blocks/out'), { recursive: true });
    symlinkSync(join(root, 'elsewhere.mjs'), join(root, '.ai-workflows/blocks/out/index.mjs'));
    commit(root, 'escaping block');
    await expect(compile(root, oneStage('recompute', './.ai-workflows/blocks/out'))).rejects.toThrow(/inside the block folder/);
  });
});

describe('compileRecipe works on the whole repository', () => {
  it('refuses a folder that is not the top of the repository', async () => {
    const root = repository();
    write(root, 'sub/readme.md', 'x\n');
    commit(root, 'sub');
    await expect(compile(join(root, 'sub'), oneStage('recompute', 'ai-workflows/scope-reconcile@1')))
      .rejects.toThrow(/top of the repository/);
  });
});

describe('a project command block gets its declared defaults', () => {
  it('receives in with every input of block.yml, defaults included, keys as written', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/echo/block.yml', lines(
      'kind: command',
      'natures: [recompute]',
      'inputs: { min-psa: { type: integer, min: 0, max: 50, default: 5 }, label: { type: string } }',
      'run: node echo.mjs',
    ));
    write(root, '.ai-workflows/blocks/echo/echo.mjs', [
      'let t = "";',
      'process.stdin.on("data", (c) => { t += c; });',
      'process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ ok: true, evidence: JSON.parse(t).with })); });',
      '',
    ].join('\n'));
    commit(root, 'echo block');
    const store = createMemoryStore();
    const withLabel = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: only',
      '    summary: "Uno"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/echo',
      '      with: { label: hola }',
    ));
    const second = await compileRecipe(withLabel, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: second.config, store, describeChange: second.describeChange });
    await engine.run('42');
    const entry = (await store.journal('42')).find((item) => item.stage === 'only');
    expect(entry?.evidence).toMatchObject({ block: { 'min-psa': 5, label: 'hola' } });
  });
});

describe('explain says what the engine cannot check', () => {
  it('a sandboxed review says that who built the piece is only declared', () => {
    const text = explainRecipe(oneStage('attest', 'ai-workflows/sandboxed-review@1'));
    expect(text).toContain('   Quién construyó lo declara la pieza; el motor no puede comprobarlo.');
  });

  it('and in English', () => {
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: en',
      'stages:',
      '  - id: only',
      '    summary: "One"',
      '    phase: merge',
      '    nature: attest',
      '    gate:',
      '      uses: ai-workflows/sandboxed-review@1',
    ));
    expect(explainRecipe(recipe)).toContain('   Who built it is declared by the piece; the engine cannot check it.');
  });
});
