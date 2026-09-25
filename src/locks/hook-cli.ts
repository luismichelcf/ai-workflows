// PLAN-13-R5 §1.2 and §1.5: the `hook` and `hooks install` commands.
//
// The editor hook judges every path with the working copy that holds it, never with the folder the
// session started in: Claude Code can walk into a linked worktree mid-session and
// `${CLAUDE_PROJECT_DIR}` does not follow. Git and the file system are real here; the decisions
// themselves stay in editor.ts and git.ts, which are pure.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { childEnvironment } from '../git-env.js';
import { parseRecipe } from '../recipe/parse.js';
import type { Recipe } from '../recipe/types.js';
import { lockContextFor } from './context.js';
import { isUnder, readAbsolute } from './paths.js';
import {
  decideGitFolder,
  decideToolUse,
  isCoveredWriteTool,
  orderRefusal,
  parseHookInput,
  renderHookOutput,
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
  type HookHandler,
  type HooksFile,
} from './install.js';

export type HookKind = 'editor' | 'pre-commit' | 'pre-push';

export interface RunHookOptions {
  /** The folder the hook was installed in; Claude substitutes it for `${CLAUDE_PROJECT_DIR}`. */
  readonly projectDir: string;
  /** The folder of the request (the CLI's `cwd`), which relative paths are read against. */
  readonly cwd: string;
  readonly stdin: string;
  readonly argv?: readonly string[];
  /** The git executable, by default `git`. A caller may point at one that does not answer. */
  readonly gitPath?: string;
}

export interface HookResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface InstallHooksOptions {
  readonly root: string;
  readonly apply: boolean;
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

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(cwd: string, args: readonly string[], gitPath = 'git'): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      gitPath,
      [...args],
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: childEnvironment(),
      },
      (error, stdout, stderr) => {
        done({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** The working copy that contains `dir`, or `undefined` when `dir` is in no work tree. */
async function workCopyAt(dir: string, gitPath = 'git'): Promise<WorkCopy | undefined> {
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'], gitPath);
  if (!top.ok || top.stdout.trim().length === 0) return undefined;
  const common = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], gitPath);
  if (!common.ok || common.stdout.trim().length === 0) return undefined;
  const gitDir = await runGit(dir, ['rev-parse', '--absolute-git-dir'], gitPath);
  if (!gitDir.ok || gitDir.stdout.trim().length === 0) return undefined;

  const root = top.stdout.trim();
  const branch = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], gitPath);
  return {
    root,
    commonKey: fold(resolve(common.stdout.trim())),
    commonDir: resolve(common.stdout.trim()),
    gitDir: resolve(gitDir.stdout.trim()),
    branch: branch.ok && branch.stdout.trim().length > 0 ? branch.stdout.trim() : undefined,
  };
}

/**
 * The working copy that owns a path inside the repository's own git area (PLAN-13-R5 §1.2), or
 * `undefined` when the path is not in this repository's git area. Git refuses `--show-toplevel`
 * inside `.git`, so those paths would otherwise read as "outside any repository" and let an agent
 * rewrite the configuration or switch the hooks off. A linked worktree keeps the path of its own
 * work tree in `<common>/worktrees/<name>/gitdir`, so the ruling copy is that one, not the session.
 */
async function workCopyOwningGitPath(
  target: string,
  watched: WorkCopy,
  gitPath: string,
): Promise<WorkCopy | undefined> {
  const targetAbs = readAbsolute(target);
  const common = readAbsolute(watched.commonDir);
  if (!targetAbs.ok || !common.ok || !isUnder(targetAbs.path, common.path)) return undefined;

  const rel = relative(watched.commonDir, targetAbs.path.display).split(/[\\/]+/);
  if (rel[0] === 'worktrees' && rel[1] !== undefined && rel[1].length > 0) {
    try {
      const pointer = readFileSync(join(watched.commonDir, 'worktrees', rel[1], 'gitdir'), 'utf8').trim();
      if (pointer.length > 0) {
        const owner = await workCopyAt(dirname(resolve(pointer)), gitPath);
        if (owner !== undefined) return owner;
      }
    } catch {
      // No readable pointer: fall through to the main working copy, which shares the same repo.
    }
  }
  return await workCopyAt(dirname(watched.commonDir), gitPath);
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

function editorOutput(decision: LockDecision): HookResult {
  const out = renderHookOutput(decision);
  return { stdout: out.stdout, stderr: '', exitCode: out.exitCode };
}

/** The real path of an existing folder, or the same spelling when it cannot be resolved. */
function realPathOf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

async function runEditor(options: RunHookOptions): Promise<HookResult> {
  const gitPath = options.gitPath ?? 'git';
  const parsed = parseHookInput(options.stdin);
  if ('error' in parsed) {
    return editorOutput({
      allow: false,
      reason: `No pude leer la solicitud del CLI (${parsed.error}); me niego en vez de dejar pasar a ciegas.`,
    });
  }

  const watched = await workCopyAt(options.projectDir, gitPath);
  if (watched === undefined) {
    return editorOutput({
      allow: false,
      reason:
        'La carpeta del proyecto no es un repositorio de git: el candado no puede vigilar nada y ' +
        'se niega en vez de dejar pasar a ciegas.',
    });
  }

  const sessionContext = contextForCopy(watched);

  // Rule 0 once on the whole request: writing an order is refused wherever the target folder is.
  const order = orderRefusal(parsed, sessionContext);
  if (order !== undefined) return editorOutput(order);

  if (!isCoveredWriteTool(parsed.toolName)) return { stdout: '', stderr: '', exitCode: 0 };

  const targets = writeTargets(parsed.toolName, parsed.toolInput);
  // A writing tool whose paths cannot be read is refused, exactly like rule 5: an empty patch is
  // not "nothing to judge" but a request the lock could not read.
  if (targets === undefined || targets.length === 0) {
    return editorOutput({
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

    const copy = await workCopyAt(realNearest, gitPath);
    if (copy === undefined) {
      // Not in a work tree: it may still be the repository's own git area, which git refuses to
      // call a work tree. That is this lock's business, judged with the copy that owns it.
      const owner = await workCopyOwningGitPath(judged, watched, gitPath);
      if (owner === undefined) continue;
      const decision = decideGitFolder(contextForCopy(owner));
      if (!decision.allow) return editorOutput(decision);
      continue;
    }
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
    if (!decision.allow) return editorOutput(decision);
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}

async function runPreCommit(options: RunHookOptions): Promise<HookResult> {
  const gitPath = options.gitPath ?? 'git';
  const copy = await workCopyAt(options.cwd, gitPath);
  if (copy === undefined) {
    return {
      stdout: '',
      stderr: 'Este gancho corre fuera de un repositorio de git: me niego en vez de adivinar.',
      exitCode: 1,
    };
  }

  const staged = await runGit(copy.root, STAGED_PATHS_GIT_ARGS, gitPath);
  if (!staged.ok) {
    return { stdout: '', stderr: `No pude leer lo preparado: ${staged.stderr.trim()}`, exitCode: 1 };
  }

  const context = contextForCopy(copy);
  const decision = decidePreCommit({ stagedPaths: parseStagedPaths(staged.stdout), context });
  if (decision.allow) return { stdout: '', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: decision.reason, exitCode: 1 };
}

async function runPrePush(options: RunHookOptions): Promise<HookResult> {
  const gitPath = options.gitPath ?? 'git';
  const copy = await workCopyAt(options.cwd, gitPath);
  if (copy === undefined) {
    return {
      stdout: '',
      stderr: 'Este gancho corre fuera de un repositorio de git: me niego en vez de adivinar.',
      exitCode: 1,
    };
  }

  // Without the network: the default branch is what `origin/HEAD` already says.
  const head = await runGit(copy.root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], gitPath);
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

/** The whole hook: read the kind, decide, answer. Any internal failure is a refusal, never a pass. */
export async function runHook(kind: HookKind, options: RunHookOptions): Promise<HookResult> {
  try {
    if (kind === 'editor') return await runEditor(options);
    if (kind === 'pre-commit') return await runPreCommit(options);
    return await runPrePush(options);
  } catch (error) {
    // A lock that blows up must not let the tool through: say why and refuse.
    const result = editorOutput({
      allow: false,
      reason: `El candado falló por dentro (${reasonOf(error)}); me niego en vez de dejar pasar.`,
    });
    return kind === 'editor' ? result : { stdout: '', stderr: result.stdout, exitCode: 1 };
  }
}

/** The plan text, and what `--apply` writes: the Claude hook, the git hooks and the local path. */
export async function installHooks(options: InstallHooksOptions): Promise<InstallHooksResult> {
  const copy = await workCopyAt(options.root);
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
  const current = await runGit(copy.root, ['config', '--local', '--get', 'core.hooksPath']);
  const existingPath = current.ok ? current.stdout.trim() : '';
  if (existingPath.length > 0 && existingPath !== HOOKS_PATH) {
    return {
      ok: false,
      text:
        `No se toca core.hooksPath: ya apunta a "${existingPath}", que no es de ai-workflows. ` +
        'Resuélvelo a mano antes de instalar.',
    };
  }

  const matcher = buildHooksConfig('claude', 'node').hooks.PreToolUse[0]?.matcher ?? '';
  const ourHandler: HookHandler = {
    type: 'command',
    command: 'node',
    args: ['-e', HOOK_LOADER, '${CLAUDE_PROJECT_DIR}', 'hook', 'editor'],
    timeout: 30,
  };
  const ours: HooksFile = { hooks: { PreToolUse: [{ matcher, hooks: [ourHandler] }] } };

  const settingsPath = join(copy.root, '.claude', 'settings.json');
  let merged: Record<string, unknown>;
  try {
    const existing = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown)
      : undefined;
    merged = mergeHooksConfig(existing, ours);
  } catch (error) {
    return {
      ok: false,
      text: `No se puede leer .claude/settings.json sin perder lo que tiene: ${reasonOf(error)}`,
    };
  }

  const plan = [
    'Se escribiría, sin tocar nada más:',
    `  .claude/settings.json (se funde con lo que ya haya)`,
    `  ${HOOKS_PATH}/pre-commit`,
    `  ${HOOKS_PATH}/pre-push`,
    `  git config --local core.hooksPath ${HOOKS_PATH}`,
    '',
    'Usa --apply para escribirlo.',
  ].join('\n');
  if (!options.apply) return { ok: true, text: plan };

  try {
    mkdirSync(join(copy.root, '.claude'), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

    const hooksDir = join(copy.root, HOOKS_PATH);
    mkdirSync(hooksDir, { recursive: true });
    for (const kind of ['pre-commit', 'pre-push'] as const) {
      const file = join(hooksDir, kind);
      writeFileSync(file, renderGitHook(kind, GIT_BIN_ARGS));
      if (process.platform !== 'win32') chmodSync(file, 0o755);
    }

    const set = await runGit(copy.root, ['config', '--local', 'core.hooksPath', HOOKS_PATH]);
    if (!set.ok) {
      return { ok: false, text: `No se pudo fijar core.hooksPath: ${set.stderr.trim()}` };
    }
  } catch (error) {
    return { ok: false, text: `No se pudo instalar: ${reasonOf(error)}` };
  }

  return { ok: true, text: 'Ganchos instalados.' };
}
