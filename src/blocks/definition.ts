import type { Gate, Store } from '../contract.js';
import type { BlockManifest } from './manifest.js';

// PLAN-13-R2 §2.1, §5 and §6: a block is its manifest plus the factory that builds its gate.
// Engine blocks receive `EngineBlockDeps`, which carries `recordCleanUpdate`: it lets only the
// engine's own blocks write `@clean-update` records, never a project block (whose gate only
// sees the public `GateContext`).

/**
 * What an engine block (or a block handed in as `extraBlocks`) receives when it is created.
 * The privileged `recordCleanUpdate` is deliberately not part of `GateContext`: project
 * blocks cannot write the journal records that prove a clean update.
 */
export interface EngineBlockDeps {
  readonly root: string;
  readonly baseRef: string;
  readonly store: Store;
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
}
