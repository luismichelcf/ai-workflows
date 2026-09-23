import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { explainRecipe, parseRecipe, recipeCommand } from '../src/index.js';

// PLAN-13 §3.2 and §3.5 from the command line: `init` writes the example recipe, `validate`
// rejects with file, line, column and motive, and `explain` never explains a recipe it could
// not validate. Messages for agents are in English; `explain` speaks the recipe's language.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const TEMPLATE_URL = new URL('../templates/pipeline.yml', import.meta.url);

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ai-workflows-recipe-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const recipePath = () => join(cwd, '.ai-workflows', 'pipeline.yml');

const DUPLICATE_KEY = lines(
  'version: 1',
  'locale: es',
  'stages:',
  '  - id: a',
  '    summary: "Paso A"',
  '    summary: "Otra vez"',
  '    nature: recompute',
  '    gate:',
  '      run: node a.mjs',
);

describe('init', () => {
  it('writes the example recipe where the engine looks for it', async () => {
    const output = await recipeCommand(['init'], { cwd });

    expect(output).toEqual({
      ok: true,
      text: 'Created .ai-workflows/pipeline.yml. Read it in plain words with: ai-workflows explain',
    });
    expect(await readFile(recipePath(), 'utf8')).toBe(await readFile(TEMPLATE_URL, 'utf8'));
  });

  it('never overwrites a recipe that already exists', async () => {
    await mkdir(join(cwd, '.ai-workflows'));
    await writeFile(recipePath(), 'mine\n');

    const output = await recipeCommand(['init'], { cwd });

    expect(output.ok).toBe(false);
    expect(output.text).toBe('.ai-workflows/pipeline.yml already exists; init does not overwrite it.');
    expect(await readFile(recipePath(), 'utf8')).toBe('mine\n');
  });
});

describe('validate', () => {
  it('accepts the recipe init wrote and says how many stages it has', async () => {
    await recipeCommand(['init'], { cwd });

    expect(await recipeCommand(['validate'], { cwd })).toEqual({
      ok: true,
      text: '.ai-workflows/pipeline.yml: valid recipe, 9 stages.',
    });
  });

  it('rejects with file, line, column and motive, one error per line', async () => {
    await writeFile(join(cwd, 'bad.yml'), DUPLICATE_KEY);

    const output = await recipeCommand(['validate', 'bad.yml'], { cwd });

    expect(output.ok).toBe(false);
    const errorLines = output.text.split('\n');
    expect(errorLines.some((line) => line.startsWith('bad.yml:6:5: duplicate key "summary"'))).toBe(true);
    for (const line of errorLines) expect(line).toMatch(/^bad\.yml:\d+:\d+: \S/);
  });

  it('says so when there is no recipe, and how to make one', async () => {
    expect(await recipeCommand(['validate'], { cwd })).toEqual({
      ok: false,
      text: '.ai-workflows/pipeline.yml: not found. Create one with: ai-workflows init',
    });
  });
});

describe('explain', () => {
  it('explains the recipe in its own language', async () => {
    await recipeCommand(['init'], { cwd });
    const template = await readFile(TEMPLATE_URL, 'utf8');
    const parsed = parseRecipe(template, '.ai-workflows/pipeline.yml');
    if (!parsed.ok) throw new Error('the example recipe must be valid');

    expect(await recipeCommand(['explain'], { cwd })).toEqual({ ok: true, text: explainRecipe(parsed.recipe) });
  });

  it('RC-01: explains nothing about a recipe that does not validate', async () => {
    await writeFile(join(cwd, 'bad.yml'), DUPLICATE_KEY);

    const output = await recipeCommand(['explain', 'bad.yml'], { cwd });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('bad.yml:6:5: duplicate key "summary"');
    expect(output.text).not.toContain('Proceso de este proyecto');
    expect(output.text).not.toContain('Paso A');
  });

  it('says so when there is no recipe', async () => {
    expect(await recipeCommand(['explain'], { cwd })).toEqual({
      ok: false,
      text: '.ai-workflows/pipeline.yml: not found. Create one with: ai-workflows init',
    });
  });
});

describe('anything else', () => {
  it('answers with the usage, never in silence', async () => {
    for (const argv of [[], ['frobnicate']]) {
      const output = await recipeCommand(argv, { cwd });
      expect(output.ok).toBe(false);
      expect(output.text).toContain('Usage: ai-workflows <validate|explain|init> [file]');
    }
  });
});

describe('paths and arguments', () => {
  it('reads an absolute path and names it with forward slashes', async () => {
    const absolute = join(cwd, 'bad.yml');
    await writeFile(absolute, DUPLICATE_KEY);

    const output = await recipeCommand(['validate', absolute], { cwd });

    expect(output.ok).toBe(false);
    const shown = absolute.split('\\').join('/');
    expect(output.text).toContain(`${shown}:6:5: duplicate key "summary"`);
  });

  it('never echoes control characters from the file name it was given', async () => {
    const output = await recipeCommand(['validate', 'no\u001b[31mexist.yml'], { cwd });
    expect(output.ok).toBe(false);
    expect(output.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(output.text).toContain('exist.yml: not found');
  });

  it('init takes no file: it only ever writes where the engine looks', async () => {
    const output = await recipeCommand(['init', 'other.yml'], { cwd });
    expect(output.ok).toBe(false);
    expect(output.text).toContain('Usage: ai-workflows <validate|explain|init> [file]');
  });
});
