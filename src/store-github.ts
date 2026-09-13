import type { StatePort } from './store-git.js';

export interface GhRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` with these arguments, feeding `input` to its stdin when given. Never through a shell. */
export type GhRunner = (args: readonly string[], input?: string) => Promise<GhRun>;

export interface GitHubStatePortOptions {
  readonly owner: string;
  readonly repo: string;
  /** Where the state lives. Never under `refs/heads/` or `refs/tags/`. */
  readonly ref?: string;
  /** Defaults to the real `gh`, resolved without a shell. */
  readonly run?: GhRunner;
}

export const DEFAULT_STATE_REF = 'refs/ai-workflows/state';

export function createGitHubStatePort(_options: GitHubStatePortOptions): StatePort {
  throw new Error('createGitHubStatePort is not implemented yet');
}
