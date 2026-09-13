export interface GhRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` with these arguments, feeding `input` to its stdin when given. Never through a shell. */
export type GhRunner = (args: readonly string[], input?: string) => Promise<GhRun>;

/** A program to run in place of `gh`, already resolved: never a shell, never a `.cmd`. */
export interface GhExecutable {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  /** Environment a shim declares, laid over the process environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface GhRunnerOptions {
  /** Kills a call that has not finished by then. `gh` itself never gives up. */
  readonly timeoutMs?: number;
  /** Runs this instead of resolving `gh` on the PATH. */
  readonly executable?: GhExecutable;
}

export const DEFAULT_GH_TIMEOUT_MS = 60_000;

export function createGhRunner(_options: GhRunnerOptions = {}): GhRunner {
  throw new Error('createGhRunner is not implemented yet');
}
