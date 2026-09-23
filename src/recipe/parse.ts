import { LineCounter, Parser, parseAllDocuments, type Node } from 'yaml';

import { constructRecipe } from './construct.js';
import { safeTerminalText } from './safe-text.js';
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
    issues.push({ offset: 0, message: 'empty recipe' });
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

export function parseRecipe(text: string, file: string): RecipeParseResult {
  const lineCounter = new LineCounter();
  const issues: LocatedIssue[] = [];
  let roots: YamlNode[];
  try {
    roots = libraryIssues(text, lineCounter, issues);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {
      ok: false,
      errors: [{ file, line: 1, column: 1, message: 'recipe nesting is too deep' }],
    };
  }

  for (const root of roots) {
    const inspection = inspectYamlTree(root);
    issues.push(...inspection.controls, ...inspection.depth, ...inspection.keys);
  }

  const root = roots[0] ?? null;
  if (issues.length === 0) issues.push(...validateStructure(root));
  if (issues.length === 0) issues.push(...validateSemantics(root));

  if (issues.length > 0) {
    issues.sort((left, right) => left.offset - right.offset);
    const errors = issues.map((issue): RecipeError => {
      const position = lineCounter.linePos(issue.offset);
      return {
        file,
        line: position.line,
        column: position.col,
        message: safeTerminalText(issue.message),
      };
    });
    return { ok: false, errors };
  }

  return { ok: true, recipe: constructRecipe(root as Node) };
}
