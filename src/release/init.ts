// PLAN-13-R6 §9.2 and §9.4 tests 1 to 5, 4b, 4c and 4d: `init` from a sealed engine.
//
// `init` leaves a project ready from the sealed package in one order: (1) install the engine as a
// dev dependency of this version with the detected manager, (2) write the files that are missing
// (recipe, the three judge workflows), (3) install the hooks only if step 1 left
// `node_modules/ai-workflows` carrying this engine's seal. Without a valid seal nothing is
// installed and no workflow is written — never a marker, never `HEAD`. `--judge-only` writes only
// the three workflows, from the recipe that already exists, and touches neither package.json, nor
// the lock file, nor the hooks. `--package <path>` installs from that package instead of the
// version address, but only after checking that its `engine.json` is the same seal.
//
// PLAN-13-R6 §15 (fixes after the flock): `init` refuses to run from a subfolder of a repository,
// speaks the language of the recipe it ends up with, gives the closing text with the exact
// `gh variable set` commands and the piece-branch line, treats three already-present workflows as
// reported and still installs the hooks, starts the package manager without a shell (the JS entry
// point on Windows), fails when the judge template has no anchor for `branches`, writes the
// `branches` value quoted, and names any file a failed rollback could not remove.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { parse } from 'yaml';

import type { CommandOutput } from '../cli.js';
import { installHooks } from '../locks/hook-cli.js';
import { isValidBranchName } from '../locks/refname.js';
import { languageOf, type Language } from '../recipe/applies.js';
import { safeTerminalText } from '../safe-text.js';
import { readPackageSeal } from './package.js';

export const RECIPE_USAGE = 'Usage: ai-workflows <validate|explain|init> [file]';

const RECIPE_PATH = '.ai-workflows/pipeline.yml';
const ENGINE = 'luismichelcf/ai-workflows';
const BRANCHES_ANCHOR = '          token: ${{ github.token }}\n';

/** The three judge workflows, by the path init writes and the template it takes them from. */
const WORKFLOW_TEMPLATES: Readonly<Record<string, string>> = {
  '.github/workflows/ai-workflows.yml': 'ai-workflows.yml',
  '.github/workflows/ai-workflows-red-test.yml': 'ai-workflows-red-test.yml',
  '.github/workflows/ai-workflows-review-signal.yml': 'ai-workflows-review-signal.yml',
};

export interface InstallRequest {
  readonly manager: 'pnpm' | 'npm' | 'yarn';
  readonly cwd: string;
}

export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type RunPackageInstall = (request: InstallRequest) => Promise<InstallResult>;

/**
 * How the default installer starts the package manager. The real one is `child_process.spawn`; the
 * tests inject a fake. It must be asked for no shell and must not start a shell program.
 */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** What the CLI passes to `init`; the tests inject the external edges to keep it hermetic. */
export interface RecipeCommandOptions {
  readonly cwd: string;
  /** The seal of the running engine. Omitted: read `<package root>/engine.json`; `null`: none. */
  readonly seal?: unknown;
  /** How the detected package manager installs. Omitted in tests: never actually installs. */
  readonly runPackageInstall?: RunPackageInstall;
  /** How a temporary workflow is moved into place; injected only to make a rename fail (4b). */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
  /** How every rollback removal happens; injected only to make a removal fail (§15). */
  readonly removeFile?: (path: string) => Promise<void>;
  /** How the default installer starts the package manager; injected in tests (§15). */
  readonly spawnProcess?: SpawnProcess;
  /** Where the four templates are read from; default: the package's `templates/`. */
  readonly templatesDir?: string;
}

interface Seal {
  readonly version: string;
  readonly sha: string;
}

/** A seal is exactly `{ version: 'X.Y.Z', sha: <40 lowercase hex> }` and nothing looser. */
function asSeal(value: unknown): Seal | undefined {
  if (!isRecord(value)) return undefined;
  const version = value['version'];
  const sha = value['sha'];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
  return { version, sha };
}

const sameSeal = (left: Seal | undefined, right: Seal): boolean =>
  left !== undefined && left.version === right.version && left.sha === right.sha;

/** The address the release of this seal is downloaded from. */
const releaseAddress = (seal: Seal): string =>
  `https://github.com/luismichelcf/ai-workflows/releases/download/v${seal.version}/ai-workflows-${seal.version}.tgz`;

/** The seal next to the running engine; a development copy has no `engine.json`, so no seal. */
async function readInstalledSeal(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(new URL('../../engine.json', import.meta.url), 'utf8'));
  } catch {
    return undefined;
  }
}

type InitArgs =
  | { readonly kind: 'ok'; readonly judgeOnly: boolean; readonly packagePath?: string }
  | { readonly kind: 'usage' };

function parseInitArgs(rest: readonly string[]): InitArgs {
  let judgeOnly = false;
  let packagePath: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--judge-only') {
      judgeOnly = true;
      continue;
    }
    if (arg === '--package') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) return { kind: 'usage' };
      packagePath = value;
      index += 1;
      continue;
    }
    return { kind: 'usage' };
  }
  return { kind: 'ok', judgeOnly, ...(packagePath === undefined ? {} : { packagePath }) };
}

export async function runInit(
  rest: readonly string[],
  options: RecipeCommandOptions,
): Promise<CommandOutput> {
  const args = parseInitArgs(rest);
  if (args.kind === 'usage') return { ok: false, text: RECIPE_USAGE };

  // A piece branch lives at the root of the repository: running from a subfolder would write the
  // recipe and the workflows in the wrong place. A folder that is not a repository is left as it
  // was, so `init` still works outside git.
  const top = repositoryRoot(options.cwd);
  if (top !== undefined && !samePath(top, options.cwd)) {
    return {
      ok: false,
      text: `Run init from the repository root (${top}), not from a subfolder.`,
    };
  }

  const fromPackageJson = options.seal === undefined;
  const rawSeal = fromPackageJson ? await readInstalledSeal() : options.seal;
  const seal = asSeal(rawSeal);
  if (seal === undefined) {
    // Without a valid seal nothing is installed and no workflow is written; the example recipe is
    // still written, as the development copy always did, and the reason names the seal.
    const recipe = args.packagePath === undefined ? await writeRecipe(options.cwd, undefined, options.templatesDir) : undefined;
    const words = INIT_WORDS[await initLanguage(options.cwd)];
    const lines = [fromPackageJson ? words.sealMissing : words.sealInvalid];
    if (recipe !== undefined) lines.push(fileStatusText(words, RECIPE_PATH, recipe));
    lines.push(words.hint);
    return { ok: false, text: lines.join('\n') };
  }

  if (args.packagePath !== undefined) {
    const packageSeal = await readPackageSeal(args.packagePath, options.cwd);
    if (!sameSeal(asSeal(packageSeal), seal)) {
      return {
        ok: false,
        text:
          `No instalé nada: ${safeTerminalText(args.packagePath)} no trae el mismo sello ` +
          '(engine.json) que este init.',
      };
    }
  }

  const address =
    args.packagePath === undefined ? releaseAddress(seal) : `file:${args.packagePath}`;

  if (args.judgeOnly) return judgeOnly(options.cwd, seal, options);
  return fullInit(options.cwd, seal, address, options);
}

async function judgeOnly(
  cwd: string,
  seal: Seal,
  options: RecipeCommandOptions,
): Promise<CommandOutput> {
  if (!existsSync(join(cwd, RECIPE_PATH))) {
    return {
      ok: false,
      text: `${RECIPE_PATH}: not found. Write the recipe before running init --judge-only.`,
    };
  }
  const words = INIT_WORDS[await initLanguage(cwd)];
  const branches = await recipeBranches(cwd);
  const written = await writeWorkflows(cwd, seal, branches, words, options);
  if (!written.ok) return { ok: false, text: written.text };
  return { ok: true, text: workflowLines(words, written).concat(words.hint).join('\n') };
}

async function fullInit(
  cwd: string,
  seal: Seal,
  address: string,
  options: RecipeCommandOptions,
): Promise<CommandOutput> {
  const dependency = await prepareDependency(cwd, seal, address, options);
  if (!dependency.ok) return { ok: false, text: dependency.reason };

  const recipe = await writeRecipe(cwd, seal.version, options.templatesDir);
  const words = INIT_WORDS[await initLanguage(cwd)];

  const lines: string[] = [];
  lines.push(dependencyText(words, dependency.line));
  lines.push(fileStatusText(words, RECIPE_PATH, recipe));

  const branches = await recipeBranches(cwd);
  const written = await writeWorkflows(cwd, seal, branches, words, options);
  if (!written.ok) {
    lines.push(written.text, words.hint);
    return { ok: false, text: lines.join('\n') };
  }
  lines.push(...workflowLines(words, written));

  if (dependency.installHooks) {
    const installed = await installHooks({ root: cwd, apply: true });
    lines.push(installed.text, words.hint);
    return { ok: installed.ok, text: lines.join('\n') };
  }

  lines.push(dependency.line.kind === 'declared-other' ? words.skipDeclared : words.skipLanded);
  lines.push(words.hint);
  return { ok: true, text: lines.join('\n') };
}

type DependencyLine =
  | { readonly kind: 'declared-other'; readonly version: string }
  | { readonly kind: 'landed-miss'; readonly version: string; readonly manager: string }
  | { readonly kind: 'installed'; readonly version: string; readonly manager: string };

type DependencyOutcome =
  | {
      readonly ok: true;
      readonly line: DependencyLine;
      readonly installHooks: boolean;
    }
  | { readonly ok: false; readonly reason: string };

async function prepareDependency(
  cwd: string,
  seal: Seal,
  address: string,
  options: RecipeCommandOptions,
): Promise<DependencyOutcome> {
  const packagePath = join(cwd, 'package.json');
  let pkg: Record<string, unknown> = {};
  const existed = existsSync(packagePath);
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
      if (!isRecord(parsed)) return { ok: false, reason: 'package.json does not hold a JSON object.' };
      pkg = parsed;
    } catch (error) {
      return { ok: false, reason: `Could not read package.json: ${reasonOf(error)}` };
    }
  }

  const declared = declaredEngine(pkg);
  if (declared !== undefined && declared !== address) {
    const version = versionIn(declared);
    return {
      ok: true,
      line: { kind: 'declared-other', version },
      installHooks: false,
    };
  }

  const next: Record<string, unknown> = { ...pkg };
  if (!existed) {
    next['name'] = packageName(basename(cwd));
    next['private'] = true;
  }
  const devDependencies = isRecord(pkg['devDependencies']) ? { ...pkg['devDependencies'] } : {};
  devDependencies['ai-workflows'] = address;
  next['devDependencies'] = devDependencies;
  try {
    await writeFile(packagePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return { ok: false, reason: `Could not write package.json: ${reasonOf(error)}` };
  }

  const manager = detectManager(cwd);
  const install = options.runPackageInstall ?? defaultInstall(options.spawnProcess);
  let result: InstallResult;
  try {
    result = await install({ manager, cwd });
  } catch (error) {
    return { ok: false, reason: `The install failed: ${reasonOf(error)}` };
  }
  if (!result.ok) {
    return { ok: false, reason: `Could not install ai-workflows with ${manager}: ${result.reason}` };
  }

  const landed = asSeal(await nodeModulesSeal(cwd));
  if (!sameSeal(landed, seal)) {
    return {
      ok: true,
      line: { kind: 'landed-miss', version: seal.version, manager },
      installHooks: false,
    };
  }
  return {
    ok: true,
    line: { kind: 'installed', version: seal.version, manager },
    installHooks: true,
  };
}

/** The declared engine dependency, if any, from the four dependency maps. */
function declaredEngine(pkg: Record<string, unknown>): string | undefined {
  for (const key of ['devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[key];
    if (isRecord(deps) && typeof deps['ai-workflows'] === 'string') return deps['ai-workflows'];
  }
  return undefined;
}

/** pnpm-lock.yaml -> pnpm, package-lock.json -> npm, yarn.lock -> yarn, none -> pnpm. */
function detectManager(cwd: string): InstallRequest['manager'] {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'pnpm';
}

/**
 * The package manager at the external edge, started with no shell (§15). On Windows a bare `pnpm`
 * is a `.cmd` the system cannot run without a shell, so the manager's JS entry point is found and
 * run with this same `node`; on Linux the manager itself runs.
 */
function defaultInstall(spawnProcess: SpawnProcess | undefined): RunPackageInstall {
  const launch: SpawnProcess =
    spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  return (request) =>
    new Promise<InstallResult>((resolve) => {
      let settled = false;
      const finish = (result: InstallResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const { command, args } = managerCommand(request.manager);
      const launchOptions: SpawnOptions = {
        cwd: request.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      let child: ChildProcess;
      try {
        child = launch(command, args, launchOptions);
      } catch (error) {
        finish({ ok: false, reason: reasonOf(error) });
        return;
      }
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 65536) stderr += chunk;
      });
      child.on('error', (error) => finish({ ok: false, reason: reasonOf(error) }));
      child.on('close', (code: number | null) =>
        code === 0 ? finish({ ok: true }) : finish({ ok: false, reason: stderr.trim() || `exit ${code}` }),
      );
    });
}

/** The command that starts `manager install`, with the JS entry point on Windows (§15). */
function managerCommand(manager: InstallRequest['manager']): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const script = windowsManagerScript(manager);
    if (script !== undefined) return { command: process.execPath, args: [script, 'install'] };
  }
  return { command: manager, args: ['install'] };
}

/**
 * PLAN-13-R6 §15 (B2): the JS entry point of each manager, as a global install leaves it. npm
 * ships `npm-cli.js`, pnpm `pnpm.cjs` and yarn classic `yarn.js`; using one manager's entry to
 * run another is what this guards against.
 */
const MANAGER_ENTRY: Readonly<Record<InstallRequest['manager'], string>> = {
  npm: 'npm-cli.js',
  pnpm: 'pnpm.cjs',
  yarn: 'yarn.js',
};

/**
 * The JS entry point of the DETECTED manager on Windows, if it can be found, so `node <entry>
 * install` runs it. `npm_execpath` (set by whichever manager started this process) is used only
 * when its file name is the detected manager's entry: otherwise a pnpm path would start pnpm for
 * an npm project. When nothing is found, `undefined` lets the caller fail honestly naming the
 * manager, never start another one.
 */
function windowsManagerScript(manager: InstallRequest['manager']): string | undefined {
  const entry = MANAGER_ENTRY[manager];
  // npm is also where Node's installer puts it, next to the running `node`.
  const candidates: string[] = [join(dirname(process.execPath), 'node_modules', manager, 'bin', entry)];
  for (const dir of (process.env['PATH'] ?? '').split(';')) {
    const trimmed = dir.trim();
    // PLAN-13-R6 §15 (N2): a relative entry (`.`) is resolved against the folder init runs in,
    // which is the project: a project carrying its own `node_modules/<manager>/bin/<entry>`
    // would make init run that file. Only absolute entries of PATH are searched.
    if (trimmed.length > 0 && isAbsolute(trimmed)) {
      candidates.push(join(trimmed, 'node_modules', manager, 'bin', entry));
    }
  }
  const execpath = process.env['npm_execpath'];
  if (typeof execpath === 'string' && execpath.length > 0 && basename(execpath).toLowerCase() === entry) {
    candidates.unshift(execpath);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function nodeModulesSeal(cwd: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(join(cwd, 'node_modules', 'ai-workflows', 'engine.json'), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

type FileStatus =
  | { readonly kind: 'created' }
  | { readonly kind: 'existed' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Writes the example recipe if it is missing; never overwrites, and reports which of the two. */
async function writeRecipe(
  cwd: string,
  version: string | undefined,
  templatesDir: string | undefined,
): Promise<FileStatus> {
  const target = join(cwd, RECIPE_PATH);
  if (existsSync(target)) return { kind: 'existed' };
  let template = await readFile(templateFile('pipeline.yml', templatesDir), 'utf8');
  if (version !== undefined) {
    template = template.replace(
      /(releases\/download\/)v[^/]+(\/recipe\.schema\.json)/,
      `$1v${version}$2`,
    );
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, template, { flag: 'wx' });
    return { kind: 'created' };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { kind: 'existed' };
    return { kind: 'failed', reason: reasonOf(error) };
  }
}

/** The `branches.into` of the recipe, straight from its YAML, with only git-valid names kept. */
async function recipeBranches(cwd: string): Promise<readonly string[]> {
  let content: string;
  try {
    content = await readFile(join(cwd, RECIPE_PATH), 'utf8');
  } catch {
    return [];
  }
  let document: unknown;
  try {
    document = parse(content);
  } catch {
    return [];
  }
  if (!isRecord(document)) return [];
  const branches = document['branches'];
  if (!isRecord(branches)) return [];
  const into = branches['into'];
  if (!Array.isArray(into)) return [];
  return into.filter(
    (name): name is string => typeof name === 'string' && isValidBranchName(name),
  );
}

type WorkflowsOutcome =
  | { readonly ok: true; readonly created: readonly string[]; readonly existing: readonly string[] }
  | { readonly ok: false; readonly text: string };

/** A template that cannot take the `branches` input because it lost its anchor (§15). */
class WorkflowTemplateError extends Error {
  readonly template: string;

  constructor(template: string) {
    super(`the template ${template} has no anchor for the branches input`);
    this.template = template;
  }
}

/**
 * Writes the three workflows all or nothing (§9.2): if some — but not all — of them exist none is
 * written and the ones that exist are named; if all three exist each is reported as already there
 * and nothing is touched (§15). Each is written to a temporary file and renamed into place, and if
 * a rename fails the ones already renamed and the temporary file are removed (§15: naming any file
 * the rollback could not remove).
 */
async function writeWorkflows(
  cwd: string,
  seal: Seal,
  branches: readonly string[],
  words: InitWords,
  options: RecipeCommandOptions,
): Promise<WorkflowsOutcome> {
  const paths = Object.keys(WORKFLOW_TEMPLATES);
  const existing = paths.filter((path) => existsSync(join(cwd, path)));
  if (existing.length === paths.length) {
    return { ok: true, created: [], existing };
  }
  if (existing.length > 0) return { ok: false, text: words.partialExisting(existing) };

  let rendered: { readonly path: string; readonly content: string }[];
  try {
    rendered = [];
    for (const path of paths) {
      const name = WORKFLOW_TEMPLATES[path];
      if (name === undefined) continue;
      rendered.push({ path, content: await renderWorkflow(name, seal, branches, options.templatesDir) });
    }
  } catch (error) {
    if (error instanceof WorkflowTemplateError) return { ok: false, text: words.anchorMissing(error.template) };
    return { ok: false, text: words.noneWritten('', reasonOf(error)) };
  }

  const move = options.renameFile ?? rename;
  const drop = options.removeFile ?? ((path: string) => rm(path, { force: true }));
  const created: string[] = [];
  let temporary: string | undefined;
  let target: string | undefined;
  try {
    for (const { path, content } of rendered) {
      target = join(cwd, path);
      await mkdir(dirname(target), { recursive: true });
      temporary = `${target}.init-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await writeFile(temporary, content);
      await move(temporary, target);
      temporary = undefined;
      created.push(path);
    }
    return { ok: true, created, existing: [] };
  } catch (error) {
    const named = target === undefined ? '' : relative(cwd, target).split('\\').join('/');
    const left: string[] = [];
    for (const path of created) {
      try {
        await drop(join(cwd, path));
      } catch {
        left.push(path);
      }
    }
    if (temporary !== undefined) {
      try {
        await drop(temporary);
      } catch {
        left.push(relative(cwd, temporary).split('\\').join('/'));
      }
    }
    const text =
      left.length === 0
        ? words.noneWritten(named, reasonOf(error))
        : words.rollbackLeft(named, reasonOf(error), left);
    return { ok: false, text };
  }
}

/**
 * One workflow as its template, with the only allowed substitutions: the engine pinned by the
 * sealed SHA (`# v<version>`), and — in the judge workflow only — the `branches` input taken from
 * the recipe. The value is a quoted YAML scalar, so any git-valid name survives (§15).
 */
async function renderWorkflow(
  name: string,
  seal: Seal,
  branches: readonly string[],
  templatesDir: string | undefined,
): Promise<string> {
  const template = await readFile(templateFile(name, templatesDir), 'utf8');
  const pinned = template.replace(`${ENGINE}@<ENGINE_SHA>`, `${ENGINE}@${seal.sha} # v${seal.version}`);
  if (name !== 'ai-workflows.yml' || branches.length === 0) return pinned;
  if (!pinned.includes(BRANCHES_ANCHOR)) throw new WorkflowTemplateError(name);
  return pinned.replace(
    BRANCHES_ANCHOR,
    `${BRANCHES_ANCHOR}          branches: ${JSON.stringify(branches.join(', '))}\n`,
  );
}

/** The template file, from the injected folder or the package's own `templates/`. */
function templateFile(name: string, templatesDir: string | undefined): URL | string {
  return templatesDir === undefined
    ? new URL(`../../templates/${name}`, import.meta.url)
    : join(templatesDir, name);
}

/** A file status as it is reported, in the running language (§15). */
function fileStatusText(words: InitWords, path: string, status: FileStatus): string {
  switch (status.kind) {
    case 'created':
      return words.created(path);
    case 'existed':
      return words.existed(path);
    case 'failed':
      return words.couldNotWrite(path, status.reason);
  }
}

function workflowLines(
  words: InitWords,
  outcome: { readonly created: readonly string[]; readonly existing: readonly string[] },
): string[] {
  return [
    ...outcome.created.map((path) => words.created(path)),
    ...outcome.existing.map((path) => words.existed(path)),
  ];
}

/** The closed-repository root of `cwd`, or `undefined` when it is not inside a repository. */
function repositoryRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  const out = (result.stdout ?? '').trim();
  return out.length > 0 ? out : undefined;
}

/**
 * Same folder, whatever the separator or the case (Windows). PLAN-13-R6 §15: on Windows a
 * temporary folder can be reached by a short 8.3 name (`RUNNER~1`) while git reports the long one,
 * so both sides are compared by their real, long path.
 */
function samePath(left: string, right: string): boolean {
  const a = realPathOf(left);
  const b = realPathOf(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The real, long path when the file system can give it; the resolved path otherwise. */
function realPathOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The language of the recipe as it stands after step 2; anything else is English (§15). */
async function initLanguage(cwd: string): Promise<Language> {
  try {
    const document = parse(await readFile(join(cwd, RECIPE_PATH), 'utf8'));
    if (isRecord(document) && typeof document['locale'] === 'string') {
      return languageOf(document['locale']);
    }
  } catch {
    // Fall through: no readable recipe means English.
  }
  return 'en';
}

interface InitWords {
  readonly created: (path: string) => string;
  readonly existed: (path: string) => string;
  readonly couldNotWrite: (path: string, reason: string) => string;
  readonly added: (version: string, manager: string) => string;
  readonly declaredOther: (version: string) => string;
  readonly landedMiss: (version: string, manager: string) => string;
  readonly skipDeclared: string;
  readonly skipLanded: string;
  readonly partialExisting: (paths: readonly string[]) => string;
  readonly anchorMissing: (template: string) => string;
  readonly noneWritten: (target: string, reason: string) => string;
  readonly rollbackLeft: (target: string, reason: string, left: readonly string[]) => string;
  readonly sealMissing: string;
  readonly sealInvalid: string;
  readonly hint: string;
}

const COMMON_HINT_ES = [
  '  - ajusta los pasos de instalación y prueba de .github/workflows/ai-workflows-red-test.yml a tu proyecto;',
  '  - agrega tus workflows de checks exigidos a la lista `workflow_run` de .github/workflows/ai-workflows.yml;',
  '  - pon la variable del repositorio AI_WORKFLOWS_MODE: `gh variable set AI_WORKFLOWS_MODE --body advisory` para probar el juez, o `gh variable set AI_WORKFLOWS_MODE --body off` para apagarlo. Encenderlo (`on`) y exigir su estado es un paso aparte tuyo;',
  '  - Guarda estos archivos con un commit en una rama de pieza, no en la rama principal.',
];

const COMMON_HINT_EN = [
  '  - adjust the install and test steps of .github/workflows/ai-workflows-red-test.yml to this project;',
  '  - add your required-check workflows to the `workflow_run` list of .github/workflows/ai-workflows.yml;',
  '  - set the repository variable AI_WORKFLOWS_MODE: `gh variable set AI_WORKFLOWS_MODE --body advisory` to try the judge, or `gh variable set AI_WORKFLOWS_MODE --body off` to switch it off. Turning it `on` and requiring its status is a separate step you take;',
  '  - Commit these files on a piece branch, not on the main branch.',
];

const INIT_WORDS: Record<Language, InitWords> = {
  es: {
    created: (path) => `Creado ${path}`,
    existed: (path) => `${path} ya existía; init no lo sobrescribe.`,
    couldNotWrite: (path, reason) => `No se pudo escribir ${path}: ${reason}`,
    added: (version, manager) =>
      `Se añadió ai-workflows ${version} a devDependencies y se instaló con ${manager}.`,
    declaredOther: (version) =>
      `ai-workflows ya depende de ${version}; init no lo cambia. ` +
      'Los ganchos no se instalaron, porque cargarían ese otro motor.',
    landedMiss: (version, manager) =>
      `ai-workflows ${version} se declaró y ${manager} corrió, pero node_modules/ai-workflows ` +
      'no trae el sello de este motor.',
    skipDeclared:
      'Los ganchos no se instalaron: node_modules/ai-workflows no traería este motor.',
    skipLanded:
      'Los ganchos no se instalaron: node_modules/ai-workflows no trae el sello de este motor.',
    partialExisting: (paths) =>
      `No se escribió ninguno de los tres workflows: ${paths.join(', ')} ya existe; ` +
      'init no lo sobrescribe.',
    anchorMissing: (template) =>
      `No se escribió ninguno de los tres workflows: ${template} no tiene dónde escribir la entrada branches.`,
    noneWritten: (target, reason) =>
      `No se escribió ninguno de los tres workflows: mover ${target} falló (${reason}).`,
    rollbackLeft: (target, reason, left) =>
      `Mover ${target} falló (${reason}); no se escribió ninguno de los tres workflows que faltaban. ` +
      `No se pudo borrar en el retroceso: ${left.join(', ')}; quedan en su sitio.`,
    sealMissing:
      'No se instaló nada ni se escribió ningún workflow: este motor no trae sello (engine.json, una copia de desarrollo). Solo una versión sellada puede instalar.',
    sealInvalid:
      'No se instaló nada ni se escribió ningún workflow: el sello (engine.json) no es válido: necesita una versión X.Y.Z y un sha de 40 hex.',
    hint: ['Siguiente, a mano:', ...COMMON_HINT_ES].join('\n'),
  },
  en: {
    created: (path) => `Created ${path}`,
    existed: (path) => `${path} already exists; init does not overwrite it.`,
    couldNotWrite: (path, reason) => `Could not write ${path}: ${reason}`,
    added: (version, manager) =>
      `Added ai-workflows ${version} to devDependencies and installed it with ${manager}.`,
    declaredOther: (version) =>
      `ai-workflows already depends on ${version}; init does not change it. ` +
      'The hooks were not installed, because they would load that other engine.',
    landedMiss: (version, manager) =>
      `ai-workflows ${version} was declared and ${manager} ran, but node_modules/ai-workflows ` +
      "does not carry this engine's seal.",
    skipDeclared:
      'The hooks were not installed: node_modules/ai-workflows would not carry this engine.',
    skipLanded:
      "The hooks were not installed: node_modules/ai-workflows does not carry this engine's seal.",
    partialExisting: (paths) =>
      `None of the three workflows was written: ${paths.join(', ')} already exists; ` +
      'init does not overwrite it.',
    anchorMissing: (template) =>
      `None of the three workflows was written: ${template} has no place to write the branches input.`,
    noneWritten: (target, reason) =>
      `None of the three workflows was written: moving ${target} failed (${reason}).`,
    rollbackLeft: (target, reason, left) =>
      `Moving ${target} failed (${reason}); none of the missing three workflows was written. ` +
      `The rollback could not remove: ${left.join(', ')}; they stay in place.`,
    sealMissing:
      'No install and no workflow written: this engine has no engine.json (a development copy). Only a sealed release can install.',
    sealInvalid:
      'No install and no workflow written: the seal (engine.json) is not valid: it needs a version X.Y.Z and a 40-hex sha.',
    hint: ['Next, by hand:', ...COMMON_HINT_EN].join('\n'),
  },
};

function dependencyText(words: InitWords, line: DependencyLine): string {
  switch (line.kind) {
    case 'declared-other':
      return words.declaredOther(line.version);
    case 'landed-miss':
      return words.landedMiss(line.version, line.manager);
    case 'installed':
      return words.added(line.version, line.manager);
  }
}

/** The semver found in a dependency value, for the plain message when it names another version. */
function versionIn(value: string): string {
  return /\d+\.\d+\.\d+/.exec(value)?.[0] ?? value;
}

/** A package name npm would accept, derived from the folder. */
function packageName(folder: string): string {
  const cleaned = folder
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'app';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return String((error as { code: unknown }).code);
}
