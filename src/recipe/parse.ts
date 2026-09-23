import { LineCounter, Parser, parseAllDocuments, type Node } from 'yaml';

import { constructRecipe } from './construct.js';
import { safeTerminalText } from '../safe-text.js';
import { validateSemantics } from './semantics.js';
import type { Recipe, RecipeError } from './types.js';
import {
  nodeStart,
  inspectYamlTree,
  type LocatedIssue,
  scalarKey,
  validateStructure,
  type YamlNode,
  yamlMap,
  yamlSeq,
} from './validation.js';

export type RecipeParseResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; errors: readonly RecipeError[] };

/** The strict YAML reader's output, before any recipe-shaped validation happens. */
export interface StrictYaml {
  readonly root: YamlNode;
  readonly lineCounter: LineCounter;
  readonly issues: readonly LocatedIssue[];
}

function duplicateKeyAt(node: YamlNode, offset: number): string | undefined {
  const pending: YamlNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop() ?? null;
    for (const pair of yamlMap(current)?.items ?? []) {
      if (nodeStart(pair.key) === offset) return scalarKey(pair.key);
      pending.push(pair.value);
    }
    for (const item of yamlSeq(current)?.items ?? []) pending.push(item);
  }
  return undefined;
}

function scanCst(item: unknown, issues: LocatedIssue[]): void {
  const pending: unknown[] = [item];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;

    const token = current as Record<string, unknown>;
    if (typeof token.offset === 'number') {
      if (token.type === 'anchor') {
        issues.push({ offset: token.offset, message: 'anchors are not allowed' });
      } else if (token.type === 'alias') {
        issues.push({ offset: token.offset, message: 'aliases are not allowed' });
      } else if (token.type === 'tag') {
        issues.push({ offset: token.offset, message: 'tags are not allowed' });
      }
    }
    for (const child of Object.values(token)) {
      if (typeof child === 'object') pending.push(child);
    }
  }
}

function libraryIssues(
  text: string,
  lineCounter: LineCounter,
  issues: LocatedIssue[],
  emptyMessage: string,
): YamlNode[] {
  const documents = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    lineCounter,
  });
  const roots = documents.map((document) => document.contents);

  if (documents.length === 0 || roots[0] === null) {
    issues.push({ offset: 0, message: emptyMessage });
  }
  if (documents.length > 1) {
    issues.push({ offset: documents[1]?.range?.[0] ?? 0, message: 'expected one document' });
  }

  for (const document of documents) {
    for (const problem of [...document.errors, ...document.warnings]) {
      const offset = problem.pos[0];
      if (problem.code === 'DUPLICATE_KEY') {
        // The YAML node has already decoded quoted and escaped keys for us.
        const key = duplicateKeyAt(document.contents, offset) ?? '';
        issues.push({ offset, message: `duplicate key "${key}"` });
      } else {
        issues.push({
          offset,
          message: `invalid YAML: ${problem.message.split('\n')[0] ?? ''}`,
        });
      }
    }
  }

  // A document's leading anchor or tag is outside contents.srcToken. Scan the entire CST.
  for (const token of new Parser().parse(text)) scanCst(token, issues);
  return roots;
}

/**
 * Reads strict YAML — no anchors, aliases, tags or duplicate keys — with positions, without
 * imposing any document shape. The recipe parser and `block.yml` share it so both reject the
 * same syntax with the same line and column.
 */
export function readStrictYaml(text: string, emptyMessage = 'empty recipe'): StrictYaml {
  const lineCounter = new LineCounter();
  const issues: LocatedIssue[] = [];
  let roots: YamlNode[];
  try {
    roots = libraryIssues(text, lineCounter, issues, emptyMessage);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { root: null, lineCounter, issues: [{ offset: 0, message: 'recipe nesting is too deep' }] };
  }

  for (const root of roots) {
    const inspection = inspectYamlTree(root);
    issues.push(...inspection.controls, ...inspection.depth, ...inspection.keys);
  }

  return { root: roots[0] ?? null, lineCounter, issues };
}

/** Converts located issues to the public error shape, dropping exact duplicates. */
export function locatedRecipeErrors(
  issues: readonly LocatedIssue[],
  lineCounter: LineCounter,
  file: string,
): RecipeError[] {
  // The CST and AST may report the same fault; keep distinct faults at one location.
  const seen = new Map<number, Set<string>>();
  const unique = issues.filter((issue) => {
    const messages = seen.get(issue.offset) ?? new Set<string>();
    if (messages.has(issue.message)) return false;
    messages.add(issue.message);
    seen.set(issue.offset, messages);
    return true;
  });
  unique.sort((left, right) => left.offset - right.offset);
  return unique.map((issue): RecipeError => {
    const position = lineCounter.linePos(issue.offset);
    return {
      file,
      line: position.line,
      column: position.col,
      message: safeTerminalText(issue.message),
    };
  });
}

export function parseRecipe(text: string, file: string): RecipeParseResult {
  const strict = readStrictYaml(text);
  if (strict.issues.length > 0) {
    return { ok: false, errors: locatedRecipeErrors(strict.issues, strict.lineCounter, file) };
  }

  let issues = validateStructure(strict.root);
  if (issues.length === 0) issues = validateSemantics(strict.root);
  if (issues.length > 0) {
    return { ok: false, errors: locatedRecipeErrors(issues, strict.lineCounter, file) };
  }

  return { ok: true, recipe: constructRecipe(strict.root as Node) };
}
