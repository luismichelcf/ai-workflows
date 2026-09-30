import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { CommandOutput } from '../cli.js';
import { RECIPE_USAGE, runInit, type RecipeCommandOptions } from '../release/init.js';
import { checkRecipe } from './blocks.js';
import { explainRecipe } from './explain.js';
import { safeTerminalText } from '../safe-text.js';

const DEFAULT_RECIPE = '.ai-workflows/pipeline.yml';

function errorReason(error: unknown): string {
  return safeTerminalText(error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return String(error.code);
}

async function readRecipe(
  action: 'validate' | 'explain',
  file: string,
  cwd: string,
): Promise<CommandOutput> {
  const path = isAbsolute(file) ? file : join(cwd, file);
  const shownFile = safeTerminalText(file);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        ok: false,
        text: `${shownFile}: not found. Create one with: ai-workflows init`,
      };
    }
    return { ok: false, text: `${shownFile}: ${errorReason(error)}` };
  }

  const checked = await checkRecipe(content, file, { root: cwd });
  if (!checked.ok) {
    const text = checked.errors
      .map((error) =>
        `${safeTerminalText(error.file)}:${error.line}:${error.column}: ${error.message}`)
      .join('\n');
    return { ok: false, text };
  }

  if (action === 'explain') return { ok: true, text: explainRecipe(checked.recipe) };
  return {
    ok: true,
    text: `${shownFile}: valid recipe, ${checked.recipe.stages.length} stages.`,
  };
}

export async function recipeCommand(
  argv: readonly string[],
  options: RecipeCommandOptions,
): Promise<CommandOutput> {
  const [action, filename, ...extra] = argv;
  if (action === 'init') return runInit(argv.slice(1), options);
  if (extra.length > 0) return { ok: false, text: RECIPE_USAGE };
  if (action !== 'validate' && action !== 'explain') return { ok: false, text: RECIPE_USAGE };

  // Diagnostics show the same separator on Windows and Linux.
  const file = (filename ?? DEFAULT_RECIPE).replace(/\\/g, '/');
  return readRecipe(action, file, options.cwd);
}
