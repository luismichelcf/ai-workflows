import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  Gate,
  GateContext,
  GateResult,
  GateNature,
  JsonValue,
  PipelineConfig,
  StageConfig,
  Store,
} from '../contract.js';
import { createCommandGate } from '../blocks/command-block.js';
import type { BlockDefinition, EngineBlockDeps, ProviderRunner } from '../blocks/definition.js';
import type { BlockManifest, InputSpec, ValidWhile } from '../blocks/manifest.js';
import { createModuleGate } from '../blocks/module-block.js';
import { engineBlock } from '../blocks/registry.js';
import { checkQuarantine, launchInGroup, type ProcessGroupControl } from '../process-group.js';
import { appliesIfFor } from './applies.js';
import { describeChangeFromGit, type ChangeDeclared, type ChangeFacts } from './facts.js';
import { readStrictYaml } from './parse.js';
import type { Recipe, RecipeStage } from './types.js';
import { readJudged, recordCleanUpdate, stillValidFor } from './validity.js';
import {
  yamlField,
  yamlMap,
  yamlSeq,
  yamlValue,
  yamlWord,
  type YamlNode,
} from './validation.js';

// PLAN-13-R2 §2.2, §2.3, §5 and §6: the recipe becomes the engine's configuration. Each
// stage's block is built once here — the engine registry, the extra blocks a caller hands in,
// a project block read from disk, or a `run:` command — and its gate is wrapped so the engine
// seals what was judged. The result also carries `describeChange`, `confirmFacts` and
// `confirmQuarantine`, which the engine calls to read the facts of a run, to check before
// `done` that the working tree still matches them, and to ask the system again whether a
// quarantined process group is empty.

export interface CompileLimits {
  readonly commandTimeoutMs?: number;
  readonly stdoutBytes?: number;
}

export interface CompileRecipeDeps {
  readonly root: string;
  readonly baseRef: string;
  readonly declared: (piece: string) => ChangeDeclared;
  readonly store: Store;
  /** Blocks handed in by the caller, tried before the engine registry. Used by tests. */
  readonly extraBlocks?: Readonly<Record<string, BlockDefinition>>;
  /** How a command block's group is launched and re-checked. Defaults to the real mechanism. */
  readonly processGroups?: ProcessGroupControl;
  /** How a block runs a coding CLI. Defaults to the real process group. */
  readonly providers?: ProviderRunner;
  readonly limits?: CompileLimits;
}

export interface CompiledRecipe {
  readonly config: PipelineConfig;
  describeChange(piece: string): Promise<ChangeFacts>;
  /** The motive to block on when the run's facts still hold, or `undefined` when they do. */
  confirmFacts(change: unknown): Promise<string | undefined>;
  /** The motive to stay blocked while the quarantined group is not empty. */
  confirmQuarantine(quarantine: JsonValue): Promise<string | undefined>;
}

const DEFAULT_GROUPS: ProcessGroupControl = { launch: launchInGroup, check: checkQuarantine };
const PROJECT_USES = /^\.\/\.ai-workflows\/blocks\/([a-z][a-z0-9-]*)$/;

interface Judged {
  readonly sha: string;
  readonly snapshot: string;
  readonly fingerprint: string;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldOf(value, key);
  return typeof field === 'string' ? field : undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The facts the engine will seal, read from the change it computed for the run. */
function judgedOf(change: unknown): Judged | undefined {
  const sha = stringField(change, 'sha');
  const snapshot = stringField(change, 'snapshot');
  const fingerprint = stringField(change, 'fingerprint');
  if (sha === undefined || snapshot === undefined || fingerprint === undefined) return undefined;
  return { sha, snapshot, fingerprint };
}

function assertSameTree(now: { sha: string; snapshot: string }, judged: Judged): void {
  if (now.sha !== judged.sha || now.snapshot !== judged.snapshot) {
    throw new Error('the working tree changed while the stage ran');
  }
}

/**
 * Wraps a block's gate so the engine seals `judged` from the facts of the run, and nothing is
 * sealed with a snapshot produced over different facts. The working tree is re-read just before
 * and just after the block; any difference throws and the piece is blocked technically.
 */
function sealedGate(gate: Gate, root: string): Gate {
  return async (context: GateContext): Promise<GateResult> => {
    const judged = judgedOf(context.change);
    if (judged === undefined) throw new Error('the change has no readable facts to judge');

    assertSameTree(await readJudged(root), judged);
    const result = await gate(context);
    assertSameTree(await readJudged(root), judged);

    if (result.ok === true) {
      return {
        ok: true,
        evidence: {
          judged: { sha: judged.sha, snapshot: judged.snapshot, fingerprint: judged.fingerprint },
          block: result.evidence ?? null,
        },
      };
    }
    return result;
  };
}

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function defaultValueOf(spec: InputSpec): unknown {
  return Object.hasOwn(spec, 'default') ? (spec as { readonly default?: unknown }).default : undefined;
}

/** Applies the manifest defaults and renames the keys of an object-shaped input to camelCase. */
function fieldsWithDefaults(
  fields: Readonly<Record<string, InputSpec>>,
  raw: unknown,
): Record<string, unknown> {
  const provided = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = Object.hasOwn(provided, key) ? provided[key] : defaultValueOf(spec);
    if (value === undefined) continue;
    result[camelCase(key)] = withDefaults(spec, value);
  }
  return result;
}

function withDefaults(spec: InputSpec, value: unknown): unknown {
  if (spec.type === 'object') return fieldsWithDefaults(spec.fields, value);
  if (spec.type === 'object-list') {
    if (!Array.isArray(value)) return value;
    return value.map((item) => fieldsWithDefaults(spec.items, item));
  }
  return value;
}

function blockInputs(manifest: BlockManifest, provided: unknown): Record<string, unknown> {
  return fieldsWithDefaults(manifest.inputs, provided);
}

// ---------------------------------------------------------------------------------------
// Project blocks
// ---------------------------------------------------------------------------------------

interface ProjectBlock {
  readonly manifest: BlockManifest;
  readonly blockDir: string;
  readonly kind: 'module' | 'command';
  readonly main?: string;
  readonly run?: string;
  readonly timeoutMinutes?: number;
}

/** Reads `.ai-workflows/blocks/<name>/block.yml` with the recipe's own strict YAML reader. */
async function readProjectBlock(root: string, name: string): Promise<ProjectBlock> {
  const blockDir = join(root, '.ai-workflows', 'blocks', name);
  const uses = `./.ai-workflows/blocks/${name}`;
  let text: string;
  try {
    text = await readFile(join(blockDir, 'block.yml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`project block "${uses}" has no block.yml`);
    }
    throw error;
  }

  const strict = readStrictYaml(text, 'empty block');
  const firstIssue = strict.issues[0];
  if (firstIssue !== undefined) {
    throw new Error(`project block "${uses}" has an invalid block.yml: ${firstIssue.message}`);
  }

  const rootNode = strict.root;
  const kindWord = yamlWord(yamlField(rootNode, 'kind'));
  const kind: 'module' | 'command' = kindWord === 'command' ? 'command' : 'module';
  const natures = (yamlSeq(yamlField(rootNode, 'natures'))?.items ?? []).map(
    (item) => yamlWord(item) as GateNature,
  );
  const validWhiles = (yamlSeq(yamlField(rootNode, 'valid-while'))?.items ?? [])
    .map((item) => yamlWord(item) as ValidWhile);
  const inputs = parseInputSpecs(yamlField(rootNode, 'inputs'));
  const mainNode = yamlField(rootNode, 'main');
  const runNode = yamlField(rootNode, 'run');
  const timeout = yamlValue(yamlField(rootNode, 'timeout-minutes'));

  const manifest: BlockManifest = {
    name: uses,
    kind,
    natures,
    ...(validWhiles.length === 0 ? {} : { validWhile: validWhiles }),
    inputs,
  };

  return {
    manifest,
    blockDir,
    kind,
    ...(mainNode === null ? {} : { main: yamlWord(mainNode) }),
    ...(runNode === null ? {} : { run: yamlWord(runNode) }),
    ...(typeof timeout === 'number' && Number.isInteger(timeout) ? { timeoutMinutes: timeout } : {}),
  };
}

function parseInputSpecs(node: YamlNode): Record<string, InputSpec> {
  const map = yamlMap(node);
  if (map === undefined) return {};
  const inputs: Record<string, InputSpec> = {};
  for (const pair of map.items) inputs[yamlWord(pair.key)] = parseInputSpec(pair.value);
  return inputs;
}

function parseInputSpec(node: YamlNode): InputSpec {
  const type = yamlWord(yamlField(node, 'type')) || 'string';
  const requiredField = yamlValue(yamlField(node, 'required')) === true ? { required: true as const } : {};
  const fallback = yamlValue(yamlField(node, 'default'));

  switch (type) {
    case 'integer': {
      const min = numericField(node, 'min');
      const max = numericField(node, 'max');
      return {
        type: 'integer',
        ...requiredField,
        ...(typeof fallback === 'number' ? { default: fallback } : {}),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
    }
    case 'boolean':
      return {
        type: 'boolean',
        ...requiredField,
        ...(typeof fallback === 'boolean' ? { default: fallback } : {}),
      };
    case 'string-list':
      return { type: 'string-list', ...requiredField, ...(isStringArray(fallback) ? { default: fallback } : {}) };
    case 'glob-list':
      return { type: 'glob-list', ...requiredField, ...(isStringArray(fallback) ? { default: fallback } : {}) };
    case 'command':
      return {
        type: 'command',
        ...requiredField,
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
      };
    case 'object':
      return { type: 'object', ...requiredField, fields: parseInputSpecs(yamlField(node, 'fields')) };
    case 'object-list':
      return { type: 'object-list', ...requiredField, items: parseInputSpecs(yamlField(node, 'items')) };
    default:
      return {
        type: 'string',
        ...requiredField,
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
      };
  }
}

function numericField(node: YamlNode, key: string): number | undefined {
  const value = yamlValue(yamlField(node, key));
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ---------------------------------------------------------------------------------------
// Stage blocks
// ---------------------------------------------------------------------------------------

/**
 * Resolves a stage's block: `extraBlocks` first, then a project block, then the engine
 * registry; a `run:` command is built here. Anything else is refused.
 */
async function resolveStageBlock(
  stage: RecipeStage,
  deps: CompileRecipeDeps,
  groups: ProcessGroupControl,
): Promise<BlockDefinition> {
  const { uses, run, with: withValue } = stage.gate;

  if (run !== undefined) {
    return {
      manifest: { name: stage.id, kind: 'command', natures: ['recompute', 'structure'], inputs: {} },
      create: (_inputs, engineDeps) =>
        createCommandGate({ run, root: engineDeps.root, groups, limits: deps.limits ?? {}, withValue }),
    };
  }
  if (uses === undefined) throw new Error(`stage "${stage.id}" has neither uses nor run`);

  if (deps.extraBlocks !== undefined && Object.hasOwn(deps.extraBlocks, uses)) {
    return deps.extraBlocks[uses] as BlockDefinition;
  }
  const engine = engineBlock(uses);
  if (engine !== undefined) return engine;
  if (uses.startsWith('ai-workflows/')) throw new Error(`unknown engine block "${uses}"`);

  const project = PROJECT_USES.exec(uses);
  if (project) {
    const block = await readProjectBlock(deps.root, project[1] ?? '');
    if (block.kind === 'module') {
      if (block.main === undefined) throw new Error(`project block "${uses}" has no main`);
      const mainPath = resolve(block.blockDir, block.main);
      return {
        manifest: block.manifest,
        create: (inputs, engineDeps) =>
          createModuleGate({ mainPath, root: engineDeps.root, store: engineDeps.store, inputs }),
      };
    }
    if (block.run === undefined) throw new Error(`project block "${uses}" has no run`);
    return {
      manifest: block.manifest,
      create: (_inputs, engineDeps) =>
        createCommandGate({
          run: block.run as string,
          root: engineDeps.root,
          groups,
          limits: deps.limits ?? {},
          withValue,
          blockDir: block.blockDir,
          ...(block.timeoutMinutes === undefined ? {} : { timeoutMinutes: block.timeoutMinutes }),
        }),
    };
  }
  throw new Error(`unknown block "${uses}"`);
}

/**
 * Translates a recipe into the engine's configuration. `create` runs once per stage, here,
 * with the inputs already completed and with the privileged deps — including `recordCleanUpdate`
 * bound to the store — so the stages the engine later runs are plain functions of their facts.
 */
export async function compileRecipe(
  recipe: Recipe,
  deps: CompileRecipeDeps,
): Promise<CompiledRecipe> {
  const stages: StageConfig[] = [];
  const groups = deps.processGroups ?? DEFAULT_GROUPS;
  // The default runs a coding CLI the same way a command block runs: inside a group of its
  // own, without a console, with the prompt on stdin, and the group always terminated.
  const providers: ProviderRunner =
    deps.providers ?? {
      run: async (invocation) => {
        const group = groups.launch({
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          stdin: invocation.stdin ?? '',
        });
        try {
          const exit = await group.wait();
          if (exit.kind === 'technical') throw new Error(exit.reason);
          return { output: exit.stdout, exitCode: exit.code };
        } finally {
          await group.terminate();
        }
      },
    };

  for (const stage of recipe.stages) {
    if (stage.retry !== undefined) {
      throw new Error(`stage "${stage.id}": retry is not available until slice 4`);
    }
    if (stage.required === false) {
      throw new Error(`stage "${stage.id}": required: false is not available until slice 4`);
    }

    const definition = await resolveStageBlock(stage, deps, groups);
    const inputs = blockInputs(definition.manifest, stage.gate.with);
    const engineDeps: EngineBlockDeps = {
      root: deps.root,
      baseRef: deps.baseRef,
      store: deps.store,
      providers,
      recipe,
      recordCleanUpdate: (update) =>
        recordCleanUpdate({
          store: deps.store,
          root: deps.root,
          baseRef: deps.baseRef,
          piece: update.piece,
          from: update.from,
          to: update.to,
        }),
    };
    const gate = definition.create(inputs, engineDeps);
    const appliesWhen = appliesIfFor(recipe, stage.id);

    stages.push({
      name: stage.id,
      summary: stage.summary,
      ...(stage.after === undefined ? {} : { after: stage.after }),
      nature: stage.nature,
      ...(appliesWhen === undefined ? {} : { appliesWhen }),
      stillValid: (entry, context) =>
        stillValidFor(stage.validWhile, entry, context, {
          root: deps.root,
          baseRef: deps.baseRef,
        }),
      ...(stage.needsHuman ? { needsHuman: true } : {}),
      gate: sealedGate(gate, deps.root),
    });
  }

  return {
    config: { locale: recipe.locale, stages },
    describeChange: (piece) =>
      describeChangeFromGit({
        root: deps.root,
        baseRef: deps.baseRef,
        recipe,
        piece,
        declared: deps.declared(piece),
      }),
    async confirmFacts(change: unknown): Promise<string | undefined> {
      const judged = judgedOf(change);
      if (judged === undefined) return 'the working tree changed during the run';
      const now = await readJudged(deps.root);
      return now.sha === judged.sha && now.snapshot === judged.snapshot
        ? undefined
        : 'the working tree changed during the run';
    },
    async confirmQuarantine(quarantine: JsonValue): Promise<string | undefined> {
      try {
        const answer = await groups.check(quarantine);
        return answer.empty ? undefined : answer.reason;
      } catch (error) {
        return `the quarantine could not be checked: ${reasonOf(error)}`;
      }
    },
  };
}
