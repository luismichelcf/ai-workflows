import type {
  Gate,
  GateContext,
  GateResult,
  PipelineConfig,
  StageConfig,
  Store,
} from '../contract.js';
import type { BlockDefinition, EngineBlockDeps } from '../blocks/definition.js';
import type { BlockManifest, InputSpec } from '../blocks/manifest.js';
import { engineBlock } from '../blocks/registry.js';
import { appliesIfFor } from './applies.js';
import { describeChangeFromGit, type ChangeDeclared, type ChangeFacts } from './facts.js';
import type { Recipe } from './types.js';
import { readJudged, recordCleanUpdate, stillValidFor } from './validity.js';

// PLAN-13-R2 §2.3, §5 and §6: the recipe becomes the engine's configuration. Each stage's
// block is built once here, its inputs are completed with the manifest defaults, and its gate
// is wrapped so the engine — never the block — seals what was judged. The result also carries
// `describeChange` and `confirmFacts`, which the engine calls to read the facts of a run and to
// check, before `done`, that the working tree still matches them.

export interface CompileRecipeDeps {
  readonly root: string;
  readonly baseRef: string;
  readonly declared: (piece: string) => ChangeDeclared;
  readonly store: Store;
  /** Blocks handed in by the caller, tried before the engine registry. Used by tests. */
  readonly extraBlocks?: Readonly<Record<string, BlockDefinition>>;
}

export interface CompiledRecipe {
  readonly config: PipelineConfig;
  describeChange(piece: string): Promise<ChangeFacts>;
  /** The motive to block on when the run's facts still hold, or `undefined` when they do. */
  confirmFacts(change: unknown): Promise<string | undefined>;
}

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

/** `extraBlocks` first, then the engine registry; anything else is refused. */
function resolveBlock(
  stage: { readonly id: string; readonly gate: { readonly uses?: string; readonly run?: string } },
  extraBlocks: Readonly<Record<string, BlockDefinition>> | undefined,
): BlockDefinition {
  const { uses, run } = stage.gate;
  if (uses === undefined) {
    if (run === undefined) throw new Error(`stage "${stage.id}" has neither uses nor run`);
    throw new Error(`stage "${stage.id}" uses run:, which is not available until part 5`);
  }
  if (extraBlocks !== undefined && Object.hasOwn(extraBlocks, uses)) {
    return extraBlocks[uses] as BlockDefinition;
  }
  const engine = engineBlock(uses);
  if (engine !== undefined) return engine;
  if (uses.startsWith('./')) {
    throw new Error(`project block "${uses}" is not available until part 5`);
  }
  throw new Error(`unknown engine block "${uses}"`);
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

  for (const stage of recipe.stages) {
    if (stage.retry !== undefined) {
      throw new Error(`stage "${stage.id}": retry is not available until slice 4`);
    }
    if (stage.required === false) {
      throw new Error(`stage "${stage.id}": required: false is not available until slice 4`);
    }

    const definition = resolveBlock(stage, deps.extraBlocks);
    const inputs = blockInputs(definition.manifest, stage.gate.with);
    const engineDeps: EngineBlockDeps = {
      root: deps.root,
      baseRef: deps.baseRef,
      store: deps.store,
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
  };
}
