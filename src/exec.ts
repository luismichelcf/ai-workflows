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

// Launchers that re-read their own arguments are never a valid answer. Handing one back would
// recreate the shell hop this module exists to avoid: `wsl` without `--exec` delegates to the
// Linux shell, and wscript, cscript, mshta and conhost run whatever they are given. Matched on
// the base name with its extension stripped, case insensitively, so `CMD.EXE`, `cmd.com` and a
// shim pointing at `wsl.exe` all trip it. The refusal names the command that was asked for.
const FORBIDDEN_LAUNCHERS =
  /^(?:cmd|powershell|pwsh|bash|sh|zsh|dash|ksh|csh|tcsh|fish|wsl|wscript|cscript|mshta|conhost)$/i;

// An 8.3 short name such as POWERS~1 hides which program it really points at, so it is never
// used. The rule looks at the last segment only, matching the way a program name is written.
const SHORT_NAME = /~\d/;

// The exact line every npm shim ends with before it forwards the arguments. Only the two
// verified shapes below are trusted; anything else (a bun interpreter, flags before the script,
// NODE_OPTIONS, an Electron exe-plus-script pair, a `.cmd`/`.bat` target) is not run.
const SHIM_PREFIX = 'endLocal & goto #_undefined_# 2>NUL \\|\\| title %COMSPEC% & ';
const EXE_DIRECT_SHAPE = new RegExp(`^(?:${SHIM_PREFIX})?"(%dp0%[\\\\/][^"]+\\.exe)"\\s+%\\*$`, 'i');
const SCRIPT_CALL_SHAPE = new RegExp(`^(?:${SHIM_PREFIX})?"%_prog%"\\s+"(%dp0%[\\\\/][^"]+\\.(?:cjs|mjs|js))"\\s+%\\*$`, 'i');
const PROG_ASSIGNMENT = /^\s*SET\s+"_prog=([^"]*)"\s*$/i;
const NODE_OPTIONS_ASSIGNMENT = /^\s*SET\s+NODE_OPTIONS=/i;

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function withoutExtension(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

function isForbiddenLauncher(file: string): boolean {
  return FORBIDDEN_LAUNCHERS.test(withoutExtension(baseName(file)));
}

function hasShortName(file: string): boolean {
  return SHORT_NAME.test(baseName(file));
}

function extensionOf(file: string): string {
  const dot = baseName(file).lastIndexOf('.');
  return dot <= 0 ? '' : baseName(file).slice(dot).toLowerCase();
}

function isWindowsAbsolutePath(file: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\');
}

function isAllowedProg(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '%dp0%\\node.exe' || normalized === 'node';
}

function splitPath(value: string, separator: string): string[] {
  return value.split(separator).filter((entry) => entry.length > 0);
}

// Windows writes PATH entries quoted when they contain spaces, and occasionally relative. A
// relative entry could never produce an absolute command, so it is dropped instead of being
// joined. Empty entries are dropped the same way.
function windowsPathEntries(value: string): string[] {
  const entries: string[] = [];
  for (const raw of value.split(';')) {
    const entry = raw.trim().replace(/^"|"$/g, '');
    if (entry.length === 0 || !isWindowsAbsolutePath(entry)) continue;
    entries.push(entry);
  }
  return entries;
}

function joinPath(dir: string, child: string, separator: string): string {
  return dir.endsWith(separator) ? `${dir}${child}` : `${dir}${separator}${child}`;
}

// Collapses `.` and resolves `..` so a shim like `"%dp0%\..\..\Windows\System32\cmd.exe"`
// can be tested for existence — and recognised as a launcher — instead of failing on the dot
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

function substituteDp0(token: string, dir: string): string {
  return normalizeWindows(token.replace(/%dp0%/gi, () => dir));
}

function windowsDirName(file: string): string {
  const normalized = file.replace(/\//g, '\\');
  const index = normalized.lastIndexOf('\\');
  return index === -1 ? '' : normalized.slice(0, index);
}

// A verified shim is one whose `%*` line matches exactly one of the two npm shapes. The
// interpreter for a script shim must be node, and `_prog` may only have been set to the local
// node.exe or the bare `node` the shim falls back to; any other value means an interpreter this
// module did not verify (bun, for one), so the shim is skipped and the PATH search continues.
function inspectCmdShim(content: string): { readonly kind: 'exe' | 'script'; readonly target: string } | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (NODE_OPTIONS_ASSIGNMENT.test(line)) return undefined;
  }

  const invocationLines = content
    .split(/\r?\n/)
    .filter((line) => line.trimEnd().endsWith('%*'))
    .map((line) => line.trim());
  if (invocationLines.length !== 1) return undefined;
  const line = invocationLines[0];
  if (line === undefined) return undefined;

  const exe = EXE_DIRECT_SHAPE.exec(line);
  if (exe !== null) {
    const target = exe[1];
    return target === undefined ? undefined : { kind: 'exe', target };
  }

  const script = SCRIPT_CALL_SHAPE.exec(line);
  if (script !== null) {
    const target = script[1];
    if (target === undefined) return undefined;
    const progs: string[] = [];
    for (const sourceLine of content.split(/\r?\n/)) {
      const assignment = PROG_ASSIGNMENT.exec(sourceLine);
      const value = assignment?.[1];
      if (value !== undefined) progs.push(value);
    }
    if (progs.length === 0 || !progs.every(isAllowedProg)) return undefined;
    return { kind: 'script', target };
  }

  return undefined;
}

// Turns a verified shim into the program it really runs. Returns undefined when the target does
// not exist, is itself a forbidden launcher, or hides behind an 8.3 name.
function resolveShim(dir: string, content: string, env: ExecutableEnvironment): ResolvedExecutable | undefined {
  const shim = inspectCmdShim(content);
  if (shim === undefined) return undefined;

  const target = substituteDp0(shim.target, dir);
  if (!env.exists(target) || isForbiddenLauncher(target) || hasShortName(target)) return undefined;

  if (shim.kind === 'script') {
    const localNode = joinPath(dir, 'node.exe', '\\');
    const command = env.exists(localNode) ? localNode : env.nodePath;
    return { ok: true, command, prefixArgs: [target] };
  }
  return { ok: true, command: target, prefixArgs: [] };
}

function reasonFor(name: string): string {
  return `No se encontró un programa que se pueda lanzar sin shell para "${name}".`;
}

function resolveWindows(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  if (isForbiddenLauncher(name) || hasShortName(name)) {
    return { ok: false, reason: reasonFor(name) };
  }

  for (const dir of windowsPathEntries(env.path)) {
    // A real binary in the directory wins: it needs no shim at all.
    for (const extension of ['.exe', '.com']) {
      const candidate = joinPath(dir, name + extension, '\\');
      if (env.exists(candidate) && !isForbiddenLauncher(candidate) && !hasShortName(candidate)) {
        return { ok: true, command: candidate, prefixArgs: [] };
      }
    }

    const shim = joinPath(dir, name + '.cmd', '\\');
    if (!env.exists(shim)) continue;

    const content = env.readText(shim);
    if (content === undefined) continue;

    const resolved = resolveShim(dir, content, env);
    if (resolved !== undefined) return resolved;
  }

  return { ok: false, reason: reasonFor(name) };
}

// An absolute path gets exactly the same treatment as a name: a real `.exe`/`.com` is used, a
// `.cmd` is read as a shim, and everything else (`.bat`, `.ps1`, no extension, missing, or a
// forbidden launcher such as cmd.exe) is refused without ever walking the PATH.
function resolveWindowsAbsolute(file: string, env: ExecutableEnvironment): ResolvedExecutable {
  if (isForbiddenLauncher(file) || hasShortName(file)) {
    return { ok: false, reason: reasonFor(file) };
  }

  const extension = extensionOf(file);
  if (extension === '.exe' || extension === '.com') {
    return env.exists(file)
      ? { ok: true, command: file, prefixArgs: [] }
      : { ok: false, reason: reasonFor(file) };
  }

  if (extension === '.cmd') {
    if (!env.exists(file)) return { ok: false, reason: reasonFor(file) };
    const content = env.readText(file);
    if (content === undefined) return { ok: false, reason: reasonFor(file) };
    return resolveShim(windowsDirName(file), content, env) ?? { ok: false, reason: reasonFor(file) };
  }

  return { ok: false, reason: reasonFor(file) };
}

function resolvePosix(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  for (const dir of splitPath(env.path, ':')) {
    const candidate = joinPath(dir, name, '/');
    if (env.exists(candidate) && !isForbiddenLauncher(candidate) && !hasShortName(candidate)) {
      return { ok: true, command: candidate, prefixArgs: [] };
    }
  }
  return { ok: false, reason: reasonFor(name) };
}

function resolvePosixAbsolute(file: string, env: ExecutableEnvironment): ResolvedExecutable {
  if (env.exists(file) && !isForbiddenLauncher(file) && !hasShortName(file)) {
    return { ok: true, command: file, prefixArgs: [] };
  }
  return { ok: false, reason: reasonFor(file) };
}

export function resolveExecutable(name: string, env: ExecutableEnvironment): ResolvedExecutable {
  if (env.platform === 'win32') {
    return isWindowsAbsolutePath(name) ? resolveWindowsAbsolute(name, env) : resolveWindows(name, env);
  }
  return name.startsWith('/') ? resolvePosixAbsolute(name, env) : resolvePosix(name, env);
}
