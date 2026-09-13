import type { Store } from './contract.js';

/**
 * What the git-backed store needs from wherever its state ref lives. Small on purpose: the
 * store's logic is tested over an in-memory remote, and each host (GitHub today) implements
 * these four calls.
 */
export interface StatePort {
  /** The commit the state ref points at, or `undefined` while the ref does not exist yet. */
  head(): Promise<string | undefined>;
  /** One file's contents at a commit, or `undefined` when the file is absent. */
  read(commit: string, path: string): Promise<string | undefined>;
  /** Every file path under `dir` at a commit, at any depth. */
  list(commit: string, dir: string): Promise<readonly string[]>;
  /**
   * Writes `changes` (`null` deletes a file) as a commit on top of `parent` and moves the ref
   * only if it still points at `parent`. Returns the new commit, or `undefined` when the ref
   * had moved: someone else wrote first. Anything else is thrown, never guessed.
   */
  commit(
    parent: string | undefined,
    changes: Readonly<Record<string, string | null>>,
    message: string,
  ): Promise<string | undefined>;
}

export interface GitStoreOptions {
  readonly port: StatePort;
  /** Injected so leases can be tested without waiting on the wall clock. */
  readonly now?: () => number;
  /** Lost races a single write retries before giving up. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Waits between retries; injected so tests never sleep. */
  readonly pause?: (ms: number) => Promise<void>;
}

export function createGitStore(_options: GitStoreOptions): Store {
  throw new Error('createGitStore is not implemented yet');
}
