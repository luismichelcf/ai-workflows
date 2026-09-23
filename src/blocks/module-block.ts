import { pathToFileURL } from 'node:url';

import {
  EffectNeedsReconciliation,
  type Gate,
  type GateContext,
  type GateResult,
  type JsonValue,
  type Store,
} from '../contract.js';

// PLAN-13-R2 §2.2 and §5 (RC-09): a module block of the project is imported and run in the
// engine's own process with the public `GateContext` and nothing more — no `recordCleanUpdate`,
// no store. When an effect of the block is left in doubt by a crash, the wrapper asks the
// block's own `reconcile` against the outside world and runs the block one more time; it is
// never retried blindly. A block error travels with its own message and blocks technically.

export interface ModuleGateOptions {
  readonly mainPath: string;
  readonly root: string;
  readonly store: Store;
  readonly inputs: Record<string, unknown>;
}

interface BlockModule {
  readonly default?: unknown;
  readonly reconcile?: unknown;
}

/** The project a module block judges: its absolute root, and nothing else. */
export interface ModuleProject {
  readonly root: string;
}

type BlockHandler = (
  context: GateContext,
  inputs: Record<string, unknown>,
  project: ModuleProject,
) => GateResult | Promise<GateResult>;
type Reconciler = (
  operationId: string,
  context: GateContext,
  project: ModuleProject,
) => Promise<unknown> | unknown;

function cannotReconcile(operationId: string): Error {
  return new Error(`effect "${operationId}" is in doubt and the block cannot reconcile it`);
}

export function createModuleGate(options: ModuleGateOptions): Gate {
  const project: ModuleProject = Object.freeze({ root: options.root });
  let loaded: Promise<BlockModule> | undefined;
  const load = (): Promise<BlockModule> =>
    (loaded ??= import(pathToFileURL(options.mainPath).href) as Promise<BlockModule>);

  const callOnce = async (context: GateContext): Promise<GateResult> => {
    const block = await load();
    const handler = block.default;
    if (typeof handler !== 'function') {
      throw new Error(`the module block "${options.mainPath}" has no default export`);
    }
    return await (handler as BlockHandler)(context, options.inputs, project);
  };

  return async (context): Promise<GateResult> => {
    try {
      return await callOnce(context);
    } catch (error) {
      if (!(error instanceof EffectNeedsReconciliation)) throw error;

      const block = await load();
      const reconcile = block.reconcile;
      if (typeof reconcile !== 'function') throw cannotReconcile(error.operationId);

      let answer: unknown;
      try {
        answer = await (reconcile as Reconciler)(error.operationId, context, project);
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        throw new Error(`effect "${error.operationId}" is in doubt and reconciling it failed: ${message}`);
      }
      if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
        throw cannotReconcile(error.operationId);
      }

      const record = answer as Record<string, unknown>;
      if (record['didNotHappen'] === true) {
        await options.store.reconcileEffect(context.piece, error.operationId, { didNotHappen: true });
      } else if (Object.hasOwn(record, 'confirmed')) {
        await options.store.reconcileEffect(context.piece, error.operationId, {
          confirmed: record['confirmed'] as JsonValue,
        });
      } else {
        throw cannotReconcile(error.operationId);
      }

      // The effect is settled now: run the block one more time, and only once.
      return await callOnce(context);
    }
  };
}
