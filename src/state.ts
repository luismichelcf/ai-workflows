import type { Store } from './contract.js';

export interface MemoryStoreOptions {
  /** Injected so leases can be tested without waiting on the wall clock. */
  readonly now?: () => number;
}

export function createMemoryStore(_options?: MemoryStoreOptions): Store {
  throw new Error('createMemoryStore: not implemented');
}
