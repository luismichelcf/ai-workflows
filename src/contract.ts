// The public contract of the engine. Types and signatures only.
//
// Rewritten after the slice-1 review: three independent reviewers returned 22 blocking
// findings, every one of them reproduced by running code. The verdict was not about the
// implementation — it was faithful to these signatures — but about the signatures
// themselves. What changed, and the case that forced each change:
//
//   1. Resume by evidence, not by position. Inserting a stage before a stopped piece made
//      that stage vanish and the piece finish as `done`.
//   2. `skipped` is an answer. A gate could only say yes or no, so an exemption from the
//      lane matrix would have been recorded as "ran and passed".
//   3. A journal exists. Two gates in the spec are validated *against the journal*; there
//      was nowhere to write it.
//   4. Gates receive the world, not a string. Otherwise every gate rediscovers the diff,
//      the token and the worktree on its own — and `--dry-run` is impossible.
//   5. The store admits what it promises. `reserve` returning a boolean cannot express a
//      version comparison, and over GitHub two controllers both win that race.

/** One unit of work: an issue, a slice, whatever the project uses to name it. */
export type PieceId = string;

/** Identifies one controller process, so a dead one's reservation can be told apart. */
export type RunId = string;

/**
 * Optimistic concurrency token. Every read hands one out; every write demands the one it
 * read. A write whose token is stale fails instead of overwriting — the only way a store
 * backed by a remote (where read and write are two round trips) can serialise writers.
 */
export type Version = string;

// ---------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------

/**
 * What a gate is allowed to claim. A gate that promises more than its nature permits is the
 * failure this whole engine exists to prevent, so it says which one it is.
 */
export type GateNature =
  /** The engine produces the result again now; prior evidence is irrelevant. */
  | 'recompute'
  /** Checks the shape of a document — not its truth, not its sufficiency. */
  | 'structure'
  /** A historical property, validated against the journal the engine itself wrote. */
  | 'execution-record'
  /** A human or model judgement, published as an authenticated event. */
  | 'attest';

/** Anything that survives a round trip through JSON, which is where evidence ends up. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type GateResult =
  | {
      readonly ok: true;
      /**
       * What this stage observed, kept in the journal. This is the material an
       * `execution-record` gate checks later: the red test's assertion, the builder's
       * execution identity, the SHA the review was given. Without it a stage that passes
       * leaves no trace, and a gate that must ask "what happened before?" has nothing to
       * read.
       */
      readonly evidence?: JsonValue;
    }
  | { readonly ok: false; readonly reason: string }
  /**
   * The stage does not apply to this change. Never the same as passing: it is recorded as
   * an exemption with its motive, so nothing can later read it as "ran and approved".
   */
  | { readonly ok: 'skipped'; readonly reason: string };

/**
 * What the engine hands a gate. Wide on purpose: every field here is something a gate would
 * otherwise have to rediscover for itself, with no way to test it and no way to honour a
 * dry run.
 */
export interface GateContext {
  readonly piece: PieceId;
  readonly stage: string;
  /**
   * What this piece actually changes, as the project's config describes it. Opaque to the
   * engine: `pipeline.config.ts` decides its shape and how to compute it. This is what lets
   * a gate be conditional ("mutation tests, but only when the diff touches lib/calc")
   * without the engine knowing anything about any project.
   */
  readonly change: unknown;
  /** Everything already observed for this piece, in order. Read-only for a gate. */
  readonly journal: readonly JournalEntry[];
  /** Language of anything the gate writes for a person to read. */
  readonly locale: string;
  /**
   * `dry-run` means: report what you would check, change nothing outside. A gate that
   * cannot tell says so rather than acting.
   */
  readonly mode: 'run' | 'dry-run';
  /** Aborted when the owner stops or pauses the piece mid-stage. */
  readonly signal: AbortSignal;
  /**
   * Runs an external effect at most once for this piece, keyed by `operationId`. A gate
   * that opens a PR, asks for a queue turn or posts a verdict goes through here, so
   * resuming after a crash reconciles instead of repeating.
   */
  runEffect<T extends JsonValue>(operationId: string, effect: () => Promise<T>): Promise<T>;
}

export type Gate = (context: GateContext) => GateResult | Promise<GateResult>;

/**
 * Whether a stage applies at all. `true` runs it; `false` skips it with a generic motive;
 * `{skip}` skips it saying exactly why, which is what the lane matrix needs ("no red test
 * on a purely visual change, per ADR 0110" reads very differently from "does not apply").
 */
export type Applicability = boolean | { readonly skip: string };

export interface StageConfig {
  /** Unique within the pipeline. */
  readonly name: string;
  /** The stage that must pass before this one. Omitted only by the first stage. */
  readonly after?: string;
  readonly nature: GateNature;
  /** Omitted means "always applies". A malformed answer blocks; it never exempts. */
  readonly appliesWhen?: (context: GateContext) => Applicability | Promise<Applicability>;
  /**
   * Whether what this stage recorded earlier is still evidence. This is how a stage keeps
   * its own rule for going stale: the flock survives a clean update with `main`, while QA
   * and the owner's sign-off expire the moment the SHA moves.
   *
   * Omitted means evidence never goes stale on its own. It still stops counting if the
   * stage disappears from the pipeline.
   *
   * Note what is deliberately NOT here: the engine does not invalidate everything whenever
   * the pipeline's shape changes. Adding a stage must not force a piece to redo the review
   * and ask the owner again for a sign-off they already gave.
   */
  readonly stillValid?: (
    entry: JournalEntry,
    context: GateContext,
  ) => boolean | Promise<boolean>;
  /**
   * A stage only a person can satisfy. Its gate saying no is not a failure — it is pending
   * (`waiting:decision`).
   */
  readonly needsHuman?: boolean;
  readonly gate: Gate;
}

export interface PipelineConfig {
  /** Language of everything a person reads. The engine itself stays in English. */
  readonly locale: string;
  readonly stages: readonly StageConfig[];
}

export type ValidationResult = { ok: true } | { ok: false; errors: readonly string[] };

/**
 * Rejects a pipeline whose order is not fully determined: no stages, duplicate names, a
 * dependency on an unknown stage, a cycle, more than one stage without `after`, or two
 * stages sharing an `after`. The last two matter because a pipeline with several valid
 * orders would run in whatever order the array happened to be written in.
 */
export type ValidateConfig = (config: PipelineConfig) => ValidationResult;

// ---------------------------------------------------------------------------------------
// Journal and status
// ---------------------------------------------------------------------------------------

export type StageOutcome = 'passed' | 'skipped' | 'rejected' | 'failed' | 'waiting';

/**
 * One thing the engine observed, as it observed it. Append-only: this is the record that
 * `execution-record` gates are validated against, so rewriting it would defeat them.
 */
export interface JournalEntry {
  readonly stage: string;
  readonly outcome: StageOutcome;
  readonly reason?: string;
  /** What the stage observed, from its `GateResult`. The material of later gates. */
  readonly evidence?: JsonValue;
  /** Milliseconds since the epoch, supplied by the caller so runs stay reproducible. */
  readonly at: number;
  readonly runId: RunId;
  /** Fingerprint of the pipeline's shape when this was written. Informational. */
  readonly pipeline: string;
}

export type PieceState =
  | 'running'
  | 'done'
  | 'blocked:rejected'
  | 'blocked:technical'
  | 'waiting:decision'
  | 'parked';

export interface PieceStatus {
  readonly piece: PieceId;
  /** Stage the piece stopped at, or is inside right now. */
  readonly stage?: string;
  readonly state: PieceState;
  /** Why it stopped, in the gate's own words. */
  readonly reason?: string;
  /** What the piece was before it was parked, so parking never erases a diagnosis. */
  readonly previous?: { readonly state: PieceState; readonly reason?: string };
  /**
   * When the current stage started. Written before the gate runs, not after, so `status`
   * from another terminal can say what is happening now — and so a piece whose controller
   * died mid-stage is not mistaken for one that never ran.
   */
  readonly startedAt?: number;
  readonly updatedAt?: number;
}

// ---------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------

export type EffectState = 'pending' | 'confirmed' | 'uncertain';

export interface EffectRecord {
  readonly state: EffectState;
  readonly result?: unknown;
}

/**
 * Thrown when an effect is neither confirmed nor untouched — it was in flight when
 * something died, so whether it reached the outside world is unknown. Retrying blindly is
 * how you open a second pull request; the engine reports instead.
 */
export class EffectNeedsReconciliation extends Error {
  constructor(
    readonly piece: PieceId,
    readonly operationId: string,
    readonly effectState: EffectState,
  ) {
    super(`effect "${operationId}" of piece ${piece} is ${effectState} and needs reconciliation`);
    this.name = 'EffectNeedsReconciliation';
  }
}

/** Thrown when a write lost its race: someone else wrote since this caller read. */
export class StaleVersion extends Error {
  constructor(readonly piece: PieceId) {
    super(`piece ${piece} changed since it was read`);
    this.name = 'StaleVersion';
  }
}

export class InvalidPipeline extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`invalid pipeline: ${errors.join('; ')}`);
    this.name = 'InvalidPipeline';
  }
}

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------

export type Reservation =
  | { readonly ok: true; readonly version: Version }
  | { readonly ok: false; readonly heldBy: RunId; readonly expiresAt: number };

export interface VersionedStatus {
  readonly status: PieceStatus;
  readonly version: Version;
}

/**
 * Where a piece's progress lives. The memory store is the reference implementation; the
 * GitHub-backed one implements this same shape over labels, checks and a journal in the
 * branch — which is why nothing here may assume a local map, instant writes, or that a
 * read and the write that follows it are one atomic step.
 */
export interface Store {
  /**
   * Takes the piece for `runId` under a lease. Fails if someone else holds a live lease,
   * saying who and until when. Re-taking one's own lease renews it.
   */
  reserve(piece: PieceId, runId: RunId, leaseMs: number): Promise<Reservation>;
  /** Extends a held lease. A controller that stops renewing is treated as gone. */
  renew(piece: PieceId, runId: RunId, leaseMs: number): Promise<Reservation>;
  release(piece: PieceId, runId: RunId): Promise<void>;

  loadStatus(piece: PieceId): Promise<VersionedStatus | undefined>;
  /** Fails with `StaleVersion` if the piece changed since `expected` was read. */
  saveStatus(status: PieceStatus, expected: Version | undefined): Promise<Version>;
  /** Every piece the store knows about, for `status` with no argument. */
  listStatuses(): Promise<readonly PieceStatus[]>;

  append(piece: PieceId, entry: JournalEntry): Promise<void>;
  journal(piece: PieceId): Promise<readonly JournalEntry[]>;
  /** Drops a stage's entries, so a piece stuck on evidence of a retired stage can move. */
  forget(piece: PieceId, stage: string): Promise<void>;

  getEffect(piece: PieceId, operationId: string): Promise<EffectRecord | undefined>;
  /**
   * Runs an external effect at most once. A confirmed effect returns its first result
   * without running again. One left `pending` or `uncertain` by a crash throws
   * `EffectNeedsReconciliation` — it is never retried blindly.
   *
   * The result must survive JSON: over a remote store it travels as text, so a `Date` comes
   * back as a string. Constraining it here means the memory store's tests catch what the
   * GitHub-backed one would do, instead of the difference surfacing on a resume in
   * production — the one path nobody exercises by hand.
   */
  runEffect<T extends JsonValue>(
    piece: PieceId,
    operationId: string,
    effect: () => Promise<T>,
  ): Promise<T>;
  /**
   * Resolves an effect whose outcome someone determined by checking the outside world.
   * `didNotHappen` puts it back to never-ran so it can be retried — without it, whoever
   * verifies that the PR was never opened would have to invent a result to move on, which
   * is fabricating evidence.
   */
  reconcileEffect(
    piece: PieceId,
    operationId: string,
    outcome: { readonly confirmed: JsonValue } | { readonly didNotHappen: true },
  ): Promise<void>;

  /**
   * Takes a shared resource — a board zone, the main checkout for packaging — so two
   * pieces cannot work on it at once. Same lease semantics as `reserve`.
   */
  reserveZone(zone: string, piece: PieceId, runId: RunId, leaseMs: number): Promise<Reservation>;
  releaseZone(zone: string, runId: RunId): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

export type RunOutcome =
  | { readonly outcome: 'ran'; readonly status: PieceStatus }
  /** Another controller holds the piece. Nothing was read as this run's own progress. */
  | { readonly outcome: 'busy'; readonly heldBy: RunId }
  /** The piece is parked; it does not advance until someone resumes it. */
  | { readonly outcome: 'parked'; readonly status: PieceStatus };

export interface RunOptions {
  readonly mode?: 'run' | 'dry-run';
  readonly signal?: AbortSignal;
}

export interface Engine {
  /**
   * Advances the piece as far as its gates allow. Resumes by evidence: a stage with no
   * current journal entry runs, even if it sits before wherever the piece last stopped.
   */
  run(piece: PieceId, options?: RunOptions): Promise<RunOutcome>;
  status(piece: PieceId): Promise<PieceStatus | undefined>;
  list(): Promise<readonly PieceStatus[]>;
  /** Parks the piece, keeping its work and its previous diagnosis. */
  stop(piece: PieceId, reason: string): Promise<PieceStatus>;
  /** Un-parks it. The next run resumes by evidence, like any other. */
  resume(piece: PieceId): Promise<PieceStatus>;
}

export interface EngineOptions {
  readonly config: PipelineConfig;
  readonly store: Store;
  readonly runId?: RunId;
  /** How the project describes what a piece changes. Fed to every gate as `change`. */
  readonly describeChange?: (piece: PieceId) => unknown | Promise<unknown>;
  /** Injected so runs are reproducible and tests do not depend on the wall clock. */
  readonly now?: () => number;
  readonly leaseMs?: number;
}
