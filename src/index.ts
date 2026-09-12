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
export function validateConfig(config: PipelineConfig): ValidationResult {
  const { stages } = config;
  const errors: string[] = [];

  if (stages.length === 0) {
    return { ok: false, errors: ['pipeline has no stages'] };
  }

  const byName = new Map<string, StageConfig>();
  for (const stage of stages) {
    if (byName.has(stage.name)) {
      errors.push(`duplicate stage name "${stage.name}"`);
      continue;
    }
    byName.set(stage.name, stage);
  }

  for (const stage of stages) {
    const after = stage.after;
    if (after !== undefined && !byName.has(after)) {
      errors.push(`stage "${stage.name}" depends on unknown stage "${after}"`);
    }
  }

  // Each stage names at most one predecessor, so a cycle is a walk that revisits a stage.
  // Resolved stages are marked so each is walked only once across the whole scan.
  const resolved = new Set<string>();
  for (const stage of stages) {
    const path = new Set<string>();
    let current: StageConfig | undefined = stage;
    while (current !== undefined && !resolved.has(current.name)) {
      if (path.has(current.name)) {
        errors.push(`cycle in stage order involving "${current.name}"`);
        break;
      }
      path.add(current.name);
      const after: string | undefined = current.after;
      current = after === undefined ? undefined : byName.get(after);
    }
    for (const name of path) {
      resolved.add(name);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
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
  const holders = new Map<string, string>();
  const statuses = new Map<string, PieceStatus>();
  const ledgers = new Map<string, Map<string, EffectRecord>>();

  const ledgerFor = (piece: string): Map<string, EffectRecord> => {
    const existing = ledgers.get(piece);
    if (existing !== undefined) {
      return existing;
    }
    const ledger = new Map<string, EffectRecord>();
    ledgers.set(piece, ledger);
    return ledger;
  };

  // exactOptionalPropertyTypes forbids writing `result: undefined`, so the key is omitted
  // when the effect produced nothing.
  const confirmed = (result: unknown): EffectRecord =>
    result === undefined ? { state: 'confirmed' } : { state: 'confirmed', result };

  return {
    async reserve(piece, runId) {
      const holder = holders.get(piece);
      if (holder === undefined || holder === runId) {
        holders.set(piece, runId);
        return true;
      }
      return false;
    },

    async release(piece, runId) {
      if (holders.get(piece) === runId) {
        holders.delete(piece);
      }
    },

    async loadStatus(piece) {
      return statuses.get(piece);
    },

    async saveStatus(status) {
      statuses.set(status.piece, status);
    },

    async beginEffect(piece, operationId) {
      ledgerFor(piece).set(operationId, { state: 'pending' });
    },

    async confirmEffect(piece, operationId, result) {
      ledgerFor(piece).set(operationId, confirmed(result));
    },

    async getEffect(piece, operationId) {
      return ledgers.get(piece)?.get(operationId);
    },

    async runEffect<T>(
      piece: string,
      operationId: string,
      effect: () => Promise<T>,
    ): Promise<T> {
      const existing = ledgers.get(piece)?.get(operationId);
      if (existing?.state === 'confirmed') {
        return existing.result as T;
      }

      const ledger = ledgerFor(piece);
      ledger.set(operationId, { state: 'pending' });
      try {
        const result = await effect();
        ledger.set(operationId, confirmed(result));
        return result;
      } catch (error) {
        // A failed effect might have reached the outside world. Recording it as uncertain
        // keeps the next attempt from repeating it blindly.
        ledger.set(operationId, { state: 'uncertain' });
        throw error;
      }
    },
  };
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

export function createEngine(options: EngineOptions): Engine {
  const { config, store } = options;
  const runId = options.runId ?? `engine-${Math.random().toString(36).slice(2)}`;

  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(`invalid pipeline: ${validation.errors.join('; ')}`);
  }

  const order = resolveOrder(config.stages);
  const indexByName = new Map(order.map((stage, index) => [stage.name, index] as const));

  const run = async (piece: string): Promise<PieceStatus> => {
    const saved = await store.loadStatus(piece);

    // A parked or finished piece is left exactly where it is.
    if (saved?.state === 'parked' || saved?.state === 'done') {
      return saved;
    }

    // Claim the piece before touching stages so a competing controller cannot interleave.
    const held = await store.reserve(piece, runId);
    if (!held) {
      return saved ?? { piece, state: 'running' };
    }

    try {
      // Resume at the recorded stage; everything before it already passed.
      const startIndex = saved?.stage === undefined ? 0 : (indexByName.get(saved.stage) ?? 0);
      const resumeStage = order[startIndex];
      await store.saveStatus(
        resumeStage === undefined
          ? { piece, state: 'running' }
          : { piece, stage: resumeStage.name, state: 'running' },
      );

      for (let index = startIndex; index < order.length; index += 1) {
        const stage = order[index];
        if (stage === undefined) {
          continue;
        }

        let result: GateResult;
        try {
          result = await stage.gate({ piece });
        } catch (error) {
          // The gate could not run: that is a technical block, not a rejection.
          const status: PieceStatus = {
            piece,
            stage: stage.name,
            state: 'blocked:technical',
            reason: error instanceof Error ? error.message : String(error),
          };
          await store.saveStatus(status);
          return status;
        }

        if (result.ok) {
          continue;
        }

        const status: PieceStatus = {
          piece,
          stage: stage.name,
          // A gate that needs a person and said no is pending, not failed.
          state: stage.needsHuman === true ? 'waiting:decision' : 'blocked:rejected',
          reason: result.reason,
        };
        await store.saveStatus(status);
        return status;
      }

      const done: PieceStatus = { piece, state: 'done' };
      await store.saveStatus(done);
      return done;
    } finally {
      await store.release(piece, runId);
    }
  };

  return {
    run,

    async status(piece) {
      return store.loadStatus(piece);
    },

    async stop(piece, reason) {
      const previous = await store.loadStatus(piece);
      const status: PieceStatus =
        previous?.stage === undefined
          ? { piece, state: 'parked', reason }
          : { piece, stage: previous.stage, state: 'parked', reason };
      await store.saveStatus(status);
      return status;
    },
  };
}

/**
 * Orders stages so every stage follows the one it declares in `after`. The config has
 * already passed `validateConfig`, so the walk is guaranteed to consume every stage.
 */
function resolveOrder(stages: readonly StageConfig[]): StageConfig[] {
  const byName = new Map<string, StageConfig>();
  const indegree = new Map<string, number>();
  const children = new Map<string, StageConfig[]>();

  for (const stage of stages) {
    if (!byName.has(stage.name)) {
      byName.set(stage.name, stage);
    }
    if (!indegree.has(stage.name)) {
      indegree.set(stage.name, 0);
    }
    if (!children.has(stage.name)) {
      children.set(stage.name, []);
    }
  }

  for (const stage of stages) {
    const after = stage.after;
    if (after === undefined || !byName.has(after)) {
      continue;
    }
    indegree.set(stage.name, (indegree.get(stage.name) ?? 0) + 1);
    children.get(after)?.push(stage);
  }

  const queue: string[] = [];
  for (const stage of stages) {
    if ((indegree.get(stage.name) ?? 0) === 0) {
      queue.push(stage.name);
    }
  }

  const order: StageConfig[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const name = queue[cursor];
    if (name === undefined) {
      continue;
    }
    const stage = byName.get(name);
    if (stage === undefined) {
      continue;
    }
    order.push(stage);
    for (const child of children.get(name) ?? []) {
      const remaining = (indegree.get(child.name) ?? 0) - 1;
      indegree.set(child.name, remaining);
      if (remaining === 0) {
        queue.push(child.name);
      }
    }
  }

  return order;
}
