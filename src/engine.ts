import {
  InvalidPipeline,
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
 */
const MIN_LEASE_MS = DEFAULT_LEASE_MS;

/** How often the keepalive re-extends a lease while a single stage is still running. */
const leaseHeartbeatMs = (leaseMs: number): number => Math.max(1, Math.floor(leaseMs / 3));

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

/** Recursively freezes a JSON value so nested evidence is as immutable as the entry holding it. */
function deepFreeze(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return;
  const nested = Array.isArray(value) ? value : Object.values(value);
  for (const item of nested) deepFreeze(item);
  Object.freeze(value);
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

export function createEngine(options: EngineOptions): Engine {
  const validation = validateConfig(options.config);
  if (!validation.ok) {
    throw new InvalidPipeline(validation.errors);
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
  const describeChange = options.describeChange;
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

  const runReserved = async (
    piece: PieceId,
    mode: 'run' | 'dry-run',
    controller: AbortController,
  ): Promise<RunOutcome> => {
    const dryRun = mode === 'dry-run';

    const blockedStatus = (stage: string | undefined, reason: string): PieceStatus => ({
      piece,
      ...(stage === undefined ? {} : { stage }),
      state: 'blocked:technical',
      reason,
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
    const renewLease = async (): Promise<Reservation> => {
      try {
        return await store.renew(piece, leaseId, requestedLeaseMs);
      } catch (error) {
        throw new StoreReadFailure(
          `store failed to renew the lease of piece "${piece}": ${describeUnknown(error)}`,
        );
      }
    };

    // Why the keepalive gave up on the lease. It is recorded before aborting so the abort
    // can be translated honestly: an abort and a theft are not the same answer. `undefined`
    // means no theft was seen, so an abort, if any, came from the caller's signal.
    type LeaseLoss =
      | { readonly kind: 'taken'; readonly heldBy: string }
      | { readonly kind: 'lapsed' }
      | { readonly kind: 'unconfirmed' };
    let leaseLoss: LeaseLoss | undefined;

    // A failed renewal with a named holder means another controller has the piece. Anything
    // else — a lease nobody took, or a store that cannot answer — is a technical block, never
    // `busy`: `busy` promises the caller someone else owns the piece, and a caller may wait on
    // that controller to finish.
    const lostOutcome = (loss: LeaseLoss): RunOutcome => {
      if (loss.kind === 'taken') return { outcome: 'busy', heldBy: loss.heldBy };
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
      // writing over whoever holds it now would be worse.
      const finish = async (status: PieceStatus): Promise<RunOutcome> => {
        if (dryRun) return { outcome: 'ran', status };

        const held = await renewLease();
        if (!held.ok) {
          return lostByHolder(held.heldBy);
        }

        const latest = await readStatus();
        if (latest !== undefined && latest.status.state === 'parked') {
          return { outcome: 'parked', status: latest.status };
        }

        try {
          await store.saveStatus(status, latest?.version);
        } catch (error) {
          // Someone wrote between our read and our write. If it was a stop, honour it; any
          // other lost race is reported rather than thrown out of run.
          if (error instanceof StaleVersion) {
            const current = await readStatus();
            if (current !== undefined && current.status.state === 'parked') {
              return { outcome: 'parked', status: current.status };
            }
          }
          // Saving the failure must not recurse into saving another failure.
          return {
            outcome: 'ran',
            status: blockedStatus(
              undefined,
              `store failed to save the piece status: ${describeUnknown(error)}`,
            ),
          };
        }
        return { outcome: 'ran', status };
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

      const knownStages = new Set(config.stages.map((stage) => stage.name));

      // Renaming or removing a stage makes old evidence name something that no longer exists.
      // Resuming blindly from there would either skip a stage or repeat external effects.
      // `store.forget` is the way out: it drops the retired stage's entries and the next run
      // resumes by what remains.
      const gone = journal.find((entry) => !knownStages.has(entry.stage));
      if (gone !== undefined) {
        return finish(
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
          change: await getChange(),
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
      // stage in progress. A StaleVersion here is a stop that landed in between; that stop
      // wins, so the write is dropped rather than overwriting it.
      const writeRunning = async (stage: StageConfig): Promise<void> => {
        if (dryRun) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readStatus();
          if (current !== undefined && current.status.state === 'parked') return;
          const running: PieceStatus = {
            piece,
            stage: stage.name,
            state: 'running',
            startedAt: now(),
          };
          try {
            await store.saveStatus(running, current?.version);
            return;
          } catch (error) {
            if (error instanceof StaleVersion) continue;
            throw new StoreWriteFailure(
              `store failed to save the running status of stage "${stage.name}": ${describeUnknown(error)}`,
            );
          }
        }
      };

      // A stage may run far longer than one lease. This timer re-extends the lease while the
      // gate works, and stops the run if the piece is gone: once another controller holds it,
      // whatever this run concludes is worthless and writing it would overwrite theirs. The
      // timer is unref'd so it never keeps the process alive, and it is always cleared.
      const startHeartbeat = (): (() => void) => {
        if (dryRun) return () => {};
        const timer = setInterval(() => {
          store.renew(piece, leaseId, requestedLeaseMs).then(
            (renewed) => {
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
              // The lease could not be confirmed. Unknown is not held, so stop touching it.
              leaseLoss = { kind: 'unconfirmed' };
              controller.abort();
            },
          );
        }, leaseHeartbeatMs(requestedLeaseMs));
        timer.unref();
        return () => clearInterval(timer);
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
            return finish(blockedStatus(stage.name, reason));
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
                const reason = `stillValid of stage "${stage.name}" failed: ${describeUnknown(error)}`;
                await record(stage.name, 'failed', reason);
                return finish(blockedStatus(stage.name, reason));
              }
              // `stillValid` is external input, exactly like `appliesWhen`: a forgotten
              // comparison returning an entry shape, a truthy string or `{}` must not keep
              // stale evidence alive in silence. Only a real boolean answers.
              if (answer !== true && answer !== false) {
                const reason =
                  `stillValid of stage "${stage.name}" returned ${describeValue(answer)} ` +
                  'instead of a boolean';
                await record(stage.name, 'failed', reason);
                return finish(blockedStatus(stage.name, reason));
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
                return finish(blockedStatus(stage.name, applicability.reason));
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
              return finish(blockedStatus(stage.name, applicability.reason));
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
            if (error instanceof DryRunEffectRefused) {
              // The stage could not be evaluated without acting. A healthy pipeline in dry
              // mode is not broken: note it as not evaluated, keep checking the rest, and
              // leave no trace.
              unchecked.push(stage.name);
              continue;
            }
            const stopped = await readStatus();
            if (stopped !== undefined && stopped.status.state === 'parked') {
              return { outcome: 'parked', status: stopped.status };
            }
            if (controller.signal.aborted) return abortedOutcome();
            const reason = describeUnknown(error);
            await record(stage.name, 'failed', reason);
            return finish(
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
              return finish({
                piece,
                stage: stage.name,
                state: 'waiting:decision',
                reason: verdict.reason,
              });
            }
            await record(stage.name, 'rejected', verdict.reason);
            return finish({
              piece,
              stage: stage.name,
              state: 'blocked:rejected',
              reason: verdict.reason,
            });
          }

          // Malformed: the gate could not be trusted, so it is a technical block, never a pass.
          await record(stage.name, 'failed', verdict.reason);
          return finish(blockedStatus(stage.name, verdict.reason));
        } catch (error) {
          if (error instanceof StoreWriteFailure || error instanceof StoreReadFailure) {
            // The store failed mid-stage. Report it as a technical block; do not let the raw
            // store exception escape run() with no state and no diagnosis.
            return finish(blockedStatus(stage.name, error.message));
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
        return finish({
          piece,
          state: 'waiting:decision',
          reason: `dry-run could not check ${unchecked.length === 1 ? 'stage' : 'stages'} ${named} without performing external effects`,
        });
      }

      return finish({ piece, state: 'done' });
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

    async stop(piece, reason): Promise<PieceStatus> {
      // Freeze the stage's context signal first: the gate should learn it was stopped.
      const active = activeRuns.get(piece);
      if (active !== undefined) controllers.get(active.key)?.abort();

      // `stop` reads, then writes with the version it read. Over a remote those are two
      // round trips and a write in between makes the write stale — losing the owner's brake.
      // Re-read and retry a few times before giving up.
      for (let attempt = 1; ; attempt += 1) {
        const current = await store.loadStatus(piece);
        if (current === undefined && active === undefined) {
          // A stop is a fact about a piece, not a piece. Parking one the store has never
          // seen would invent a phantom that `list` hides, `status` shows and a later run
          // obeys — three readers, three answers, from one write that should not happen.
          // The brake is reported; nothing is stored. A piece with a run in flight is a
          // real piece even before its first write, so that one is parked below.
          return { piece, state: 'parked', reason };
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

        const parked: PieceStatus = {
          piece,
          state: 'parked',
          reason,
          ...(previous === undefined ? {} : { previous }),
        };
        try {
          await store.saveStatus(parked, current?.version);
          return parked;
        } catch (error) {
          if (error instanceof StaleVersion && attempt < 3) continue;
          throw error;
        }
      }
    },

    async resume(piece): Promise<PieceStatus> {
      const current = await store.loadStatus(piece);
      if (current === undefined) {
        const status: PieceStatus = { piece, state: 'running' };
        await store.saveStatus(status, undefined);
        return status;
      }
      if (current.status.state !== 'parked') return current.status;

      // Restore the diagnosis parking preserved; a never-run piece simply becomes runnable.
      const previous = current.status.previous;
      const restored: PieceStatus =
        previous === undefined
          ? { piece, state: 'running' }
          : {
              piece,
              state: previous.state,
              ...(previous.reason === undefined ? {} : { reason: previous.reason }),
            };
      await store.saveStatus(restored, current.version);
      return restored;
    },
  };
}
