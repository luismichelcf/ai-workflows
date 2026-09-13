// Finding the real program behind a command name, without ever going through a shell.
//
// On Windows, npm installs CLIs such as codex, opencode and pnpm as `.cmd` shims. Node 20+
// refuses to spawn a `.cmd` without `shell: true`, and with a shell the arguments — the
// prompt included — would pass through cmd.exe. Measured on the owner's machine on
// 13-sep-2026: `spawn('codex')` fails with ENOENT, `spawn('codex.cmd')` with EINVAL.
//
// The shims are small and regular. Two shapes were read from the real files:
//   node script:  "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
//   direct exe:   "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
// Reading the shim and running its target directly gives the same program with no shell.
//
// Pure: the file system and the environment are injected, so it is tested without touching
// the machine it runs on.

export interface ExecutableEnvironment {
  /** `process.platform`. */
  readonly platform: string;
  /** The PATH value. */
  readonly path: string;
  /** The PATHEXT value on Windows. */
  readonly pathExt?: string;
  /** `process.execPath`, used when a shim runs a script with `node`. */
  readonly nodePath: string;
  readonly exists: (file: string) => boolean;
  /** File contents, or undefined when it cannot be read. */
  readonly readText: (file: string) => string | undefined;
}

export type ResolvedExecutable =
  | {
      readonly ok: true;
      /** An absolute path to a real executable. Never a shell, never a `.cmd`. */
      readonly command: string;
      /** Arguments that must go before the caller's, such as the script a shim runs. */
      readonly prefixArgs: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

export function resolveExecutable(_name: string, _env: ExecutableEnvironment): ResolvedExecutable {
  throw new Error('resolveExecutable: not implemented');
}
