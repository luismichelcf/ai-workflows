import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { resolveExecutable, type ExecutableEnvironment } from './exec.js';

export interface GhRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` with these arguments, feeding `input` to its stdin when given. Never through a shell. */
export type GhRunner = (args: readonly string[], input?: string) => Promise<GhRun>;

/**
 * A `gh` runner that also takes environment variables for one single call. The agents' token
 * travels this way — in the child's environment, never in an argument, a URL or a log. A
 * `GhRunner` is a `GhRunnerWithEnv` that never uses the third parameter, so callers that do
 * not need a per-call environment still accept one.
 */
export type GhRunnerWithEnv = (
  args: readonly string[],
  input?: string,
  env?: Readonly<Record<string, string>>,
) => Promise<GhRun>;

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

// The real environment `resolveExecutable` needs, so the resolver itself stays a pure function.
function executableEnvironment(): ExecutableEnvironment {
  const pathExt = process.env['PATHEXT'];
  return {
    platform: process.platform,
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    // `exactOptionalPropertyTypes` forbids an explicit `undefined`: omit it instead.
    ...(pathExt !== undefined ? { pathExt } : {}),
    nodePath: process.execPath,
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        // A shim that cannot be read is skipped by the resolver, which keeps walking the PATH.
        return undefined;
      }
    },
  };
}

/**
 * The environment a shim would have exported, laid over the engine's own. NODE_PATH is special:
 * the shim's value goes in front of any the engine already had, separated the way the platform
 * separates PATH entries, mirroring the shim's own `%NODE_PATH%` reference.
 */
function mergeShimEnvironment(shimEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const separator = process.platform === 'win32' ? ';' : ':';
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(shimEnv)) {
    const existing = merged[name];
    merged[name] =
      name.toUpperCase() === 'NODE_PATH' && existing !== undefined && existing.length > 0
        ? `${value}${separator}${existing}`
        : value;
  }
  return merged;
}

export function createGhRunner(options: GhRunnerOptions = {}): GhRunnerWithEnv {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  // A limit that is not a finite, positive number is not a limit. `NaN` and negative
  // values would otherwise reach `setTimeout` and either fire immediately or never, and an
  // absent limit is what `gh` relies on to hold a piece forever while its lease keeps renewing.
  // Refuse before any call can be launched.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid timeoutMs ${String(timeoutMs)}: the gh timeout must be a finite number greater than 0.`,
    );
  }

  return (args, input, extraEnv) =>
    new Promise<GhRun>((resolve, reject) => {
      // An explicit executable wins; otherwise `gh` is resolved once, without a shell.
      // A failed resolution rejects this one call with its own reason instead of throwing here.
      let executable: GhExecutable;
      if (options.executable !== undefined) {
        executable = options.executable;
      } else {
        const resolved = resolveExecutable('gh', executableEnvironment());
        if (!resolved.ok) {
          reject(new Error(resolved.reason));
          return;
        }
        executable = {
          command: resolved.command,
          prefixArgs: resolved.prefixArgs,
          ...(resolved.env !== undefined ? { env: resolved.env } : {}),
        };
      }

      // The child environment starts from the engine's own, takes the shim's variables
      // (NODE_PATH first, as the shim would have done), then forces the settings that make
      // `gh`'s output machine-readable. Without NO_COLOR and GH_PROMPT_DISABLED a colored or
      // prompting `gh` prints text no JSON parser can read; GH_NO_UPDATE_NOTIFIER keeps a
      // background update notice out of stdout.
      const env: NodeJS.ProcessEnv =
        executable.env !== undefined ? mergeShimEnvironment(executable.env) : { ...process.env };
      // GH_FORCE_TTY and CLICOLOR_FORCE would re-enable a terminal or color no matter what
      // NO_COLOR says: with GH_FORCE_TTY, `gh` can open a paginator and leave the call hanging
      // until the timeout. They are dropped before the overrides below are set. On Windows
      // environment names are case-insensitive, so `delete env['CLICOLOR_FORCE']` would miss a
      // differently-cased `clicolor_force`; scan by uppercased name to remove every spelling.
      for (const name of Object.keys(env)) {
        const upper = name.toUpperCase();
        if (upper === 'GH_FORCE_TTY' || upper === 'CLICOLOR_FORCE') delete env[name];
      }
      env['NO_COLOR'] = '1';
      env['GH_PROMPT_DISABLED'] = '1';
      env['GH_NO_UPDATE_NOTIFIER'] = '1';

      // The per-call environment comes last, so a caller can add the agents' GH_TOKEN to this
      // one call without changing anything the caller did not ask for. It never becomes an
      // argument, so it cannot show up in a command line or in `gh`'s own messages.
      if (extraEnv !== undefined) {
        for (const [name, value] of Object.entries(extraEnv)) env[name] = value;
      }

      const spawnOptions: SpawnOptions = {
        // Never a shell, so gh's arguments cannot be re-parsed. `windowsHide` avoids a
        // console window flashing on Windows, and all three pipes are used: stdin carries the
        // request body, stdout/stderr carry the answer.
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      };

      const child = spawn(executable.command, [...executable.prefixArgs, ...args], spawnOptions);

      // `setEncoding` decodes UTF-8 across chunk boundaries, so a multi-byte character
      // split between two writes is not mangled into a replacement character. Output is joined
      // only once at close.
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // The result is settled exactly once and the timer is always cleared, so a late
      // close after a timeout (or a second error) cannot overwrite the first answer.
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        action();
      };

      // `gh` may exit before reading a large stdin body, which makes the write fail with
      // EPIPE. That is the child refusing the body, not a failure worth surfacing on its own, so
      // the error is listened for — an unheard 'error' event would become an uncaught exception
      // and crash the engine — while `close` below still reports the real exit code and output.
      // This is not swallowing a real failure: the failure, if any, is read from `close`.
      if (child.stdin !== null) {
        child.stdin.on('error', () => {
          // Deliberately ignored; the outcome comes from the child's exit.
        });
        // An empty, closed stdin is what lets `gh --input -` finish reading, and what keeps a
        // call without a body from waiting for one. `input` is absent for those calls.
        child.stdin.end(input ?? '');
      }

      // `gh` never gives up by itself, so a call past the limit is killed and the call
      // rejects. SIGKILL cannot be caught, so the child cannot decline to stop.
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() =>
          reject(new Error(`gh timed out after ${timeoutMs}ms and was stopped.`)),
        );
      }, timeoutMs);

      child.on('error', (error) => {
        settle(() => reject(error));
      });

      // `close` — not `exit` — is when all output has been read, so it is the signal
      // that reports the result. A timeout has already settled by then and is left alone.
      child.on('close', (code) => {
        settle(() => resolve({ exitCode: code, stdout, stderr }));
      });
    });
}
