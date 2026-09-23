import { isDeepStrictEqual } from 'node:util';

import {
  EffectRefusedBecauseParked,
  InvalidPipeline,
  ProcessTreeSurvived,
  StaleVersion,
  type Engine,
  type EngineOptions,
  type GateContext,
  type JournalEntry,
  type JsonValue,
  type PieceId,
  type PieceStatus,
  type Reservation,
  type RunOutcome,
  type StageConfig,
  type StageOutcome,
  type StopOptions,
  type Store,
  type VersionedStatus,
} from './contract.js';
import { fingerprint, validateConfig } from './config.js';

// Each engine instance gets a distinct serial. It both names a default run and, more
// importantly, salts the lease id so two engines that share a `runId` cannot mistake each
// other's reservation for their own renewal.
let engineSerial = 0;

/** Milliseconds a reservation stays alive before another controller may take over. */
const DEFAULT_LEASE_MS = 30_000;

/**
 * The first reservation is always at least this long. A short requested lease can expire
 * before the run has had a chance to start its keepalive, leaving a live piece looking
 * abandoned. Renewals, by contrast, use the requested duration: a short lease must really
 * expire once its owner stops renewing, or a rehearsal and a theft could never be observed.
 *
 * Exported so `runCommand` can refuse a lease below it before building the engine, which is
 * where a seconds-for-milliseconds mistake belongs: a units slip in a project script must be
 * an answer to the person, not a renewal on every tick.
 */
export const MIN_LEASE_MS = DEFAULT_LEASE_MS;

/**
 * A lease duration the engine cannot honour. It is the caller's mistake, like an invalid
 * pipeline, so `runCommand` reports it instead of crashing the process. A lease that is not a
 * finite number of milliseconds above zero would be written as an `expiresAt: null`, which the
 * git store refuses to read, leaving the piece locked for good. The realistic way in is a
 * project script passing `Number(process.env.X)` with `X` unset.
 */
export class InvalidLease extends Error {
  constructor(readonly value: number) {
    super(
      `the lease duration must be a finite number of milliseconds greater than 0, got ${String(value)}`,
    );
    this.name = 'InvalidLease';
  }
}

/**
 * A cancellation poll the engine cannot honour. Like a bad lease it is the caller's mistake, so
 * it is reported rather than fed to `setInterval`, where `NaN`, a fraction or a value past the
 * 32-bit timer ceiling would be rounded or silently clamped to a different cadence, changing how
 * quickly a stop is observed.
 */
export class InvalidCancellationPoll extends Error {
  constructor(readonly value: number) {
    super(
      'the cancellation poll must be a whole number of milliseconds between 1 and 2147483647, ' +
        `got ${String(value)}`,
    );
    this.name = 'InvalidCancellationPoll';
  }
}

/** How often the keepalive re-extends a lease while a single stage is still running. */
const leaseHeartbeatMs = (leaseMs: number): number => Math.max(1, Math.floor(leaseMs / 3));

/**
 * How often a running stage looks at the shared store to see whether another controller parked
 * the piece, unless the project asks otherwise. A stop from elsewhere writes to the store, not
 * into this run's controller map, so the run must watch for it. The watch has its own interval,
 * deliberately not derived from the lease: a lease measured in minutes must not mean minutes of
 * silence before a stop is honoured. But the interval is also a budget: a watcher poll is at
 * least two GitHub requests (one to read the ref, one for the status file), so thirty seconds is
 * 120 polls — 240 requests — an hour per active gate. Ten pieces running at once are about
 * 2,400 requests/h against the 5,000/h limit, leaving room for the lease renewals and the
 * transitions themselves; five seconds would have spent the whole allowance on watching.
 */
const DEFAULT_CANCELLATION_POLL_MS = 30_000;

type GateVerdict =
  | { readonly kind: 'passed'; readonly evidence?: JsonValue }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

type ApplicabilityVerdict =
  | { readonly kind: 'applies' }
  | { readonly kind: 'skip'; readonly reason?: string }
  | { readonly kind: 'malformed'; readonly reason: string };

/**
 * Resolves the single order `after` implies. `validateConfig` already rejected duplicate
 * roots, unknown targets, cycles and shared successors, so following one child per stage
 * from the lone root visits every stage exactly once.
 *
 * Every branch that an impossible config would reach throws instead of returning a partial
 * order: an engine whose whole job is that no stage is skipped must not silently skip one
 * because its own ordering fell through.
 */
function orderStages(stages: readonly StageConfig[]): readonly StageConfig[] {
  const childOf = new Map<string, StageConfig>();
  let root: StageConfig | undefined;
  for (const stage of stages) {
    if (stage.after === undefined) {
      if (root === undefined) root = stage;
    } else {
      childOf.set(stage.after, stage);
    }
  }
  if (root === undefined) {
    throw new Error('pipeline has no root stage; validateConfig should have rejected it');
  }

  const order: StageConfig[] = [];
  const visited = new Set<string>();
  let current: StageConfig | undefined = root;
  while (current !== undefined && !visited.has(current.name)) {
    visited.add(current.name);
    order.push(current);
    current = childOf.get(current.name);
  }
  if (order.length !== stages.length) {
    throw new Error(
      `pipeline order is incomplete: reached ${order.length} of ${stages.length} stages; ` +
        'validateConfig should have rejected a cycle or a shared successor',
    );
  }
  return order;
}

/** Renders any thrown value as a reason a person can read. Never `[object Object]`. */
function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
  }
  return describeValue(error);
}

/** JSON for structured values, so a thrown plain object stays legible. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // A value JSON cannot represent (bigint, circular): fall through to String below.
    }
  }
  return String(value);
}

/**
 * A gate's answer is external input: it was written by another project and may be wrong.
 * Only an exact `ok: true` passes; `'no'`, `1`, `{}` and a missing return are all reported.
 */
function classifyGateResult(result: unknown): GateVerdict {
  if (result === null || typeof result !== 'object') {
    return {
      kind: 'malformed',
      reason: `gate returned ${describeValue(result)} instead of a gate result`,
    };
  }

  const record = result as { readonly ok?: unknown; readonly reason?: unknown };

  if (record.ok === true) {
    // A passing stage's evidence is the material an `execution-record` gate checks later.
    const evidence = (result as { readonly evidence?: JsonValue }).evidence;
    return evidence === undefined ? { kind: 'passed' } : { kind: 'passed', evidence };
  }

  if (record.ok === 'skipped') {
    if (typeof record.reason === 'string' && record.reason.trim().length > 0) {
      return { kind: 'skipped', reason: record.reason };
    }
    return { kind: 'malformed', reason: 'gate returned { ok: "skipped" } without a reason' };
  }

  if (record.ok === false) {
    if (typeof record.reason === 'string' && record.reason.trim().length > 0) {
      return { kind: 'rejected', reason: record.reason };
    }
    return { kind: 'malformed', reason: 'gate refused without giving a reason' };
  }

  return {
    kind: 'malformed',
    reason: `gate returned an unrecognised result: ${describeValue(result)}`,
  };
}

/**
 * `appliesWhen` is external input too. Only `true`, `false` and `{ skip: <motive> }` mean
 * something; anything else (a forgotten `return`, a coerced string, `{}`) blocks. Silently
 * treating a malformed answer as "does not apply" is how a stage gets exempted by a bug.
 */
function classifyApplicability(value: unknown): ApplicabilityVerdict {
  if (value === true) return { kind: 'applies' };
  if (value === false) return { kind: 'skip' };

  if (value !== null && typeof value === 'object' && 'skip' in value) {
    const reason = (value as { readonly skip?: unknown }).skip;
    if (typeof reason === 'string' && reason.trim().length > 0) {
      return { kind: 'skip', reason };
    }
    return {
      kind: 'malformed',
      reason: `appliesWhen returned { skip: ${describeValue(reason)} } without a readable motive`,
    };
  }

  return {
    kind: 'malformed',
    reason: `appliesWhen returned ${describeValue(value)} instead of true, false or { skip }`,
  };
}

/**
 * Recursively freezes a JSON value so nested evidence is as immutable as the entry holding it.
 * `seen` remembers every object already frozen: a value that appears twice (a shared reference,
 * which `structuredClone` preserves) is frozen once instead of once per path, so a deep graph
 * with shared branches costs time proportional to its distinct size, not to the number of paths.
 */
function deepFreeze(value: JsonValue, seen: Set<object> = new Set()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  const nested = Array.isArray(value) ? value : Object.values(value);
  for (const item of nested) deepFreeze(item, seen);
  Object.freeze(value);
}

/**
 * PLAN-13-R2 §11: every gate gets its own deep copy of the facts, frozen to its roots. A block
 * that rewrites `change.kind`, `change.files` or `change.fingerprint` changes only its own copy,
 * never what the next stages read nor what the wrapper seals.
 */
function frozenFacts(change: unknown): unknown {
  if (typeof change !== 'object' || change === null) return change;
  // `structuredClone` copies a cycle happily, but `deepFreeze` would then recurse into it
  // forever and overflow the stack. The cycle is refused here, with a readable motive, before
  // anything is cloned or frozen.
  if (hasCycle(change, new Set(), new Set())) {
    throw new FrozenFactsFailure('a value refers back to itself');
  }
  let copy: unknown;
  try {
    copy = structuredClone(change);
  } catch (error) {
    // A value structured cloning cannot copy (a function or a symbol inside it) must never
    // travel to a gate unfrozen: the stage is blocked instead, with a motive a person can read.
    throw new FrozenFactsFailure(describeUnknown(error));
  }
  deepFreeze(copy as JsonValue);
  return copy;
}

/**
 * Whether the value refers back to itself on its own path. A depth-first walk that remembers
 * both the nodes on the current path (`inProgress`) and the ones already fully explored
 * (`done`): an edge to a node on the path is a cycle, an edge to a finished node is a shared
 * reference (plain data — JSON duplicates it) and is never explored twice. Remembering finished
 * nodes is what makes a graph whose branches share a deep subtree linear instead of exponential.
 */
function hasCycle(value: unknown, inProgress: Set<object>, done: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (inProgress.has(value)) return true;
  if (done.has(value)) return false;
  inProgress.add(value);
  const nested = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const item of nested) {
    if (hasCycle(item, inProgress, done)) return true;
  }
  inProgress.delete(value);
  done.add(value);
  return false;
}

/** A stored quarantine is one object or a list of them; either way, its parts are what count. */
function quarantineParts(value: JsonValue): readonly JsonValue[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * PLAN-13-R2 §2.2: a new quarantine never replaces one already stored. If it is not already
 * there (by deep equality) it joins it; several of them are kept as a list. One part collapses
 * back to a bare object, so a quarantine that is only ever seen alone keeps its old shape.
 */
function mergeQuarantine(existing: JsonValue | undefined, incoming: JsonValue): JsonValue {
  const parts: JsonValue[] = existing === undefined ? [] : [...quarantineParts(existing)];
  for (const candidate of quarantineParts(incoming)) {
    if (!parts.some((seen) => isDeepStrictEqual(seen, candidate))) parts.push(candidate);
  }
  return parts.length === 1 ? (parts[0] as JsonValue) : parts;
}

/**
 * What a caller wants to happen to the stored quarantine. Every read and write of the
 * quarantine in the engine goes through `updateQuarantined` with one of these:
 *
 * - `carry`: write `status`. A new quarantine in it joins whatever is stored (never replaces
 *   it); a status without one keeps the stored one. The owner's stop (`previous`) is preserved
 *   from what was read while a quarantine remains. `keepStop: false` is the one exception, used
 *   by `resume`, which is deliberately undoing the stop.
 * - `lift`: the quarantine `checked` was just confirmed empty. It is removed only if what is
 *   stored right now is deep-equal to it; otherwise nothing runs and the piece stays blocked.
 *   If the owner had parked the piece while it was quarantined, lifting restores that park.
 * - `none`: nothing is written.
 */
type QuarantineAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'carry'; readonly status: PieceStatus; readonly keepStop?: boolean }
  | { readonly kind: 'lift'; readonly checked: JsonValue };

/** Every action that actually writes something; `none` never does. */
type QuarantineMove = Exclude<QuarantineAction, { readonly kind: 'none' }>;

/** What a quarantine write should store, and what it means for the run. */
interface QuarantinePlan {
  readonly status: PieceStatus;
  readonly lifted: boolean;
  readonly parked: boolean;
  readonly changed: boolean;
}

/** The outcome of an actual (or rehearsed) quarantine write. */
interface QuarantineUpdate extends QuarantinePlan {
  readonly wrote: boolean;
  /** The write kept losing its race and was given up on: nothing ran. */
  readonly stale: boolean;
}

/** The owner's stop, read from the state as it is now: the current park, or the one it carries. */
function stopOf(current: VersionedStatus | undefined): PieceStatus['previous'] | undefined {
  if (current === undefined) return undefined;
  if (current.status.state === 'parked') {
    return {
      state: 'parked',
      ...(current.status.reason === undefined ? {} : { reason: current.status.reason }),
    };
  }
  return current.status.previous;
}

/** Re-attaches the owner's stop to a status that keeps a quarantine. */
function withStop(
  status: PieceStatus,
  current: VersionedStatus | undefined,
): PieceStatus {
  if (current === undefined) return status;
  const previous = stopOf(current) ?? status.previous;
  return previous === undefined ? status : { ...status, previous };
}

/**
 * The one decision the quarantine helper applies before every write: merge, keep, or lift.
 * Pure, so it can be tested by reading it; the version-checked read/write loop lives in
 * `updateQuarantined`.
 */
function planQuarantine(
  piece: PieceId,
  current: VersionedStatus | undefined,
  action: QuarantineMove,
): QuarantinePlan {
  const existing = current?.status.quarantine;

  if (action.kind === 'lift') {
    // Only the quarantine that was actually checked may be lifted. If what is stored now is
    // different — a second quarantine joined, or someone replaced it — nothing runs and the
    // quarantine that is really there stays, stop included.
    if (existing === undefined || !isDeepStrictEqual(existing, action.checked)) {
      const blocked: PieceStatus = {
        piece,
        state: 'blocked:technical',
        reason: 'the quarantine changed while it was being checked',
        ...(existing === undefined ? {} : { quarantine: existing }),
      };
      return { status: withStop(blocked, current), lifted: false, parked: false, changed: true };
    }
    // The owner parked the piece while its processes were quarantined: lifting the quarantine
    // must not undo that stop. The piece goes back to parked with its original reason.
    const previous = current?.status.previous;
    if (previous !== undefined && previous.state === 'parked') {
      return {
        status: {
          piece,
          state: 'parked',
          ...(previous.reason === undefined ? {} : { reason: previous.reason }),
        },
        lifted: true,
        parked: true,
        changed: false,
      };
    }
    // Confirmed empty: the quarantine goes, the rest of the stored status stays.
    const source: PieceStatus = current?.status ?? { piece, state: 'running' };
    const { quarantine: _dropped, ...cleared } = source;
    return { status: cleared, lifted: true, parked: false, changed: false };
  }

  // `carry`: a new quarantine merges with the stored one; a status without one keeps it.
  const incoming = action.status.quarantine;
  const quarantine = incoming === undefined ? existing : mergeQuarantine(existing, incoming);
  if (quarantine === undefined) {
    return { status: action.status, lifted: false, parked: false, changed: false };
  }
  const carried: PieceStatus = { ...action.status, quarantine };
  if (action.keepStop === false) {
    return { status: carried, lifted: false, parked: false, changed: false };
  }
  return { status: withStop(carried, current), lifted: false, parked: false, changed: false };
}

/**
 * Freezes an entry — and its evidence in depth — before it enters the run's own journal.
 * The store freezes what it keeps, but the copy the next stage reads was pushed raw: a gate
 * could rewrite its own `skipped` into a `passed` and the following gate would read the
 * forgery as history. The evidence is cloned first so freezing never reaches into the
 * gate's own return value.
 */
function freezeEntry(entry: JournalEntry): JournalEntry {
  if (entry.evidence === undefined) return Object.freeze({ ...entry });
  let evidence: JsonValue;
  try {
    // JSON drops a function or a symbol inside an object without complaining, leaving a
    // quietly truncated copy the store would keep as if it were the gate's answer. Refuse
    // those too, so evidence is either stored whole or reported.
    evidence = JSON.parse(
      JSON.stringify(entry.evidence, (_key, nested: unknown) => {
        if (typeof nested === 'function' || typeof nested === 'symbol') {
          throw new TypeError(`${typeof nested} values cannot be stored as JSON`);
        }
        return nested;
      }),
    ) as JsonValue;
  } catch (error) {
    throw new StoreWriteFailure(
      `the evidence of stage "${entry.stage}" cannot be stored as JSON: ${describeUnknown(error)}`,
    );
  }
  deepFreeze(evidence);
  return Object.freeze({ ...entry, evidence });
}

/** A store write that failed. It is reported as a technical block, never thrown out of run. */
class StoreWriteFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreWriteFailure';
  }
}

/** A store read that failed. Same treatment as a write: a diagnosed technical block. */
class StoreReadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreReadFailure';
  }
}

/** The run is no longer the holder of the piece. Any further write would be over someone else. */
class LeaseLost extends Error {
  constructor(readonly heldBy: string) {
    super('the run no longer holds the piece');
    this.name = 'LeaseLost';
  }
}

/**
 * A dry-run gate asked for an external effect. The rehearsal must not act, so the stage is
 * reported as not evaluated rather than as a broken environment. Only `runEffect` raises it.
 */
class DryRunEffectRefused extends Error {
  constructor(operationId: string) {
    super(`dry-run: external effect "${operationId}" was not executed`);
    this.name = 'DryRunEffectRefused';
  }
}

/** `describeChange` failed. It is the project's failure, not the gate's. */
class ChangeDescriptionFailure extends Error {
  constructor(piece: PieceId, cause: unknown) {
    super(`describeChange failed for piece "${piece}": ${describeUnknown(cause)}`);
    this.name = 'ChangeDescriptionFailure';
  }
}

/**
 * The facts of the change cannot be copied as plain data: they hold a function, a symbol or a
 * cycle. The original object must never be handed to a gate — a block could rewrite what the
 * next stage reads — so the stage is blocked technically instead. A cycle is refused here, by
 * walking the value before freezing it, because walking a frozen copy would exhaust the stack.
 */
class FrozenFactsFailure extends Error {
  constructor(detail: string) {
    super(`the facts of the change are not plain data and cannot be frozen: ${detail}`);
    this.name = 'FrozenFactsFailure';
  }
}

export function createEngine(options: EngineOptions): Engine {
  const validation = validateConfig(options.config);
  if (!validation.ok) {
    throw new InvalidPipeline(validation.errors);
  }

  // Refuse a lease the store could not read back. `NaN`, `Infinity`, `0` and negatives all
  // reach the store as a duration it cannot turn into an expiry; an absent lease is fine, the
  // default below covers it.
  if (
    options.leaseMs !== undefined &&
    !(Number.isFinite(options.leaseMs) && options.leaseMs > 0)
  ) {
    throw new InvalidLease(options.leaseMs);
  }

  // Same treatment for the cancellation poll: it must be an interval `setInterval` can represent
  // faithfully — a whole number of milliseconds in [1, 2_147_483_647] — because a fraction or a
  // value past the 32-bit timer ceiling is rounded or clamped to a different cadence.
  if (
    options.cancellationPollMs !== undefined &&
    !(
      Number.isInteger(options.cancellationPollMs) &&
      options.cancellationPollMs >= 1 &&
      options.cancellationPollMs <= 2_147_483_647
    )
  ) {
    throw new InvalidCancellationPoll(options.cancellationPollMs);
  }

  const { config, store } = options;
  const instanceSerial = (engineSerial += 1);
  const runId = options.runId ?? `engine-${instanceSerial}`;
  // The store must see a distinct id per engine instance. Two engines that share a `runId`
  // would otherwise reserve the same piece under the same name, each believe it is a renewal
  // and run every gate twice.
  const leaseId = `${runId}#${instanceSerial}`;
  const now = options.now ?? Date.now;
  const requestedLeaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const reserveLeaseMs = Math.max(requestedLeaseMs, MIN_LEASE_MS);
  const cancellationPollMs = options.cancellationPollMs ?? DEFAULT_CANCELLATION_POLL_MS;
  const describeChange = options.describeChange;
  const confirmFacts = options.confirmFacts;
  const confirmQuarantine = options.confirmQuarantine;
  // Computed once: a pipeline cannot change under a live engine, so its fingerprint is fixed.
  const pipeline = fingerprint(config);

  // One in-flight run per piece and mode. A second `run` of the same mode joins it instead
  // of racing: two overlapping runs would execute every gate twice and each would free the
  // piece while the other still works. A run of the other mode waits for it and then runs
  // for real, so a rehearsal can never quietly absorb a real run.
  interface ActiveRun {
    readonly key: string;
    readonly mode: 'run' | 'dry-run';
    readonly promise: Promise<RunOutcome>;
  }
  const activeRuns = new Map<PieceId, ActiveRun>();
  // Abort controllers keyed by run, not by piece. Keeping them per piece let a second run
  // overwrite the first's controller, after which `stop` could no longer abort anything.
  const controllers = new Map<string, AbortController>();
  let runSerial = 0;

  // A live read may arrive on the same turn a run was started, before that run's own
  // microtask chain has published its current stage. Yielding one macrotask drains those
  // microtasks, so `status` observes the stage the piece is actually in. It never waits for
  // the run itself: a gate may stay open indefinitely.
  const letRunPublish = async (): Promise<void> => {
    if (activeRuns.size === 0) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };

  /**
   * PLAN-13-R2 §2.2: the single place the stored quarantine is read and written. It reads the
   * status with its version, lets `decide` turn that read into an action, applies the merge /
   * keep / lift rules (`planQuarantine`) and saves with the version it read. On `StaleVersion`
   * it reads and decides again, up to `attempts`; when those run out the caller is told
   * (`stale`) so a run can end as a technical block without touching a stage. In a rehearsal
   * nothing is written and the plan is returned, so a `dry-run` sees exactly what a real run
   * would have done.
   */
  const updateQuarantined = async (
    target: PieceId,
    decide: (current: VersionedStatus | undefined) => QuarantineAction,
    settings: {
      readonly dryRun: boolean;
      readonly attempts?: number;
      /** Defaults to the raw store read; a run passes its error-wrapping reader. */
      readonly read?: (piece: PieceId) => Promise<VersionedStatus | undefined>;
    },
  ): Promise<QuarantineUpdate> => {
    const read = settings.read ?? ((piece: PieceId) => store.loadStatus(piece));
    const attempts = settings.attempts ?? 1;
    let current = await read(target);
    for (let attempt = 1; ; attempt += 1) {
      const action = decide(current);
      if (action.kind === 'none') {
        return {
          status: current?.status ?? { piece: target, state: 'running' },
          lifted: false,
          parked: false,
          changed: false,
          wrote: false,
          stale: false,
        };
      }
      const plan = planQuarantine(target, current, action);
      if (settings.dryRun) return { ...plan, wrote: false, stale: false };
      try {
        await store.saveStatus(plan.status, current?.version);
        return { ...plan, wrote: true, stale: false };
      } catch (error) {
        if (error instanceof StaleVersion && attempt < attempts) {
          current = await read(target);
          continue;
        }
        if (error instanceof StaleVersion) {
          // Someone kept writing. Re-read once so the caller can honour a park that landed,
          // or report the block against the quarantine that is really there.
          const fresh = await read(target).catch(() => undefined);
          return {
            status: fresh?.status ?? plan.status,
            lifted: false,
            parked: false,
            changed: plan.changed,
            wrote: false,
            stale: true,
          };
        }
        throw error;
      }
    }
  };

  const runReserved = async (
    piece: PieceId,
    mode: 'run' | 'dry-run',
    controller: AbortController,
  ): Promise<RunOutcome> => {
    const dryRun = mode === 'dry-run';

    const blockedStatus = (
      stage: string | undefined,
      reason: string,
      quarantine?: JsonValue,
    ): PieceStatus => ({
      piece,
      ...(stage === undefined ? {} : { stage }),
      state: 'blocked:technical',
      reason,
      ...(quarantine === undefined ? {} : { quarantine }),
    });

    // Reads are external like writes: a store that cannot answer is a technical block, not
    // a raw exception thrown out of run.
    const readStatus = async (): Promise<VersionedStatus | undefined> => {
      try {
        return await store.loadStatus(piece);
      } catch (error) {
        throw new StoreReadFailure(
          `store failed to read the status of piece "${piece}": ${describeUnknown(error)}`,
        );
      }
    };
    const readJournal = async (): Promise<readonly JournalEntry[]> => {
      try {
        return await store.journal(piece);
      } catch (error) {
        throw new StoreReadFailure(
          `store failed to read the journal of piece "${piece}": ${describeUnknown(error)}`,
        );
      }
    };
    // The stored quarantine names how to ask the system again. No checker means the question
    // cannot be asked at all, which is a block, never a silent pass.
    const quarantineMotive = async (quarantine: JsonValue): Promise<string | undefined> => {
      if (confirmQuarantine === undefined) return 'the quarantine cannot be checked';
      try {
        return await confirmQuarantine(quarantine);
      } catch (error) {
        return `the quarantine could not be checked: ${describeUnknown(error)}`;
      }
    };

    const renewLease = async (): Promise<Reservation> => {
      try {
        return await store.renew(piece, leaseId, requestedLeaseMs);
      } catch (error) {
        throw new StoreReadFailure(
          `store failed to renew the lease of piece "${piece}": ${describeUnknown(error)}`,
        );
      }
    };

    // Why this run stopped touching the piece. It is recorded before aborting so the abort can be
    // translated honestly: an abort, a theft and a park are not the same answer. `undefined`
    // means no loss was seen, so an abort, if any, came from the caller's signal.
    type LeaseLoss =
      | { readonly kind: 'taken'; readonly heldBy: string }
      | { readonly kind: 'lapsed' }
      | { readonly kind: 'unconfirmed' }
      /** Another controller parked the piece; the stored status is the outcome to return. */
      | { readonly kind: 'parked'; readonly status: PieceStatus };
    let leaseLoss: LeaseLoss | undefined;

    // A failed renewal with a named holder means another controller has the piece. Anything
    // else — a lease nobody took, a store that cannot answer, or a park another controller
    // recorded — is not `busy`: `busy` promises the caller someone else owns the piece, and a
    // caller may wait on that controller to finish. A park is a settled outcome, returned as
    // itself rather than dressed up as a technical lease failure.
    const lostOutcome = (loss: LeaseLoss): RunOutcome => {
      if (loss.kind === 'taken') return { outcome: 'busy', heldBy: loss.heldBy };
      if (loss.kind === 'parked') return { outcome: 'parked', status: loss.status };
      return {
        outcome: 'ran',
        status: blockedStatus(
          undefined,
          loss.kind === 'lapsed'
            ? 'the lease of the piece lapsed and no controller holds it'
            : 'the lease of the piece could not be confirmed',
        ),
      };
    };
    const lostByHolder = (heldBy: string): RunOutcome =>
      lostOutcome(heldBy.length > 0 ? { kind: 'taken', heldBy } : { kind: 'lapsed' });

    // An abort with no recorded lease loss is the caller's signal: nothing is written —
    // least of all `done`, which would claim the piece finished when it did not — and the
    // status stays as the run last stored it. When the keepalive did lose the lease, the
    // abort is reported as the loss it was, never as a `running` status nobody stored.
    const abortedOutcome = (): RunOutcome =>
      leaseLoss === undefined
        ? { outcome: 'ran', status: { piece, state: 'running' } }
        : lostOutcome(leaseLoss);

    // A park refuses an effect the gate — or its `appliesWhen` — was about to start. That is a
    // cancellation decision, not a failure, so it is translated in exactly one place: the piece's
    // current state decides whether the run is `parked` or simply cancelled where it stands. If
    // that state cannot be read, the run reports it as a technical block without a `failed`
    // entry, without a `finish`, and without writing over a transition that followed the park.
    const cancellationOutcome = async (stageName: string): Promise<RunOutcome> => {
      let current: VersionedStatus | undefined;
      try {
        current = await readStatus();
      } catch (readError) {
        return { outcome: 'ran', status: blockedStatus(stageName, describeUnknown(readError)) };
      }
      if (current !== undefined && current.status.state === 'parked') {
        return { outcome: 'parked', status: current.status };
      }
      return { outcome: 'ran', status: current?.status ?? { piece, state: 'running' } };
    };

    try {
      // A stop that happened before this run began still wins over any progress.
      const before = await readStatus();
      if (before !== undefined && before.status.state === 'parked') {
        return { outcome: 'parked', status: before.status };
      }

      const journal: JournalEntry[] = [...(await readJournal())];

      // Persists the run's verdict, but first re-reads: a stop that landed while the gates
      // ran must win over this write, so the parked status is returned untouched instead.
      // The lease is re-checked too: work done after losing the piece is worthless, and
      // writing over whoever holds it now would be worse. A quarantine (`overParked`) is the
      // exception: a process nobody can account for must be written even when the piece was
      // parked AND even when the lease was lost — what prevents another run is the stored
      // quarantine, not the lease.
      const finish = async (
        status: PieceStatus,
        options?: { readonly overParked?: boolean; readonly quarantine?: JsonValue },
      ): Promise<RunOutcome> => {
        const overParked = options?.overParked === true;
        const incoming = options?.quarantine;
        if (dryRun) return { outcome: 'ran', status };

        if (!overParked) {
          const held = await renewLease();
          if (!held.ok) {
            return lostByHolder(held.heldBy);
          }
        }

        // The decision runs inside `updateQuarantined`, against the state actually read: a stop
        // that landed while the gates ran wins over this write, so its parked status is returned
        // untouched instead. A new quarantine in the verdict joins whatever is already stored,
        // and an owner's stop is kept as `previous` while the quarantine remains. `overParked`
        // is the exception to the stop and the lease: the processes must be written regardless.
        const decided: PieceStatus =
          incoming === undefined ? status : { ...status, quarantine: incoming };
        let parked: PieceStatus | undefined;
        let update: QuarantineUpdate;
        try {
          update = await updateQuarantined(
            piece,
            (current) => {
              if (!overParked && current !== undefined && current.status.state === 'parked') {
                parked = current.status;
                return { kind: 'none' };
              }
              return { kind: 'carry', status: decided };
            },
            { dryRun: false, attempts: overParked ? 3 : 1, read: readStatus },
          );
        } catch (error) {
          // Saving the failure must not recurse into saving another failure.
          return {
            outcome: 'ran',
            status: blockedStatus(
              undefined,
              `store failed to save the piece status: ${describeUnknown(error)}`,
            ),
          };
        }
        if (parked !== undefined) return { outcome: 'parked', status: parked };
        if (update.wrote) return { outcome: 'ran', status: update.status };
        // The write lost its races. A park that landed is honoured; anything else is a block.
        if (!overParked && update.status !== undefined && update.status.state === 'parked') {
          return { outcome: 'parked', status: update.status };
        }
        return {
          outcome: 'ran',
          status: blockedStatus(
            undefined,
            'store failed to save the piece status: the piece changed while it was being saved',
          ),
        };
      };

      // Writes one append-only observation. A dry run leaves no trace at all.
      const record = async (
        stage: string,
        outcome: StageOutcome,
        reason?: string,
        evidence?: JsonValue,
      ): Promise<void> => {
        if (dryRun) return;
        const entry = freezeEntry({
          stage,
          outcome,
          at: now(),
          runId,
          pipeline,
          ...(reason === undefined ? {} : { reason }),
          ...(evidence === undefined ? {} : { evidence }),
        });
        // Renew immediately before the append. The journal is what resume-by-evidence reads,
        // so an entry written by a controller that already lost the piece could finish it
        // with evidence nobody produced. Losing the lease stops the journal and the status.
        const held = await renewLease();
        if (!held.ok) {
          throw new LeaseLost(held.heldBy);
        }
        try {
          await store.append(piece, entry);
        } catch (error) {
          throw new StoreWriteFailure(
            `store failed to append the "${outcome}" entry of stage "${stage}": ${describeUnknown(error)}`,
          );
        }
        journal.push(entry);
      };

      // PLAN-13-R2 §2.2: a stored quarantine is re-asked of the system before any stage runs,
      // after the lease expired or not, and in a rehearsal too. Another machine cannot be
      // asked, a group still alive and an unreadable quarantine all block; only an affirmative
      // empty answer lifts it. Every read and write here goes through `updateQuarantined`, so a
      // quarantine stored meanwhile is never erased and the owner's stop survives. A dry run
      // writes nothing at all, not even the cleanup.
      if (before !== undefined && before.status.quarantine !== undefined) {
        const quarantine = before.status.quarantine;
        const motive = await quarantineMotive(quarantine);
        let update: QuarantineUpdate;
        try {
          if (motive !== undefined) {
            // Still not confirmed empty: keep the quarantine — merging any that arrived while
            // it was checked — and block without running a stage.
            update = await updateQuarantined(
              piece,
              () => ({ kind: 'carry', status: blockedStatus(undefined, motive, quarantine) }),
              { dryRun, attempts: 3, read: readStatus },
            );
          } else {
            // Affirmative empty: lift ONLY the quarantine that was actually checked.
            update = await updateQuarantined(piece, () => ({ kind: 'lift', checked: quarantine }), {
              dryRun,
              attempts: 3,
              read: readStatus,
            });
          }
        } catch (error) {
          return {
            outcome: 'ran',
            status: blockedStatus(
              undefined,
              `the quarantine could not be checked: ${describeUnknown(error)}`,
            ),
          };
        }
        if (update.parked || (update.stale && update.status.state === 'parked')) {
          // The owner parked the piece while its processes were quarantined: the stop wins.
          return { outcome: 'parked', status: update.status };
        }
        if (motive !== undefined) {
          return { outcome: 'ran', status: update.status };
        }
        if (update.changed || update.stale) {
          // Nothing may run against a quarantine that is not the one checked, or whose lift
          // could not be committed.
          const blocked: PieceStatus =
            update.status.state === 'blocked:technical'
              ? update.status
              : {
                  ...update.status,
                  state: 'blocked:technical',
                  reason: 'the quarantine could not be lifted while it was being checked',
                };
          return { outcome: 'ran', status: blocked };
        }
        // Lifted with no stop: a real run already dropped it, a rehearsal goes on.
      }

      const knownStages = new Set(config.stages.map((stage) => stage.name));

      // Renaming or removing a stage makes old evidence name something that no longer exists.
      // Resuming blindly from there would either skip a stage or repeat external effects.
      // `store.forget` is the way out: it drops the retired stage's entries and the next run
      // resumes by what remains. An entry whose stage starts with `@` is a record the engine
      // itself wrote (e.g. `@clean-update`): it is not a stage and blocks nothing.
      const gone = journal.find(
        (entry) => !entry.stage.startsWith('@') && !knownStages.has(entry.stage),
      );
      if (gone !== undefined) {
        // await: a store failure inside finish() must reach the outer catch, not reject run().
        return await finish(
          blockedStatus(
            gone.stage,
            `journal mentions stage "${gone.stage}", which is not part of the current pipeline`,
          ),
        );
      }

      // `change` is opaque to the engine and may be async; compute it at most once per run.
      let changeComputed = false;
      let changeValue: unknown;
      const getChange = async (): Promise<unknown> => {
        if (!changeComputed) {
          if (describeChange === undefined) {
            changeValue = undefined;
          } else {
            try {
              changeValue = await describeChange(piece);
            } catch (error) {
              throw new ChangeDescriptionFailure(piece, error);
            }
          }
          changeComputed = true;
        }
        return changeValue;
      };

      const buildContext = async (stage: StageConfig): Promise<GateContext> => {
        // A dry run must not leave the process. The effect is refused with a dedicated error
        // the engine recognises as "not evaluated dry", never as a broken environment.
        const runEffect = dryRun
          ? <T extends JsonValue>(operationId: string, _effect: () => Promise<T>): Promise<T> => {
              throw new DryRunEffectRefused(operationId);
            }
          : <T extends JsonValue>(operationId: string, effect: () => Promise<T>): Promise<T> =>
              store.runEffect(piece, operationId, effect);

        return {
          piece,
          stage: stage.name,
          change: frozenFacts(await getChange()),
          journal: Object.freeze([...journal]),
          locale: config.locale,
          mode,
          signal: controller.signal,
          runEffect,
        };
      };

      const evaluateApplicability = async (
        stage: StageConfig,
        context: GateContext,
      ): Promise<ApplicabilityVerdict> => {
        if (stage.appliesWhen === undefined) return { kind: 'applies' };
        try {
          return classifyApplicability(await stage.appliesWhen(context));
        } catch (error) {
          // A refusal is a cancellation decision, not a malformed applicability. It travels to
          // the stage's catch, which is the one place that translates it.
          if (error instanceof EffectRefusedBecauseParked) throw error;
          return {
            kind: 'malformed',
            reason: `appliesWhen of stage "${stage.name}" failed: ${describeUnknown(error)}`,
          };
        }
      };

      const skipReason = (stage: StageConfig, verdict: ApplicabilityVerdict): string =>
        verdict.kind === 'skip' && verdict.reason !== undefined
          ? verdict.reason
          : `stage "${stage.name}" does not apply to this change`;

      // The latest thing the journal says about a stage, whatever its outcome. A stage is
      // judged by its last entry, not its first: a sign-off that was refused and later given
      // must be read as given, and a `waiting`/`failed` last entry means it is not settled.
      const latestEntry = (stage: string): JournalEntry | undefined => {
        for (let index = journal.length - 1; index >= 0; index -= 1) {
          const entry = journal[index];
          if (entry !== undefined && entry.stage === stage) return entry;
        }
        return undefined;
      };

      // Writes live state before a gate runs, so `status` from another terminal shows the
      // stage in progress. A stop that landed in between wins, so the write is dropped rather
      // than overwriting it; a quarantine already stored is carried, never erased. Every write
      // goes through `updateQuarantined`, which retries a stale version.
      const writeRunning = async (stage: StageConfig): Promise<void> => {
        if (dryRun) return;
        try {
          await updateQuarantined(
            piece,
            (current) =>
              current !== undefined && current.status.state === 'parked'
                ? { kind: 'none' }
                : {
                    kind: 'carry',
                    status: { piece, stage: stage.name, state: 'running', startedAt: now() },
                  },
            { dryRun: false, attempts: 3, read: readStatus },
          );
        } catch (error) {
          throw new StoreWriteFailure(
            `store failed to save the running status of stage "${stage.name}": ${describeUnknown(error)}`,
          );
        }
      };

      // A stage may run far longer than one lease. This timer re-extends the lease while the
      // gate works, and stops the run if the piece is gone: once another controller holds it,
      // whatever this run concludes is worthless and writing it would overwrite theirs. The
      // timers are unref'd so they never keep the process alive, and they are always cleared.
      //
      // Each stage gets its own heartbeat with its own lifecycle. A `loadStatus` already on the
      // wire when the stage ends may resolve much later, during a later stage: without a local
      // `closed` flag its stale `parked` would abort that later stage and lose work the store
      // says is still running. So once the stage closes, neither a pending renewal nor a pending
      // watcher read may set `leaseLoss` or abort the controller, and a watcher read still in
      // flight is not overlapped by the next tick.
      const startHeartbeat = (): (() => void) => {
        if (dryRun) return () => {};

        let closed = false;
        let reading = false;

        const renewal = setInterval(() => {
          if (closed) return;
          store.renew(piece, leaseId, requestedLeaseMs).then(
            (renewed) => {
              if (closed) return;
              if (!renewed.ok) {
                // Record who took it before aborting: the abort is translated to `busy`
                // with a holder, not to a `running` status the store never saw.
                leaseLoss =
                  renewed.heldBy.length > 0
                    ? { kind: 'taken', heldBy: renewed.heldBy }
                    : { kind: 'lapsed' };
                controller.abort();
              }
            },
            () => {
              if (closed) return;
              // The lease could not be confirmed. Unknown is not held, so stop touching it.
              leaseLoss = { kind: 'unconfirmed' };
              controller.abort();
            },
          );
        }, leaseHeartbeatMs(requestedLeaseMs));
        renewal.unref();

        // A stop may come from another controller whose `stop` cannot reach this run's
        // in-memory controller map, because it is a different Engine over the same store. The
        // shared store is the channel, so the stored status is polled while the gate is open.
        // The interval is its own setting, never the lease heartbeat, so a minutes-long lease
        // does not mean minutes of silence; the project can shorten it for tests. A read failure
        // is left to the run's own reads to report; it must not turn a healthy gate into a
        // technical failure.
        const parkedWatch = setInterval(() => {
          // A slow store must not accumulate reads: skip a tick while the previous one is open.
          if (closed || reading) return;
          reading = true;
          store.loadStatus(piece).then(
            (current) => {
              reading = false;
              if (closed) return;
              if (current !== undefined && current.status.state === 'parked') {
                leaseLoss = { kind: 'parked', status: current.status };
                controller.abort();
              }
            },
            () => {
              reading = false;
            },
          );
        }, cancellationPollMs);
        parkedWatch.unref();

        let stopped = false;
        return () => {
          // Idempotent: a second cleanup must not undo anything or throw.
          if (stopped) return;
          stopped = true;
          closed = true;
          clearInterval(renewal);
          clearInterval(parkedWatch);
        };
      };

      const order = orderStages(config.stages);

      // A dry run cannot rehearse a stage whose gate asks for a real external effect: it
      // must not act, so the stage is skipped. Skipping it silently and then answering
      // `done` would call the piece ready without ever looking at that stage. The names are
      // collected so the rehearsal can end by naming what it could not check.
      const unchecked: string[] = [];

      for (const stage of order) {
        try {
          // A signal can arrive between stages. Honour it before any more work is written.
          if (controller.signal.aborted) return abortedOutcome();

          // Re-read the world before each stage: a stop during the previous gate wins.
          const latest = await readStatus();
          if (latest !== undefined && latest.status.state === 'parked') {
            return { outcome: 'parked', status: latest.status };
          }

          // Keep the piece through a stage slower than the lease.
          const held = await renewLease();
          if (!held.ok) {
            // The piece is someone else's now, or nobody's at all. Each is its own answer;
            // neither is the `running` status this run would otherwise invent.
            return lostByHolder(held.heldBy);
          }

          let context: GateContext;
          try {
            context = await buildContext(stage);
          } catch (error) {
            const reason =
              error instanceof ChangeDescriptionFailure
                ? error.message
                : `building the context of stage "${stage.name}" failed: ${describeUnknown(error)}`;
            await record(stage.name, 'failed', reason);
            return await finish(blockedStatus(stage.name, reason)); // await: a store failure in finish() must reach this stage's catch

          }

          const prior = latestEntry(stage.name);
          let applicability: ApplicabilityVerdict | undefined;

          // Evidence, not position: a stage counts as resolved only when its own rule says
          // the journal entry still holds. The pipeline fingerprint is informative, not
          // decisive: adding a stage must not force a piece to redo everything that passed.
          // `waiting` and `failed` are not settled, so they fall through and run again.
          if (prior !== undefined && (prior.outcome === 'passed' || prior.outcome === 'skipped')) {
            let stillValid = true;
            if (stage.stillValid !== undefined) {
              let answer: unknown;
              try {
                answer = await stage.stillValid(prior, context);
              } catch (error) {
                // A refusal from `stillValid` is the same cancellation decision as one from a
                // gate or `appliesWhen`: it must reach the stage's central translation instead of
                // being journalled as a failure here. Ordinary errors keep their behaviour.
                if (error instanceof EffectRefusedBecauseParked) throw error;
                const reason = `stillValid of stage "${stage.name}" failed: ${describeUnknown(error)}`;
                await record(stage.name, 'failed', reason);
                return await finish(blockedStatus(stage.name, reason)); // await: a store failure in finish() must reach this stage's catch

              }
              // `stillValid` is external input, exactly like `appliesWhen`: a forgotten
              // comparison returning an entry shape, a truthy string or `{}` must not keep
              // stale evidence alive in silence. Only a real boolean answers.
              if (answer !== true && answer !== false) {
                const reason =
                  `stillValid of stage "${stage.name}" returned ${describeValue(answer)} ` +
                  'instead of a boolean';
                await record(stage.name, 'failed', reason);
                return await finish(blockedStatus(stage.name, reason)); // await: a store failure in finish() must reach this stage's catch

              }
              stillValid = answer;
            }

            if (stillValid) {
              if (prior.outcome === 'passed') {
                continue; // Resolved: the evidence still holds.
              }
              // A skip is re-evaluated like any other answer: if the change grew into what it
              // exempted, the stage runs now. If the exemption still holds, it is re-recorded.
              applicability = await evaluateApplicability(stage, context);
              if (applicability.kind === 'malformed') {
                await record(stage.name, 'failed', applicability.reason);
                return await finish(blockedStatus(stage.name, applicability.reason)); // await: a store failure in finish() must reach this stage's catch
              }
              if (applicability.kind === 'skip' || stage.appliesWhen === undefined) {
                if (stage.appliesWhen !== undefined) {
                  await record(stage.name, 'skipped', skipReason(stage, applicability));
                }
                continue;
              }
            }
          }

          // The stage is going to run, so its applicability is checked exactly once.
          if (applicability === undefined && stage.appliesWhen !== undefined) {
            applicability = await evaluateApplicability(stage, context);
            if (applicability.kind === 'malformed') {
              await record(stage.name, 'failed', applicability.reason);
              return await finish(blockedStatus(stage.name, applicability.reason)); // await: a store failure in finish() must reach this stage's catch
            }
            if (applicability.kind === 'skip') {
              // A skip is its own answer with its own motive: it must never read as a pass.
              await record(stage.name, 'skipped', skipReason(stage, applicability));
              continue;
            }
          }

          // Live state, written before the gate so a run in progress is visible.
          await writeRunning(stage);

          let raw: unknown;
          const stopHeartbeat = startHeartbeat();
          try {
            raw = await stage.gate(context);
          } catch (error) {
            if (error instanceof ProcessTreeSurvived) {
              // PLAN-13-R2 §2.2: unlike every other failure after a cancellation, this one is
              // always registered as `failed` and leaves the piece blocked with its quarantine
              // stored, even when the piece was parked or the run had lost the lease. Losing
              // track of a live process is worse than losing the parking, so neither write
              // demands the lease; the status write retries a race and re-reads.
              let reason =
                `stage "${stage.name}" left processes that could not be confirmed empty: ` +
                error.message;
              if (!dryRun) {
                const entry = freezeEntry({
                  stage: stage.name,
                  outcome: 'failed',
                  at: now(),
                  runId,
                  pipeline,
                  reason,
                });
                try {
                  await store.append(piece, entry);
                } catch (appendError) {
                  // The quarantine is what stops the next run: a journal that refused the entry
                  // is reported in the motive rather than allowed to lose the write.
                  reason += ` (the journal could not record the failure: ${describeUnknown(appendError)})`;
                }
              }
              return await finish(blockedStatus(stage.name, reason), {
                overParked: true,
                quarantine: error.quarantine,
              });
            }
            if (error instanceof DryRunEffectRefused) {
              // The stage could not be evaluated without acting. A healthy pipeline in dry
              // mode is not broken: note it as not evaluated, keep checking the rest, and
              // leave no trace.
              unchecked.push(stage.name);
              continue;
            }
            if (error instanceof EffectRefusedBecauseParked) {
              // A refusal is a cancellation decision, not a gate failure. It is translated once,
              // in the stage's catch, so it travels past this one without being journalled or
              // turned into a `blocked:technical`.
              throw error;
            }
            const stopped = await readStatus();
            if (stopped !== undefined && stopped.status.state === 'parked') {
              return { outcome: 'parked', status: stopped.status };
            }
            if (controller.signal.aborted) return abortedOutcome();
            const reason = describeUnknown(error);
            await record(stage.name, 'failed', reason);
            // await: a store failure in finish() must reach this stage's catch, not reject run().
            return await finish(
              blockedStatus(stage.name, `gate of stage "${stage.name}" threw: ${reason}`),
            );
          } finally {
            stopHeartbeat();
          }

          // The gate resolved, but a stop or an abort may have landed while it ran. Check
          // before recording anything, so neither is overwritten by a `passed` or a `done`.
          const stopped = await readStatus();
          if (stopped !== undefined && stopped.status.state === 'parked') {
            return { outcome: 'parked', status: stopped.status };
          }
          if (controller.signal.aborted) return abortedOutcome();

          const verdict = classifyGateResult(raw);

          if (verdict.kind === 'passed') {
            await record(stage.name, 'passed', undefined, verdict.evidence);
            continue;
          }

          if (verdict.kind === 'skipped') {
            await record(stage.name, 'skipped', verdict.reason);
            continue;
          }

          if (verdict.kind === 'rejected') {
            if (stage.needsHuman === true) {
              // A person has not answered yet; that is pending, not a failure.
              await record(stage.name, 'waiting', verdict.reason);
              // await: a store failure in finish() must reach this stage's catch, not reject run().
              return await finish({
                piece,
                stage: stage.name,
                state: 'waiting:decision',
                reason: verdict.reason,
              });
            }
            await record(stage.name, 'rejected', verdict.reason);
            // await: a store failure in finish() must reach this stage's catch, not reject run().
            return await finish({
              piece,
              stage: stage.name,
              state: 'blocked:rejected',
              reason: verdict.reason,
            });
          }

          // Malformed: the gate could not be trusted, so it is a technical block, never a pass.
          await record(stage.name, 'failed', verdict.reason);
          // await: a store failure in finish() must reach this stage's catch, not reject run().
          return await finish(blockedStatus(stage.name, verdict.reason));
        } catch (error) {
          if (error instanceof EffectRefusedBecauseParked) {
            // Whether it came from the gate or from `appliesWhen`, a refusal is translated here,
            // before any other failure: this is cancellation, not a technical block.
            return await cancellationOutcome(stage.name);
          }
          if (error instanceof StoreWriteFailure || error instanceof StoreReadFailure) {
            // The store failed mid-stage. Report it as a technical block; do not let the raw
            // store exception escape run() with no state and no diagnosis.
            // await: this catch has already run, so a failure here must reach the outer catch.
            return await finish(blockedStatus(stage.name, error.message));
          }
          if (error instanceof LeaseLost) {
            // The lease is gone. A named holder means another controller owns the piece and
            // its verdict is the one that counts; a lapsed one is a technical block. Either
            // way this run writes neither the journal nor the status.
            return lostByHolder(error.heldBy);
          }
          throw error;
        }
      }

      // A rehearsal that skipped a stage it could not rehearse is incomplete, never `done`.
      // `waiting:decision` is the non-failure state: a person must decide to run for real.
      // The reason names every stage the rehearsal could not check.
      if (unchecked.length > 0) {
        const named = unchecked.map((name) => `"${name}"`).join(', ');
        // await: a store failure inside finish() must reach the outer catch, not reject run().
        return await finish({
          piece,
          state: 'waiting:decision',
          reason: `dry-run could not check ${unchecked.length === 1 ? 'stage' : 'stages'} ${named} without performing external effects`,
        });
      }

      // The facts the run judged must still hold before a piece is called `done`. The project
      // reads the world again and returns the motive to block with when they moved (the tree
      // changed while the stages ran); a failure to confirm is the same technical block. Only
      // a real run confirms — a rehearse must not read the world it refused to touch.
      if (!dryRun && confirmFacts !== undefined) {
        let reason: string | undefined;
        try {
          reason = await confirmFacts(await getChange());
        } catch (error) {
          reason = `the facts of the piece could not be confirmed: ${describeUnknown(error)}`;
        }
        if (reason !== undefined) {
          // await: a store failure inside finish() must reach the outer catch, not reject run().
          return await finish(blockedStatus(undefined, reason));
        }
      }

      // await: a store failure inside finish() must reach the outer catch, not reject run().
      return await finish({ piece, state: 'done' });
    } catch (error) {
      if (error instanceof StoreReadFailure) {
        // A read failed before or around a write. We cannot consult the store to report the
        // block, so the diagnosis is returned directly rather than thrown out of run.
        return { outcome: 'ran', status: blockedStatus(undefined, error.message) };
      }
      throw error;
    }
  };

  return {
    async run(piece, runOptions): Promise<RunOutcome> {
      const mode = runOptions?.mode === 'dry-run' ? 'dry-run' : 'run';

      // Join a run of the same mode; never join one of a different mode. A real run that
      // arrived while a rehearsal was in flight must not be handed the rehearsal's empty
      // verdict: it waits for the rehearsal to settle, then starts for real.
      for (;;) {
        const existing = activeRuns.get(piece);
        if (existing === undefined) break;
        if (existing.mode === mode) return existing.promise;
        // Wait for the other-mode run to settle and free the piece. Its rejection (if any)
        // already reaches its own caller; this run must not inherit it, so it is settled here.
        await existing.promise.catch(() => undefined);
        if (activeRuns.get(piece) === existing) activeRuns.delete(piece);
      }

      const controller = new AbortController();
      const key = `${piece}#${(runSerial += 1)}`;

      // A caller-supplied signal (Ctrl-C, a parent job) must reach the gate too.
      const external = runOptions?.signal;
      const forwardAbort = (): void => controller.abort();
      if (external !== undefined) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', forwardAbort, { once: true });
      }

      const promise = (async (): Promise<RunOutcome> => {
        let reservation: Reservation;
        try {
          reservation = await store.reserve(piece, leaseId, reserveLeaseMs);
        } catch (error) {
          return {
            outcome: 'ran',
            status: {
              piece,
              state: 'blocked:technical',
              reason: `store failed to reserve the piece: ${describeUnknown(error)}`,
            },
          };
        }
        if (!reservation.ok) {
          // Someone else's live lease: report it without reading or writing any progress.
          return { outcome: 'busy', heldBy: reservation.heldBy };
        }
        let result: RunOutcome | undefined;
        let releaseFailure: string | undefined;
        try {
          result = await runReserved(piece, mode, controller);
        } finally {
          try {
            await store.release(piece, leaseId);
          } catch (error) {
            // Releasing is cleanup, not the run's verdict: a store that fails to drop the
            // lease must not replace the result the run reached. It must not vanish in
            // silence either — the lease stays taken until it lapses and nobody would know.
            // The failure is carried into the verdict's reason once the verdict is known.
            releaseFailure = describeUnknown(error);
          }
        }
        // A thrown run already propagated through the finally, so only a settled verdict
        // reaches here; the guard keeps that invariant visible to the type checker.
        if (result === undefined) {
          throw new Error('the run settled without a verdict');
        }
        if (releaseFailure !== undefined && result.outcome === 'ran') {
          const trace = `the piece could not be released: ${releaseFailure}`;
          return {
            outcome: 'ran',
            status: {
              ...result.status,
              reason:
                result.status.reason === undefined
                  ? trace
                  : `${result.status.reason} (${trace})`,
            },
          };
        }
        return result;
      })();

      const active: ActiveRun = { key, mode, promise };
      activeRuns.set(piece, active);
      controllers.set(key, controller);

      const cleanup = (): void => {
        if (activeRuns.get(piece) === active) activeRuns.delete(piece);
        controllers.delete(key);
        if (external !== undefined) external.removeEventListener('abort', forwardAbort);
      };
      void promise.then(cleanup, cleanup);

      return promise;
    },

    async status(piece): Promise<PieceStatus | undefined> {
      await letRunPublish();
      return (await store.loadStatus(piece))?.status;
    },

    async list(): Promise<readonly PieceStatus[]> {
      await letRunPublish();
      return store.listStatuses();
    },

    async stop(piece, reason, stopOptions): Promise<PieceStatus> {
      const onlyWhenUnfinished = stopOptions?.onlyWhenUnfinished === true;
      const active = activeRuns.get(piece);
      const abortActive = (): void => {
        if (active !== undefined) controllers.get(active.key)?.abort();
      };

      // The stored park is the source of truth, so the active run is aborted only once the
      // park has been committed. The read and the write go through `updateQuarantined`, so the
      // decision is made from the same read the write is committed against, a race is retried,
      // and a quarantine already stored is carried along rather than erased.
      let decided: PieceStatus | undefined;
      const update = await updateQuarantined(
        piece,
        (current) => {
          if (
            onlyWhenUnfinished &&
            current !== undefined &&
            (current.status.state === 'done' || current.status.state === 'parked')
          ) {
            // Decided against the same read the write would commit against: a piece that
            // finished in between is left exactly as it is.
            decided = current.status;
            return { kind: 'none' };
          }
          if (current === undefined && active === undefined) {
            // A stop is a fact about a piece, not a piece. Parking one the store has never
            // seen would invent a phantom that `list` hides, `status` shows and a later run
            // obeys. The brake is reported; nothing is stored. A piece with a run in flight is
            // real even before its first write, so that one is parked below.
            decided = { piece, state: 'parked', reason };
            return { kind: 'none' };
          }
          const previous =
            current === undefined || current.status.state === 'parked'
              ? current?.status.previous
              : {
                  state: current.status.state,
                  ...(current.status.reason === undefined
                    ? {}
                    : { reason: current.status.reason }),
                };
          return {
            kind: 'carry',
            status: { piece, state: 'parked', reason, ...(previous === undefined ? {} : { previous }) },
            keepStop: false,
          };
        },
        { dryRun: false, attempts: 3 },
      );
      if (decided !== undefined) return decided;
      if (!update.wrote) throw new StaleVersion(piece);
      // Committed: now the gate that is still working learns the piece is stopped.
      abortActive();
      return update.status;
    },

    async resume(piece): Promise<PieceStatus> {
      let decided: PieceStatus | undefined;
      const update = await updateQuarantined(
        piece,
        (current) => {
          if (current === undefined) {
            return { kind: 'carry', status: { piece, state: 'running' }, keepStop: false };
          }
          if (current.status.state === 'parked') {
            // Restore the diagnosis parking preserved; a never-run piece simply becomes runnable.
            // Un-parking restores the diagnosis, not the quarantine: that is a fact about the
            // system, so it is carried along.
            const previous = current.status.previous;
            const restored: PieceStatus =
              previous === undefined
                ? { piece, state: 'running' }
                : {
                    piece,
                    state: previous.state,
                    ...(previous.reason === undefined ? {} : { reason: previous.reason }),
                  };
            return { kind: 'carry', status: restored, keepStop: false };
          }
          if (current.status.previous !== undefined) {
            // A stop recorded while the piece was quarantined (ProcessTreeSurvived over a park):
            // the owner is taking it back. The diagnosis and the quarantine stay; only the
            // pending park is cleared, so lifting the quarantine later resumes instead of
            // re-parking a piece the owner already resumed.
            const { previous: _stop, ...rest } = current.status;
            return { kind: 'carry', status: rest, keepStop: false };
          }
          decided = current.status;
          return { kind: 'none' };
        },
        { dryRun: false, attempts: 1 },
      );
      if (decided !== undefined) return decided;
      if (!update.wrote) throw new StaleVersion(piece);
      return update.status;
    },
  };
}
