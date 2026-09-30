// PLAN-13-R6 §2: the judge's own files. One fixed list, shared with `hooks install`, of the paths
// that are knowledge of the engine and never of a project (R05): what its installer writes and the
// line that says which engine is installed. Plus the engine version, compared field by field, so a
// pull request that changes many ordinary things in package.json is judged on the few keys that
// decide which package lands in `node_modules/ai-workflows`.

import { parse as parseYaml } from 'yaml';

import {
  gitChangedPaths,
  gitFileAt,
  gitMergeBases,
  gitMergeTree,
  type GitFileReading,
} from '../recipe/facts.js';

/**
 * The one list shared by the judge and `hooks install` (§2.1). Repository-relative, forward
 * slashes, lower case: the comparison is case-insensitive, because on a case-insensitive file
 * system a pull request that adds `.Claude/settings.json` overwrites the real file. An entry
 * ending in `/` covers every path under that folder; any other entry is one exact path. The
 * engine's own workflow path is not here: it varies per project and comes from the run.
 */
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

export const ENGINE_PROTECTED_PATHS: readonly string[] = [
  '.ai-workflows/',
  CLAUDE_SETTINGS_PATH,
  '.claude/settings.local.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
  '.opencode/plugins/',
  '.opencode/plugin/',
  '.opencode/tool/',
  '.opencode/tools/',
  '.pnpmfile.cjs',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.yarn/releases/',
  '.yarn/plugins/',
  '.github/workflows/ai-workflows-red-test.yml',
  '.github/workflows/ai-workflows-review-signal.yml',
];

/**
 * Whether a path is one of the engine's own, in lower case: a folder entry ending in `/` covers
 * its whole subtree (and the folder name itself); any other entry is exact.
 */
export function isEngineProtectedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return ENGINE_PROTECTED_PATHS.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.endsWith('/')) {
      return lower === rule.slice(0, -1) || lower.startsWith(rule);
    }
    return lower === rule;
  });
}

/**
 * PLAN-13-R6 §2.2: a key that names the engine wherever pnpm, npm or yarn read a dependency or a
 * patch rule. It bites `ai-workflows` and `algo>ai-workflows`, but never `ai-workflows-extra`.
 */
const ENGINE_KEY = /(^|>)ai-workflows(@|$)/;

/** The sections of a package.json or an importer that install the dependency named by their key. */
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * PLAN-13-R6 §15 and R32: the scripts that run when dependencies are installed. Changing any of
 * them needs the owner's attestation, because one can rewrite the engine on the agents' machine.
 * B3 of the delta review adds the rest npm and pnpm run around an install, including
 * `dependencies`, which pnpm runs after every install.
 */
const LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'pnpm:devPreinstall',
  'preprepare',
  'postprepare',
  'prepublish',
  'dependencies',
] as const;

/** The lockfiles that decide which engine is installed, read with their own cap (§2.2). */
export const ENGINE_VERSION_FILES: readonly string[] = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
];

/** The real lockfiles pass 1 MB; over this, they count as touched, never as "passes" (§2.2). */
export const ENGINE_VERSION_MAX_BYTES = 50 * 1024 * 1024;

/**
 * PLAN-13-R6 §15 (B3): a package.json anywhere — the root or a workspace member — carries the
 * lifecycle scripts that run on install, so it is compared field by field like the root one.
 */
function isPackageJson(file: string): boolean {
  const lower = file.toLowerCase();
  return lower === 'package.json' || lower.endsWith('/package.json');
}

/**
 * PLAN-13-R6 §15 (M-c): a workspace member's package.json is any `…/package.json` that is not the
 * root one. Unlike the root one, a member that is added or removed has a trustworthy empty side:
 * it is compared field by field with the missing side read as an empty object.
 */
function isMemberPackageJson(file: string): boolean {
  const lower = file.toLowerCase();
  return lower !== 'package.json' && lower.endsWith('/package.json');
}

/** The canonical engine-version files a pull request touches, whatever the case it committed. */
export function engineVersionFilesIn(files: readonly string[]): string[] {
  const canonical = new Set(ENGINE_VERSION_FILES);
  return files.filter((file) => isPackageJson(file) || canonical.has(file.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON string with every object key sorted, so reordering or reformatting is never a change. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

function hasKey(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/** Every key of `section` that names the engine, under `prefix`. */
function collectEngineKeys(section: unknown, prefix: string, out: Record<string, unknown>): void {
  if (!isRecord(section)) return;
  for (const [key, entry] of Object.entries(section)) {
    if (ENGINE_KEY.test(key)) out[`${prefix}.${key}`] = entry;
  }
}

/** Every key of `section` that starts with `ai-workflows@`, under `prefix`. */
function collectEnginePackages(section: unknown, prefix: string, out: Record<string, unknown>): void {
  if (!isRecord(section)) return;
  for (const [key, entry] of Object.entries(section)) {
    // PLAN-13-R6 §15/R32: an older pnpm lockfile names the package key with a leading slash
    // (`/ai-workflows@1.0.0`); it counts exactly like `ai-workflows@1.0.0`.
    if (key.replace(/^\/+/, '').toLowerCase().startsWith('ai-workflows@')) out[`${prefix}.${key}`] = entry;
  }
}

/** The projection of package.json: only the keys that decide which engine is installed. */
function projectPackageJson(value: unknown): string {
  if (!isRecord(value)) throw new Error('package.json is not an object');
  const out: Record<string, unknown> = {};
  for (const section of DEPENDENCY_SECTIONS) {
    if (hasKey(value[section], 'ai-workflows')) {
      out[`${section}.ai-workflows`] = (value[section] as Record<string, unknown>)['ai-workflows'];
    }
  }
  const scripts = value['scripts'];
  if (isRecord(scripts)) {
    for (const name of LIFECYCLE_SCRIPTS) {
      if (hasKey(scripts, name)) out[`scripts.${name}`] = scripts[name];
    }
  }
  // PLAN-13-R6 §15 (M1): `packageManager` picks the installer through corepack.
  if (hasKey(value, 'packageManager')) out['packageManager'] = value['packageManager'];
  // PLAN-13-R6 §15 (M-d): `workspaces` says which folders are members (whose lifecycle scripts
  // run), and `dependenciesMeta` can allow or forbid build scripts of dependencies.
  if (hasKey(value, 'workspaces')) out['workspaces'] = value['workspaces'];
  if (hasKey(value, 'dependenciesMeta')) out['dependenciesMeta'] = value['dependenciesMeta'];
  collectEngineKeys(value['overrides'], 'overrides', out);
  collectEngineKeys(value['resolutions'], 'resolutions', out);
  const pnpm = value['pnpm'];
  if (isRecord(pnpm)) {
    collectEngineKeys(pnpm['overrides'], 'pnpm.overrides', out);
    collectEngineKeys(pnpm['patchedDependencies'], 'pnpm.patchedDependencies', out);
    if (hasKey(pnpm, 'onlyBuiltDependencies')) out['pnpm.onlyBuiltDependencies'] = pnpm['onlyBuiltDependencies'];
    // PLAN-13-R6 §15 (M1): another build allow-list a pnpm install would read.
    if (hasKey(pnpm, 'onlyBuiltDependenciesFile')) out['pnpm.onlyBuiltDependenciesFile'] = pnpm['onlyBuiltDependenciesFile'];
  }
  return canonical(out);
}

/** The projection of pnpm-workspace.yaml: its overrides, its patches, its installer and catalogs. */
function projectWorkspace(value: unknown): string {
  if (!isRecord(value)) throw new Error('pnpm-workspace.yaml is not an object');
  const out: Record<string, unknown> = {};
  collectEngineKeys(value['overrides'], 'overrides', out);
  collectEngineKeys(value['patchedDependencies'], 'patchedDependencies', out);
  // PLAN-13-R6 §15/R32: the build allow-list and a custom pnpmfile run when dependencies install.
  // M1 of the delta review adds the rest of the pnpm workspace knobs that decide what runs.
  for (const key of [
    'onlyBuiltDependencies',
    'pnpmfile',
    'dangerouslyAllowAllBuilds',
    'onlyBuiltDependenciesFile',
    'neverBuiltDependencies',
    // PLAN-13-R6 §15 (M-d): which folders are members, the config dependencies pnpm runs, and the
    // allow-list of build scripts (the other spelling of the build permission).
    'packages',
    'configDependencies',
    'allowBuilds',
  ] as const) {
    if (hasKey(value, key)) out[key] = value[key];
  }
  if (hasKey(value['catalog'], 'ai-workflows')) {
    out['catalog.ai-workflows'] = (value['catalog'] as Record<string, unknown>)['ai-workflows'];
  }
  const catalogs = value['catalogs'];
  if (isRecord(catalogs)) {
    for (const [name, catalog] of Object.entries(catalogs)) {
      if (hasKey(catalog, 'ai-workflows')) {
        out[`catalogs.${name}.ai-workflows`] = (catalog as Record<string, unknown>)['ai-workflows'];
      }
    }
  }
  return canonical(out);
}

/** The projection of pnpm-lock.yaml: the engine entries of each importer, package and override. */
function projectPnpmLock(value: unknown): string {
  if (!isRecord(value)) throw new Error('pnpm-lock.yaml is not an object');
  const out: Record<string, unknown> = {};
  const importers = value['importers'];
  if (isRecord(importers)) {
    for (const [name, importer] of Object.entries(importers)) {
      if (!isRecord(importer)) continue;
      for (const section of DEPENDENCY_SECTIONS) {
        if (hasKey(importer[section], 'ai-workflows')) {
          out[`importers.${name}.${section}.ai-workflows`] =
            (importer[section] as Record<string, unknown>)['ai-workflows'];
        }
      }
    }
  }
  collectEnginePackages(value['packages'], 'packages', out);
  collectEnginePackages(value['snapshots'], 'snapshots', out);
  collectEngineKeys(value['overrides'], 'overrides', out);
  collectEngineKeys(value['patchedDependencies'], 'patchedDependencies', out);
  return canonical(out);
}

/** The projection of package-lock.json: the resolved engine under `node_modules/`. */
function projectPackageLock(value: unknown): string {
  if (!isRecord(value)) throw new Error('package-lock.json is not an object');
  const out: Record<string, unknown> = {};
  const packages = value['packages'];
  if (hasKey(packages, 'node_modules/ai-workflows')) {
    out['packages.node_modules/ai-workflows'] =
      (packages as Record<string, unknown>)['node_modules/ai-workflows'];
  }
  return canonical(out);
}

/**
 * The blocks of a yarn (v1) lockfile whose header names `ai-workflows@`, as written. A block
 * starts at an unindented, non-comment line (its header) and runs through the indented lines that
 * follow it. Order carries no meaning, so the blocks are sorted.
 */
function yarnEngineBlocks(content: string): string[] {
  const blocks: string[] = [];
  let header: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (header !== undefined && /ai-workflows@/i.test(header)) blocks.push([header, ...body].join('\n'));
    header = undefined;
    body = [];
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      body.push(line);
      continue;
    }
    flush();
    header = line;
  }
  flush();
  return blocks.sort();
}

/** The projection of a version file, or `undefined` when it cannot be read as its format. */
function projectionOf(file: string, content: string): string | undefined {
  try {
    // PLAN-13-R6 §15 (B3): any package.json of the workspace, root or member, projects the same.
    if (isPackageJson(file)) return projectPackageJson(JSON.parse(content));
    if (file === 'package-lock.json') return projectPackageLock(JSON.parse(content));
    if (file === 'yarn.lock') return canonical(yarnEngineBlocks(content));
    if (file === 'pnpm-workspace.yaml') return projectWorkspace(parseYaml(content));
    if (file === 'pnpm-lock.yaml') return projectPnpmLock(parseYaml(content));
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The projection of one side of a comparison. PLAN-13-R6 §15 (M-c): a workspace member's
 * package.json that is missing reads as an empty object, so adding it with only name and ordinary
 * dependencies, or deleting it without lifecycle scripts, is not a change. The root package.json,
 * the lockfiles and a member that cannot be read as its format have no trustworthy empty side:
 * they count as touched.
 */
function projectionOfSide(file: string, reading: GitFileReading): string | undefined {
  if (reading.kind === 'file') return projectionOf(file, reading.content ?? '');
  if (reading.kind === 'missing' && isMemberPackageJson(file)) return projectPackageJson({});
  return undefined;
}

/**
 * PLAN-13-R6 §2.2 and §15 P3: whether the engine version this pull request installs changes. The
 * comparison is fail-closed — a file that cannot be read as its format on either side, or that is
 * added or removed (except a workspace member's package.json, which has an empty side), counts as
 * touched. A git failure to read a commit throws, and the judge turns it into a technical error,
 * never into a pass.
 */
async function projectionDiffers(
  root: string,
  a: string,
  b: string,
  file: string,
): Promise<boolean> {
  const before = await gitFileAt(root, a, file, ENGINE_VERSION_MAX_BYTES);
  const after = await gitFileAt(root, b, file, ENGINE_VERSION_MAX_BYTES);
  const one = projectionOfSide(file, before);
  const other = projectionOfSide(file, after);
  return one === undefined || other === undefined || one !== other;
}

/** A repository path folded for comparison: forward slashes, no `./`, lower case. */
function foldRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** The path a settings value names, normalized for comparison, or `undefined` when it names none. */
function namedPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const folded = foldRepoPath(value.trim());
  return folded.length > 0 ? folded : undefined;
}

/**
 * PLAN-13-R6 §15 (M-d): the file the trusted side names with `onlyBuiltDependenciesFile` (in
 * `pnpm-workspace.yaml` or in `pnpm` of `package.json`). pnpm builds only what that file lists, so
 * it decides which dependencies run code. A git failure throws; a config that cannot be read, or
 * that names nothing, yields no named file (the config itself is compared field by field).
 */
async function namedBuildFile(root: string, trusted: string): Promise<string | undefined> {
  const workspace = await gitFileAt(root, trusted, 'pnpm-workspace.yaml', ENGINE_VERSION_MAX_BYTES);
  if (workspace.kind === 'file') {
    try {
      const parsed = parseYaml(workspace.content ?? '');
      if (isRecord(parsed)) {
        const found = namedPath(parsed['onlyBuiltDependenciesFile']);
        if (found !== undefined) return found;
      }
    } catch {
      // Not YAML: its own projection already counts it as touched; no named file to add.
    }
  }
  const packageJson = await gitFileAt(root, trusted, 'package.json', ENGINE_VERSION_MAX_BYTES);
  if (packageJson.kind === 'file') {
    try {
      const parsed: unknown = JSON.parse(packageJson.content ?? '');
      if (isRecord(parsed) && isRecord(parsed['pnpm'])) {
        return namedPath((parsed['pnpm'] as Record<string, unknown>)['onlyBuiltDependenciesFile']);
      }
    } catch {
      // Not JSON: its own projection already counts it as touched; no named file to add.
    }
  }
  return undefined;
}

export interface OwnFilesScan {
  /** Every path that truly lands when `head` is merged into the trusted tip, sorted. */
  readonly files: readonly string[];
  /**
   * The merge GitHub would perform conflicts. It counts as touching the judge's own files, never as
   * a pass (PLAN-13-R6 §15 P3).
   */
  readonly conflicted: boolean;
  /** The engine-version files whose projection changes on what truly lands. */
  readonly versionTouched: readonly string[];
}

/**
 * PLAN-13-R6 §15 P3 (criss-cross merges): the judge's own files and the engine version are measured
 * on what really lands. With several merge bases (`git merge-base --all`), a single base can hide a
 * change, so every changed path is the union of the diffs against all of them, plus the diff of the
 * merge tree (`git merge-tree`, the merge GitHub performs) against the trusted tip. The engine
 * version is compared against every merge base and against that merge tree. A conflicting merge
 * tree is reported as `conflicted`, which the caller treats as touched. A git failure throws.
 */
export async function scanOwnFiles(
  root: string,
  trusted: string,
  head: string,
): Promise<OwnFilesScan> {
  const bases = await gitMergeBases(root, trusted, head);
  const landing = new Set<string>();
  for (const base of bases) {
    for (const path of await gitChangedPaths(root, base, head)) landing.add(path);
  }

  const merge = await gitMergeTree(root, trusted, head);
  if (merge.conflicted) {
    return { files: [...landing].sort(), conflicted: true, versionTouched: [] };
  }
  if (merge.tree !== undefined) {
    for (const path of await gitChangedPaths(root, trusted, merge.tree)) landing.add(path);
  }
  const files = [...landing].sort();

  const versionTouched: string[] = [];
  for (const file of engineVersionFilesIn(files)) {
    let differs = false;
    for (const base of bases) {
      if (await projectionDiffers(root, base, head, file)) {
        differs = true;
        break;
      }
    }
    if (!differs && merge.tree !== undefined) {
      differs = await projectionDiffers(root, trusted, merge.tree, file);
    }
    if (differs) versionTouched.push(file);
  }

  // PLAN-13-R6 §15 (M-d): the file the trusted side names as its build allow-list is one of the
  // judge's own; a change to it is reported with its name, like any engine-version file.
  const buildFile = await namedBuildFile(root, trusted);
  if (buildFile !== undefined) {
    const changed = files.find((file) => foldRepoPath(file) === buildFile);
    if (changed !== undefined && !versionTouched.includes(changed)) versionTouched.push(changed);
  }
  return { files, conflicted: false, versionTouched };
}
