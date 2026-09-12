import type { PieceStatus, PipelineConfig, Store } from './contract.js';

export interface CommandOptions {
  readonly config: PipelineConfig;
  readonly store: Store;
}

export interface CommandOutput {
  /** Whether the command succeeded. Drives the process exit code. */
  readonly ok: boolean;
  /** What the person reads. Plain language: never an internal state name. */
  readonly text: string;
}

export interface RenderOptions {
  readonly locale: string;
  /** Keep long reasons whole instead of trimming them to fit a terminal line. */
  readonly verbose?: boolean;
}

export interface ProviderReport {
  readonly name: string;
  readonly authenticated: boolean;
  readonly models: readonly string[];
}

export interface DoctorReport {
  readonly providers: readonly ProviderReport[];
}

/**
 * Renders the piece list. The seven states of the spec live here: empty, running, error,
 * no permission, one, many, and very long text. What the owner reads must never be an
 * internal state name — those are for the code, not for him.
 */
export function renderStatus(_pieces: readonly PieceStatus[], _options: RenderOptions): string {
  throw new Error('renderStatus: not implemented');
}

/** Renders what is installed and signed in, and what is missing to work. */
export function renderDoctor(_report: DoctorReport, _options: RenderOptions): string {
  throw new Error('renderDoctor: not implemented');
}

/** Runs one command. Unknown or missing commands answer with the help, never in silence. */
export function runCommand(_argv: readonly string[], _options: CommandOptions): Promise<CommandOutput> {
  throw new Error('runCommand: not implemented');
}
