// ai-workflows — deterministic stage engine for coding agents.
//
// Contract only. The orchestrator writes the types and the failing tests; the delegated
// builder fills in the bodies (PLAN-997 §3.5 D29, ADR 0110). Every export below throws
// until it is implemented, so a red test fails on behaviour and not on module resolution.

export type GateResult = { ok: true } | { ok: false; reason: string };

export interface GateContext {
  /** Issue number, slice id, or whatever the project uses to name one unit of work. */
  readonly piece: string;
}

export type Gate = (context: GateContext) => GateResult | Promise<GateResult>;

export interface StageConfig {
  /** Unique within the pipeline. */
  readonly name: string;
  /** Name of the stage that must pass before this one. Omitted for the first stage. */
  readonly after?: string;
  /**
   * A stage whose gate can only be satisfied by a person. When its gate says no, the piece
   * waits (`waiting:decision`) rather than being rejected — nothing is wrong, it is pending.
   */
  readonly needsHuman?: boolean;
  readonly gate: Gate;
}

export interface PipelineConfig {
  /** Language of everything the owner reads. The engine itself stays in English. */
  readonly locale: string;
  readonly stages: readonly StageConfig[];
}

export type ValidationResult = { ok: true } | { ok: false; errors: readonly string[] };

/**
 * Rejects a pipeline whose stage order cannot be resolved: no stages, duplicated names,
 * a dependency on an unknown stage, or a cycle. Errors name the offending stage.
 */
export function validateConfig(_config: PipelineConfig): ValidationResult {
  throw new Error('validateConfig: not implemented');
}

export type PieceState =
  | 'running'
  | 'done'
  | 'blocked:rejected'
  | 'blocked:technical'
  | 'waiting:decision'
  | 'parked';

export interface PieceStatus {
  readonly piece: string;
  /** Stage the piece stopped at. Undefined once every stage passed. */
  readonly stage?: string;
  readonly state: PieceState;
  /** Why it stopped, in the words the gate used. */
  readonly reason?: string;
}

export type EffectState = 'pending' | 'confirmed' | 'uncertain';

export interface EffectRecord {
  readonly state: EffectState;
  readonly result?: unknown;
}

/**
 * Where a piece's progress lives. The memory store is the reference implementation and the
 * one the tests use; the GitHub-backed store (slice 1 of the integration) implements the
 * same shape on top of labels, checks and a journal in the branch.
 */
export interface Store {
  /**
   * Takes the piece for `runId` using a version comparison, so two controllers racing for
   * the same piece cannot both win. Returns false if someone else holds it; true if the
   * caller already held it.
   */
  reserve(piece: string, runId: string): Promise<boolean>;
  release(piece: string, runId: string): Promise<void>;

  loadStatus(piece: string): Promise<PieceStatus | undefined>;
  saveStatus(status: PieceStatus): Promise<void>;

  /** Records the effect as `pending` before it is attempted. */
  beginEffect(piece: string, operationId: string): Promise<void>;
  confirmEffect(piece: string, operationId: string, result: unknown): Promise<void>;
  getEffect(piece: string, operationId: string): Promise<EffectRecord | undefined>;
  /**
   * Runs an external effect at most once. A confirmed effect returns its first result
   * without running again; one that threw is left `uncertain` and is never retried blindly.
   */
  runEffect<T>(piece: string, operationId: string, effect: () => Promise<T>): Promise<T>;
}

export function createMemoryStore(): Store {
  throw new Error('createMemoryStore: not implemented');
}

export interface Engine {
  /** Runs the piece from wherever it stopped, stage by stage, until one refuses to advance. */
  run(piece: string): Promise<PieceStatus>;
  status(piece: string): Promise<PieceStatus | undefined>;
  /** Parks the piece, keeping its work. A parked piece does not advance on the next run. */
  stop(piece: string, reason: string): Promise<PieceStatus>;
}

export interface EngineOptions {
  readonly config: PipelineConfig;
  readonly store: Store;
  /** Identifies this controller process. Defaults to a per-engine value. */
  readonly runId?: string;
}

export function createEngine(_options: EngineOptions): Engine {
  throw new Error('createEngine: not implemented');
}
