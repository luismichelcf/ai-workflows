// PLAN-13-R6 §2: the judge's own files. One fixed list, shared with `hooks install`, of the paths
// that are knowledge of the engine and never of a project (R05): what its installer writes and the
// line that says which engine is installed. Plus the engine version, compared field by field, so a
// pull request that changes many ordinary things in package.json is judged on the few keys that
// decide which package lands in `node_modules/ai-workflows`.

import { parse as parseYaml } from 'yaml';

import { gitFileAt } from '../recipe/facts.js';

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
  '.pnpmfile.cjs',
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

/** The canonical engine-version files a pull request touches, whatever the case it committed. */
export function engineVersionFilesIn(files: readonly string[]): string[] {
  const lower = new Set(files.map((file) => file.toLowerCase()));
  return ENGINE_VERSION_FILES.filter((file) => lower.has(file));
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
    if (key.toLowerCase().startsWith('ai-workflows@')) out[`${prefix}.${key}`] = entry;
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
  collectEngineKeys(value['overrides'], 'overrides', out);
  collectEngineKeys(value['resolutions'], 'resolutions', out);
  const pnpm = value['pnpm'];
  if (isRecord(pnpm)) {
    collectEngineKeys(pnpm['overrides'], 'pnpm.overrides', out);
    collectEngineKeys(pnpm['patchedDependencies'], 'pnpm.patchedDependencies', out);
  }
  return canonical(out);
}

/** The projection of pnpm-workspace.yaml: its overrides, its patches and its engine catalogs. */
function projectWorkspace(value: unknown): string {
  if (!isRecord(value)) throw new Error('pnpm-workspace.yaml is not an object');
  const out: Record<string, unknown> = {};
  collectEngineKeys(value['overrides'], 'overrides', out);
  collectEngineKeys(value['patchedDependencies'], 'patchedDependencies', out);
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
    if (file === 'package.json') return projectPackageJson(JSON.parse(content));
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
 * PLAN-13-R6 §2.2: which of the engine-version files a pull request touches actually change which
 * engine is installed, comparing the merge base with the head. Fail-closed: a file that cannot be
 * read as its format on either side, or that is added or removed, counts as touched. A git failure
 * to read a commit throws, and the judge turns it into a technical error, never into a pass.
 */
export async function touchedEngineVersionFiles(
  root: string,
  mergeBase: string,
  head: string,
  files: readonly string[],
): Promise<string[]> {
  const touched: string[] = [];
  for (const file of engineVersionFilesIn(files)) {
    const base = await gitFileAt(root, mergeBase, file, ENGINE_VERSION_MAX_BYTES);
    const atHead = await gitFileAt(root, head, file, ENGINE_VERSION_MAX_BYTES);
    if (base.kind !== 'file' || atHead.kind !== 'file') {
      touched.push(file);
      continue;
    }
    const before = projectionOf(file, base.content ?? '');
    const after = projectionOf(file, atHead.content ?? '');
    if (before === undefined || after === undefined || before !== after) touched.push(file);
  }
  return touched;
}
