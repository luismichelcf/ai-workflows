import { languageOf } from '../recipe/applies.js';
import type { ProjectFiles } from '../recipe/facts.js';
import type { Recipe } from '../recipe/types.js';

// PLAN-13-R3 §1.1 (R19): on GitHub the piece is recognized by the branch name and its declared
// kind is read from a line of the piece's plan. Both are read from the judged commit, never from
// the working tree.

const PIECE_TOKEN = '{piece}';

/** Every literal of a pattern is escaped; only `*` and `{piece}` become syntax. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A whole-branch pattern: `{piece}` is one or more digits and `*` is one or more characters
 * other than `/`; everything else is literal, so `feat/-13` names no piece.
 */
function patternToRegExp(pattern: string): RegExp {
  let source = '^';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith(PIECE_TOKEN, index)) {
      source += '(\\d+)';
      index += PIECE_TOKEN.length;
    } else if (pattern.charAt(index) === '*') {
      source += '[^/]+';
      index += 1;
    } else {
      source += escapeLiteral(pattern.charAt(index));
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/**
 * R19: the exclusion pattern a branch matches, or `undefined` when none does. One implementation
 * for the judge and for the locks, so both answer the same question the same way (PLAN-13-R5 §1.2).
 */
export function excludedBy(recipe: Recipe, branch: string): string | undefined {
  for (const pattern of recipe.pieces?.excludeBranches ?? []) {
    if (patternToRegExp(pattern).test(branch)) return pattern;
  }
  return undefined;
}

/**
 * R19: the piece a branch declares, or the reason it declares none. Without `pieces:` the piece
 * of a change is the pull request number.
 */
export function pieceOfBranch(
  recipe: Recipe,
  branch: string,
  prNumber: number,
): { piece: string } | { none: string } {
  const pieces = recipe.pieces;
  if (pieces === undefined) return { piece: String(prNumber) };
  const spanish = languageOf(recipe.locale) === 'es';

  const excluded = excludedBy(recipe, branch);
  if (excluded !== undefined) {
    return {
      none: spanish
        ? `la rama "${branch}" está excluida por "${excluded}" y no nombra ninguna pieza`
        : `the branch "${branch}" is excluded by "${excluded}" and names no piece`,
    };
  }

  for (const pattern of pieces.branch) {
    const match = patternToRegExp(pattern).exec(branch);
    const found = match?.[1];
    if (found !== undefined) return { piece: found };
  }

  return {
    none: spanish
      ? `la rama "${branch}" no nombra ninguna pieza`
      : `the branch "${branch}" does not name a piece`,
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Accents, case and the decorations `*`, `` ` `` and `_` do not matter when reading a line. */
function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[*`_]/g, '');
}

/** A line is compared from its first non-space character, past a list marker if there is one. */
function normalizedLine(line: string): string {
  return normalizeText(line).replace(/^\s*(?:-\s*)?/, '');
}

/** The value of a declaration: inner spaces become `-`, so "Solo Visual" reads as "solo-visual". */
function normalizedValue(value: string): string {
  return normalizeText(value).trim().replace(/\s+/g, '-');
}

/** The declared value named by its kind, either by its name or by its owner-facing label. */
function kindNamed(recipe: Recipe, value: string): string | undefined {
  const names = recipe.kinds?.names ?? [];
  for (const name of names) {
    if (normalizedValue(name) === value) return name;
    const label = recipe.labels?.[name];
    if (label !== undefined && normalizedValue(label) === value) return name;
  }
  return undefined;
}

function refusedValue(recipe: Recipe, value: string): string {
  const shown = value.trim();
  return languageOf(recipe.locale) === 'es'
    ? `el tipo declarado "${shown}" no nombra ningún tipo`
    : `the declared kind "${shown}" does not name a kind`;
}

/**
 * R19: the kind the piece declares in its plan, read through `files`. The first line that starts
 * with the configured label gives the value; a value that names no kind is a rejection.
 */
export async function readDeclaredKind(
  recipe: Recipe,
  piece: string,
  files: ProjectFiles,
): Promise<{ kind?: string } | { rejected: string }> {
  const declared = recipe.pieces?.declaredKind;
  if (declared === undefined) return {};

  const path = declared.file.replaceAll(PIECE_TOKEN, piece);
  let content: string | undefined;
  try {
    content = await files.read(path);
  } catch (error) {
    // Only a file that is too big is a rejection of the piece; any other failure to read is not
    // an answer about the declared kind, so it propagates and the judge makes the run technical.
    if (error instanceof Error && /larger than 1 MB/.test(error.message)) {
      return { rejected: reasonOf(error) };
    }
    throw error;
  }
  if (content === undefined) return {};

  const label = normalizeText(declared.line);
  for (const raw of content.split(/\r?\n/)) {
    if (!normalizedLine(raw).startsWith(`${label}:`)) continue;
    const kind = kindNamed(recipe, normalizedValue(raw.slice(raw.indexOf(':') + 1)));
    if (kind !== undefined) return { kind };
    return { rejected: refusedValue(recipe, raw.slice(raw.indexOf(':') + 1)) };
  }
  return {};
}
