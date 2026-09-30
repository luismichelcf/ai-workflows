// PLAN-13-R6 §2: the judge's own files. One fixed list, shared with `hooks install`, of the paths
// that are knowledge of the engine and never of a project (R05): what its installer writes and the
// line that says which engine is installed. Plus the engine version, compared field by field, so a
// pull request that changes many ordinary things in package.json is judged on the few keys that
// decide which package lands in `node_modules/ai-workflows`.
//
// PLAN-13-R6 §15 (third delta, last paragraph): protecting the manifests with a list of dangerous
// keys never closes — another manifest format, another installer option. The rule is inverted: in a
// package manifest (`package.json`, `package.yaml`, `package.json5`, at any depth) and in
// `pnpm-workspace.yaml`, every change is touched except a short list of harmless ones.

import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

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
 * PLAN-13-R6 §2.2 and §15 (fourth delta): a key that names the engine wherever pnpm, npm or yarn
 * read a dependency or a patch rule. It bites `ai-workflows` and `algo>ai-workflows`, but never
 * `ai-workflows-extra`. The comparison ignores case: `AI-Workflows` is the engine too.
 */
const ENGINE_KEY = /(^|>)ai-workflows(@|$)/i;

/** The engine package name, exactly: only this `name` is dangerous (§15 third delta). */
const ENGINE_NAME = 'ai-workflows';

/** The sections of a package.json or an importer that install the dependency named by their key. */
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const DEPENDENCY_SECTION_SET = new Set<string>(DEPENDENCY_SECTIONS);

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
const LIFECYCLE_SCRIPT_SET = new Set<string>(LIFECYCLE_SCRIPTS);

/**
 * PLAN-13-R6 §15 (third delta): the package.json fields that are harmless whatever they hold. Every
 * other field — and every field this list does not name, like `main`, `exports`, `bin`, `type`,
 * `overrides` or `pnpm` — is part of what decides which packages run on install.
 */
const HARMLESS_FIELDS = [
  'version',
  'description',
  'keywords',
  'author',
  'contributors',
  'license',
  'repository',
  'homepage',
  'bugs',
  'private',
] as const;
const HARMLESS_FIELD_SET = new Set<string>(HARMLESS_FIELDS);

/** A manifest format, by file name, at any depth (§15 third delta). */
type ManifestKind = 'json' | 'yaml' | 'json5';

/** The last path segment, lower case: a manifest is named wherever it lives. */
function baseName(file: string): string {
  const lower = file.toLowerCase();
  const at = lower.lastIndexOf('/');
  return at < 0 ? lower : lower.slice(at + 1);
}

/** The kind of package manifest `file` is, in any folder, or `undefined` for any other file. */
function manifestKindOf(file: string): ManifestKind | undefined {
  switch (baseName(file)) {
    case 'package.json':
      return 'json';
    case 'package.yaml':
      return 'yaml';
    case 'package.json5':
      return 'json5';
    default:
      return undefined;
  }
}

/** The root `package.json`, whose added or removed side has no trustworthy empty (§15 M-c). */
function isRootPackageJson(file: string): boolean {
  return file.toLowerCase() === 'package.json';
}

/**
 * PLAN-13-R6 §15 (M-c, third delta): a package manifest of a workspace member is any manifest that
 * is not the root `package.json`; added or removed, its missing side reads as an empty manifest.
 */
function isMemberManifest(file: string): boolean {
  return manifestKindOf(file) !== undefined && !isRootPackageJson(file);
}

/**
 * PLAN-13-R6 §15 (third delta): `binding.gyp`, at any depth, is touched whenever it changes: npm
 * runs `node-gyp rebuild` on install when a package has one and no install script.
 */
function isBindingGyp(file: string): boolean {
  return baseName(file) === 'binding.gyp';
}

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
 * The engine-version files a pull request touches: any package manifest at any depth, any
 * `binding.gyp`, and the canonical lockfiles, whatever the case it committed (§15 third delta).
 */
export function engineVersionFilesIn(files: readonly string[]): string[] {
  const canonical = new Set(ENGINE_VERSION_FILES);
  return files.filter(
    (file) =>
      manifestKindOf(file) !== undefined ||
      isBindingGyp(file) ||
      canonical.has(file.toLowerCase()),
  );
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

/**
 * PLAN-13-R6 §15 (fifth delta): a node-semver range or version. The parts follow semver's own
 * grammar (numeric, `x`/`X`/`*` wildcards, an optional `v`, a prerelease and build metadata), so a
 * range like `1.x`, `>=1 <2` or `1.0.0-beta.1` is harmless while a look-alike with a dot but no
 * version — `release.candidate` — is not.
 */
const XRANGE = '(?:[xX*]|0|[1-9][0-9]*)';
const PRERELEASE_ID = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const PRERELEASE = `(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)`;
const BUILD_ID = '[0-9a-zA-Z-]+';
const BUILD = `(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)`;
const VERSION = `v?${XRANGE}(?:\\.${XRANGE}(?:\\.${XRANGE})?)?${PRERELEASE}?${BUILD}?`;
const COMPARATOR = `(?:[<>=~^]=?[ ]*)?${VERSION}`;
const HYPHEN_RANGE = `${VERSION}[ ]+-[ ]+${VERSION}`;
const RANGE_TOKEN = `(?:${HYPHEN_RANGE}|${COMPARATOR})`;
const SEMVER_RANGE = new RegExp(
  `^\\s*${RANGE_TOKEN}(?:[ ]+${RANGE_TOKEN})*(?:\\s*\\|\\|\\s*${RANGE_TOKEN}(?:[ ]+${RANGE_TOKEN})*)*\\s*$`,
);

/** PLAN-13-R6 §15 (fifth delta): a tag is letters, digits, `-` and `_`, with no dots or slashes. */
const TAG_SPEC = /^[A-Za-z0-9_-]+$/;

/** PLAN-13-R6 §15 (fifth delta): a tarball by extension, whatever the case. */
const TARBALL_SPEC = /\.(?:tgz|tar|tar\.gz)$/i;

/**
 * PLAN-13-R6 §15 (fourth and fifth delta): whether a dependency or catalog entry that does not name
 * the engine is harmless. It is, only when its value is a registry range or version written with the
 * characters of semver, a tag without dots or slashes, or starts with `workspace:` or `catalog:`.
 * Everything that leaves the registry is touched: `file:`, `link:`, a git URL, `github:`, `npm:`,
 * `patch:`, `portal:`, an address, anything with a `/` or `:`, a `.tgz`/`.tar`/`.tar.gz`, a value
 * starting with `.`, `\` or `~/`, and any look-alike that is neither a range nor a tag.
 */
function isRegistrySpec(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const spec = value.trim();
  if (spec.length === 0) return false;
  if (spec.startsWith('workspace:') || spec.startsWith('catalog:')) return true;
  if (spec.startsWith('.')) return false;
  if (spec.startsWith('\\') || spec.startsWith('~/')) return false;
  if (TARBALL_SPEC.test(spec)) return false;
  if (spec.includes('/') || spec.includes(':')) return false;
  return SEMVER_RANGE.test(spec) || TAG_SPEC.test(spec);
}

/**
 * PLAN-13-R6 §15 (fourth delta): whether `value` — or anything inside it — holds the key `forbidden`
 * as its own. A plain JS object drops `__proto__` when it is assigned to; detecting it before any
 * assignment is what lets the judge see what the installer would. `Object.entries` is used because
 * it reads the own property even when it shadows `Object.prototype.__proto__`.
 */
function hasForbiddenKeyDeep(value: unknown, forbidden: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenKeyDeep(entry, forbidden));
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === forbidden) return true;
      if (hasForbiddenKeyDeep(entry, forbidden)) return true;
    }
  }
  return false;
}

/**
 * PLAN-13-R6 §15 (fifth delta): whether a YAML node is one the installer's reader and the judge read
 * the same way — a map, a sequence or a scalar, with scalar keys and no anchor, alias or explicit
 * tag. Anything else (an anchor, an alias, a non-scalar key, a merge key) is an advanced feature, so
 * the document is touched without being interpreted.
 */
function isPlainYamlNode(node: unknown): boolean {
  if (node === null || node === undefined) return true;
  if (isAlias(node)) return false;
  if (isScalar(node)) return node.anchor === undefined && node.tag === undefined;
  if (isMap(node)) {
    if (node.anchor !== undefined || node.tag !== undefined) return false;
    for (const item of node.items) {
      if (!isScalar(item.key)) return false;
      if (item.key.anchor !== undefined || item.key.tag !== undefined) return false;
      if (item.key.value === '<<') return false;
      if (!isPlainYamlNode(item.value)) return false;
    }
    return true;
  }
  if (isSeq(node)) {
    if (node.anchor !== undefined || node.tag !== undefined) return false;
    return node.items.every((item) => isPlainYamlNode(item));
  }
  return false;
}

/**
 * PLAN-13-R6 §15 (fifth delta): whether a parsed document uses only plain YAML. A directive
 * (`%YAML`, `%TAG`), any error or warning of the reader (a duplicated key or a second document
 * included), or an advanced node makes it touched without being interpreted. `parseDocument` keeps
 * explicit tags and merge keys visible (the merge option is not set), so this traversal sees them.
 */
function isPlainYamlDocument(doc: Document): boolean {
  if (doc.errors.length > 0 || doc.warnings.length > 0) return false;
  if (doc.directives?.yaml?.explicit === true) return false;
  const tags = doc.directives?.tags ?? {};
  if (Object.keys(tags).some((key) => key !== '!!')) return false;
  return isPlainYamlNode(doc.contents);
}

/**
 * The JavaScript value of a YAML document, or `undefined` when it uses any advanced YAML feature
 * (§15 fifth delta): the judge and the installer do not read such a document the same way, so it is
 * touched without being interpreted.
 */
function yamlValue(content: string): unknown {
  const doc = parseDocument(content);
  if (!isPlainYamlDocument(doc)) return undefined;
  return doc.toJS();
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

/**
 * The projection of a package manifest (§15 third delta): the manifest with its harmless parts
 * removed, so any change anywhere else counts as touched — an unknown key as much as a known one.
 * The harmless parts are: the dependency entries that do not name the engine; `name` when it is not
 * the engine; the fixed list of descriptive fields; and every script that does not run on install.
 */
function sanitizeManifest(value: unknown): string {
  if (!isRecord(value)) throw new Error('package manifest is not an object');
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DEPENDENCY_SECTION_SET.has(key)) {
      if (!isRecord(entry)) {
        out[key] = entry;
        continue;
      }
      const kept: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(entry)) {
        if (ENGINE_KEY.test(name) || !isRegistrySpec(spec)) kept[name] = spec;
      }
      if (Object.keys(kept).length > 0) out[key] = kept;
      continue;
    }
    if (key === 'name') {
      if (typeof entry !== 'string' || entry.toLowerCase() === ENGINE_NAME) out[key] = entry;
      continue;
    }
    if (key === 'scripts') {
      if (!isRecord(entry)) {
        out[key] = entry;
        continue;
      }
      const kept: Record<string, unknown> = {};
      for (const [name, script] of Object.entries(entry)) {
        if (LIFECYCLE_SCRIPT_SET.has(name)) kept[name] = script;
      }
      if (Object.keys(kept).length > 0) out[key] = kept;
      continue;
    }
    if (HARMLESS_FIELD_SET.has(key)) continue;
    out[key] = entry;
  }
  return canonical(out);
}

/** The catalog entries that matter: the engine's, and any other whose spec leaves the registry. */
function engineEntriesOnly(section: unknown): unknown {
  if (!isRecord(section)) return section;
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(section)) {
    if (ENGINE_KEY.test(key) || !isRegistrySpec(entry)) kept[key] = entry;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The projection of pnpm-workspace.yaml (§15 third delta): everything is kept except the catalog
 * entries of packages that are not the engine. An unknown key — `scriptShell`, `packageExtensions`,
 * whatever pnpm adds next — is kept, so it is touched.
 */
function sanitizeWorkspace(value: unknown): string {
  if (!isRecord(value)) throw new Error('pnpm-workspace.yaml is not an object');
  const out: Record<string, unknown> = { ...value };
  if (hasKey(out, 'catalog')) {
    const kept = engineEntriesOnly(out['catalog']);
    if (kept === undefined) delete out['catalog'];
    else out['catalog'] = kept;
  }
  if (hasKey(out, 'catalogs')) {
    const catalogs = out['catalogs'];
    if (isRecord(catalogs)) {
      const kept: Record<string, unknown> = {};
      for (const [name, catalog] of Object.entries(catalogs)) {
        const entries = engineEntriesOnly(catalog);
        if (entries !== undefined) kept[name] = entries;
      }
      if (Object.keys(kept).length > 0) out['catalogs'] = kept;
      else delete out['catalogs'];
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
        const entries = importer[section];
        if (!isRecord(entries)) continue;
        for (const [key, entry] of Object.entries(entries)) {
          if (ENGINE_KEY.test(key)) out[`importers.${name}.${section}.${key}`] = entry;
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
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (key.toLowerCase() === 'node_modules/ai-workflows') out[`packages.${key}`] = entry;
    }
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
    const kind = manifestKindOf(file);
    if (kind === 'json') {
      const parsed: unknown = JSON.parse(content);
      // §15 (fourth delta): a `__proto__` key at any depth of a manifest is touched: a plain JS
      // object drops it, so the judge would not see what the installer reads.
      if (hasForbiddenKeyDeep(parsed, '__proto__')) return undefined;
      return sanitizeManifest(parsed);
    }
    if (kind === 'yaml') {
      const value = yamlValue(content);
      if (value === undefined || hasForbiddenKeyDeep(value, '__proto__')) return undefined;
      return sanitizeManifest(value);
    }
    // §15 (third delta): package.json5 and binding.gyp have no reader here, so they are touched
    // whenever they change (a harmless field included), never read as a pass.
    if (kind === 'json5' || isBindingGyp(file)) return undefined;
    if (file === 'package-lock.json') return projectPackageLock(JSON.parse(content));
    if (file === 'yarn.lock') return canonical(yarnEngineBlocks(content));
    if (file === 'pnpm-workspace.yaml') {
      const value = yamlValue(content);
      if (value === undefined || hasForbiddenKeyDeep(value, '__proto__')) return undefined;
      return sanitizeWorkspace(value);
    }
    if (file === 'pnpm-lock.yaml') {
      const value = yamlValue(content);
      if (value === undefined) return undefined;
      return projectPnpmLock(value);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The projection of one side of a comparison. PLAN-13-R6 §15 (M-c, third delta): a workspace
 * member's manifest — `package.json` or `package.yaml` — that is missing reads as an empty
 * manifest, so adding it with only name and ordinary dependencies, or deleting it without lifecycle
 * scripts, is not a change. The root package.json, package.json5, binding.gyp, the lockfiles and a
 * member that cannot be read as its format have no trustworthy empty side: they count as touched.
 */
function projectionOfSide(file: string, reading: GitFileReading): string | undefined {
  if (reading.kind === 'file') return projectionOf(file, reading.content ?? '');
  if (reading.kind === 'missing' && isMemberManifest(file)) return projectionOf(file, '{}');
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

/**
 * A path a settings value names, normalized to the repository: forward slashes, no `.` or `..`
 * segments, lower case. `undefined` when it names nothing, or when it leaves the repository (an
 * absolute path or one that pops above its root), so such a value is ignored (§15 third delta).
 */
function normalizeRepoPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const folded = value.trim().replace(/\\/g, '/');
  if (folded.length === 0) return undefined;
  if (folded.startsWith('/') || /^[A-Za-z]:/.test(folded)) return undefined;
  const stack: string[] = [];
  for (const part of folded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return undefined;
  return stack.join('/').toLowerCase();
}

/** A value with one layer of matching quotes removed, the way npm reads an .npmrc value. */
function unquoted(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * PLAN-13-R6 §15 (fifth delta): an .npmrc value with its inline comment cut, the way the `ini`
 * reader reads it — ` ; …` or ` # …` ends the value. A `;` or `#` inside a quoted value is kept, so
 * a quoted path is not truncated.
 */
function iniValue(raw: string): string {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === ';' || ch === '#') && i > 0 && /\s/.test(raw.charAt(i - 1))) return raw.slice(0, i);
  }
  return raw;
}

/**
 * Every value of `only-built-dependencies-file` in an .npmrc (§15 fourth and fifth delta): the
 * installer reads each occurrence, so each names a file of the judge's own. A key in double or
 * single quotes is unquoted before it is compared, and an inline comment ends the value.
 */
function npmrcBuildFiles(content: string): string[] {
  const found: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    if (unquoted(line.slice(0, at).trim()) !== 'only-built-dependencies-file') continue;
    found.push(unquoted(iniValue(line.slice(at + 1)).trim()));
  }
  return found;
}

/**
 * PLAN-13-R6 §15 (M-d, third delta): the files the trusted side names as its build allow-list, from
 * every setting that can name one — `onlyBuiltDependenciesFile` in `pnpm-workspace.yaml`,
 * `pnpm.onlyBuiltDependenciesFile` in `package.json` and `only-built-dependencies-file` in
 * `.npmrc`. pnpm builds only what those files list, so each decides which dependencies run code.
 * A git failure throws; a config that cannot be read, or that names nothing, contributes nothing
 * (the config itself is compared field by field). Every value is normalized, and one that leaves
 * the repository is ignored.
 */
async function namedBuildFiles(root: string, trusted: string): Promise<string[]> {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    const path = normalizeRepoPath(value);
    if (path !== undefined) found.add(path);
  };

  const workspace = await gitFileAt(root, trusted, 'pnpm-workspace.yaml', ENGINE_VERSION_MAX_BYTES);
  if (workspace.kind === 'file') {
    try {
      const parsed: unknown = parseDocument(workspace.content ?? '').toJS();
      if (isRecord(parsed)) add(parsed['onlyBuiltDependenciesFile']);
    } catch {
      // Not YAML: its own projection already counts it as touched; no named file to add.
    }
  }

  const packageJson = await gitFileAt(root, trusted, 'package.json', ENGINE_VERSION_MAX_BYTES);
  if (packageJson.kind === 'file') {
    try {
      const parsed: unknown = JSON.parse(packageJson.content ?? '');
      if (isRecord(parsed) && isRecord(parsed['pnpm'])) {
        add((parsed['pnpm'] as Record<string, unknown>)['onlyBuiltDependenciesFile']);
      }
    } catch {
      // Not JSON: its own projection already counts it as touched; no named file to add.
    }
  }

  const npmrc = await gitFileAt(root, trusted, '.npmrc', ENGINE_VERSION_MAX_BYTES);
  if (npmrc.kind === 'file') {
    for (const value of npmrcBuildFiles(npmrc.content ?? '')) add(value);
  }

  return [...found];
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

  // PLAN-13-R6 §15 (M-d, third delta): every file the trusted side names as its build allow-list —
  // from `pnpm-workspace.yaml`, `pnpm` of `package.json` or `.npmrc` — is one of the judge's own; a
  // change to it is reported with its name, like any engine-version file.
  for (const buildFile of await namedBuildFiles(root, trusted)) {
    const changed = files.find((file) => foldRepoPath(file) === buildFile);
    if (changed !== undefined && !versionTouched.includes(changed)) versionTouched.push(changed);
  }
  return { files, conflicted: false, versionTouched };
}
