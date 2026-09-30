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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { parse } from 'yaml';

import type { CommandOutput } from '../cli.js';
import { installHooks } from '../locks/hook-cli.js';
import { isValidBranchName } from '../locks/refname.js';
import { safeTerminalText } from '../safe-text.js';
import { readPackageSeal } from './package.js';

export const RECIPE_USAGE = 'Usage: ai-workflows <validate|explain|init> [file]';

const RECIPE_PATH = '.ai-workflows/pipeline.yml';
const ENGINE = 'luismichelcf/ai-workflows';

/** The three judge workflows, by the path init writes and the template it takes them from. */
const WORKFLOW_TEMPLATES: Readonly<Record<string, string>> = {
  '.github/workflows/ai-workflows.yml': 'ai-workflows.yml',
  '.github/workflows/ai-workflows-red-test.yml': 'ai-workflows-red-test.yml',
  '.github/workflows/ai-workflows-review-signal.yml': 'ai-workflows-review-signal.yml',
};

/**
 * What `init` cannot do for the owner, said at the end and always naming the switch variable
 * (§9.2). Turning the judge on and requiring its status is always the owner's own step.
 */
const HINT = [
  'Next, by hand:',
  '  - adjust the install and test steps of .github/workflows/ai-workflows-red-test.yml to this project;',
  '  - add your required-check workflows to the `workflow_run` list of .github/workflows/ai-workflows.yml;',
  '  - set the repository variable AI_WORKFLOWS_MODE to `off` or `advisory` to try the judge. Turning it `on` and requiring the status is a separate step you take.',
].join('\n');

export interface InstallRequest {
  readonly manager: 'pnpm' | 'npm' | 'yarn';
  readonly cwd: string;
}

export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type RunPackageInstall = (request: InstallRequest) => Promise<InstallResult>;

/** What the CLI passes to `init`; the tests inject the external edges to keep it hermetic. */
export interface RecipeCommandOptions {
  readonly cwd: string;
  /** The seal of the running engine. Omitted: read `<package root>/engine.json`; `null`: none. */
  readonly seal?: unknown;
  /** How the detected package manager installs. Omitted in tests: never actually installs. */
  readonly runPackageInstall?: RunPackageInstall;
  /** How a temporary workflow is moved into place; injected only to make a rename fail (4b). */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
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

  const fromPackageJson = options.seal === undefined;
  const rawSeal = fromPackageJson ? await readInstalledSeal() : options.seal;
  const seal = asSeal(rawSeal);
  if (seal === undefined) {
    // Without a valid seal nothing is installed and no workflow is written; the example recipe is
    // still written, as the development copy always did, and the reason names the seal.
    const lines = [sealReason(fromPackageJson)];
    if (args.packagePath === undefined) lines.push(await writeRecipe(options.cwd, undefined));
    lines.push(HINT);
    return { ok: false, text: lines.join('\n') };
  }

  if (args.packagePath !== undefined) {
    const packageSeal = await readPackageSeal(args.packagePath, options.cwd);
    if (!sameSeal(asSeal(packageSeal), seal)) {
      return {
        ok: false,
        text:
          `No installé nada: ${safeTerminalText(args.packagePath)} no trae el mismo sello ` +
          '(engine.json) que este init.',
      };
    }
  }

  const address =
    args.packagePath === undefined ? releaseAddress(seal) : `file:${args.packagePath}`;

  if (args.judgeOnly) return judgeOnly(options.cwd, seal, options.renameFile);
  return fullInit(options.cwd, seal, address, options.runPackageInstall, options.renameFile);
}

async function judgeOnly(
  cwd: string,
  seal: Seal,
  renameFile: RecipeCommandOptions['renameFile'],
): Promise<CommandOutput> {
  if (!existsSync(join(cwd, RECIPE_PATH))) {
    return {
      ok: false,
      text: `${RECIPE_PATH}: not found. Write the recipe before running init --judge-only.`,
    };
  }
  const branches = await recipeBranches(cwd);
  const written = await writeWorkflows(cwd, seal, branches, renameFile);
  if (!written.ok) return { ok: false, text: written.text };
  return { ok: true, text: [...written.created.map((path) => `Created ${path}`), HINT].join('\n') };
}

async function fullInit(
  cwd: string,
  seal: Seal,
  address: string,
  runPackageInstall: RunPackageInstall | undefined,
  renameFile: RecipeCommandOptions['renameFile'],
): Promise<CommandOutput> {
  const lines: string[] = [];

  const dependency = await prepareDependency(cwd, seal, address, runPackageInstall);
  if (!dependency.ok) return { ok: false, text: dependency.reason };
  lines.push(dependency.line);

  lines.push(await writeRecipe(cwd, seal.version));

  const branches = await recipeBranches(cwd);
  const written = await writeWorkflows(cwd, seal, branches, renameFile);
  if (!written.ok) {
    lines.push(written.text, HINT);
    return { ok: false, text: lines.join('\n') };
  }
  lines.push(...written.created.map((path) => `Created ${path}`));

  if (dependency.installHooks) {
    const installed = await installHooks({ root: cwd, apply: true });
    lines.push(installed.text, HINT);
    return { ok: installed.ok, text: lines.join('\n') };
  }

  lines.push(dependency.skipHooksReason, HINT);
  return { ok: true, text: lines.join('\n') };
}

type DependencyOutcome =
  | { readonly ok: true; readonly line: string; readonly installHooks: boolean; readonly skipHooksReason: string }
  | { readonly ok: false; readonly reason: string };

async function prepareDependency(
  cwd: string,
  seal: Seal,
  address: string,
  runPackageInstall: RunPackageInstall | undefined,
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
    return {
      ok: true,
      line:
        `ai-workflows already depends on ${versionIn(declared)}; init does not change it. ` +
        'The hooks were not installed, because they would load that other engine.',
      installHooks: false,
      skipHooksReason:
        'The hooks were not installed: node_modules/ai-workflows would not carry this engine.',
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
  const install = runPackageInstall ?? defaultInstall();
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
      line: `ai-workflows ${seal.version} was declared and ${manager} ran, but node_modules/ai-workflows does not carry this engine's seal.`,
      installHooks: false,
      skipHooksReason:
        'The hooks were not installed: node_modules/ai-workflows does not carry this engine\'s seal.',
    };
  }
  return {
    ok: true,
    line: `Added ai-workflows ${seal.version} to devDependencies and installed it with ${manager}.`,
    installHooks: true,
    skipHooksReason: '',
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

/** The package manager at the external edge. Injected in tests, so it is only the real default. */
function defaultInstall(): RunPackageInstall {
  return (request) =>
    new Promise<InstallResult>((resolve) => {
      let settled = false;
      const finish = (result: InstallResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let child;
      try {
        child = spawn(request.manager, ['install'], {
          cwd: request.cwd,
          windowsHide: true,
          shell: process.platform === 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
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
      child.on('close', (code) =>
        code === 0 ? finish({ ok: true }) : finish({ ok: false, reason: stderr.trim() || `exit ${code}` }),
      );
    });
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

/** Writes the example recipe if it is missing; never overwrites, and reports which of the two. */
async function writeRecipe(cwd: string, version: string | undefined): Promise<string> {
  const target = join(cwd, RECIPE_PATH);
  if (existsSync(target)) return `${RECIPE_PATH} already exists; init does not overwrite it.`;
  let template = await readFile(new URL('../../templates/pipeline.yml', import.meta.url), 'utf8');
  if (version !== undefined) {
    template = template.replace(
      /(releases\/download\/)v[^/]+(\/recipe\.schema\.json)/,
      `$1v${version}$2`,
    );
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, template, { flag: 'wx' });
    return `Created ${RECIPE_PATH}`;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return `${RECIPE_PATH} already exists; init does not overwrite it.`;
    }
    return `Could not write ${RECIPE_PATH}: ${reasonOf(error)}`;
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
  | { readonly ok: true; readonly created: readonly string[] }
  | { readonly ok: false; readonly text: string };

/**
 * Writes the three workflows all or nothing (§9.2): if any of them exists none is written and the
 * one that exists is named; each is written to a temporary file and renamed into place, and if a
 * rename fails the ones already renamed are removed and no temporary file stays behind.
 */
async function writeWorkflows(
  cwd: string,
  seal: Seal,
  branches: readonly string[],
  renameFile: RecipeCommandOptions['renameFile'],
): Promise<WorkflowsOutcome> {
  const paths = Object.keys(WORKFLOW_TEMPLATES);
  const existing = paths.filter((path) => existsSync(join(cwd, path)));
  if (existing.length > 0) {
    return {
      ok: false,
      text:
        `None of the three workflows was written: ${existing.join(', ')} already exists; ` +
        'init does not overwrite it.',
    };
  }

  const move = renameFile ?? rename;
  const created: string[] = [];
  let temporary: string | undefined;
  let target: string | undefined;
  try {
    for (const path of paths) {
      const name = WORKFLOW_TEMPLATES[path];
      if (name === undefined) continue;
      const content = await renderWorkflow(name, seal, branches);
      target = join(cwd, path);
      await mkdir(dirname(target), { recursive: true });
      temporary = `${target}.init-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await writeFile(temporary, content);
      await move(temporary, target);
      temporary = undefined;
      created.push(path);
    }
    return { ok: true, created };
  } catch (error) {
    const named = target === undefined ? '' : relative(cwd, target).split('\\').join('/');
    for (const path of created) {
      try {
        await rm(join(cwd, path), { force: true });
      } catch {
        // Best effort: the reply names the failure below.
      }
    }
    if (temporary !== undefined) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Best effort.
      }
    }
    return {
      ok: false,
      text: `None of the three workflows was written: moving ${named} failed (${reasonOf(error)}).`,
    };
  }
}

/**
 * One workflow as its template, with the only allowed substitutions: the engine pinned by the
 * sealed SHA (`# v<version>`), and — in the judge workflow only — the `branches` input taken from
 * the recipe. Everything else stays byte for byte.
 */
async function renderWorkflow(
  name: string,
  seal: Seal,
  branches: readonly string[],
): Promise<string> {
  const template = await readFile(new URL(`../../templates/${name}`, import.meta.url), 'utf8');
  const pinned = template.replace(
    `${ENGINE}@<ENGINE_SHA>`,
    `${ENGINE}@${seal.sha} # v${seal.version}`,
  );
  if (name !== 'ai-workflows.yml' || branches.length === 0) return pinned;
  const anchor = '          token: ${{ github.token }}\n';
  if (!pinned.includes(anchor)) return pinned;
  return pinned.replace(anchor, `${anchor}          branches: ${branches.join(', ')}\n`);
}

function sealReason(fromPackageJson: boolean): string {
  return fromPackageJson
    ? 'No install and no workflow written: this engine has no engine.json (a development copy). Only a sealed release can install.'
    : 'No install and no workflow written: the seal (engine.json) is not valid: it needs a version X.Y.Z and a 40-hex sha.';
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
