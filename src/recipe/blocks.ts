import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { GateNature } from '../contract.js';
import {
  ALL_VALID_WHILE,
  type BlockManifest,
  type InputSpec,
  type ValidWhile,
} from '../blocks/manifest.js';
import { ENGINE_BLOCKS, engineBlockManifest } from '../blocks/registry.js';
import { validateCommandLine } from './command-line.js';
import { validGlob } from './glob.js';
import { locatedRecipeErrors, parseRecipe, readStrictYaml } from './parse.js';
import type { Recipe, RecipeError } from './types.js';
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

// PLAN-13-R2 §1.3 rules 4–8 and §2: after the recipe itself parses, every `uses:` is matched
// against the manifest of its block (engine or project), and every `with:` input is checked.
// Project blocks are read from `.ai-workflows/blocks/<name>/block.yml` with the recipe's own
// strict reader, so both reject the same syntax with the same line and column.

const VALID_NATURES: ReadonlySet<string> = new Set<GateNature>([
  'recompute',
  'structure',
  'execution-record',
  'attest',
]);

const PROJECT_USES = /^\.\/\.ai-workflows\/blocks\/([a-z][a-z0-9-]*)$/;
const ENGINE_USES = /^ai-workflows\/([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;
const PLACEHOLDER = /^\{[^{}]*\}$/;
const INPUT_NAME = /^[a-z][a-z0-9-]*$/;
const INPUT_TYPES = [
  'string',
  'integer',
  'boolean',
  'string-list',
  'command',
  'glob-list',
  'object',
  'object-list',
] as const;

export type CheckRecipeResult =
  | { ok: true; recipe: Recipe }
  | { ok: false; errors: readonly RecipeError[] };

interface Location {
  readonly rootDir: string;
  readonly lineCounter: ReturnType<typeof readStrictYaml>['lineCounter'];
  /** Located against the recipe file, reported as recipe errors at the end. */
  readonly recipeIssues: LocatedIssue[];
  /** Already located against the block file they came from. */
  readonly fileErrors: RecipeError[];
}

function add(issues: LocatedIssue[], node: YamlNode, message: string): void {
  issues.push({ offset: nodeStart(node), message });
}

/**
 * Parses the recipe exactly as `parseRecipe` does; when that succeeds, checks every stage's
 * block against its manifest. Defaults are NOT applied: the recipe keeps `with:` as written
 * and defaults belong to the block when it is created.
 */
export async function checkRecipe(
  text: string,
  file: string,
  options: { root: string },
): Promise<CheckRecipeResult> {
  const parsed = parseRecipe(text, file);
  if (!parsed.ok) return parsed;

  const strict = readStrictYaml(text);
  const location: Location = {
    rootDir: options.root,
    lineCounter: strict.lineCounter,
    recipeIssues: [],
    fileErrors: [],
  };

  const stages = yamlSeq(yamlField(strict.root, 'stages'))?.items ?? [];
  for (const stage of stages) {
    const gate = yamlField(stage, 'gate');
    const usesNode = yamlField(gate, 'uses');
    if (usesNode === null) {
      checkRunServer(stage, location);
      continue;
    }
    await checkStageBlock(stage, gate, usesNode, stages, location);
  }

  if (location.recipeIssues.length === 0 && location.fileErrors.length === 0) {
    return { ok: true, recipe: parsed.recipe };
  }
  return {
    ok: false,
    errors: [
      ...locatedRecipeErrors(location.recipeIssues, location.lineCounter, file),
      ...location.fileErrors,
    ],
  };
}

async function checkStageBlock(
  stage: YamlNode,
  gate: YamlNode,
  usesNode: YamlNode,
  stages: readonly YamlNode[],
  location: Location,
): Promise<void> {
  const uses = yamlWord(usesNode);
  const manifest = await readBlock(uses, usesNode, location);
  if (manifest === undefined) return;

  checkNature(stage, uses, manifest, location.recipeIssues);
  checkValidity(stage, usesNode, uses, manifest, location.recipeIssues);
  checkInputs(gate, usesNode, uses, manifest, stage, stages, location.recipeIssues);
  checkServerMode(stage, gate, uses, manifest, location.recipeIssues);
}

function stagePhase(stage: YamlNode): string {
  return yamlWord(yamlField(stage, 'phase')) || 'pre-merge';
}

/** The written `server:` value, or `'require-check'` when it is a map. */
function serverMode(serverNode: YamlNode): string {
  return yamlMap(serverNode) !== undefined ? 'require-check' : yamlWord(serverNode);
}

/** §1.2 rule 1: a pre-merge stage says how GitHub checks it. */
function checkPreMergeServerPresent(stage: YamlNode, issues: LocatedIssue[]): void {
  const idNode = yamlField(stage, 'id');
  add(issues, idNode, `stage "${yamlWord(idNode)}" is pre-merge and needs server:`);
}

/** §1.2 rule 3, for a `run:` stage: only `require-check` (or local-only when optional). */
function checkRunServer(stage: YamlNode, location: Location): void {
  if (stagePhase(stage) !== 'pre-merge') return;
  const serverNode = yamlField(stage, 'server');
  if (serverNode === null) {
    checkPreMergeServerPresent(stage, location.recipeIssues);
    return;
  }
  const mode = serverMode(serverNode);
  if (mode === 'local-only' || mode === 'require-check') return;
  add(location.recipeIssues, serverNode, 'a project block or run: only takes server: require-check');
}

/** §1.2 rules 1, 3 and 6 for a stage whose gate names a block. */
function checkServerMode(
  stage: YamlNode,
  gate: YamlNode,
  uses: string,
  manifest: BlockManifest,
  issues: LocatedIssue[],
): void {
  if (stagePhase(stage) !== 'pre-merge') return;
  const serverNode = yamlField(stage, 'server');
  if (serverNode === null) {
    checkPreMergeServerPresent(stage, issues);
    return;
  }
  const mode = serverMode(serverNode);
  if (mode === 'local-only') return;

  if (!ENGINE_USES.test(uses)) {
    if (mode !== 'require-check') {
      add(issues, serverNode, 'a project block or run: only takes server: require-check');
    }
    return;
  }

  if (!manifest.server.includes(mode as (typeof manifest.server)[number])) {
    add(
      issues,
      serverNode,
      `block "${uses}" cannot use server: ${mode}; it allows: ${manifest.server.join(', ')}`,
    );
    return;
  }

  if (
    mode === 'recompute' &&
    uses === 'ai-workflows/benchmark-sources@1' &&
    yamlValue(yamlField(yamlField(gate, 'with'), 'check-reachable')) === true
  ) {
    add(issues, serverNode, 'check-reachable cannot be recomputed on GitHub; use require-check');
  }
}

/** Engine or project block; adds the reason and returns undefined when it cannot be read. */
async function readBlock(
  uses: string,
  usesNode: YamlNode,
  location: Location,
): Promise<BlockManifest | undefined> {
  const engine = ENGINE_USES.exec(uses);
  if (engine) {
    const name = engine[1] ?? '';
    const manifest = engineBlockManifest(uses);
    if (manifest) return manifest;
    if (Object.hasOwn(ENGINE_BLOCKS, name)) {
      add(location.recipeIssues, usesNode, `block "ai-workflows/${name}" has no version ${engine[2] ?? ''}`);
    } else {
      add(location.recipeIssues, usesNode, `unknown engine block "${uses}"`);
    }
    return undefined;
  }

  const project = PROJECT_USES.exec(uses);
  if (project) return readProjectBlock(project[1] ?? '', uses, usesNode, location);
  return undefined;
}

async function readProjectBlock(
  name: string,
  uses: string,
  usesNode: YamlNode,
  location: Location,
): Promise<BlockManifest | undefined> {
  const relativePath = `.ai-workflows/blocks/${name}/block.yml`;
  const blockDir = join(location.rootDir, '.ai-workflows/blocks', name);
  let content: string;
  try {
    content = await readFile(join(location.rootDir, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      add(location.recipeIssues, usesNode, `project block "${uses}" has no block.yml`);
      return undefined;
    }
    throw error;
  }

  const strict = readStrictYaml(content, 'empty block');
  const issues: LocatedIssue[] = [...strict.issues];
  if (issues.length === 0) validateBlockManifest(strict.root, blockDir, issues);
  if (issues.length > 0) {
    location.fileErrors.push(...locatedRecipeErrors(issues, strict.lineCounter, relativePath));
    return undefined;
  }

  return constructBlockManifest(name, strict.root);
}

/** A project block read the strict way, with its runtime manifest and its YAML root node. */
export interface StrictProjectBlock {
  readonly manifest: BlockManifest;
  readonly blockDir: string;
  readonly relativePath: string;
  readonly root: YamlNode;
}

/**
 * Reads `.ai-workflows/blocks/<name>/block.yml` with the recipe's own strict reader and its own
 * validation, throwing the first error when it is invalid. `compileRecipe` uses it so a block
 * that `validate` would reject — an unknown `kind` included — is never guessed at run time.
 */
export async function loadProjectBlockStrict(
  rootDir: string,
  name: string,
  uses: string,
): Promise<StrictProjectBlock> {
  const relativePath = `.ai-workflows/blocks/${name}/block.yml`;
  const blockDir = join(rootDir, '.ai-workflows/blocks', name);
  let content: string;
  try {
    content = await readFile(join(rootDir, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`project block "${uses}" has no block.yml`);
    }
    throw error;
  }

  const strict = readStrictYaml(content, 'empty block');
  const issues: LocatedIssue[] = [...strict.issues];
  if (issues.length === 0) validateBlockManifest(strict.root, blockDir, issues);
  if (issues.length > 0) {
    const errors = locatedRecipeErrors(issues, strict.lineCounter, relativePath);
    throw new Error(errors[0]?.message ?? `invalid block.yml of project block "${uses}"`);
  }

  return {
    manifest: constructBlockManifest(name, strict.root),
    blockDir,
    relativePath,
    root: strict.root,
  };
}

/** §1.3 rule 5: the stage's nature must be one the manifest allows. */
export function natureComplaint(
  uses: string,
  nature: string,
  manifest: BlockManifest,
): string | undefined {
  if (manifest.natures.includes(nature as GateNature)) return undefined;
  return `block "${uses}" cannot be ${nature}; it allows: ${manifest.natures.join(', ')}`;
}

/** §1.3 rule 6 and R14: the written validity, or the default `same-sha`, must be allowed. */
export function validityComplaint(
  uses: string,
  validWhile: string,
  manifest: BlockManifest,
): string | undefined {
  const allowed = manifest.validWhile ?? ALL_VALID_WHILE;
  if (allowed.includes(validWhile as ValidWhile)) return undefined;
  return `block "${uses}" cannot use valid-while: ${validWhile}; it allows: ${allowed.join(', ')}`;
}

function checkNature(
  stage: YamlNode,
  uses: string,
  manifest: BlockManifest,
  issues: LocatedIssue[],
): void {
  const natureNode = yamlField(stage, 'nature');
  const nature = yamlWord(natureNode);
  const complaint = natureComplaint(uses, nature, manifest);
  if (complaint !== undefined) add(issues, natureNode, complaint);
}

/** §1.3 rule 6 and R14: the written validity, or the default `same-sha`, must be allowed. */
function checkValidity(
  stage: YamlNode,
  usesNode: YamlNode,
  uses: string,
  manifest: BlockManifest,
  issues: LocatedIssue[],
): void {
  const allowed = manifest.validWhile ?? ALL_VALID_WHILE;
  const validWhileNode = yamlField(stage, 'valid-while');
  if (validWhileNode !== null) {
    const value = yamlWord(validWhileNode);
    const complaint = validityComplaint(uses, value, manifest);
    if (complaint !== undefined) add(issues, validWhileNode, complaint);
    return;
  }
  if (!allowed.includes('same-sha')) {
    add(issues, usesNode, `block "${uses}" needs valid-while: ${allowed.join(' or ')}`);
  }
}

/** §1.3 rule 7: every key of `with:` is an input of the manifest, with the declared shape. */
function checkInputs(
  gate: YamlNode,
  usesNode: YamlNode,
  uses: string,
  manifest: BlockManifest,
  stage: YamlNode,
  stages: readonly YamlNode[],
  issues: LocatedIssue[],
): void {
  const withNode = yamlField(gate, 'with');
  const provided = new Map<string, YamlNode>();
  if (withNode !== null) {
    const map = yamlMap(withNode);
    if (map === undefined) {
      add(issues, withNode, '"with" must be a map');
    } else {
      for (const pair of map.items) {
        const key = yamlWord(pair.key);
        if (!Object.hasOwn(manifest.inputs, key)) {
          add(issues, pair.key, `unknown input "${key}" for block "${uses}"`);
          continue;
        }
        provided.set(key, pair.value);
      }
    }
  }

  const context = { stage, stages };
  for (const [key, spec] of Object.entries(manifest.inputs)) {
    const node = provided.get(key);
    if (node === undefined) {
      if (isRequired(spec)) {
        add(issues, usesNode, `missing required input "${key}" for block "${uses}"`);
      }
      continue;
    }
    validateInput(node, spec, key, `input "${key}"`, context, issues);
  }

  // A waiver is a written excuse: without the file that carries it, there is nothing to read.
  if (Object.hasOwn(manifest.inputs, 'spec') && provided.has('waiver') && !provided.has('spec')) {
    add(issues, usesNode, `input "spec" is required with "waiver"`);
  }
}

function isRequired(spec: InputSpec): boolean {
  return 'required' in spec && spec.required === true;
}

interface InputContext {
  readonly stage: YamlNode;
  readonly stages: readonly YamlNode[];
}

function validateInput(
  node: YamlNode,
  spec: InputSpec,
  inputName: string,
  subject: string,
  context: InputContext,
  issues: LocatedIssue[],
): void {
  switch (spec.type) {
    case 'string':
      validateStringInput(node, spec, subject, issues);
      if (inputName === 'red-stage') {
        const value = yamlValue(node);
        if (typeof value === 'string' && !namesEarlierRedTestStage(value, context)) {
          add(issues, node, 'input "red-stage" must name an earlier stage that uses ai-workflows/red-test@1');
        }
      }
      return;
    case 'integer':
      validateIntegerInput(node, spec, subject, issues);
      return;
    case 'boolean':
      if (typeof yamlValue(node) !== 'boolean') add(issues, node, `${subject} must be true or false`);
      return;
    case 'string-list':
      validateListInput(node, subject, false, issues);
      return;
    case 'glob-list':
      validateListInput(node, subject, true, issues);
      return;
    case 'command':
      validateCommandInput(node, spec, inputName, subject, issues);
      return;
    case 'object':
      validateObjectInput(node, spec, inputName, subject, context, issues);
      return;
    case 'object-list':
      validateObjectListInput(node, spec, inputName, subject, context, issues);
      return;
  }
}

function validateStringInput(
  node: YamlNode,
  spec: Extract<InputSpec, { type: 'string' }>,
  subject: string,
  issues: LocatedIssue[],
): void {
  const value = yamlValue(node);
  if (typeof value !== 'string') {
    add(issues, node, `${subject} must be a string`);
    return;
  }
  if (spec.enum && !spec.enum.includes(value)) {
    add(issues, node, `${subject} must be one of: ${spec.enum.join(', ')}`);
  }
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
    add(issues, node, `${subject} must match ${spec.pattern}`);
  }
}

function validateIntegerInput(
  node: YamlNode,
  spec: Extract<InputSpec, { type: 'integer' }>,
  subject: string,
  issues: LocatedIssue[],
): void {
  const value = yamlValue(node);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    add(issues, node, `${subject} must be an integer`);
    return;
  }
  if (spec.min !== undefined && value < spec.min) {
    add(issues, node, `${subject} must be at least ${spec.min}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    add(issues, node, `${subject} must be at most ${spec.max}`);
  }
}

function validateListInput(
  node: YamlNode,
  subject: string,
  globs: boolean,
  issues: LocatedIssue[],
): void {
  const list = yamlSeq(node);
  if (list === undefined) {
    add(issues, node, `${subject} must be a list`);
    return;
  }
  for (const item of list.items) {
    const value = yamlValue(item);
    if (typeof value !== 'string') {
      add(issues, item, `${subject} must be a list of strings`);
      continue;
    }
    if (globs && !validGlob(value, true)) {
      add(issues, item, `unsupported glob "${value}": only *, ** and ? are allowed`);
    }
  }
}

function validateCommandInput(
  node: YamlNode,
  spec: Extract<InputSpec, { type: 'command' }>,
  inputName: string,
  subject: string,
  issues: LocatedIssue[],
): void {
  const value = yamlValue(node);
  if (typeof value !== 'string') {
    add(issues, node, `${subject} must be a string`);
    return;
  }
  validateCommandLine(node, issues, inputName);
  if (spec.requireTests === true && !value.split(' ').includes('{tests}')) {
    add(issues, node, `input "${inputName}" must contain {tests}`);
  }
}

function validateObjectInput(
  node: YamlNode,
  spec: Extract<InputSpec, { type: 'object' }>,
  inputName: string,
  subject: string,
  context: InputContext,
  issues: LocatedIssue[],
): void {
  const map = yamlMap(node);
  if (map === undefined) {
    add(issues, node, `${subject} must be a map`);
    return;
  }
  validateFields(map, spec.fields, inputName, context, node, issues);
}

function validateObjectListInput(
  node: YamlNode,
  spec: Extract<InputSpec, { type: 'object-list' }>,
  inputName: string,
  subject: string,
  context: InputContext,
  issues: LocatedIssue[],
): void {
  const list = yamlSeq(node);
  if (list === undefined) {
    add(issues, node, `${subject} must be a list`);
    return;
  }
  for (const item of list.items) {
    const map = yamlMap(item);
    if (map === undefined) {
      add(issues, item, `${subject} must be a list of maps`);
      continue;
    }
    validateFields(map, spec.items, inputName, context, item, issues);
  }
}

function validateFields(
  map: ReturnType<typeof yamlMap> & object,
  fields: Readonly<Record<string, InputSpec>>,
  inputName: string,
  context: InputContext,
  start: YamlNode,
  issues: LocatedIssue[],
): void {
  const provided = new Set<string>();
  for (const pair of map.items) {
    const field = yamlWord(pair.key);
    if (!Object.hasOwn(fields, field)) {
      add(issues, pair.key, `unknown field "${field}" in input "${inputName}"`);
      continue;
    }
    provided.add(field);
    const fieldSpec = fields[field];
    if (fieldSpec === undefined) continue;
    validateInput(pair.value, fieldSpec, inputName, `field "${field}" in input "${inputName}"`, context, issues);
  }
  for (const [field, fieldSpec] of Object.entries(fields)) {
    if (!provided.has(field) && isRequired(fieldSpec)) {
      add(issues, start, `missing required field "${field}" in input "${inputName}"`);
    }
  }
}

/** True when `id` names a stage reachable through `after` that gates with red-test@1. */
function namesEarlierRedTestStage(id: string, context: InputContext): boolean {
  const byId = new Map<string, YamlNode>();
  for (const stage of context.stages) byId.set(yamlWord(yamlField(stage, 'id')), stage);

  const seen = new Set<string>();
  let cursor = yamlField(context.stage, 'after');
  while (cursor !== null) {
    const current = yamlWord(cursor);
    if (seen.has(current)) return false;
    seen.add(current);
    if (current === id) {
      const ancestor = byId.get(current);
      const uses = yamlWord(yamlField(yamlField(ancestor ?? null, 'gate'), 'uses'));
      return uses === 'ai-workflows/red-test@1';
    }
    const ancestor = byId.get(current);
    cursor = yamlField(ancestor ?? null, 'after');
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// block.yml
// ---------------------------------------------------------------------------------------

const BLOCK_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'natures',
  'valid-while',
  'inputs',
  'main',
  'run',
  'timeout-minutes',
]);

const INPUT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'required',
  'default',
  'min',
  'max',
  'enum',
  'pattern',
  'fields',
  'items',
]);

function validateBlockManifest(root: YamlNode, blockDir: string, issues: LocatedIssue[]): void {
  const object = yamlMap(root);
  if (object === undefined) {
    add(issues, root, 'a block manifest must be a map');
    return;
  }

  for (const pair of object.items) {
    const key = yamlWord(pair.key);
    if (!BLOCK_KEYS.has(key)) add(issues, pair.key, `unknown key "${key}"`);
  }

  const kind = yamlWord(yamlField(root, 'kind'));
  if (kind !== 'module' && kind !== 'command') {
    add(issues, yamlField(root, 'kind') ?? root, '"kind" must be module or command');
  }

  const natures = yamlSeq(yamlField(root, 'natures'));
  if (natures === undefined || natures.items.length === 0) {
    add(issues, yamlField(root, 'natures') ?? root, '"natures" must list at least one nature');
  } else {
    for (const item of natures.items) {
      const nature = yamlWord(item);
      if (!VALID_NATURES.has(nature)) {
        add(issues, item, `"natures" must be one of: ${[...VALID_NATURES].join(', ')}`);
      } else if (kind === 'command' && nature !== 'recompute' && nature !== 'structure') {
        add(issues, item, 'a command block can only be recompute or structure');
      }
    }
  }

  for (const item of yamlSeq(yamlField(root, 'valid-while'))?.items ?? []) {
    const value = yamlWord(item);
    if (!ALL_VALID_WHILE.includes(value as ValidWhile)) {
      add(issues, item, `"valid-while" must be one of: ${ALL_VALID_WHILE.join(', ')}`);
    }
  }

  const inputsNode = yamlField(root, 'inputs');
  if (inputsNode !== null) {
    const map = yamlMap(inputsNode);
    if (map === undefined) {
      add(issues, inputsNode, '"inputs" must be a map');
    } else {
      for (const pair of map.items) {
        const name = yamlWord(pair.key);
        if (!INPUT_NAME.test(name)) add(issues, pair.key, `"${name}" must match ^[a-z][a-z0-9-]*$`);
        parseInputSpec(pair.value, `inputs.${name}`, issues);
      }
    }
  }

  const mainNode = yamlField(root, 'main');
  const runNode = yamlField(root, 'run');
  if (kind === 'module') {
    if (mainNode === null) add(issues, root, 'a module block needs "main"');
    else if (!staysInside(blockDir, yamlWord(mainNode))) {
      add(issues, mainNode, '"main" must stay inside the block folder');
    }
  }
  if (kind === 'command') {
    if (runNode === null) {
      add(issues, root, 'a command block needs "run"');
    } else {
      validateCommandLine(runNode, issues, 'run');
      const { program, script } = runParts(yamlWord(runNode));
      if (program === undefined || !isPathProgram(program)) {
        add(
          issues,
          runNode,
          '"run" must start with a program on the PATH followed by a script of the block folder',
        );
      } else if (script === undefined) {
        add(issues, runNode, '"run" must name a script inside the block folder');
      } else if (!staysInside(blockDir, script)) {
        add(issues, runNode, '"run" must stay inside the block folder');
      }
    }
    const timeout = yamlField(root, 'timeout-minutes');
    if (timeout !== null) {
      const value = yamlValue(timeout);
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        add(issues, timeout, '"timeout-minutes" must be an integer');
      } else if (value > 120) {
        add(issues, timeout, '"timeout-minutes" must be at most 120');
      } else if (value < 1) {
        add(issues, timeout, '"timeout-minutes" must be at least 1');
      }
    }
  }
}

/** Builds the runtime manifest from a block.yml that already passed validation. */
function constructBlockManifest(name: string, root: YamlNode): BlockManifest {
  const kind: 'module' | 'command' = yamlWord(yamlField(root, 'kind')) === 'command'
    ? 'command'
    : 'module';
  const natures = (yamlSeq(yamlField(root, 'natures'))?.items ?? [])
    .map((item) => yamlWord(item) as GateNature);
  const validWhiles = (yamlSeq(yamlField(root, 'valid-while'))?.items ?? [])
    .map((item) => yamlWord(item) as ValidWhile);
  const inputs: Record<string, InputSpec> = {};
  for (const pair of yamlMap(yamlField(root, 'inputs'))?.items ?? []) {
    inputs[yamlWord(pair.key)] = parseInputSpec(pair.value, '', []);
  }
  return {
    name,
    kind,
    natures,
    ...(validWhiles.length === 0 ? {} : { validWhile: validWhiles }),
    // PLAN-13-R3 §1.3: a project block never declares server modes; it can only be a check.
    server: ['require-check'],
    inputs,
  };
}

function parseInputSpec(node: YamlNode, label: string, issues: LocatedIssue[]): InputSpec {
  const map = yamlMap(node);
  if (map === undefined) {
    add(issues, node, `"${label}" must be a map`);
    return { type: 'string' };
  }
  for (const pair of map.items) {
    const key = yamlWord(pair.key);
    if (!INPUT_KEYS.has(key)) add(issues, pair.key, `unknown key "${key}"`);
  }

  const requiredNode = yamlField(node, 'required');
  const requiredValue = yamlValue(requiredNode);
  if (requiredNode !== null && typeof requiredValue !== 'boolean') {
    add(issues, requiredNode, '"required" must be true or false');
  }
  const requiredField = requiredValue === true ? { required: true as const } : {};
  const defaultNode = yamlField(node, 'default');
  const defaultValue = yamlValue(defaultNode);

  const typeNode = yamlField(node, 'type');
  const type = yamlWord(typeNode);
  if (typeNode !== null && !(INPUT_TYPES as readonly string[]).includes(type)) {
    add(issues, typeNode, `"type" must be one of: ${INPUT_TYPES.join(', ')}`);
  }

  switch (type) {
    case 'integer': {
      const min = integerField(node, 'min', issues);
      const max = integerField(node, 'max', issues);
      const fallback = defaultInteger(defaultNode, defaultValue, min, max, issues);
      return {
        type: 'integer',
        ...requiredField,
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
    }
    case 'boolean': {
      const fallback = defaultBoolean(defaultNode, defaultValue, issues);
      return {
        type: 'boolean',
        ...requiredField,
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case 'string-list':
      return {
        type: 'string-list',
        ...requiredField,
        ...defaultStringList(defaultNode, defaultValue, issues),
      };
    case 'glob-list':
      return {
        type: 'glob-list',
        ...requiredField,
        ...defaultStringList(defaultNode, defaultValue, issues),
      };
    case 'command': {
      const fallback = defaultString(defaultNode, defaultValue, issues);
      return {
        type: 'command',
        ...requiredField,
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case 'object':
      return {
        type: 'object',
        ...requiredField,
        fields: readFields(yamlField(node, 'fields'), label, issues),
      };
    case 'object-list':
      return {
        type: 'object-list',
        ...requiredField,
        items: readFields(yamlField(node, 'items'), label, issues),
      };
    default: {
      const pattern = yamlValue(yamlField(node, 'pattern'));
      const values = yamlSeq(yamlField(node, 'enum'))?.items.map((item) => yamlWord(item));
      const fallback = defaultString(defaultNode, defaultValue, issues);
      if (fallback !== undefined && values !== undefined && !values.includes(fallback)) {
        add(issues, defaultNode, `"default" must be one of: ${values.join(', ')}`);
      }
      return {
        type: 'string',
        ...requiredField,
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(typeof pattern === 'string' ? { pattern } : {}),
        ...(values === undefined ? {} : { enum: values }),
      };
    }
  }
}

function integerField(node: YamlNode, key: string, issues: LocatedIssue[]): number | undefined {
  const field = yamlField(node, key);
  const value = numeric(field);
  if (field !== null && value === undefined) add(issues, field, `"${key}" must be an integer`);
  return value;
}

function defaultString(node: YamlNode, value: unknown, issues: LocatedIssue[]): string | undefined {
  if (node === null) return undefined;
  if (typeof value !== 'string') {
    add(issues, node, '"default" must be a string');
    return undefined;
  }
  return value;
}

function defaultBoolean(node: YamlNode, value: unknown, issues: LocatedIssue[]): boolean | undefined {
  if (node === null) return undefined;
  if (typeof value !== 'boolean') {
    add(issues, node, '"default" must be true or false');
    return undefined;
  }
  return value;
}

function defaultStringList(
  node: YamlNode,
  value: unknown,
  issues: LocatedIssue[],
): { default?: readonly string[] } {
  if (node === null) return {};
  if (!isStringArray(value)) {
    add(issues, node, '"default" must be a list');
    return {};
  }
  return { default: value };
}

function defaultInteger(
  node: YamlNode,
  value: unknown,
  min: number | undefined,
  max: number | undefined,
  issues: LocatedIssue[],
): number | undefined {
  if (node === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    add(issues, node, '"default" must be an integer');
    return undefined;
  }
  if (min !== undefined && value < min) add(issues, node, `"default" must be at least ${min}`);
  if (max !== undefined && value > max) add(issues, node, `"default" must be at most ${max}`);
  return value;
}

function readFields(
  node: YamlNode,
  label: string,
  issues: LocatedIssue[],
): Readonly<Record<string, InputSpec>> {
  const map = yamlMap(node);
  if (map === undefined) {
    if (node !== null) add(issues, node, `"${label}" fields must be a map`);
    return {};
  }
  const fields: Record<string, InputSpec> = {};
  for (const pair of map.items) {
    const field = yamlWord(pair.key);
    if (!INPUT_NAME.test(field)) add(issues, pair.key, `"${field}" must match ^[a-z][a-z0-9-]*$`);
    fields[field] = parseInputSpec(pair.value, label, issues);
  }
  return fields;
}

function numeric(node: YamlNode): number | undefined {
  const value = yamlValue(node);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** `main` and the script of a `run:` must resolve inside the block folder, links included. */
export function staysInside(blockDir: string, candidate: string): boolean {
  if (candidate.length === 0 || isAbsolute(candidate)) return false;
  if (candidate.split(/[\\/]+/).includes('..')) return false;
  try {
    const block = realpathSync(blockDir);
    const target = realpathSync(resolve(blockDir, candidate));
    const inside = relative(block, target);
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  } catch {
    return false;
  }
}

/**
 * PLAN-13-R2 §2.2: the program of a `run:` is a program that lives on the PATH — no slash, no
 * backslash and no leading dot — so validation and execution agree on where it is looked up.
 */
export function isPathProgram(program: string): boolean {
  return (
    program.length > 0 &&
    !program.includes('/') &&
    !program.includes('\\') &&
    !program.startsWith('.')
  );
}

/** PLAN-13-R2 §2.2: the program, and the first non-flag non-marker argument after it. */
export function runParts(run: string): { program?: string; script?: string } {
  const args = run.split(' ').filter((argument) => argument.length > 0);
  const program = args[0];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument.startsWith('-') || PLACEHOLDER.test(argument)) continue;
    return program === undefined ? {} : { program, script: argument };
  }
  return program === undefined ? {} : { program };
}
