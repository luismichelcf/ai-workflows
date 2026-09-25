import { isAbsolute } from 'node:path';

import { validGlob } from './glob.js';
import { validateCommandLine } from './command-line.js';
import {
  nodeStart,
  type LocatedIssue,
  type YamlNode,
  yamlField,
  yamlMap,
  yamlSeq,
  yamlValue,
  yamlWord,
} from './validation.js';

function add(issues: LocatedIssue[], node: YamlNode, message: string): void {
  issues.push({ offset: nodeStart(node), message });
}

function listNodes(node: YamlNode): readonly YamlNode[] {
  return yamlSeq(node)?.items ?? [];
}

function validateGlobs(group: YamlNode, issues: LocatedIssue[]): void {
  for (const pair of yamlMap(group)?.items ?? []) {
    for (const item of listNodes(pair.value)) {
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
    for (const item of listNodes(yamlField(condition, key))) {
      const name = yamlWord(item);
      if (!declared.has(name)) add(issues, item, `unknown class "${name}"`);
    }
  }
}

/** R15: every kind reference must be in `kinds.names`; without kinds, none is. */
function validateKindRefs(
  condition: YamlNode,
  vocabulary: ReadonlySet<string>,
  issues: LocatedIssue[],
): void {
  for (const key of ['kind-any', 'kind-none']) {
    for (const item of listNodes(yamlField(condition, key))) {
      const name = yamlWord(item);
      if (!vocabulary.has(name)) add(issues, item, `unknown kind "${name}"`);
    }
  }
}

function validateLaneRefs(
  condition: YamlNode,
  lanes: ReadonlySet<string>,
  issues: LocatedIssue[],
): void {
  for (const item of listNodes(yamlField(condition, 'lane-any'))) {
    const name = yamlWord(item);
    if (!lanes.has(name)) add(issues, item, `unknown lane "${name}"`);
  }
}

/** R15: `lanes:` must hold every declared kind in exactly one lane. */
function validateVocabulary(
  root: YamlNode,
  stages: readonly YamlNode[],
  declared: ReadonlySet<string>,
  issues: LocatedIssue[],
): void {
  const kinds = yamlField(root, 'kinds');
  const vocabulary = new Set(listNodes(yamlField(kinds, 'names')).map((item) => yamlWord(item)));

  const defaultNode = yamlField(kinds, 'default');
  if (defaultNode !== null && !vocabulary.has(yamlWord(defaultNode))) {
    add(issues, defaultNode, `unknown kind "${yamlWord(defaultNode)}"`);
  }

  for (const pair of yamlMap(yamlField(kinds, 'from-paths'))?.items ?? []) {
    const name = yamlWord(pair.key);
    if (!vocabulary.has(name)) add(issues, pair.key, `unknown kind "${name}"`);
  }

  for (const elevation of listNodes(yamlField(kinds, 'elevate'))) {
    validateKindRefs(yamlField(elevation, 'when'), vocabulary, issues);
    const to = yamlField(elevation, 'to');
    if (to !== null && !vocabulary.has(yamlWord(to))) {
      add(issues, to, `unknown kind "${yamlWord(to)}"`);
    }
  }

  const lanesNode = yamlField(root, 'lanes');
  const lanePairs = yamlMap(lanesNode)?.items ?? [];
  const laneNames = new Set(lanePairs.map((pair) => yamlWord(pair.key)));
  const assigned = new Map<string, string>();
  for (const pair of lanePairs) {
    const lane = yamlWord(pair.key);
    for (const item of listNodes(pair.value)) {
      const name = yamlWord(item);
      if (!vocabulary.has(name)) {
        add(issues, item, `unknown kind "${name}"`);
        continue;
      }
      const prior = assigned.get(name);
      if (prior === undefined) assigned.set(name, lane);
      else if (prior !== lane) {
        add(issues, item, `kind "${name}" is in lanes "${prior}" and "${lane}"`);
      }
    }
  }
  if (lanesNode !== null) {
    for (const name of vocabulary) {
      if (!assigned.has(name)) add(issues, lanesNode, `kind "${name}" has no lane`);
    }
  }

  for (const stage of stages) {
    const condition = yamlField(stage, 'applies-if');
    validateKindRefs(condition, vocabulary, issues);
    validateLaneRefs(condition, laneNames, issues);
  }

  // R16: a label names a declared class, kind or lane.
  const labelNames = new Set<string>([...vocabulary, ...laneNames, ...declared]);
  for (const pair of yamlMap(yamlField(root, 'labels'))?.items ?? []) {
    const name = yamlWord(pair.key);
    if (!labelNames.has(name)) add(issues, pair.key, `unknown name "${name}" in labels`);
  }
}

/** The stages in execution order, or undefined when the chain is not a single line. */
function stageOrder(stages: readonly YamlNode[]): Map<string, number> | undefined {
  const ids: string[] = [];
  const known = new Set<string>();
  for (const stage of stages) {
    const id = yamlWord(yamlField(stage, 'id'));
    if (known.has(id)) return undefined;
    known.add(id);
    ids.push(id);
  }

  const after = new Map<string, string | undefined>();
  const successors = new Map<string, string>();
  let roots = 0;
  for (const stage of stages) {
    const id = yamlWord(yamlField(stage, 'id'));
    const afterNode = yamlField(stage, 'after');
    if (afterNode === null) {
      after.set(id, undefined);
      roots += 1;
      continue;
    }
    const prior = yamlWord(afterNode);
    if (!known.has(prior) || successors.has(prior)) return undefined;
    successors.set(prior, id);
    after.set(id, prior);
  }
  if (roots !== 1) return undefined;

  const ordered = new Map<string, number>();
  let cursor: string | undefined = ids.find((id) => after.get(id) === undefined);
  while (cursor !== undefined && !ordered.has(cursor)) {
    ordered.set(cursor, ordered.size);
    cursor = successors.get(cursor);
  }
  return ordered.size === stages.length ? ordered : undefined;
}

/** RC-08 §1.3 rules 1 and 2: exactly one merge, in its place. */
function validatePhases(
  stages: readonly YamlNode[],
  stagesNode: YamlNode,
  issues: LocatedIssue[],
): void {
  const idOf = (stage: YamlNode): string => yamlWord(yamlField(stage, 'id'));
  const phaseOf = (stage: YamlNode): string => yamlWord(yamlField(stage, 'phase')) || 'pre-merge';

  const merges = stages.filter((stage) => phaseOf(stage) === 'merge');
  if (merges.length === 0) {
    add(issues, stagesNode, 'exactly one stage must have phase: merge; found none');
  } else if (merges.length > 1) {
    const first = idOf(merges[0] as YamlNode);
    for (const extra of merges.slice(1)) {
      add(
        issues,
        yamlField(extra, 'phase'),
        `only one stage may have phase: merge; "${first}" already does`,
      );
    }
  }

  if (merges.length !== 1) return;
  const order = stageOrder(stages);
  if (order === undefined) return;

  const mergeId = idOf(merges[0] as YamlNode);
  const mergeAt = order.get(mergeId);
  if (mergeAt === undefined) return;

  for (const stage of stages) {
    const id = idOf(stage);
    const at = order.get(id);
    if (at === undefined) continue;
    if (phaseOf(stage) === 'pre-merge' && at > mergeAt) {
      add(
        issues,
        yamlField(stage, 'id'),
        `stage "${id}" is pre-merge but comes after the merge stage "${mergeId}"`,
      );
    }
    if (phaseOf(stage) === 'post-merge' && at < mergeAt) {
      add(
        issues,
        yamlField(stage, 'phase'),
        `stage "${id}" is post-merge but comes before the merge stage "${mergeId}"`,
      );
    }
  }
}

/** RC-08 §1.3 rules 3 and 4, plus the command text of §1.4. */
function validateStageRules(stages: readonly YamlNode[], issues: LocatedIssue[]): void {
  for (const stage of stages) {
    const phase = yamlWord(yamlField(stage, 'phase')) || 'pre-merge';
    const required = yamlValue(yamlField(stage, 'required')) !== false;

    const server = yamlField(stage, 'server');
    if (server !== null && yamlMap(server) === undefined && yamlWord(server) === 'local-only') {
      if ((phase === 'pre-merge' || phase === 'merge') && required) {
        add(
          issues,
          server,
          'local-only is only allowed in post-merge stages or with required: false',
        );
      }
    }

    const run = yamlField(yamlField(stage, 'gate'), 'run');
    if (run === null) continue;

    const nature = yamlWord(yamlField(stage, 'nature'));
    if (nature !== 'recompute' && nature !== 'structure') {
      add(issues, yamlField(stage, 'nature'), 'a command (run:) can only be recompute or structure');
    }
    validateCommandLine(run, issues);
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

/** R19: how a branch names its piece, and where that piece declares its kind. */
function keyNode(node: YamlNode, key: string): YamlNode {
  for (const pair of yamlMap(node)?.items ?? []) {
    if (yamlWord(pair.key) === key) return pair.key;
  }
  return null;
}

const BRANCH_CHARS = /^[A-Za-z0-9._/*-]*$/;

/** R19 §1.1: the syntax of a branch pattern, and of an exclusion. */
function validateBranchPattern(item: YamlNode, requirePiece: boolean): string | undefined {
  const pattern = yamlWord(item);
  const occurrences = pattern.split('{piece}').length - 1;
  if (requirePiece && occurrences !== 1) {
    return `branch pattern "${pattern}" must contain {piece} exactly once`;
  }
  if (!requirePiece && occurrences > 0) {
    return 'an excluded branch cannot contain {piece}';
  }
  if (!BRANCH_CHARS.test(pattern.split('{piece}').join(''))) {
    return `unsupported character in branch pattern "${pattern}"`;
  }
  if (pattern.includes('*{piece}') || pattern.includes('{piece}*')) {
    return `a star cannot touch {piece} in branch pattern "${pattern}"`;
  }
  return undefined;
}

/** R19 §1.1: the file that carries a piece's declared kind. */
function validateDeclaredKindFile(item: YamlNode): string | undefined {
  const file = yamlWord(item);
  const leaves = file.split(/[\\/]+/).includes('..');
  if (!file.includes('{piece}') || isAbsolute(file) || leaves) {
    return `declared-kind file "${file}" must be a relative path with {piece} and no ".."`;
  }
  return undefined;
}

/** R19: `pieces:`, its patterns and the declared kind. */
function validatePieces(root: YamlNode, issues: LocatedIssue[]): void {
  const pieces = yamlField(root, 'pieces');
  if (pieces === null) return;

  for (const item of listNodes(yamlField(pieces, 'branch'))) {
    const complaint = validateBranchPattern(item, true);
    if (complaint !== undefined) add(issues, item, complaint);
  }
  for (const item of listNodes(yamlField(pieces, 'exclude-branches'))) {
    const complaint = validateBranchPattern(item, false);
    if (complaint !== undefined) add(issues, item, complaint);
  }

  const declaredKind = yamlField(pieces, 'declared-kind');
  if (declaredKind === null) return;
  if (yamlField(root, 'kinds') === null) {
    add(issues, keyNode(pieces, 'declared-kind'), 'declared-kind needs kinds: in the recipe');
  }
  const fileNode = yamlField(declaredKind, 'file');
  if (fileNode !== null) {
    const complaint = validateDeclaredKindFile(fileNode);
    if (complaint !== undefined) add(issues, fileNode, complaint);
  }
}

/**
 * PLAN-13-R5 §1.1: `hooks:` declares the paper folders, and it needs `pieces:` — without a way to
 * name a piece, the lock could never open and the section would quietly switch itself off. Each
 * paper folder is read with the rules of `readPapers`: relative, non-empty and inside the project.
 */
function validateHooks(root: YamlNode, issues: LocatedIssue[]): void {
  const hooks = yamlField(root, 'hooks');
  if (hooks === null) return;

  if (yamlField(root, 'pieces') === null) {
    add(issues, keyNode(root, 'hooks'), 'hooks: needs pieces: in the recipe');
  }

  for (const item of listNodes(yamlField(hooks, 'papers'))) {
    const entry = yamlWord(item);
    const forward = entry.replace(/\\/g, '/');
    const normalized = forward.replace(/\/+$/, '');
    const leaves =
      normalized === '' ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('/../');
    if (isAbsolute(forward) || /^[A-Za-z]:/.test(forward) || forward.startsWith('/') || leaves) {
      add(
        issues,
        item,
        `paper folder ${JSON.stringify(entry)} must be a relative folder inside the project`,
      );
    }
  }
}

/** PLAN-13-R4 §6: the summary file must be a relative path with no escape. */
function validateMessages(root: YamlNode, issues: LocatedIssue[]): void {
  const summary = yamlField(yamlField(root, 'messages'), 'summary');
  if (summary === null) return;
  const fileNode = yamlField(summary, 'file');
  if (fileNode === null) return;
  const file = yamlWord(fileNode);
  const leaves = file.split(/[\\/]+/).includes('..');
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || leaves) {
    add(issues, fileNode, `summary file "${file}" must be a relative path with no ".."`);
  }
}

const AGENT_ACCOUNT_USERS = new Set([
  'ai-workflows/approval-review@1',
  'ai-workflows/independent-review@1',
]);

/**
 * PLAN-13-R4 §1.1 and §5: the stages that publish as the agents need the declared identity,
 * and the two combinations of `required: false` that cannot be read.
 */
function validateAgentAndOptional(
  root: YamlNode,
  stages: readonly YamlNode[],
  issues: LocatedIssue[],
): void {
  const hasAccount = yamlField(root, 'agent-account') !== null;
  const hasOwner = yamlField(root, 'owner') !== null;
  const hasPieces = yamlField(root, 'pieces') !== null;

  for (const stage of stages) {
    const usesNode = yamlField(yamlField(stage, 'gate'), 'uses');
    const uses = yamlWord(usesNode);

    if (AGENT_ACCOUNT_USERS.has(uses)) {
      if (!hasAccount) {
        add(issues, usesNode, `block "${uses}" needs agent-account: in the recipe`);
      }
      if (uses === 'ai-workflows/approval-review@1' && !hasOwner) {
        add(issues, usesNode, `block "${uses}" needs owner: in the recipe`);
      }
      if (uses === 'ai-workflows/independent-review@1' && !hasPieces) {
        add(issues, usesNode, `block "${uses}" needs pieces: in the recipe`);
      }
    }

    const server = yamlField(stage, 'server');
    if (
      uses === 'ai-workflows/sandboxed-review@1' &&
      server !== null &&
      yamlMap(server) === undefined &&
      yamlWord(server) === 'attestation'
    ) {
      if (!hasAccount) {
        add(issues, server, `block "${uses}" with server: attestation needs agent-account: in the recipe`);
      }
      if (!hasPieces) {
        add(issues, server, `block "${uses}" with server: attestation needs pieces: in the recipe`);
      }
    }

    const requiredNode = yamlField(stage, 'required');
    if (yamlValue(requiredNode) === false) {
      if (yamlValue(yamlField(stage, 'needs-human')) === true) {
        add(issues, requiredNode, 'required: false cannot wait for a person');
      }
      if ((yamlWord(yamlField(stage, 'phase')) || 'pre-merge') === 'merge') {
        add(issues, requiredNode, 'the merge stage is always required');
      }
    }
  }
}

/** PLAN-13-R4 §5 and §6: the two `with:` values whose rule a manifest's shape cannot state. */
const JUDGE_OWN_APPROVAL_COMMAND = '/approve-judge-change';
/** The agents' credentials; the project's browser suite must never be handed one. */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AI_WORKFLOWS_APP_ID',
  'AI_WORKFLOWS_APP_KEY_FILE',
];
/** Windows does not tell the case of an environment name apart, so neither does this rule. */
const CREDENTIAL_ENV_NAMES_UPPER = new Set(CREDENTIAL_ENV_NAMES.map((name) => name.toUpperCase()));

/**
 * The owner's approval order must be a plain command that is not the judge's own, and the
 * browser suite may not be handed the agents' credentials. Both are refused with line and
 * column, at the value that carries the mistake.
 */
function validateBlockInputValues(stages: readonly YamlNode[], issues: LocatedIssue[]): void {
  for (const stage of stages) {
    const gate = yamlField(stage, 'gate');
    const uses = yamlWord(yamlField(gate, 'uses'));
    for (const pair of yamlMap(yamlField(gate, 'with'))?.items ?? []) {
      const key = yamlWord(pair.key);
      if (uses === 'ai-workflows/approval-comment@1' && key === 'command') {
        if (yamlWord(pair.value) === JUDGE_OWN_APPROVAL_COMMAND) {
          add(
            issues,
            pair.value,
            `input "command" cannot be ${JUDGE_OWN_APPROVAL_COMMAND}: that is the judge's own order, not the owner's`,
          );
        }
      }
      if (uses === 'ai-workflows/browser-qa@1' && key === 'pass-env') {
        for (const item of listNodes(pair.value)) {
          const name = yamlWord(item);
          if (CREDENTIAL_ENV_NAMES_UPPER.has(name.toUpperCase())) {
            add(issues, item, `input "pass-env" cannot name ${name}: it carries the agents' credentials`);
          }
        }
      }
    }
  }
}

/**
 * PLAN-13-R4 §1.1, §5 and §6: the rules `validate` (the full `checkRecipe`) enforces on top of
 * the strict reader — they need nothing from a block manifest, but they are not part of
 * `parseRecipe`, which reads a recipe without asking each stage how GitHub checks it.
 */
export function validateRecipeExtras(root: YamlNode): LocatedIssue[] {
  const issues: LocatedIssue[] = [];
  validateMessages(root, issues);
  const stages = listNodes(yamlField(root, 'stages'));
  validateAgentAndOptional(root, stages, issues);
  validateBlockInputValues(stages, issues);
  return issues;
}

/** §1.2 rules 2, 4 and 5: the shape of `server:` that needs no manifest. */
function validateServerForms(
  root: YamlNode,
  stages: readonly YamlNode[],
  issues: LocatedIssue[],
): void {
  const hasOwner = yamlField(root, 'owner') !== null;
  for (const stage of stages) {
    const server = yamlField(stage, 'server');
    if (server === null) continue;

    const isCheck = yamlMap(server) !== undefined;
    const mode = isCheck ? 'require-check' : yamlWord(server);
    const phase = yamlWord(yamlField(stage, 'phase')) || 'pre-merge';

    if ((phase === 'merge' || phase === 'post-merge') && mode !== 'local-only') {
      add(issues, server, 'a merge or post-merge stage only takes server: local-only');
      continue;
    }

    if (isCheck) {
      const nameNode = yamlField(server, 'require-check');
      const name = yamlWord(nameNode);
      if (name.length > 100) {
        add(issues, nameNode, 'a required check name has 1 to 100 characters');
      }
      if (name === 'ai-workflows' || name === 'ai-workflows/advisory') {
        add(issues, nameNode, "cannot require the judge's own status");
      }
    }

    const uses = yamlWord(yamlField(yamlField(stage, 'gate'), 'uses'));
    if (mode === 'attestation' && uses === 'ai-workflows/approval-comment@1' && !hasOwner) {
      add(issues, server, 'server: attestation of approval-comment needs owner: in the recipe');
    }
  }
}

export function validateSemantics(root: YamlNode): LocatedIssue[] {
  const issues: LocatedIssue[] = [];
  const classify = yamlField(root, 'classify');
  const kinds = yamlField(root, 'kinds');
  const stagesNode = yamlField(root, 'stages');
  const stages = listNodes(stagesNode);
  const declared = new Set(
    (yamlMap(classify)?.items ?? []).map((pair) => yamlWord(pair.key)),
  );

  validateGlobs(classify, issues);
  validateGlobs(yamlField(kinds, 'from-paths'), issues);
  for (const elevation of listNodes(yamlField(kinds, 'elevate'))) {
    validateClasses(yamlField(elevation, 'when'), declared, issues);
  }
  for (const stage of stages) {
    validateClasses(yamlField(stage, 'applies-if'), declared, issues);
  }

  validateVocabulary(root, stages, declared, issues);
  validatePieces(root, issues);
  validateHooks(root, issues);
  validateServerForms(root, stages, issues);
  validatePhases(stages, stagesNode, issues);
  validateStageRules(stages, issues);
  validateStageLinks(stages, issues);
  return issues;
}
