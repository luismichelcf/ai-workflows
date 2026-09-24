import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EffectNeedsReconciliation,
  type Gate,
  type GateContext,
  type GateResult,
  type JsonValue,
  type PipelineConfig,
  type StageConfig,
  type Store,
} from '../contract.js';
import { createCommandGate } from '../blocks/command-block.js';
import { confirmEmptyGroup } from '../blocks/confirm-empty.js';
import type {
  AgentDeps,
  BlockDefinition,
  EngineBlockDeps,
  ProviderRunner,
  ReconcileAnswer,
} from '../blocks/definition.js';
import type { BlockManifest } from '../blocks/manifest.js';
import { createModuleGate } from '../blocks/module-block.js';
import { blockInputs, writtenInputs } from './inputs.js';
import { engineBlock } from '../blocks/registry.js';
import { gitEnvironment } from '../git-env.js';
import {
  DEFAULT_PROCESS_GROUPS,
  TEST_STDOUT_BYTES,
  type ProcessGroup,
  type ProcessGroupControl,
} from '../process-group.js';
import type { Invocation, RawRun } from '../providers.js';
import { appliesIfFor } from './applies.js';
import {
  loadProjectBlockStrict,
  natureComplaint,
  validityComplaint,
} from './blocks.js';
import { describeChangeFromGit, type ChangeDeclared, type ChangeFacts } from './facts.js';
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
  /** PLAN-13-R4 §3.0: the GitHub edge the final blocks receive. */
  readonly agent?: AgentDeps;
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

const PROJECT_USES = /^\.\/\.ai-workflows\/blocks\/([a-z][a-z0-9-]*)$/;

/** The real path of a folder, so every spelling (8.3 short names included) becomes one. */
function realRoot(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // A path that does not exist yet is left as given; a later read reports it honestly.
    return path;
  }
}

/** The limits of one review or build run, handed to whoever runs the coding CLI. */
export interface ProviderRunInGroupOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly processGroups?: ProcessGroupControl;
}

/**
 * Runs a coding CLI the same way a command block runs: inside a group of its own, without a
 * console, under a time limit, cancellable at once, and with the group ALWAYS confirmed before
 * it returns — an explicit "not empty" raises `ProcessTreeSurvived` whatever the command's exit
 * code was, because it is a fact and final; only a LOST answer is settled by asking the system
 * again, and even then only an affirmative "empty" lifts it (PLAN-13-R2 §11). A technical end
 * rejects with its motive.
 */
export async function runProviderInGroup(
  invocation: Invocation,
  options: ProviderRunInGroupOptions = {},
): Promise<RawRun> {
  const groups = options.processGroups ?? DEFAULT_PROCESS_GROUPS;
  const group: ProcessGroup = groups.launch({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    stdin: invocation.stdin ?? '',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    stdoutBytes: TEST_STDOUT_BYTES,
  });

  // Cancellation must be honoured at once, not when the CLI decides to end: the wait races the
  // signal, and on abort the group is emptied and confirmed right there.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    const signal = options.signal;
    if (signal?.aborted === true) {
      resolve('aborted');
      return;
    }
    onAbort = () => resolve('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const raced = await Promise.race([
      group.wait().then((exit) => ({ exit })),
      aborted.then(() => 'aborted' as const),
    ]);
    if (raced === 'aborted') {
      await confirmEmptyGroup(group, groups, invocation.command);
      throw new Error(`the run of "${invocation.command}" was stopped`);
    }
    const exit = raced.exit;
    if (exit.kind === 'technical') throw new Error(exit.reason);
    return { output: exit.stdout, exitCode: exit.code };
  } finally {
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
    await confirmEmptyGroup(group, groups, invocation.command);
  }
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

/**
 * PLAN-13-R4 §3.0.1 and §5: an effect that stays in doubt keeps blocking, optional stage or
 * not. It is the same class the engine already refuses to retry and to wave through, carrying
 * both the operation and the motive that could not settle it.
 */
class EffectStillInDoubt extends EffectNeedsReconciliation {
  constructor(piece: string, operationId: string, motive: string) {
    super(piece, operationId, 'uncertain');
    this.message = motive;
  }
}

/**
 * PLAN-13-R4 §3.0.1: an engine block with effects exports `reconcile`. When its gate leaves an
 * effect in doubt (`EffectNeedsReconciliation`), the reconciler reads the outside world, settles
 * the effect in the store, and the block is run one more time — never retried blindly. A
 * reconciler that cannot answer leaves the piece technical, naming the effect.
 */
function reconcilableGate(
  gate: Gate,
  definition: BlockDefinition,
  inputs: Record<string, unknown>,
  engineDeps: EngineBlockDeps,
  store: Store,
): Gate {
  const reconcile = definition.reconcile;
  if (reconcile === undefined) return gate;

  const cannot = (piece: string, operationId: string): Error =>
    new EffectStillInDoubt(
      piece,
      operationId,
      `effect "${operationId}" is in doubt and the block cannot reconcile it`,
    );

  return async (context: GateContext): Promise<GateResult> => {
    try {
      return await gate(context);
    } catch (error) {
      if (!(error instanceof EffectNeedsReconciliation)) throw error;

      const operationId = error.operationId;
      let answer: ReconcileAnswer;
      try {
        answer = await reconcile(inputs, operationId, context, engineDeps);
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        throw new EffectStillInDoubt(
          context.piece,
          operationId,
          `effect "${operationId}" is in doubt and reconciling it failed: ${message}`,
        );
      }
      if (typeof answer !== 'object' || answer === null) throw cannot(context.piece, operationId);
      // Settling the effect is a store write. If it fails, the effect is STILL in doubt: the
      // piece keeps blocking — even an optional stage — with the operation and the motive,
      // never a generic store failure that could be waved through.
      const settle = async (
        outcome: { readonly confirmed: JsonValue } | { readonly didNotHappen: true },
      ): Promise<void> => {
        try {
          await store.reconcileEffect(context.piece, operationId, outcome);
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure);
          throw new EffectStillInDoubt(
            context.piece,
            operationId,
            `effect "${operationId}" is in doubt and settling it failed: ${message}`,
          );
        }
      };
      if ('didNotHappen' in answer) {
        await settle({ didNotHappen: true });
      } else if ('confirmed' in answer) {
        await settle({ confirmed: answer.confirmed });
      } else {
        throw cannot(context.piece, operationId);
      }
      // The effect is settled now: run the block one more time, and only once.
      return await gate(context);
    }
  };
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

/**
 * Reads a project block with the recipe's own strict reader and validation (the same ones
 * `checkRecipe` uses), so an unknown `kind` or an escaping `main`/`run` is refused here too and
 * never guessed.
 */
async function readProjectBlock(root: string, name: string): Promise<ProjectBlock> {
  const uses = `./.ai-workflows/blocks/${name}`;
  const strict = await loadProjectBlockStrict(root, name, uses);
  const rootNode = strict.root;
  const mainNode = yamlField(rootNode, 'main');
  const runNode = yamlField(rootNode, 'run');
  const timeout = yamlValue(yamlField(rootNode, 'timeout-minutes'));

  return {
    manifest: strict.manifest,
    blockDir: strict.blockDir,
    kind: strict.manifest.kind,
    ...(mainNode === null ? {} : { main: yamlWord(mainNode) }),
    ...(runNode === null ? {} : { run: yamlWord(runNode) }),
    ...(typeof timeout === 'number' && Number.isInteger(timeout) ? { timeoutMinutes: timeout } : {}),
  };
}

/** The synthetic manifest of a stage written with `run:`: never a module, only recompute/structure. */
function runManifest(name: string): BlockManifest {
  return {
    name,
    kind: 'command',
    natures: ['recompute', 'structure'],
    server: ['require-check'],
    inputs: {},
  };
}

/**
 * PLAN-13-R2 §1.3 rules 5–6 and §2 re-checked where it matters: before creating anything, the
 * nature and the validity of every stage are checked against the manifest that will run it.
 * `compileRecipe` is the last door before a block runs, so it cannot trust that `validate` ran.
 */
async function assertManifestsAllow(
  recipe: Recipe,
  deps: CompileRecipeDeps,
  root: string,
): Promise<void> {
  for (const stage of recipe.stages) {
    const { uses, run } = stage.gate;
    let manifest: BlockManifest;
    if (run !== undefined) {
      manifest = runManifest(stage.id);
    } else {
      if (uses === undefined) throw new Error(`stage "${stage.id}" has neither uses nor run`);
      if (deps.extraBlocks !== undefined && Object.hasOwn(deps.extraBlocks, uses)) {
        manifest = (deps.extraBlocks[uses] as BlockDefinition).manifest;
      } else if (uses.startsWith('ai-workflows/')) {
        const found = engineBlock(uses)?.manifest;
        if (found === undefined) throw new Error(`unknown engine block "${uses}"`);
        manifest = found;
      } else {
        const project = PROJECT_USES.exec(uses);
        if (!project) throw new Error(`unknown block "${uses}"`);
        manifest = (await readProjectBlock(root, project[1] ?? '')).manifest;
      }
    }

    const blockName = uses ?? stage.id;
    const nature = natureComplaint(blockName, stage.nature, manifest);
    if (nature !== undefined) throw new Error(nature);
    const validity = validityComplaint(blockName, stage.validWhile, manifest);
    if (validity !== undefined) throw new Error(validity);
  }
}

/** The folder git considers the top of the repository, or undefined outside a repository. */
function gitTopLevel(root: string): Promise<string | undefined> {
  return new Promise((resolveTop) => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: root,
        timeout: 60_000,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error, stdout) => {
        resolveTop(error === null ? (stdout ?? '').trim() : undefined);
      },
    );
  });
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
      manifest: {
        name: stage.id,
        kind: 'command',
        natures: ['recompute', 'structure'],
        server: ['require-check'],
        inputs: {},
      },
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
          withValue: writtenInputs(block.manifest.inputs, withValue),
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
  // A Windows 8.3 short name (`RUNNER~1`) is a valid spelling of the project folder, but git,
  // the module loader and the blocks all need one canonical path: the real one. It is resolved
  // once, here, and every path the engine builds from it is the long form.
  const root = realRoot(deps.root);
  // The whole translation assumes `root` is the repository: any git command and every block
  // that reads a path acts there. A subfolder would make the facts and the project blocks
  // disagree about which repository they belong to, so it is refused rather than guessed.
  const top = await gitTopLevel(root);
  if (top === undefined || realRoot(top) !== root) {
    throw new Error(`root "${deps.root}" is not the top of the repository`);
  }
  const rootDeps: CompileRecipeDeps = { ...deps, root };
  const stages: StageConfig[] = [];
  const groups = deps.processGroups ?? DEFAULT_PROCESS_GROUPS;
  // The same rules validate already applied, checked again here with the same functions: the
  // recipe is not trusted to have passed `validate` before it reaches the engine.
  await assertManifestsAllow(recipe, rootDeps, root);
  // The default runs a coding CLI the same way a command block runs: inside a group of its
  // own, without a console, with the prompt on stdin, under its time limit, cancellable, and
  // the group always confirmed empty (PLAN-13-R2 §11).
  const providers: ProviderRunner =
    deps.providers ?? {
      run: (invocation, options) =>
        runProviderInGroup(invocation, {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          processGroups: groups,
        }),
    };

  for (const stage of recipe.stages) {
    const definition = await resolveStageBlock(stage, rootDeps, groups);
    const inputs = blockInputs(definition.manifest, stage.gate.with);
    const engineDeps: EngineBlockDeps = {
      root,
      baseRef: deps.baseRef,
      store: deps.store,
      providers,
      recipe,
      ...(deps.agent === undefined ? {} : { agent: deps.agent }),
      recordCleanUpdate: (update) =>
        recordCleanUpdate({
          store: deps.store,
          root,
          baseRef: deps.baseRef,
          piece: update.piece,
          from: update.from,
          to: update.to,
        }),
    };
    const gate = reconcilableGate(
      definition.create(inputs, engineDeps),
      definition,
      inputs,
      engineDeps,
      deps.store,
    );
    const appliesWhen = appliesIfFor(recipe, stage.id);

    stages.push({
      name: stage.id,
      summary: stage.summary,
      ...(stage.after === undefined ? {} : { after: stage.after }),
      nature: stage.nature,
      ...(appliesWhen === undefined ? {} : { appliesWhen }),
      stillValid: (entry, context) =>
        stillValidFor(stage.validWhile, entry, context, {
          root,
          baseRef: deps.baseRef,
        }),
      ...(stage.needsHuman ? { needsHuman: true } : {}),
      // PLAN-13-R4 §5: `required: false` and `retry` reach the engine as written. The recipe
      // measures the wait in seconds; the engine measures it in milliseconds.
      required: stage.required,
      ...(stage.retry === undefined
        ? {}
        : { retry: { attempts: stage.retry.attempts, waitMs: stage.retry.waitSeconds * 1000 } }),
      gate: sealedGate(gate, root),
    });
  }

  return {
    config: { locale: recipe.locale, stages },
    describeChange: (piece) =>
      describeChangeFromGit({
        root,
        baseRef: deps.baseRef,
        recipe,
        piece,
        declared: deps.declared(piece),
      }),
    async confirmFacts(change: unknown): Promise<string | undefined> {
      const judged = judgedOf(change);
      if (judged === undefined) return 'the working tree changed during the run';
      const now = await readJudged(root);
      return now.sha === judged.sha && now.snapshot === judged.snapshot
        ? undefined
        : 'the working tree changed during the run';
    },
    async confirmQuarantine(quarantine: JsonValue): Promise<string | undefined> {
      // A stored quarantine is one object or a list of them. Every part is asked; only when
      // ALL of them are confirmed empty is the quarantine lifted. An empty list is not "all
      // empty": it names no process to confirm, so it can never be an affirmative answer.
      // Otherwise the first motive wins, so a person reads a reason rather than an aggregate.
      const parts = Array.isArray(quarantine) ? quarantine : [quarantine];
      if (parts.length === 0) return 'the quarantine names no processes to confirm';
      let firstMotive: string | undefined;
      for (const part of parts) {
        let motive: string | undefined;
        try {
          const answer = await groups.check(part);
          motive = answer.empty ? undefined : answer.reason;
        } catch (error) {
          motive = `the quarantine could not be checked: ${reasonOf(error)}`;
        }
        if (motive !== undefined && firstMotive === undefined) firstMotive = motive;
      }
      return firstMotive;
    },
  };
}
