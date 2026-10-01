// PLAN-13-R5 §1.2 and §1.5: the `hook` and `hooks install` commands.
//
// The editor hook judges every path with the working copy that holds it, never with the folder the
// session started in: Claude Code can walk into a linked worktree mid-session and
// `${CLAUDE_PROJECT_DIR}` does not follow. Git and the file system are real here; the decisions
// themselves stay in editor.ts and git.ts, which are pure.
//
// PLAN-13-R6 §4: the hook answers before Claude Code's 30 s cut, which lets the tool through. The
// whole run has a budget; every git call is given what is left of it (never the whole budget), the
// hook's own git settles on the process's `exit` event and kills the whole process tree when its
// time runs out. The main thread runs the decision in a Worker and answers from a watchdog
// (superviseHook) even when a disk read blocks the deciding thread.

import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { gitEnvironment } from '../git-env.js';
import { CLAUDE_SETTINGS_PATH } from '../judge/own-files.js';
import { parseRecipe } from '../recipe/parse.js';
import type { Recipe } from '../recipe/types.js';
import { parseClientInput, renderClientOutput } from './clients.js';
import {
  CODEX_HOOK_ORDER,
  CODEX_HOOK_ORDER_WINDOWS,
  HOOK_LOADER_CJS,
  LOADER_RELATIVE,
  OPENCODE_PLUGIN_JS,
  isOurCodexHandler,
  isOurPlugin,
} from './client-files.js';
import { lockContextFor } from './context.js';
import { isUnder, readAbsolute } from './paths.js';
import {
  decideGitFolder,
  decideToolUse,
  isCoveredWriteTool,
  orderRefusal,
  writeTargets,
  type HookInput,
  type LockContext,
  type LockDecision,
} from './editor.js';
import {
  decidePreCommit,
  decidePrePush,
  parsePrePushStdin,
  parseStagedPaths,
  renderGitHook,
  STAGED_PATHS_GIT_ARGS,
} from './git.js';
import {
  buildHooksConfig,
  mergeHooksConfig,
  type HookClient,
  type HookHandler,
  type HooksFile,
} from './install.js';

export type HookKind = 'editor' | 'pre-commit' | 'pre-push';

// §4: the budgets, in the order the tests pin them: the per-call git time <= the whole editor
// deadline < the watchdog < the timeout the editor hook is installed with, minus the cold start
// measured on Windows.
export const HOOK_GIT_CALL_MS = 10_000;
export const HOOK_DEADLINE_MS = 20_000;
export const HOOK_WATCHDOG_MS = 25_000;
export const GIT_HOOK_DEADLINE_MS = 60_000;
/** Kept free at the end of the deadline so the answer is written before the cut, not after it. */
const HOOK_GIT_RESERVE_MS = 500;
/** PLAN-13-R6 §15 (M4): a hanging `ps` may not hold the tree walk; the group kill goes on without it. */
const POSIX_PS_TIMEOUT_MS = 2_000;

const HOOK_ENV: Readonly<Record<string, string>> = {
  LC_ALL: 'C',
  LANGUAGE: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

/** The output of one git call, capped so a runaway process cannot exhaust memory. */
const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

export interface HookGitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface HookGitAnswer {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The git of one hook run, injectable so the process-boundary behaviour can be tested with a
 * runner that ignores its deadline. Every call gets `timeoutMs` (never the whole budget) and the
 * signal that is aborted when the deadline passes.
 */
export type HookGitRunner = (request: HookGitRequest) => Promise<HookGitAnswer>;

export interface RunHookOptions {
  /**
   * The folder the hook was installed in; Claude substitutes it for `${CLAUDE_PROJECT_DIR}`. Codex
   * and OpenCode do not hand it over: their project root is read from `cwd` with git (§3.2), so it
   * is optional and only Claude needs it.
   */
  readonly projectDir?: string;
  /** The client whose request and answer shape this run speaks. Claude by default. */
  readonly client?: HookClient;
  /** The folder of the request (the CLI's `cwd`), which relative paths are read against. */
  readonly cwd: string;
  readonly stdin: string;
  readonly argv?: readonly string[];
  /** The git executable, by default `git`. A caller may point at one that does not answer. */
  readonly gitPath?: string;
  /** The whole budget of this run. By default the editor or the git-hook deadline (§4). */
  readonly deadlineMs?: number;
  /** Injected git; without it the default runner is `runHookGit` with `options.gitPath`. */
  readonly git?: HookGitRunner;
}

export interface HookResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface InstallHooksOptions {
  readonly root: string;
  readonly apply: boolean;
  /**
   * §3.3: without it all three clients are written; with it, only that one (plus the shared loader
   * when it is Codex or OpenCode). Claude by default when the caller asks for nothing.
   */
  readonly client?: HookClient;
}

export interface InstallHooksResult {
  readonly ok: boolean;
  readonly text: string;
}

const RECIPE_FILE = '.ai-workflows/pipeline.yml';
const HOOKS_PATH = '.ai-workflows/githooks';
const GIT_BIN_ARGS: readonly string[] = ['node', 'node_modules/ai-workflows/dist/bin.js', 'hook'];

/**
 * The fixed line the Claude hook runs with `node -e`. It takes the project folder as its first
 * argument (falling back to `CLAUDE_PROJECT_DIR` when it is absent), imports the compiled engine
 * from `<project>/node_modules/ai-workflows/dist/bin.js` (converted to a file URL so the same line
 * works on Windows) and, if the engine is missing or throws while loading, writes the reason to
 * stderr and exits 2 — which Claude Code reads as a block. Every exit other than 0 or 2 becomes 2,
 * so an older engine that answers with an error can never let the tool through. A path never
 * appears in any written file: the folder arrives as an argument.
 */
export const HOOK_LOADER =
  "try{" +
  "var u=require('url'),p=require('path'),d=process.argv[1]||process.env.CLAUDE_PROJECT_DIR;" +
  "process.env.AI_WORKFLOWS_PROJECT_DIR=d;" +
  "process.on('exit',function(c){if(c!==0&&c!==2)process.exit(2);});" +
  "import(u.pathToFileURL(p.join(d,'node_modules','ai-workflows','dist','bin.js')).href)" +
  ".catch(function(e){process.stderr.write('ai-workflows: no se pudo cargar el motor: '" +
  "+(e&&e.message?e.message:e)+'\\n');process.exit(2);});" +
  "}catch(e){process.stderr.write('ai-workflows: no se pudo cargar el motor: '" +
  "+(e&&e.message?e.message:e)+'\\n');process.exit(2);}";

export interface RunHookGitRequest {
  readonly gitPath?: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** «20 s», «1.5 s»: the number the timeout messages name (§4 test 1). */
function secondsLabel(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return Number.isInteger(seconds) ? `${seconds}` : seconds.toFixed(1);
}

function timeoutReason(timeoutMs: number): string {
  return `git no respondió a tiempo (${secondsLabel(timeoutMs)} s)`;
}

/**
 * The pids below `root`, walking the tree, so a grandchild that left the process group (spawned
 * `detached`) is still named before the group is killed and can be ended by its own pid. On POSIX
 * only. `pgrep -P` returning nothing (exit 1) is caught; a child that cannot be listed is missed.
 */
function posixDescendants(root: number): number[] {
  let output = '';
  try {
    // One listing, then walk it: `ps -A -o pid=,ppid=` works on Linux and on macOS without a shell.
    // PLAN-13-R6 §15 (M4): `ps` gets its own short limit; a `ps` that hangs must not keep the hook
    // from answering. On timeout it throws here, the walk returns nothing, and the caller still
    // kills the process group.
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: POSIX_PS_TIMEOUT_MS,
    });
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] as string, 10);
    const ppid = Number.parseInt(match[2] as string, 10);
    const list = childrenOf.get(ppid);
    if (list === undefined) childrenOf.set(ppid, [pid]);
    else list.push(pid);
  }
  const found: number[] = [];
  const pending: number[] = [root];
  const seen = new Set<number>([root]);
  while (pending.length > 0) {
    const parent = pending.pop() as number;
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

/**
 * Ends one process tree on POSIX: the process group first (which holds every descendant that did
 * not leave it), then the detached descendants by their own pid. A process that is already gone
 * is not a reason to fail; the signal is best effort.
 */
export function killPosixTree(pid: number): void {
  if (pid <= 0) return;
  const descendants = posixDescendants(pid);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const descendant of descendants) {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Ends whatever a finished git left behind still holding its pipes (a grandchild that inherited
 * them): the process group on POSIX, the descendants by parent id on Windows. It only runs when
 * the pipes did not close after `exit`, so a normal git call never pays for it. Best effort: a
 * leftover that cannot be ended is not a reason to fail the call. On Windows the ending is
 * awaited, because the operating system releases the folder such a process held only a moment
 * after its pid disappears.
 */
async function killLeftovers(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 0) return;
  if (process.platform !== 'win32') {
    killPosixTree(pid);
    return;
  }
  let descendants: number[] = [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );
    descendants = (out.match(/\d+/g) ?? []).map(Number);
  } catch {
    return;
  }
  if (descendants.length === 0) return;
  for (const descendant of descendants) {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  const alive = (value: number): boolean => {
    try {
      process.kill(value, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = Date.now() + 1_000;
  while (descendants.some(alive) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The pid may be gone while the folder it held is still being released: a short settle so a
  // later removal does not race the teardown.
  await new Promise((resolve) => setTimeout(resolve, 75));
}

/**
 * The hook's own git, on `spawn`: it settles on the process's `exit` event, not on the pipes
 * closing, so a grandchild that inherited them cannot hold the hook. When its time runs out (or
 * its signal aborts) it kills the whole process tree and answers with the timeout reason. It runs
 * in the neutral language, without terminal prompts, without optional locks and without the
 * agents' credentials.
 */
export function runHookGit(request: RunHookGitRequest): Promise<HookGitAnswer> {
  return new Promise((resolve) => {
    const gitPath = request.gitPath ?? 'git';
    let child: ChildProcess;
    try {
      child = spawn(gitPath, [...request.args], {
        cwd: request.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: gitEnvironment({ ...HOOK_ENV }),
      });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: reasonOf(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined || pid <= 0) return;
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
          // The tree is already gone, or cannot be signalled: the run still answers.
        }
        return;
      }
      // §15: a grandchild that left the process group is named before the group is killed, so a
      // timed-out or aborted git leaves nothing alive behind.
      killPosixTree(pid);
    };

    const teardown = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (drain !== undefined) {
        clearTimeout(drain);
        drain = undefined;
      }
      // A grandchild may hold the pipes open: the streams are dropped by hand so this process can
      // end after the answer, instead of waiting on a pipe nobody will close.
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        try {
          stream?.destroy();
        } catch {
          // Already closed.
        }
      }
    };

    const finish = (answer: HookGitAnswer): void => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(answer);
    };

    const onTimeout = (): void => {
      killTree();
      finish({ ok: false, stdout: '', stderr: timeoutReason(request.timeoutMs) });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < GIT_MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < GIT_MAX_OUTPUT) stderr += chunk;
    });
    child.on('error', (error) => finish({ ok: false, stdout, stderr: reasonOf(error) }));
    child.on('close', () => {
      closed = true;
    });
    // The answer comes from `exit`; the short drain lets the pipes flush the last bytes that were
    // already written, which matters when a grandchild keeps them open and `close` never fires.
    // If the pipes did not close, that grandchild is ended too, so the call leaves nothing behind.
    child.on('exit', (code) => {
      drain = setTimeout(() => {
        drain = undefined;
        void (async () => {
          if (!closed) await killLeftovers(child.pid);
          finish({ ok: code === 0, stdout, stderr });
        })();
      }, 50);
    });

    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        onTimeout();
        return;
      }
      request.signal.addEventListener('abort', onTimeout, { once: true });
    }
    if (Number.isFinite(request.timeoutMs)) {
      timer = setTimeout(onTimeout, Math.max(0, request.timeoutMs));
    }
  });
}

/** One git call of a hook run: cwd and args, with the run's deadline applied on top. */
type GitRun = (cwd: string, args: readonly string[]) => Promise<HookGitAnswer>;

interface HookGitSession {
  readonly run: GitRun;
  dispose(): void;
}

/**
 * The deadline of one hook run (§4). Every call is given `min(HOOK_GIT_CALL_MS, what is left −
 * reserve)`; when the deadline passes each pending call answers with the timeout reason, the
 * signal is aborted and no timer is left behind. The losing timer is cleared at the end so a run
 * that answered first leaves nothing pending.
 */
function createHookGitSession(runner: HookGitRunner, deadlineMs: number): HookGitSession {
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolveExpired) => {
    timer = setTimeout(() => {
      timer = undefined;
      controller.abort();
      resolveExpired('expired');
    }, Math.max(0, deadlineAt - Date.now()));
  });

  const run: GitRun = async (cwd, args) => {
    const left = deadlineAt - Date.now();
    const timeoutMs = Math.max(0, Math.min(HOOK_GIT_CALL_MS, left - HOOK_GIT_RESERVE_MS));
    const call = runner({ cwd, args, timeoutMs, signal: controller.signal }).then(
      (answer): { readonly expired: false; readonly answer: HookGitAnswer } => ({ expired: false, answer }),
      (error): { readonly expired: false; readonly answer: HookGitAnswer } => ({
        expired: false,
        answer: { ok: false, stdout: '', stderr: reasonOf(error) },
      }),
    );
    const winner = await Promise.race([call, expired]);
    if (winner === 'expired') {
      return { ok: false, stdout: '', stderr: timeoutReason(deadlineMs) };
    }
    return winner.answer;
  };

  return {
    run,
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** The default runner: the hook's own git with the executable the caller named. */
function defaultRunner(options: RunHookOptions): HookGitRunner {
  if (options.git !== undefined) return options.git;
  const gitPath = options.gitPath ?? 'git';
  return (request) =>
    runHookGit({
      gitPath,
      cwd: request.cwd,
      args: request.args,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
}

function fold(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

interface WorkCopy {
  readonly root: string;
  /** The common git directory, folded for comparison: two worktrees share it, another repo does not. */
  readonly commonKey: string;
  /** The common git directory, as git reports it. */
  readonly commonDir: string;
  /** This working copy's own git directory (`--absolute-git-dir`). */
  readonly gitDir: string;
  readonly branch: string | undefined;
}

/** What git answered about a folder: the working copy, no repository, or a failure with its motive. */
type WorkCopyLookup =
  | { readonly kind: 'copy'; readonly copy: WorkCopy }
  | { readonly kind: 'outside' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Git's own way of saying the path is in no work tree, in the languages it may answer in. */
const NO_REPOSITORY = /not a git repository|must be run in a work tree|no es un repositorio de git/i;

/**
 * Looks for the working copy that contains `dir` (PLAN-13-R5 §1.2). Git failing because there is
 * no repository is `outside`; git failing for any other reason is `failed` with its motive, so the
 * caller refuses instead of reading the path as outside the project.
 */
async function lookupWorkCopyAt(dir: string, run: GitRun): Promise<WorkCopyLookup> {
  const top = await run(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok || top.stdout.trim().length === 0) {
    const reason = top.stderr.trim();
    return NO_REPOSITORY.test(reason) ? { kind: 'outside' } : { kind: 'failed', reason: reason || 'git no respondió' };
  }
  const common = await run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok || common.stdout.trim().length === 0) {
    return { kind: 'failed', reason: common.stderr.trim() || 'git no respondió' };
  }
  const gitDir = await run(dir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok || gitDir.stdout.trim().length === 0) {
    return { kind: 'failed', reason: gitDir.stderr.trim() || 'git no respondió' };
  }

  const root = top.stdout.trim();
  const branch = await run(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    kind: 'copy',
    copy: {
      root,
      commonKey: fold(resolve(common.stdout.trim())),
      commonDir: resolve(common.stdout.trim()),
      gitDir: resolve(gitDir.stdout.trim()),
      branch: branch.ok && branch.stdout.trim().length > 0 ? branch.stdout.trim() : undefined,
    },
  };
}

/** The working copy that contains `dir`, or `undefined` when `dir` is in no work tree. */
async function workCopyAt(dir: string, run: GitRun): Promise<WorkCopy | undefined> {
  const found = await lookupWorkCopyAt(dir, run);
  return found.kind === 'copy' ? found.copy : undefined;
}

/**
 * The working copy that owns a path inside the repository's own git area (PLAN-13-R5 §1.2), or
 * `outside` when the path is not in this repository's git area. Git refuses `--show-toplevel`
 * inside `.git`, so those paths would otherwise read as "outside any repository" and let an agent
 * rewrite the configuration or switch the hooks off. A linked worktree keeps the path of its own
 * work tree in `<common>/worktrees/<name>/gitdir`, so the ruling copy is that one, not the session.
 *
 * PLAN-13-R6 §4: a git that fails on the way is a `failed` answer, never `outside`; the caller
 * refuses with the motive instead of letting the path through.
 */
async function workCopyOwningGitPath(
  target: string,
  watched: WorkCopy,
  run: GitRun,
): Promise<WorkCopyLookup> {
  const targetAbs = readAbsolute(target);
  const common = readAbsolute(watched.commonDir);
  if (!targetAbs.ok || !common.ok || !isUnder(targetAbs.path, common.path)) return { kind: 'outside' };

  const rel = relative(watched.commonDir, targetAbs.path.display).split(/[\\/]+/);
  if (rel[0] === 'worktrees' && rel[1] !== undefined && rel[1].length > 0) {
    try {
      const pointer = readFileSync(join(watched.commonDir, 'worktrees', rel[1], 'gitdir'), 'utf8').trim();
      if (pointer.length > 0) {
        const owner = await lookupWorkCopyAt(dirname(resolve(pointer)), run);
        if (owner.kind !== 'outside') return owner;
      }
    } catch {
      // No readable pointer: fall through to the main working copy, which shares the same repo.
    }
  }
  return await lookupWorkCopyAt(dirname(watched.commonDir), run);
}

interface RecipeReading {
  readonly ok: true;
  readonly recipe: Recipe;
}

/** Reads the recipe of a working copy; a missing or invalid one is a reason, never a throw. */
function readRecipe(root: string): RecipeReading | { readonly ok: false; readonly problem: string } {
  const path = join(root, RECIPE_FILE);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, problem: `${RECIPE_FILE}: no se pudo leer la receta` };
  }
  const parsed = parseRecipe(content, RECIPE_FILE);
  if (!parsed.ok) {
    const first = parsed.errors[0];
    return {
      ok: false,
      problem:
        first === undefined
          ? `${RECIPE_FILE}: la receta no es válida`
          : `${first.file}:${first.line}:${first.column}: ${first.message}`,
    };
  }
  return { ok: true, recipe: parsed.recipe };
}

function contextForCopy(copy: WorkCopy): LockContext {
  const read = readRecipe(copy.root);
  return lockContextFor({
    root: copy.root,
    branch: copy.branch,
    recipe: read.ok ? read.recipe : { invalid: read.problem },
  });
}

/** The existing directory closest to a path, so git is asked from inside the working copy. */
function nearestExistingDir(target: string): string {
  let dir = dirname(target);
  for (;;) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir || parent.length === 0) return dir;
    dir = parent;
  }
}

function resolveTarget(target: string, cwd: string): string {
  // `resolve` normalizes a Windows rooted spelling (`\x`) against the cwd's drive, like the lock's
  // own path reader does; an already absolute path is kept as it is.
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function editorOutput(client: HookClient, decision: LockDecision): HookResult {
  return renderClientOutput(client, decision);
}

/** The real path of an existing folder, or the same spelling when it cannot be resolved. */
function realPathOf(value: string): string {
  try {
    // `native` asks the filesystem: on Windows it expands the short 8.3 name and the NTFS stream
    // form, both of which reach inside a folder without spelling its real name (PLAN-13-R5 §1.2).
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * PLAN-13-R6 §3.2: Codex and OpenCode do not hand the project folder over. It is read from the
 * folder the hook runs in and from the request's `cwd` with git; if neither is in a work tree the
 * caller refuses in that client's format. The request's own `cwd` is tried first, since the hook
 * may run in a neutral folder; if neither resolves, that first failure is the answer.
 */
async function clientWorkCopy(cwd: string, requestCwd: string, run: GitRun): Promise<WorkCopyLookup> {
  // The request's own `cwd` is the session's folder and is tried first: the folder the hook runs
  // in may be a neutral one (the OpenCode plugin runs the loader outside the project), and that
  // must never be mistaken for the project the tool is writing into.
  const order = requestCwd.length > 0 && requestCwd !== cwd ? [requestCwd, cwd] : [cwd];
  let firstFailure: WorkCopyLookup | undefined;
  for (const dir of order) {
    const found = await lookupWorkCopyAt(dir, run);
    if (found.kind === 'copy') return found;
    if (firstFailure === undefined) firstFailure = found;
  }
  return firstFailure ?? { kind: 'outside' };
}

async function runEditor(options: RunHookOptions, run: GitRun, client: HookClient): Promise<HookResult> {
  const parsed = parseClientInput(client, options.stdin);
  if ('error' in parsed) {
    return editorOutput(client, {
      allow: false,
      reason: `No pude leer la solicitud del CLI (${parsed.error}); me niego en vez de dejar pasar a ciegas.`,
    });
  }

  // Claude is told its project folder by `${CLAUDE_PROJECT_DIR}`; the other two are not, and their
  // root comes from git over the folders the hook runs in and the request names (§3.2).
  const watchedLookup =
    client === 'claude'
      ? await lookupWorkCopyAt(options.projectDir ?? options.cwd, run)
      : await clientWorkCopy(options.cwd, parsed.cwd, run);
  if (watchedLookup.kind === 'failed') {
    return editorOutput(client, {
      allow: false,
      reason:
        `Git no pudo decir a qué repositorio pertenece la carpeta del proyecto (${watchedLookup.reason}); ` +
        'el candado se niega en vez de dejar pasar a ciegas.',
    });
  }
  if (watchedLookup.kind === 'outside') {
    return editorOutput(client, {
      allow: false,
      reason:
        'La carpeta del proyecto no es un repositorio de git: el candado no puede vigilar nada y ' +
        'se niega en vez de dejar pasar a ciegas.',
    });
  }
  const watched = watchedLookup.copy;

  const sessionContext = contextForCopy(watched);

  // Rule 0 once on the whole request: writing an order is refused wherever the target folder is.
  const order = orderRefusal(parsed, sessionContext);
  if (order !== undefined) return editorOutput(client, order);

  if (!isCoveredWriteTool(parsed.toolName)) return { stdout: '', stderr: '', exitCode: 0 };

  const targets = writeTargets(parsed.toolName, parsed.toolInput);
  // A writing tool whose paths cannot be read is refused, exactly like rule 5: an empty patch is
  // not "nothing to judge" but a request the lock could not read.
  if (targets === undefined || targets.length === 0) {
    return editorOutput(client, {
      allow: false,
      reason:
        'No pude leer las rutas de esta herramienta: el candado se niega a adivinar. Revisa el ' +
        'formato de tool_input.',
    });
  }

  for (const target of targets) {
    const absolute = resolveTarget(target, parsed.cwd);
    // The nearest existing folder is resolved through any link first: a shortcut into the project
    // is judged by where it leads, not by the name it was reached through.
    const nearest = nearestExistingDir(absolute);
    const realNearest = realPathOf(nearest);
    const rest = relative(nearest, absolute);
    const judged = rest.length === 0 ? realNearest : join(realNearest, rest);

    const found = await lookupWorkCopyAt(realNearest, run);
    if (found.kind === 'failed') {
      // A git that fails for a reason other than "no repository" might be a real work tree the
      // lock cannot read: refusing is the only honest answer (PLAN-13-R5 §1.2).
      return editorOutput(client, {
        allow: false,
        reason:
          `Git no pudo decir a qué repositorio pertenece esta ruta (${found.reason}); el candado ` +
          'se niega en vez de dejarla pasar a ciegas.',
      });
    }
    if (found.kind === 'outside') {
      // Not in a work tree: it may still be the repository's own git area, which git refuses to
      // call a work tree. That is this lock's business, judged with the copy that owns it.
      const owner = await workCopyOwningGitPath(judged, watched, run);
      if (owner.kind === 'failed') {
        return editorOutput(client, {
          allow: false,
          reason:
            `Git no pudo decir a qué repositorio pertenece esta ruta (${owner.reason}); el candado ` +
            'se niega en vez de dejarla pasar a ciegas.',
        });
      }
      if (owner.kind === 'copy') {
        const decision = decideGitFolder(contextForCopy(owner.copy));
        if (!decision.allow) return editorOutput(client, decision);
        continue;
      }
      // A path under the watched work tree whose git failed (a broken `.git` in a subfolder) is
      // still the project's own code: it is judged with the watched context, never as outside.
      const judgedPath = readAbsolute(judged);
      const watchedRoot = readAbsolute(watched.root);
      if (judgedPath.ok && watchedRoot.ok && isUnder(judgedPath.path, watchedRoot.path)) {
        const single: HookInput = {
          toolName: 'Write',
          toolInput: { file_path: judged, content: '' },
          cwd: parsed.cwd,
        };
        const decision = decideToolUse(single, sessionContext);
        if (!decision.allow) return editorOutput(client, decision);
      }
      continue;
    }

    const copy = found.copy;
    // In another repository: not this lock's business (rule 6).
    if (copy.commonKey !== watched.commonKey) continue;

    // The folder rules are decided with the copy that holds the path; only the path matters here,
    // because rule 0 already ran on the whole request above.
    const single: HookInput = {
      toolName: 'Write',
      toolInput: { file_path: judged, content: '' },
      cwd: parsed.cwd,
    };
    const decision = decideToolUse(single, contextForCopy(copy));
    if (!decision.allow) return editorOutput(client, decision);
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}

async function runPreCommit(options: RunHookOptions, run: GitRun): Promise<HookResult> {
  const found = await lookupWorkCopyAt(options.cwd, run);
  if (found.kind === 'failed') {
    return { stdout: '', stderr: `No pude leer el repositorio: ${found.reason}`, exitCode: 1 };
  }
  if (found.kind === 'outside') {
    return {
      stdout: '',
      stderr: 'Este gancho corre fuera de un repositorio de git: me niego en vez de adivinar.',
      exitCode: 1,
    };
  }
  const copy = found.copy;

  const staged = await run(copy.root, STAGED_PATHS_GIT_ARGS);
  if (!staged.ok) {
    return { stdout: '', stderr: `No pude leer lo preparado: ${staged.stderr.trim()}`, exitCode: 1 };
  }

  const context = contextForCopy(copy);
  const decision = decidePreCommit({ stagedPaths: parseStagedPaths(staged.stdout), context });
  if (decision.allow) return { stdout: '', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: decision.reason, exitCode: 1 };
}

async function runPrePush(options: RunHookOptions, run: GitRun): Promise<HookResult> {
  const found = await lookupWorkCopyAt(options.cwd, run);
  if (found.kind === 'failed') {
    return { stdout: '', stderr: `No pude leer el repositorio: ${found.reason}`, exitCode: 1 };
  }
  if (found.kind === 'outside') {
    return {
      stdout: '',
      stderr: 'Este gancho corre fuera de un repositorio de git: me niego en vez de adivinar.',
      exitCode: 1,
    };
  }
  const copy = found.copy;

  // Without the network: the default branch is what `origin/HEAD` already says.
  const head = await run(copy.root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (!head.ok || head.stdout.trim().length === 0) {
    return {
      stdout: '',
      stderr:
        'No pude saber la rama principal sin red. Arréglalo con: ' +
        'git remote set-head origin --auto\n',
      exitCode: 1,
    };
  }
  const reference = head.stdout.trim();
  const defaultBranch = reference.startsWith('origin/')
    ? reference.slice('origin/'.length)
    : reference;

  const parsed = parsePrePushStdin(options.stdin);
  if (!parsed.ok) return { stdout: '', stderr: parsed.reason, exitCode: 1 };

  const decision = decidePrePush({ remoteRefs: parsed.remoteRefs, defaultBranch });
  if (decision.allow) return { stdout: '', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: decision.reason, exitCode: 1 };
}

/**
 * The refusal the watchdog writes when the deciding thread is blocked and the work cannot answer
 * (§4). It is the refusal of that client: editor, the deny JSON with exit 0; git hooks, the reason
 * on stderr with exit 1.
 */
function watchdogRefusal(kind: HookKind, watchdogMs: number, client: HookClient): HookResult {
  const reason = `El gancho tardó más tiempo del permitido (${secondsLabel(watchdogMs)} s): me niego en vez de dejar pasar a ciegas.`;
  if (kind === 'editor') return editorOutput(client, { allow: false, reason });
  return { stdout: '', stderr: reason, exitCode: 1 };
}

/**
 * The watchdog of the main thread (§4): the work's answer if it comes first, otherwise the refusal
 * of that kind when `watchdogMs` passes. It clears its timer when the work answers, so an answered
 * run leaves nothing pending.
 */
export function superviseHook(
  kind: HookKind,
  work: Promise<HookResult>,
  watchdogMs = HOOK_WATCHDOG_MS,
  client: HookClient = 'claude',
): Promise<HookResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(watchdogRefusal(kind, watchdogMs, client)), Math.max(0, watchdogMs));
    work.then(
      (result) => finish(result),
      (error) =>
        finish(
          kind === 'editor'
            ? editorOutput(client, { allow: false, reason: `El candado falló por dentro (${reasonOf(error)}); me niego.` })
            : { stdout: '', stderr: reasonOf(error), exitCode: 1 },
        ),
    );
  });
}

/** The whole hook: read the kind, decide, answer. Any internal failure is a refusal, never a pass. */
export async function runHook(kind: HookKind, options: RunHookOptions): Promise<HookResult> {
  const client = options.client ?? 'claude';
  const deadlineMs = options.deadlineMs ?? (kind === 'editor' ? HOOK_DEADLINE_MS : GIT_HOOK_DEADLINE_MS);
  const git = createHookGitSession(defaultRunner(options), deadlineMs);
  try {
    if (kind === 'editor') return await runEditor(options, git.run, client);
    if (kind === 'pre-commit') return await runPreCommit(options, git.run);
    return await runPrePush(options, git.run);
  } catch (error) {
    // A lock that blows up must not let the tool through: say why and refuse, in this client's
    // format so Codex never reads an exit 2 and OpenCode never reads it as a pass.
    if (kind !== 'editor') return { stdout: '', stderr: reasonOf(error), exitCode: 1 };
    return editorOutput(client, {
      allow: false,
      reason: `El candado falló por dentro (${reasonOf(error)}); me niego en vez de dejar pasar.`,
    });
  } finally {
    git.dispose();
  }
}

/** A runner for a caller outside `runHook` (the installer): the hook's git with the git-hook budget. */
function plainRunner(gitPath = 'git'): GitRun {
  return (cwd, args) => runHookGit({ gitPath, cwd, args, timeoutMs: GIT_HOOK_DEADLINE_MS });
}

/** The plan text, and what `--apply` writes: the Claude hook, the git hooks and the local path. */
export async function installHooks(options: InstallHooksOptions): Promise<InstallHooksResult> {
  const run = plainRunner();
  const copy = await workCopyAt(options.root, run);
  if (copy === undefined) {
    return { ok: false, text: 'No se puede instalar: la carpeta no es un repositorio de git.' };
  }

  const read = readRecipe(copy.root);
  if (!read.ok) {
    return { ok: false, text: `No se puede instalar: la receta no sirve (${read.problem}).` };
  }
  if (read.recipe.pieces === undefined) {
    return { ok: false, text: 'No se puede instalar: la receta no declara pieces:.' };
  }

  // A local hooksPath of another tool is never taken over; a global one is never touched (only
  // `--local` is read and written).
  const current = await run(copy.root, ['config', '--local', '--get', 'core.hooksPath']);
  const existingPath = current.ok ? current.stdout.trim() : '';
  if (existingPath.length > 0 && existingPath !== HOOKS_PATH) {
    return {
      ok: false,
      text:
        `No se toca core.hooksPath: ya apunta a "${existingPath}", que no es de ai-workflows. ` +
        'Resuélvelo a mano antes de instalar.',
    };
  }

  // §3.3: all three clients by default, one of them with `--client`. The loader is shared by Codex
  // and OpenCode, so it is written whenever either is asked for.
  const selected: ReadonlySet<HookClient> = new Set<HookClient>(
    options.client === undefined ? ['claude', 'codex', 'opencode'] : [options.client],
  );
  const withClaude = selected.has('claude');
  const withCodex = selected.has('codex');
  const withOpencode = selected.has('opencode');
  const withLoader = withCodex || withOpencode;

  // --- Claude: merge our entry into .claude/settings.json, keeping everything else exactly.
  const matcher = buildHooksConfig('claude', 'node').hooks.PreToolUse[0]?.matcher ?? '';
  const ourHandler: HookHandler = {
    type: 'command',
    command: 'node',
    args: ['-e', HOOK_LOADER, '${CLAUDE_PROJECT_DIR}', 'hook', 'editor'],
    timeout: 30,
  };
  const ours: HooksFile = { hooks: { PreToolUse: [{ matcher, hooks: [ourHandler] }] } };
  // PLAN-13-R6 §2.1: the same constant the judge protects, so the installer and the list can
  // never drift apart.
  const settingsPath = join(copy.root, CLAUDE_SETTINGS_PATH);
  let mergedClaude: Record<string, unknown> | undefined;
  if (withClaude) {
    try {
      const existing = existsSync(settingsPath)
        ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown)
        : undefined;
      mergedClaude = mergeHooksConfig(existing, ours);
    } catch (error) {
      return {
        ok: false,
        text: `No se puede leer .claude/settings.json sin perder lo que tiene: ${reasonOf(error)}`,
      };
    }
  }

  // --- Codex: merge our entry into .codex/hooks.json, under the matcher `.*` so every tool —
  // unknown ones with a path included — reaches the hook.
  const codexPath = join(copy.root, '.codex', 'hooks.json');
  const codexOurs: HooksFile = {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            { type: 'command', command: CODEX_HOOK_ORDER, commandWindows: CODEX_HOOK_ORDER_WINDOWS, timeout: 30 },
          ],
        },
      ],
    },
  };
  let mergedCodex: Record<string, unknown> | undefined;
  if (withCodex) {
    try {
      const existing = existsSync(codexPath)
        ? (JSON.parse(readFileSync(codexPath, 'utf8')) as unknown)
        : undefined;
      // §15: an older order of ours is recognized by the loader it runs, so a reinstall replaces
      // it in place instead of adding a second entry; foreign hooks are left exactly as they were.
      mergedCodex = mergeHooksConfig(existing, codexOurs, { isOur: isOurCodexHandler });
    } catch (error) {
      return {
        ok: false,
        text: `No se puede leer .codex/hooks.json sin perder lo que tiene: ${reasonOf(error)}`,
      };
    }
  }

  // --- OpenCode: a whole plugin file. A file there that is not ours is never overwritten, and
  // nothing else is written either: the whole install stops and names it.
  const pluginPath = join(copy.root, '.opencode', 'plugins', 'ai-workflows.js');
  if (withOpencode && existsSync(pluginPath)) {
    let existingPlugin: string;
    try {
      existingPlugin = readFileSync(pluginPath, 'utf8');
    } catch (error) {
      return { ok: false, text: `No se puede leer .opencode/plugins/ai-workflows.js: ${reasonOf(error)}` };
    }
    if (!isOurPlugin(existingPlugin)) {
      return {
        ok: false,
        text: 'No se toca .opencode/plugins/ai-workflows.js: ese archivo no es de ai-workflows.',
      };
    }
  }

  const planLines = ['Se escribiría, sin tocar nada más:'];
  if (withClaude) {
    planLines.push('  .claude/settings.json (se funde con lo que ya haya)');
    planLines.push(`  ${HOOKS_PATH}/pre-commit`);
    planLines.push(`  ${HOOKS_PATH}/pre-push`);
    planLines.push(`  git config --local core.hooksPath ${HOOKS_PATH}`);
  }
  if (withCodex) planLines.push('  .codex/hooks.json (se funde con lo que ya haya)');
  if (withOpencode) planLines.push('  .opencode/plugins/ai-workflows.js');
  if (withLoader) planLines.push(`  ${LOADER_RELATIVE}`);
  planLines.push('', 'Usa --apply para escribirlo.');
  const plan = planLines.join('\n');
  if (!options.apply) return { ok: true, text: plan };

  try {
    if (withClaude && mergedClaude !== undefined) {
      mkdirSync(join(copy.root, '.claude'), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(mergedClaude, null, 2)}\n`);
    }

    // The git hooks are the second layer, shared by every client: they are installed whatever
    // client was asked for, as they were before `--client` existed.
    const hooksDir = join(copy.root, HOOKS_PATH);
    mkdirSync(hooksDir, { recursive: true });
    for (const kind of ['pre-commit', 'pre-push'] as const) {
      const file = join(hooksDir, kind);
      writeFileSync(file, renderGitHook(kind, GIT_BIN_ARGS));
      if (process.platform !== 'win32') chmodSync(file, 0o755);
    }
    const set = await run(copy.root, ['config', '--local', 'core.hooksPath', HOOKS_PATH]);
    if (!set.ok) {
      return { ok: false, text: `No se pudo fijar core.hooksPath: ${set.stderr.trim()}` };
    }

    if (withCodex && mergedCodex !== undefined) {
      mkdirSync(join(copy.root, '.codex'), { recursive: true });
      writeFileSync(codexPath, `${JSON.stringify(mergedCodex, null, 2)}\n`);
    }
    if (withLoader) writeFileSync(join(copy.root, LOADER_RELATIVE), HOOK_LOADER_CJS);
    if (withOpencode) {
      mkdirSync(join(copy.root, '.opencode', 'plugins'), { recursive: true });
      writeFileSync(pluginPath, OPENCODE_PLUGIN_JS);
    }
  } catch (error) {
    return { ok: false, text: `No se pudo instalar: ${reasonOf(error)}` };
  }

  // §15: name every path that was written, so the owner can see what changed, and say the one
  // thing Codex does not do on its own: `exec` skips a hook that was never approved.
  const written: string[] = [];
  if (withClaude) written.push('.claude/settings.json');
  written.push(`${HOOKS_PATH}/pre-commit`);
  written.push(`${HOOKS_PATH}/pre-push`);
  if (withCodex) written.push('.codex/hooks.json');
  if (withOpencode) written.push('.opencode/plugins/ai-workflows.js');
  if (withLoader) written.push(LOADER_RELATIVE);

  const installed = ['Ganchos instalados. Archivos escritos:'];
  for (const file of written) installed.push(`  ${file}`);
  if (withCodex || withOpencode) {
    installed.push('');
    installed.push(
      'En Codex interactivo, aprueba el gancho una vez en /hooks. Codex exec salta los ganchos no ' +
        'aprobados salvo con --dangerously-bypass-hook-trust.',
    );
  }

  return { ok: true, text: installed.join('\n') };
}
