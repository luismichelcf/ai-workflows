import { validGlob } from './glob.js';
import {
  nodeStart,
  type LocatedIssue,
  type YamlNode,
  yamlField,
  yamlMap,
  yamlSeq,
  yamlWord,
} from './validation.js';

function add(issues: LocatedIssue[], node: YamlNode, message: string): void {
  issues.push({ offset: nodeStart(node), message });
}

function validateGlobs(group: YamlNode, issues: LocatedIssue[]): void {
  for (const pair of yamlMap(group)?.items ?? []) {
    for (const item of yamlSeq(pair.value)?.items ?? []) {
      const pattern = yamlWord(item);
      if (!validGlob(pattern)) {
        add(issues, item, `unsupported glob "${pattern}": only *, ** and ? are allowed`);
      }
    }
  }
}

function validateClasses(
  condition: YamlNode,
  declared: ReadonlySet<string>,
  issues: LocatedIssue[],
): void {
  for (const key of ['touches-any', 'touches-none']) {
    for (const item of yamlSeq(yamlField(condition, key))?.items ?? []) {
      const name = yamlWord(item);
      if (!declared.has(name)) add(issues, item, `unknown class "${name}"`);
    }
  }
}

function validateStageLinks(stages: readonly YamlNode[], issues: LocatedIssue[]): void {
  const ids = new Map<string, YamlNode>();
  const successors = new Map<string, string>();
  let rootId: string | undefined;

  for (const stage of stages) {
    const idNode = yamlField(stage, 'id');
    const id = yamlWord(idNode);
    if (ids.has(id)) add(issues, idNode, `duplicate stage id "${id}"`);
    else ids.set(id, stage);

    const after = yamlField(stage, 'after');
    if (after === null) {
      if (rootId !== undefined) {
        add(
          issues,
          idNode,
          `stages "${rootId}" and "${id}" both have no "after"; ` +
            'only the first stage may omit it',
        );
      } else {
        rootId = id;
      }
      continue;
    }

    const prior = yamlWord(after);
    const existing = successors.get(prior);
    if (existing) {
      add(
        issues,
        after,
        `stages "${existing}" and "${id}" both run after "${prior}"; ` +
          'a pipeline is a single line',
      );
    } else {
      successors.set(prior, id);
    }
  }

  for (const stage of stages) {
    const id = yamlWord(yamlField(stage, 'id'));
    const after = yamlField(stage, 'after');
    if (after !== null && !ids.has(yamlWord(after))) {
      add(issues, after, `stage "${id}" runs after unknown stage "${yamlWord(after)}"`);
    }
  }
  validateCycles(stages, ids, issues);
}

function validateCycles(
  stages: readonly YamlNode[],
  ids: ReadonlyMap<string, YamlNode>,
  issues: LocatedIssue[],
): void {
  const visited = new Set<string>();
  for (const stage of stages) {
    const id = yamlWord(yamlField(stage, 'id'));
    if (visited.has(id)) continue;

    const chain: string[] = [];
    let cursor: string | undefined = id;
    while (cursor && !visited.has(cursor) && !chain.includes(cursor)) {
      chain.push(cursor);
      const prior: YamlNode = yamlField(ids.get(cursor) ?? null, 'after');
      cursor = prior === null ? undefined : yamlWord(prior);
    }

    if (cursor && chain.includes(cursor)) {
      const members = chain.slice(chain.indexOf(cursor));
      const ordered = [...ids.keys()].filter((name) => members.includes(name));
      const first = ordered[0] ?? '';
      add(
        issues,
        yamlField(ids.get(first) ?? null, 'after'),
        `cycle: stages ${ordered.map((name) => `"${name}"`).join(', ')} form a cycle`,
      );
    }
    for (const name of chain) visited.add(name);
  }
}

export function validateSemantics(root: YamlNode): LocatedIssue[] {
  const issues: LocatedIssue[] = [];
  const classify = yamlField(root, 'classify');
  const kinds = yamlField(root, 'kinds');
  const stages = yamlSeq(yamlField(root, 'stages'))?.items ?? [];
  const declared = new Set(
    (yamlMap(classify)?.items ?? []).map((pair) => yamlWord(pair.key)),
  );

  validateGlobs(classify, issues);
  validateGlobs(yamlField(kinds, 'from-paths'), issues);
  for (const elevation of yamlSeq(yamlField(kinds, 'elevate'))?.items ?? []) {
    validateClasses(yamlField(elevation, 'when'), declared, issues);
  }
  for (const stage of stages) {
    validateClasses(yamlField(stage, 'applies-if'), declared, issues);
  }
  validateStageLinks(stages, issues);
  return issues;
}
