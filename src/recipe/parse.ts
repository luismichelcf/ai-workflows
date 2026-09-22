import { LineCounter, Parser, parseAllDocuments, type Node } from 'yaml';

import { constructRecipe } from './construct.js';
import { validateSemantics } from './semantics.js';
import type { Recipe, RecipeError } from './types.js';
import {
  nodeStart,
  type LocatedIssue,
  validateStructure,
  type YamlNode,
  yamlMap,
  yamlSeq,
  yamlWord,
} from './validation.js';

export type RecipeParseResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; errors: readonly RecipeError[] };

function duplicateKeyAt(node: YamlNode, offset: number): string | undefined {
  const object = yamlMap(node);
  if (object) {
    for (const pair of object.items) {
      if (nodeStart(pair.key) === offset) return yamlWord(pair.key);
      const nested = duplicateKeyAt(pair.value, offset);
      if (nested !== undefined) return nested;
    }
  }

  for (const item of yamlSeq(node)?.items ?? []) {
    const nested = duplicateKeyAt(item, offset);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function scanCst(item: unknown, issues: LocatedIssue[]): void {
  if (Array.isArray(item)) {
    for (const child of item) scanCst(child, issues);
    return;
  }
  if (typeof item !== 'object' || item === null) return;

  const token = item as Record<string, unknown>;
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
    if (typeof child === 'object') scanCst(child, issues);
  }
}

function libraryIssues(
  text: string,
  lineCounter: LineCounter,
  issues: LocatedIssue[],
): YamlNode {
  const documents = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    lineCounter,
  });
  const root = documents[0]?.contents ?? null;

  if (documents.length === 0 || root === null) {
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
          message: `invalid YAML: ${problem.message.split('\n')[0]}`,
        });
      }
    }
  }

  // A document's leading anchor or tag is outside contents.srcToken. Scan the entire CST.
  for (const token of new Parser().parse(text)) scanCst(token, issues);
  return root;
}

export function parseRecipe(text: string, file: string): RecipeParseResult {
  const lineCounter = new LineCounter();
  const issues: LocatedIssue[] = [];
  const root = libraryIssues(text, lineCounter, issues);

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
        message: issue.message,
      };
    });
    return { ok: false, errors };
  }

  return { ok: true, recipe: constructRecipe(root as Node) };
}
