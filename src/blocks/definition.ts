import type { Gate, JsonValue, Store } from '../contract.js';
import type { Invocation, RawRun } from '../providers.js';
import type { ChangeFacts, ProjectFiles } from '../recipe/facts.js';
import type { Recipe } from '../recipe/types.js';
import type { JudgeGitHub } from '../judge/port.js';
import type { BlockManifest, ValidWhile } from './manifest.js';

// PLAN-13-R2 §2.1, §5 and §6: a block is its manifest plus the factory that builds its gate.
// Engine blocks receive `EngineBlockDeps`, which carries `recordCleanUpdate`: it lets only the
// engine's own blocks write `@clean-update` records, never a project block (whose gate only
// sees the public `GateContext`). `providers` runs a coding CLI (the external edge of a
// review) and `recipe` gives a block the vocabulary it must compare against.

/** How an engine block runs one coding CLI: the real process group, or a test's stand-in. */
export interface ProviderRunner {
  run(invocation: Invocation, options?: ProviderRunOptions): Promise<RawRun>;
}

/** The limits the engine hands the runner of a coding CLI (PLAN-13-R2 §11). */
export interface ProviderRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * What an engine block (or a block handed in as `extraBlocks`) receives when it is created.
 * The privileged `recordCleanUpdate` is deliberately not part of `GateContext`: project
 * blocks cannot write the journal records that prove a clean update.
 */
export interface EngineBlockDeps {
  readonly root: string;
  readonly baseRef: string;
  readonly store: Store;
  readonly providers: ProviderRunner;
  readonly recipe: Recipe;
  recordCleanUpdate(update: {
    readonly piece: string;
    readonly from: string;
    readonly to: string;
  }): Promise<void>;
}

/** One engine block: what it declares, and how its gate is built from its inputs. */
export interface BlockDefinition {
  readonly manifest: BlockManifest;
  create(inputs: Record<string, unknown>, deps: EngineBlockDeps): Gate;
  /**
   * PLAN-13-R3 §1.3: what the judge may run on GitHub, without the piece's working tree. A block
   * without a capability is not recomputable or attestable there, and the judge says so.
   */
  readonly server?: ServerCapability;
}

/** PLAN-13-R3 §1.3: what the judge hands a server recompute. */
export interface ServerContext {
  readonly facts: ChangeFacts;
  /** Reads the judged commit, never the disk. */
  readonly files: ProjectFiles;
  readonly locale: string;
  readonly piece: string;
  /** The trusted recipe: a recompute may need the vocabulary the change was judged with. */
  readonly recipe: Recipe;
}

/** PLAN-13-R3 §1.3, §3.6: what the judge hands a server attestation. */
export interface ServerAttestContext extends ServerContext {
  /** The checkout of the trusted commit, where the judge reads git objects. */
  readonly root: string;
  /** The head of the pull request (in a group, its own head, never the group). */
  readonly head: string;
  /** The live head of the main branch: the base of every diff and of the validity checks. */
  readonly trusted: string;
  readonly needsHuman: boolean;
  readonly validWhile: ValidWhile;
  /** The `owner:` of the base recipe, the only account whose order counts. */
  readonly owner?: string;
  readonly recipe: Recipe;
  readonly pullRequest: number;
  readonly github: JudgeGitHub;
  /** Brings commit objects the judge did not check out (a replaced head, a candidate). */
  fetchObjects(shas: string[]): Promise<void>;
}

/** The answer of a server part: never a bare boolean, always the outcome and its motive. */
export type ServerResult =
  | { readonly outcome: 'passed'; readonly evidence?: JsonValue }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'rejected' | 'waiting'; readonly reason: string }
  | { readonly outcome: 'technical'; readonly reason: string };

/** PLAN-13-R3 §1.3: the ways a block can be checked on GitHub. */
export interface ServerCapability {
  recompute?(inputs: Record<string, unknown>, context: ServerContext): Promise<ServerResult>;
  attestation?(inputs: Record<string, unknown>, context: ServerAttestContext): Promise<ServerResult>;
}
