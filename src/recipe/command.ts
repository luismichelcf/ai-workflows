import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { CommandOutput } from '../cli.js';
import { explainRecipe } from './explain.js';
import { parseRecipe } from './parse.js';

const DEFAULT_RECIPE = '.ai-workflows/pipeline.yml';
const USAGE = 'Usage: ai-workflows <validate|explain|init> [file]';

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return String(error.code);
}

async function initialize(cwd: string): Promise<CommandOutput> {
  const path = join(cwd, DEFAULT_RECIPE);
  try {
    // src/recipe and dist/recipe share this depth relative to the package template.
    const template = await readFile(
      new URL('../../templates/pipeline.yml', import.meta.url),
      'utf8',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, template, { flag: 'wx' });
    return {
      ok: true,
      text: `Created ${DEFAULT_RECIPE}. Read it in plain words with: ai-workflows explain`,
    };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return {
        ok: false,
        text: `${DEFAULT_RECIPE} already exists; init does not overwrite it.`,
      };
    }
    return { ok: false, text: `${DEFAULT_RECIPE}: ${errorReason(error)}` };
  }
}

async function readRecipe(
  action: 'validate' | 'explain',
  file: string,
  cwd: string,
): Promise<CommandOutput> {
  const path = isAbsolute(file) ? file : join(cwd, file);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        ok: false,
        text: `${file}: not found. Create one with: ai-workflows init`,
      };
    }
    return { ok: false, text: `${file}: ${errorReason(error)}` };
  }

  const parsed = parseRecipe(content, file);
  if (!parsed.ok) {
    const text = parsed.errors
      .map((error) => `${error.file}:${error.line}:${error.column}: ${error.message}`)
      .join('\n');
    return { ok: false, text };
  }

  if (action === 'explain') return { ok: true, text: explainRecipe(parsed.recipe) };
  return {
    ok: true,
    text: `${file}: valid recipe, ${parsed.recipe.stages.length} stages.`,
  };
}

export async function recipeCommand(
  argv: readonly string[],
  options: { cwd: string },
): Promise<CommandOutput> {
  const [action, filename, ...extra] = argv;
  if (extra.length > 0) return { ok: false, text: USAGE };
  if (action === 'init' && filename === undefined) return initialize(options.cwd);
  if (action !== 'validate' && action !== 'explain') return { ok: false, text: USAGE };

  // Diagnostics show the same separator on Windows and Linux.
  const file = (filename ?? DEFAULT_RECIPE).replace(/\\/g, '/');
  return readRecipe(action, file, options.cwd);
}
