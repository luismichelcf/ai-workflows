import {
  InvalidPipeline,
  StaleVersion,
  type Engine,
  type EngineOptions,
  type GateContext,
  type JournalEntry,
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

type GateVerdict =
  | { readonly kind: 'passed' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

/**
 * Resolves the single order `after` implies. `validateConfig` already rejected duplicate
 * roots, unknown targets, cycles and shared successors, so following one child per stage
 * from the lone root visits every stage exactly once.
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
  if (root === undefined) return stages;

  const order: StageConfig[] = [];
  const visited = new Set<string>();
  let current: StageConfig | undefined = root;
  // The `visited` guard is belt-and-braces: a validated pipeline has no cycle, but a loop
  // here would hang a runner forever rather than fail, so it is worth one cheap check.
  while (current !== undefined && !visited.has(current.name)) {
    visited.add(current.name);
    order.push(current);
    current = childOf.get(current.name);
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

  if (record.ok === true) return { kind: 'passed' };

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

export function createEngine(options: EngineOptions): Engine {
  const validation = validateConfig(options.config);
  if (!validation.ok) {
    throw new InvalidPipeline(validation.errors);
  }

  const { config, store } = options;
  const runId = options.runId ?? `engine-${(engineSerial += 1)}`;
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const describeChange = options.describeChange;
  // Computed once: a pipeline cannot change under a live engine, so its fingerprint is fixed.
  const pipeline = fingerprint(config);

  // In-flight controllers, so `stop` can abort the signal a running gate is watching.
  const controllers = new Map<PieceId, AbortController>();

  const runReserved = async (
    piece: PieceId,
    mode: 'run' | 'dry-run',
    controller: AbortController,
  ): Promise<RunOutcome> => {
    const dryRun = mode === 'dry-run';

    // A stop that happened before this run began still wins over any progress.
    const before = await store.loadStatus(piece);
    if (before !== undefined) {
      if (before.status.state === 'parked') {
        return { outcome: 'parked', status: before.status };
      }
      if (before.status.state === 'done') {
        return { outcome: 'ran', status: before.status };
      }
    }

    const journal: JournalEntry[] = [...(await store.journal(piece))];

    // Persists the run's verdict, but first re-reads: a stop that landed while the gates ran
    // must win over this write, so the parked status is returned untouched instead.
    const finish = async (status: PieceStatus): Promise<RunOutcome> => {
      if (dryRun) return { outcome: 'ran', status };

      const latest = await store.loadStatus(piece);
      if (latest !== undefined && latest.status.state === 'parked') {
        return { outcome: 'parked', status: latest.status };
      }

      try {
        await store.saveStatus(status, latest?.version);
      } catch (error) {
        // Someone wrote between our read and our write. If it was a stop, honour it; any
        // other lost race is a real problem and must not be swallowed.
        if (error instanceof StaleVersion) {
          const current = await store.loadStatus(piece);
          if (current !== undefined && current.status.state === 'parked') {
            return { outcome: 'parked', status: current.status };
          }
        }
        throw error;
      }
      return { outcome: 'ran', status };
    };

    // Writes one append-only observation. A dry run leaves no trace at all.
    const record = async (
      stage: string,
      outcome: StageOutcome,
      reason?: string,
    ): Promise<void> => {
      if (dryRun) return;
      const entry: JournalEntry = {
        stage,
        outcome,
        at: now(),
        runId,
        pipeline,
        ...(reason === undefined ? {} : { reason }),
      };
      await store.append(piece, entry);
      journal.push(entry);
    };

    const knownStages = new Set(config.stages.map((stage) => stage.name));

    // Evidence, not position: a stage counts as resolved only when the journal holds a
    // passed/skipped entry produced under the current pipeline fingerprint. Everything else
    // runs, including stages that sit before wherever the piece last stopped.
    const alreadyResolved = new Set(
      journal
        .filter(
          (entry) =>
            (entry.outcome === 'passed' || entry.outcome === 'skipped') &&
            entry.pipeline === pipeline,
        )
        .map((entry) => entry.stage),
    );

    // Renaming or removing a stage makes old evidence name something that no longer exists.
    // Resuming blindly from there would either skip a stage or repeat external effects.
    const gone = journal.find((entry) => !knownStages.has(entry.stage));
    if (gone !== undefined) {
      return finish({
        piece,
        stage: gone.stage,
        state: 'blocked:technical',
        reason: `journal mentions stage "${gone.stage}", which is not part of the current pipeline`,
      });
    }

    // `change` is opaque to the engine and may be async; compute it at most once per run.
    let changeComputed = false;
    let changeValue: unknown;
    const getChange = async (): Promise<unknown> => {
      if (!changeComputed) {
        changeValue = describeChange === undefined ? undefined : await describeChange(piece);
        changeComputed = true;
      }
      return changeValue;
    };

    const buildContext = async (stage: StageConfig): Promise<GateContext> => {
      // A dry run must not leave the process, so an effect that would is refused here rather
      // than silently recorded as if it had run.
      const runEffect = dryRun
        ? <T>(operationId: string, _effect: () => Promise<T>): Promise<T> => {
            throw new Error(`dry-run: external effect "${operationId}" was not executed`);
          }
        : <T>(operationId: string, effect: () => Promise<T>): Promise<T> =>
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

    for (const stage of orderStages(config.stages)) {
      // Re-read the world before each stage: a stop during the previous gate wins.
      const latest = await store.loadStatus(piece);
      if (latest !== undefined && latest.status.state === 'parked') {
        return { outcome: 'parked', status: latest.status };
      }

      if (alreadyResolved.has(stage.name)) continue;

      if (stage.appliesWhen !== undefined) {
        let applies: boolean;
        try {
          applies = await stage.appliesWhen(await buildContext(stage));
        } catch (error) {
          const reason = describeUnknown(error);
          await record(stage.name, 'failed', reason);
          return finish({
            piece,
            stage: stage.name,
            state: 'blocked:technical',
            reason: `appliesWhen of stage "${stage.name}" failed: ${reason}`,
          });
        }
        if (!applies) {
          // A skip is its own answer with its own motive: it must never read as a pass.
          await record(stage.name, 'skipped', `stage "${stage.name}" does not apply to this change`);
          alreadyResolved.add(stage.name);
          continue;
        }
      }

      let raw: unknown;
      try {
        raw = await stage.gate(await buildContext(stage));
      } catch (error) {
        const stopped = await store.loadStatus(piece);
        if (stopped !== undefined && stopped.status.state === 'parked') {
          return { outcome: 'parked', status: stopped.status };
        }
        const reason = describeUnknown(error);
        await record(stage.name, 'failed', reason);
        return finish({
          piece,
          stage: stage.name,
          state: 'blocked:technical',
          reason: `gate of stage "${stage.name}" threw: ${reason}`,
        });
      }

      // The gate resolved, but a stop may have landed while it ran. Check before recording
      // anything, so the stop is not overwritten by a `passed` entry or a `done` status.
      const stopped = await store.loadStatus(piece);
      if (stopped !== undefined && stopped.status.state === 'parked') {
        return { outcome: 'parked', status: stopped.status };
      }

      const verdict = classifyGateResult(raw);

      if (verdict.kind === 'passed') {
        await record(stage.name, 'passed');
        alreadyResolved.add(stage.name);
        continue;
      }

      if (verdict.kind === 'skipped') {
        await record(stage.name, 'skipped', verdict.reason);
        alreadyResolved.add(stage.name);
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
      return finish({
        piece,
        stage: stage.name,
        state: 'blocked:technical',
        reason: verdict.reason,
      });
    }

    return finish({ piece, state: 'done' });
  };

  return {
    async run(piece, runOptions): Promise<RunOutcome> {
      const mode = runOptions?.mode === 'dry-run' ? 'dry-run' : 'run';

      const reservation = await store.reserve(piece, runId, leaseMs);
      if (!reservation.ok) {
        // Someone else's live lease: report it without reading or writing any progress.
        return { outcome: 'busy', heldBy: reservation.heldBy };
      }

      const controller = new AbortController();
      controllers.set(piece, controller);

      // A caller-supplied signal (Ctrl-C, a parent job) must reach the gate too.
      const external = runOptions?.signal;
      const forwardAbort = (): void => controller.abort();
      if (external !== undefined) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', forwardAbort, { once: true });
      }

      try {
        return await runReserved(piece, mode, controller);
      } finally {
        if (external !== undefined) external.removeEventListener('abort', forwardAbort);
        controllers.delete(piece);
        await store.release(piece, runId);
      }
    },

    async status(piece): Promise<PieceStatus | undefined> {
      return (await store.loadStatus(piece))?.status;
    },

    async list(): Promise<readonly PieceStatus[]> {
      return store.listStatuses();
    },

    async stop(piece, reason): Promise<PieceStatus> {
      // Freeze the stage's context signal first: the gate should learn it was stopped.
      const controller = controllers.get(piece);
      if (controller !== undefined) controller.abort();

      const current = await store.loadStatus(piece);
      const previous =
        current === undefined
          ? undefined
          : current.status.state === 'parked'
            ? current.status.previous
            : {
                state: current.status.state,
                ...(current.status.reason === undefined ? {} : { reason: current.status.reason }),
              };

      const parked: PieceStatus = {
        piece,
        state: 'parked',
        reason,
        ...(previous === undefined ? {} : { previous }),
      };
      await store.saveStatus(parked, current?.version);
      return parked;
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
