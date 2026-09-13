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

// Shells are never a valid answer. If a shim points at one (or the user asks for one by
// name) we must refuse rather than hand the caller a program that re-parses the arguments,
// because that is exactly the shell hop this whole module exists to avoid.
const SHELL_BASENAME = /^(?:cmd|powershell|pwsh|bash|sh)$/i;
const SCRIPT_EXTENSION = /\.(?:cjs|mjs|js)$/i;
const EXE_EXTENSION = /\.exe$/i;

function isShell(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? command;
  return SHELL_BASENAME.test(base.replace(/\.(?:exe|com)$/i, ''));
}

function splitPath(value: string, separator: string): string[] {
  return value.split(separator).filter((entry) => entry.length > 0);
}

function joinPath(dir: string, child: string, separator: string): string {
  return dir.endsWith(separator) ? `${dir}${child}` : `${dir}${separator}${child}`;
}

// Collapses `.` and resolves `..` so a shim like `"%dp0%\..\..\Windows\System32\cmd.exe"`
// can be tested for existence — and recognised as a shell — instead of failing on the dot
// segments. The drive/root is never popped, so `..` can never climb above it.
function normalizeWindows(file: string): string {
  const kept: string[] = [];
  for (const segment of file.replace(/\//g, '\\').split('\\')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (kept.length > 1) kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept.join('\\');
}

// Reads an npm `.cmd` shim. Only the invocation line (the one that forwards `%*`) counts,
// so the `"%dp0%\node.exe"` of the shim's IF branch is not mistaken for the real target.
function inspectCmdShim(dir: string, content: string): { exe: string | undefined; script: string | undefined } {
  const substitute = (token: string): string => normalizeWindows(token.replace(/%dp0%/gi, () => dir));
  let exe: string | undefined;
  let script: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('%*')) continue;
    const quoted = /"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = quoted.exec(line)) !== null) {
      const token = match[1];
      if (token === undefined) continue;
      const target = substitute(token);
      if (script === undefined && SCRIPT_EXTENSION.test(target)) script = target;
      else if (exe === undefined && EXE_EXTENSION.test(target)) exe = target;
    }
  }

  return { exe, script };
}

function reasonFor(name: string): string {
  return `No executable that can be launched without a shell was found for "${name}".`;
}

function resolveWindows(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  for (const dir of splitPath(env.path, ';')) {
    // A real binary in the directory wins: it needs no shim at all.
    for (const extension of ['.exe', '.com']) {
      const candidate = joinPath(dir, name + extension, '\\');
      if (env.exists(candidate) && !isShell(candidate)) {
        return { ok: true, command: candidate, prefixArgs: [] };
      }
    }

    const shim = joinPath(dir, name + '.cmd', '\\');
    if (!env.exists(shim)) continue;

    const content = env.readText(shim);
    if (content === undefined) continue;

    const { exe, script } = inspectCmdShim(dir, content);

    // Node-script shim: run the script through node, never through the .cmd wrapper.
    if (script !== undefined && env.exists(script) && !isShell(script)) {
      const localNode = joinPath(dir, 'node.exe', '\\');
      const command = env.exists(localNode) ? localNode : env.nodePath;
      return { ok: true, command, prefixArgs: [script] };
    }

    // Direct-exe shim: the target is already a real program, but it must not be a shell.
    if (exe !== undefined && env.exists(exe) && !isShell(exe)) {
      return { ok: true, command: exe, prefixArgs: [] };
    }

    // Any other shape — unreadable, dangling, a `.bat`/`.ps1`, or a shell — is skipped so
    // the search continues down the PATH instead of returning something unusable.
  }

  return { ok: false, reason: reasonFor(name) };
}

function resolvePosix(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  for (const dir of splitPath(env.path, ':')) {
    const candidate = joinPath(dir, name, '/');
    if (env.exists(candidate) && !isShell(candidate)) {
      return { ok: true, command: candidate, prefixArgs: [] };
    }
  }
  return { ok: false, reason: reasonFor(name) };
}

export function resolveExecutable(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  return env.platform === 'win32' ? resolveWindows(name, env) : resolvePosix(name, env);
}
