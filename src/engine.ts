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
  type RunOutcome,
  type StageConfig,
  type StageOutcome,
  type Store,
} from './contract.js';
import { fingerprint, validateConfig } from './config.js';

// Each engine instance gets a distinct controller id unless the caller names one, so two
// engines sharing a store never mistake each other's reservation for their own renewal.
let engineSerial = 0;

/** Milliseconds a reservation stays alive before another controller may take over. */
const DEFAULT_LEASE_MS = 30_000;

/**
 * The engine never holds a piece for less than this. A short requested lease can expire
 * before the keepalive gets its first chance to extend it, leaving a live piece looking
 * abandoned; `leaseMs` is therefore floored rather than taken literally.
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

/** A store write that failed. It is reported as a technical block, never thrown out of run. */
class StoreWriteFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreWriteFailure';
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
  const runId = options.runId ?? `engine-${(engineSerial += 1)}`;
  const now = options.now ?? Date.now;
  const requestedLeaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const leaseMs = Math.max(requestedLeaseMs, MIN_LEASE_MS);
  const describeChange = options.describeChange;
  // Computed once: a pipeline cannot change under a live engine, so its fingerprint is fixed.
  const pipeline = fingerprint(config);

  // One in-flight run per piece. A second `run` for a piece already being advanced returns
  // the same promise instead of racing it: two overlapping runs would execute every gate
  // twice and each would free the piece while the other still works.
  interface ActiveRun {
    readonly key: string;
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

    // A stop that happened before this run began still wins over any progress.
    const before = await store.loadStatus(piece);
    if (before !== undefined && before.status.state === 'parked') {
      return { outcome: 'parked', status: before.status };
    }

    const journal: JournalEntry[] = [...(await store.journal(piece))];

    const blockedStatus = (stage: string | undefined, reason: string): PieceStatus => ({
      piece,
      ...(stage === undefined ? {} : { stage }),
      state: 'blocked:technical',
      reason,
    });

    // Persists the run's verdict, but first re-reads: a stop that landed while the gates ran
    // must win over this write, so the parked status is returned untouched instead. The
    // lease is also re-checked here: work done after losing the piece is worthless, and
    // writing over whoever holds it now would be worse.
    const finish = async (status: PieceStatus): Promise<RunOutcome> => {
      if (dryRun) return { outcome: 'ran', status };

      const held = await store.renew(piece, runId, leaseMs);
      if (!held.ok) {
        return { outcome: 'busy', heldBy: held.heldBy };
      }

      const latest = await store.loadStatus(piece);
      if (latest !== undefined && latest.status.state === 'parked') {
        return { outcome: 'parked', status: latest.status };
      }

      try {
        await store.saveStatus(status, latest?.version);
      } catch (error) {
        // Someone wrote between our read and our write. If it was a stop, honour it; any
        // other lost race is reported rather than thrown out of run.
        if (error instanceof StaleVersion) {
          const current = await store.loadStatus(piece);
          if (current !== undefined && current.status.state === 'parked') {
            return { outcome: 'parked', status: current.status };
          }
        }
        // Saving the failure must not recurse into saving another failure.
        return {
          outcome: 'ran',
          status: blockedStatus(undefined, `store failed to save the piece status: ${describeUnknown(error)}`),
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
      const entry: JournalEntry = {
        stage,
        outcome,
        at: now(),
        runId,
        pipeline,
        ...(reason === undefined ? {} : { reason }),
        ...(evidence === undefined ? {} : { evidence }),
      };
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
      // A dry run must not leave the process, so an effect that would is refused here rather
      // than silently recorded as if it had run.
      const runEffect = dryRun
        ? <T extends JsonValue>(operationId: string, _effect: () => Promise<T>): Promise<T> => {
            throw new Error(`dry-run: external effect "${operationId}" was not executed`);
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

    // The latest thing the journal says about a stage, whatever its outcome.
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
        const current = await store.loadStatus(piece);
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
        store.renew(piece, runId, leaseMs).then(
          (renewed) => {
            if (!renewed.ok) controller.abort();
          },
          () => {
            // The lease could not be confirmed. Unknown is not held, so stop touching it.
            controller.abort();
          },
        );
      }, leaseHeartbeatMs(leaseMs));
      timer.unref();
      return () => clearInterval(timer);
    };

    const order = orderStages(config.stages);

    for (const stage of order) {
      try {
        // Re-read the world before each stage: a stop during the previous gate wins.
        const latest = await store.loadStatus(piece);
        if (latest !== undefined && latest.status.state === 'parked') {
          return { outcome: 'parked', status: latest.status };
        }

        // Keep the piece through a stage slower than the lease.
        const held = await store.renew(piece, runId, leaseMs);
        if (!held.ok) {
          // The piece is someone else's now. Their run's verdict is the one that counts.
          return { outcome: 'busy', heldBy: held.heldBy };
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

        // Evidence, not position: a stage counts as resolved only when its own rule says the
        // journal entry still holds. The pipeline fingerprint is informative, not decisive:
        // adding a stage must not force a piece to redo everything that already passed.
        if (prior !== undefined && (prior.outcome === 'passed' || prior.outcome === 'skipped')) {
          let stillValid = true;
          if (stage.stillValid !== undefined) {
            try {
              stillValid = await stage.stillValid(prior, context);
            } catch (error) {
              const reason = `stillValid of stage "${stage.name}" failed: ${describeUnknown(error)}`;
              await record(stage.name, 'failed', reason);
              return finish(blockedStatus(stage.name, reason));
            }
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
          const stopped = await store.loadStatus(piece);
          if (stopped !== undefined && stopped.status.state === 'parked') {
            return { outcome: 'parked', status: stopped.status };
          }
          const reason = describeUnknown(error);
          await record(stage.name, 'failed', reason);
          return finish(
            blockedStatus(stage.name, `gate of stage "${stage.name}" threw: ${reason}`),
          );
        } finally {
          stopHeartbeat();
        }

        // The gate resolved, but a stop may have landed while it ran. Check before recording
        // anything, so the stop is not overwritten by a `passed` entry or a `done` status.
        const stopped = await store.loadStatus(piece);
        if (stopped !== undefined && stopped.status.state === 'parked') {
          return { outcome: 'parked', status: stopped.status };
        }

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
        if (error instanceof StoreWriteFailure) {
          // The store failed mid-stage. Report it as a technical block; do not let the raw
          // store exception escape run() with no state and no diagnosis.
          return finish(blockedStatus(stage.name, error.message));
        }
        throw error;
      }
    }

    return finish({ piece, state: 'done' });
  };

  return {
    async run(piece, runOptions): Promise<RunOutcome> {
      // One run per piece in this engine: a second call joins the live one instead of
      // starting a parallel run that would repeat every gate and free the piece early.
      const existing = activeRuns.get(piece);
      if (existing !== undefined) return existing.promise;

      const mode = runOptions?.mode === 'dry-run' ? 'dry-run' : 'run';
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
        const reservation = await store.reserve(piece, runId, leaseMs);
        if (!reservation.ok) {
          // Someone else's live lease: report it without reading or writing any progress.
          return { outcome: 'busy', heldBy: reservation.heldBy };
        }
        try {
          return await runReserved(piece, mode, controller);
        } finally {
          await store.release(piece, runId);
        }
      })();

      const active: ActiveRun = { key, promise };
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
        const previous =
          current === undefined
            ? undefined
            : current.status.state === 'parked'
              ? current.status.previous
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
