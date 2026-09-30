import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { installHooks, recipeCommand } from '../src/index.js';

import { emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';
import { writeTgz } from './tgz.js';

// PLAN-13-R6 §9.2 and §9.4 (tests 1 to 5, 4b, 4c and 4d): `init` from a sealed engine.
//
// INTERFACE this file defines (the builder implements it; nothing here is edited by the builder):
//
//   recipeCommand(argv, options) with argv one of
//     ['init'] | ['init', '--judge-only'] | ['init', '--package', <path>]
//   and options, all but `cwd` optional:
//     cwd: string
//     seal?: unknown
//        The seal of the running engine (the parsed `engine.json`). Omitted: read
//        `<package root>/engine.json` (a development copy has none). `null`: no seal. Anything else
//        is validated: `{ version: 'X.Y.Z', sha: <40 lowercase hex> }`, nothing looser. The
//        version of every address init writes comes from the seal, never from package.json.
//     runPackageInstall?: (request: { manager: 'pnpm' | 'npm' | 'yarn'; cwd: string })
//        => Promise<{ ok: true } | { ok: false; reason: string }>
//        Runs the install of the detected package manager in the project root (the process is the
//        external edge). Detection by lock file: pnpm-lock.yaml -> pnpm, package-lock.json -> npm,
//        yarn.lock -> yarn, none -> pnpm.
//     renameFile?: (from: string, to: string) => Promise<void>
//        How a temporary workflow file is moved into place (default: fs.promises.rename). Injected
//        only to make a rename fail (4b).
//
//   What init writes (sealed): devDependencies['ai-workflows'] =
//     https://github.com/luismichelcf/ai-workflows/releases/download/v<version>/ai-workflows-<version>.tgz
//   (or `file:<path as given>` with --package), creating package.json when there is none; then the
//   recipe with the schema address of that version, the three workflows with
//   `uses: luismichelcf/ai-workflows@<sha> # v<version>` and the judge's `branches` input from the
//   recipe's `branches.into`, and the hooks exactly as `hooks install --apply` writes them.
//   Each file is reported as `Created <path>` or `<path> already exists; init does not overwrite it.`
//
// Without a valid seal init installs nothing and writes no workflow (it may still write the
// example recipe, as the development copy always did) and says why, naming the seal.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const VERSION = '1.2.3';
const SEAL = { version: VERSION, sha: SHA } as const;
const RELEASE_URL = 'https://github.com/luismichelcf/ai-workflows/releases/download/v1.2.3/ai-workflows-1.2.3.tgz';
const SCHEMA_URL = 'https://github.com/luismichelcf/ai-workflows/releases/download/v1.2.3/recipe.schema.json';
const OLD_URL = 'https://github.com/luismichelcf/ai-workflows/releases/download/v0.3.0/ai-workflows-0.3.0.tgz';

const RECIPE = '.ai-workflows/pipeline.yml';
const WORKFLOWS: Readonly<Record<string, string>> = {
  '.github/workflows/ai-workflows.yml': 'ai-workflows.yml',
  '.github/workflows/ai-workflows-red-test.yml': 'ai-workflows-red-test.yml',
  '.github/workflows/ai-workflows-review-signal.yml': 'ai-workflows-review-signal.yml',
};
const WORKFLOW_PATHS = Object.keys(WORKFLOWS);

const template = (name: string) => readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8');
const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
const exists = (root: string, file: string) => existsSync(join(root, file));

const RECIPE_WITH_BRANCHES = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'branches:',
  '  into: [staging, main]',
  '  promotions:',
  '    - { from: staging, to: main }',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const PACKAGE_JSON = `${JSON.stringify({ name: 'app', version: '0.0.0', private: true, scripts: { test: 'vitest run' }, dependencies: { react: '^19.0.0' } }, null, 2)}\n`;

interface InstallRequest {
  readonly manager: string;
  readonly cwd: string;
}

/** A package-manager install that succeeds and leaves `node_modules/ai-workflows` of `seal`. */
function fakeInstall(seal: { version: string; sha: string } = SEAL) {
  const calls: InstallRequest[] = [];
  const run = async (request: InstallRequest) => {
    calls.push(request);
    write(request.cwd, 'node_modules/ai-workflows/package.json', `${JSON.stringify({ name: 'ai-workflows', version: seal.version })}\n`);
    write(request.cwd, 'node_modules/ai-workflows/engine.json', `${JSON.stringify(seal)}\n`);
    return { ok: true as const };
  };
  return { calls, run };
}

/** An install that must never be asked for. */
function forbiddenInstall() {
  const calls: InstallRequest[] = [];
  const run = async (request: InstallRequest) => {
    calls.push(request);
    return { ok: false as const, reason: 'this test forbids installing' };
  };
  return { calls, run };
}

/** Drops an input line `key:` of a workflow and the lines of its value (more indented). */
function withoutInput(text: string, key: string): string {
  const rows = text.split('\n');
  const kept: string[] = [];
  let dropIndent: number | undefined;
  for (const row of rows) {
    const indent = row.length - row.trimStart().length;
    if (dropIndent !== undefined) {
      if (row.trim().length > 0 && indent > dropIndent) continue;
      dropIndent = undefined;
    }
    if (new RegExp(`^\\s+${key}:`).test(row)) {
      dropIndent = indent;
      continue;
    }
    kept.push(row);
  }
  return kept.join('\n');
}

const ENGINE_USES = /luismichelcf\/ai-workflows@[^\s#]+/g;

/** The written workflow with its only allowed substitutions put back as placeholders. */
function normalizedWritten(text: string): string {
  const pinned = text.replace(/luismichelcf\/ai-workflows@([0-9a-f]{40})[ \t]+# v1\.2\.3$/gm, 'luismichelcf/ai-workflows@<ENGINE_SHA>');
  return withoutInput(pinned, 'branches');
}

function expectWorkflowsFromTemplates(root: string): void {
  for (const [path, name] of Object.entries(WORKFLOWS)) {
    const written = read(root, path);
    const original = template(name);
    const usesLines = written.split('\n').filter((row) => /luismichelcf\/ai-workflows@/.test(row) && /^\s*-?\s*uses:/.test(row));
    expect(usesLines.length, path).toBe((original.match(/uses: luismichelcf\/ai-workflows@/g) ?? []).length);
    for (const row of usesLines) {
      expect(row, path).toMatch(new RegExp(`uses: luismichelcf/ai-workflows@${SHA}[ \\t]+# v1\\.2\\.3$`));
      expect(row, path).not.toContain('<ENGINE_SHA>');
    }
    expect(normalizedWritten(written), path).toBe(withoutInput(original, 'branches'));
  }
}

function judgeStep(root: string): Record<string, any> {
  const judge = parse(read(root, '.github/workflows/ai-workflows.yml')) as Record<string, any>;
  const job = Object.values(judge['jobs'] as Record<string, Record<string, any>>)[0] as Record<string, any>;
  const step = (job['steps'] as Record<string, any>[]).find((candidate) => String(candidate['uses'] ?? '').startsWith('luismichelcf/ai-workflows@'));
  if (step === undefined) throw new Error('the judge workflow has no engine step');
  return step;
}

const branchesOf = (value: unknown): string[] => String(value ?? '').split(/[\s,]+/).filter((name) => name.length > 0);

/** Every file under `root` except `.git`, as forward-slash relative paths. */
function filesUnder(root: string, dir = root): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (dir === root && name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(root, full));
    else found.push(relative(root, full).split('\\').join('/'));
  }
  return found.sort();
}

function hooksPathOf(root: string): string {
  try {
    return git(root, 'config', '--local', '--get', 'core.hooksPath');
  } catch {
    return '';
  }
}

function expectNoHooks(root: string): void {
  expect(exists(root, '.claude/settings.json')).toBe(false);
  expect(exists(root, '.codex')).toBe(false);
  expect(exists(root, '.opencode')).toBe(false);
  expect(exists(root, '.ai-workflows/githooks')).toBe(false);
  expect(hooksPathOf(root)).toBe('');
}

describe('R6 §9.4 test 1: init with a seal writes the recipe and the three workflows', () => {
  it('in a new project: the recipe names the schema of the sealed version, and each workflow is its template with the SHA pinned', async () => {
    const root = repository({ 'README.md': '# app\n' });
    const install = fakeInstall();

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    const recipe = read(root, RECIPE);
    expect(recipe).toContain(SCHEMA_URL);
    expect(recipe.replace(SCHEMA_URL, '<SCHEMA>')).toBe(
      template('pipeline.yml').replace(/https:\/\/github\.com\/luismichelcf\/ai-workflows\/releases\/download\/v[^/]+\/recipe\.schema\.json/, '<SCHEMA>'),
    );
    expectWorkflowsFromTemplates(root);
    // PLAN-13-R6 §15: the example recipe is `locale: es`, so init reports in Spanish (was `Created`).
    for (const path of [RECIPE, ...WORKFLOW_PATHS]) expect(output.text).toContain(`Creado ${path}`);
    // What init cannot do is said at the end, with the switch variable named.
    expect(output.text).toContain('AI_WORKFLOWS_MODE');
  });

  it('with a recipe that declares branches: keeps the recipe and writes its branches into the judge input', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES, 'package.json': PACKAGE_JSON });
    const install = fakeInstall();

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    expect(read(root, RECIPE)).toBe(RECIPE_WITH_BRANCHES);
    // PLAN-13-R6 §15: this recipe is `locale: es`, so the line is Spanish (was English).
    expect(output.text).toContain(`${RECIPE} ya existía; init no lo sobrescribe.`);
    expectWorkflowsFromTemplates(root);
    expect(branchesOf(judgeStep(root)['with']?.['branches'])).toEqual(['staging', 'main']);
  });
});

describe('R6 §9.4 test 2: without a valid seal, no workflow', () => {
  const MALFORMED: readonly unknown[] = [
    { version: VERSION, sha: 'HEAD' },
    { version: VERSION, sha: '<ENGINE_SHA>' },
    { version: VERSION, sha: 'a1b2c3d' },
    { version: VERSION, sha: `${SHA}0` },
    { version: VERSION, sha: `g${SHA.slice(1)}` },
    { sha: SHA },
    { version: 'v1.2.3', sha: SHA },
    { version: '', sha: SHA },
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    [],
  ];

  it('with no seal (null), it writes no workflow, installs nothing and says why', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON });
    const install = forbiddenInstall();

    const output = await recipeCommand(['init'], { cwd: root, seal: null, runPackageInstall: install.run });

    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/engine\.json|seal|sello/i);
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(false);
    expect(install.calls).toEqual([]);
    expect(read(root, 'package.json')).toBe(PACKAGE_JSON);
    expectNoHooks(root);
  });

  it('a development copy (no engine.json next to the engine) behaves the same', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON });

    const output = await recipeCommand(['init'], { cwd: root });

    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/engine\.json|seal|sello/i);
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(false);
    expect(read(root, 'package.json')).toBe(PACKAGE_JSON);
    expect(output.text).not.toContain('<ENGINE_SHA>');
  });

  it('with a malformed seal, the same: never a placeholder, never HEAD', async () => {
    for (const seal of MALFORMED) {
      const root = repository({ 'package.json': PACKAGE_JSON });
      const install = forbiddenInstall();

      const output = await recipeCommand(['init'], { cwd: root, seal, runPackageInstall: install.run });

      const label = JSON.stringify(seal);
      expect(output.ok, label).toBe(false);
      expect(output.text, label).toMatch(/engine\.json|seal|sello/i);
      for (const path of WORKFLOW_PATHS) expect(exists(root, path), `${label} ${path}`).toBe(false);
      expect(install.calls, label).toEqual([]);
      expect(read(root, 'package.json'), label).toBe(PACKAGE_JSON);
    }
  });
});

describe('R6 §9.4 test 3: the three workflows are all or nothing', () => {
  it('one workflow already there: none of the three is written, and it is named', async () => {
    const existing = '.github/workflows/ai-workflows-review-signal.yml';
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES, [existing]: 'mine\n' });

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });

    expect(output.ok).toBe(false);
    expect(output.text).toContain(existing);
    expect(read(root, existing)).toBe('mine\n');
    expect(exists(root, '.github/workflows/ai-workflows.yml')).toBe(false);
    expect(exists(root, '.github/workflows/ai-workflows-red-test.yml')).toBe(false);
    expect(readdirSync(join(root, '.github', 'workflows'))).toEqual(['ai-workflows-review-signal.yml']);
  });
});

describe('R6 §9.4 test 4: init --judge-only', () => {
  it('writes only the three workflows; package.json, the lock file and .claude/ stay byte for byte', async () => {
    const lock = lines("lockfileVersion: '9.0'", '', 'importers:', '  .:', '    devDependencies:', '      ai-workflows:', `        specifier: ${OLD_URL}`, `        version: ${OLD_URL}`);
    const oldPackage = `${JSON.stringify({ name: 'app', private: true, devDependencies: { 'ai-workflows': OLD_URL } }, null, 2)}\n`;
    const settings = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)}\n`;
    const root = repository({
      [RECIPE]: RECIPE_WITH_BRANCHES,
      'package.json': oldPackage,
      'pnpm-lock.yaml': lock,
      '.claude/settings.json': settings,
    });
    const before = filesUnder(root);
    const install = forbiddenInstall();

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    expect(install.calls).toEqual([]);
    expect(read(root, 'package.json')).toBe(oldPackage);
    expect(read(root, 'pnpm-lock.yaml')).toBe(lock);
    expect(read(root, '.claude/settings.json')).toBe(settings);
    expect(read(root, RECIPE)).toBe(RECIPE_WITH_BRANCHES);
    expect(filesUnder(root)).toEqual([...before, ...WORKFLOW_PATHS].sort());
    expect(hooksPathOf(root)).toBe('');
    expectWorkflowsFromTemplates(root);
    expect(branchesOf(judgeStep(root)['with']?.['branches'])).toEqual(['staging', 'main']);
  });

  it('without a recipe it writes nothing: the branches come from the recipe that exists', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON });
    const before = filesUnder(root);

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });

    expect(output.ok).toBe(false);
    expect(output.text).toContain(RECIPE);
    expect(filesUnder(root)).toEqual(before);
  });
});

describe('R6 §9.4 test 4b: a failed write leaves none of the three workflows', () => {
  it('the rename of one workflow fails: the ones already renamed are removed, no temporary file stays, and the file is named', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES });
    const renameFile = async (from: string, to: string) => {
      if (to.split('\\').join('/').endsWith('.github/workflows/ai-workflows-red-test.yml')) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      await rename(from, to);
    };

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run, renameFile });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('ai-workflows-red-test.yml');
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(false);
    const workflowsDir = join(root, '.github', 'workflows');
    const left = existsSync(workflowsDir) ? readdirSync(workflowsDir) : [];
    expect(left).toEqual([]);
    // No temporary file anywhere else either.
    expect(filesUnder(root)).toEqual([RECIPE]);
  });
});

describe('R6 §9.4 test 4c: init installs the engine of its own version', () => {
  const MANAGERS: readonly { lock?: string; manager: string }[] = [
    { lock: 'pnpm-lock.yaml', manager: 'pnpm' },
    { lock: 'package-lock.json', manager: 'npm' },
    { lock: 'yarn.lock', manager: 'yarn' },
    { manager: 'pnpm' },
  ];

  for (const { lock, manager } of MANAGERS) {
    it(`${lock ?? 'no lock file'}: adds the dependency with the sealed version's address, runs ${manager} and installs the hooks`, async () => {
      const files: Record<string, string> = { 'package.json': PACKAGE_JSON };
      if (lock !== undefined) files[lock] = lock.endsWith('.json') ? '{}\n' : '\n';
      const root = repository(files);
      const install = fakeInstall();

      const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

      expect(output.ok, output.text).toBe(true);
      const pkg = JSON.parse(read(root, 'package.json')) as Record<string, any>;
      expect(pkg['devDependencies']?.['ai-workflows']).toBe(RELEASE_URL);
      // What was there stays.
      expect(pkg['name']).toBe('app');
      expect(pkg['scripts']).toEqual({ test: 'vitest run' });
      expect(pkg['dependencies']).toEqual({ react: '^19.0.0' });
      expect(install.calls).toHaveLength(1);
      expect(install.calls[0]?.manager).toBe(manager);
      expect(resolve(install.calls[0]?.cwd ?? '')).toBe(resolve(root));
      expect(exists(root, '.claude/settings.json')).toBe(true);
      expect(hooksPathOf(root)).not.toBe('');
    });
  }

  it('a project without package.json gets one with the dependency (the rehearsal of the one command)', async () => {
    const root = repository({ 'README.md': '# app\n' });
    const install = fakeInstall();

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    const pkg = JSON.parse(read(root, 'package.json')) as Record<string, any>;
    expect(pkg['devDependencies']?.['ai-workflows']).toBe(RELEASE_URL);
    expect(install.calls.map((call) => call.manager)).toEqual(['pnpm']);
  });

  it('the hooks it installs are exactly what hooks install --apply writes', async () => {
    const start = { [RECIPE]: RECIPE_WITH_BRANCHES, 'package.json': PACKAGE_JSON };
    const root = repository(start);
    const twin = repository(start);

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });
    expect(output.ok, output.text).toBe(true);

    const before = new Set(filesUnder(twin));
    const installed = await installHooks({ root: twin, apply: true });
    expect(installed.ok, installed.text).toBe(true);
    const hookFiles = filesUnder(twin).filter((file) => !before.has(file));
    expect(hookFiles.length).toBeGreaterThan(0);
    for (const file of hookFiles) {
      expect(exists(root, file), file).toBe(true);
      expect(read(root, file), file).toBe(read(twin, file));
    }
    expect(hooksPathOf(root)).toBe(hooksPathOf(twin));
  });

  it('with the dependency already on another version: it is not changed, no hooks, and it says so', async () => {
    const oldPackage = `${JSON.stringify({ name: 'app', private: true, devDependencies: { 'ai-workflows': OLD_URL } }, null, 2)}\n`;
    const root = repository({ 'package.json': oldPackage, 'pnpm-lock.yaml': '\n' });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(read(root, 'package.json')).toBe(oldPackage);
    expect(output.text).toContain('0.3.0');
    expectNoHooks(root);
  });

  it('with a failed install: it stops with the reason, and writes neither hooks nor workflows', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
    const calls: InstallRequest[] = [];
    const runPackageInstall = async (request: InstallRequest) => {
      calls.push(request);
      return { ok: false as const, reason: 'ERR_PNPM_FETCH_404 no network' };
    };

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('ERR_PNPM_FETCH_404 no network');
    expect(calls).toHaveLength(1);
    expectNoHooks(root);
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(false);
  });
});

describe('R6 §9.4 test 4d: init --package <path> checks the seal of that package', () => {
  const packageFiles = (seal: unknown) => [
    { path: 'package/package.json', content: Buffer.from(`${JSON.stringify({ name: 'ai-workflows', version: VERSION })}\n`) },
    ...(seal === undefined ? [] : [{ path: 'package/engine.json', content: Buffer.from(`${JSON.stringify(seal)}\n`) }]),
  ];
  const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

  it('a package of another seal, without a seal, or missing: stops without touching anything', async () => {
    const cases: readonly { label: string; seal?: unknown; missing?: true }[] = [
      { label: 'other sha', seal: { version: VERSION, sha: OTHER_SHA } },
      { label: 'other version', seal: { version: '1.2.4', sha: SHA } },
      { label: 'no engine.json', seal: undefined },
      { label: 'missing package', missing: true },
    ];
    for (const { label, seal, missing } of cases) {
      const root = repository({ 'package.json': PACKAGE_JSON });
      if (missing !== true) writeFileSync(join(root, 'vendor.tgz'), writeTgz(packageFiles(seal)));
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '--allow-empty', '-m', 'vendor');
      const before = filesUnder(root);
      const install = forbiddenInstall();

      const output = await recipeCommand(['init', '--package', 'vendor.tgz'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

      expect(output.ok, label).toBe(false);
      // It stops because of the package, named, and not because it did not understand the command.
      expect(output.text, label).not.toContain('Usage:');
      expect(output.text, label).toContain('vendor.tgz');
      expect(install.calls, label).toEqual([]);
      expect(filesUnder(root), label).toEqual(before);
      expect(read(root, 'package.json'), label).toBe(PACKAGE_JSON);
      expect(hooksPathOf(root), label).toBe('');
    }
  });

  it('a .tgz of the same seal: the dependency points to that path', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON });
    write(root, 'vendor/.keep', '');
    writeFileSync(join(root, 'vendor', 'ai-workflows-1.2.3.tgz'), writeTgz(packageFiles(SEAL)));
    const install = fakeInstall();

    const output = await recipeCommand(['init', '--package', 'vendor/ai-workflows-1.2.3.tgz'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    const pkg = JSON.parse(read(root, 'package.json')) as Record<string, any>;
    expect(pkg['devDependencies']?.['ai-workflows']).toBe('file:vendor/ai-workflows-1.2.3.tgz');
    expect(install.calls).toHaveLength(1);
    expectWorkflowsFromTemplates(root);
  });

  it('a package folder of the same seal: the dependency points to that folder', async () => {
    const root = repository({
      'package.json': PACKAGE_JSON,
      'vendor/ai-workflows/package.json': `${JSON.stringify({ name: 'ai-workflows', version: VERSION })}\n`,
      'vendor/ai-workflows/engine.json': `${JSON.stringify(SEAL)}\n`,
    });
    const install = fakeInstall();

    const output = await recipeCommand(['init', '--package', 'vendor/ai-workflows'], { cwd: root, seal: SEAL, runPackageInstall: install.run });

    expect(output.ok, output.text).toBe(true);
    const pkg = JSON.parse(read(root, 'package.json')) as Record<string, any>;
    expect(pkg['devDependencies']?.['ai-workflows']).toBe('file:vendor/ai-workflows');
    expect(install.calls).toHaveLength(1);
  });
});

describe('R6 §9.4 test 5: the written judge passes the checks of tests/judge-templates.test.ts', () => {
  it('events, permissions, name, pinned action, switch, protected files, no secret, no expression in a shell', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES });
    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });
    expect(output.ok, output.text).toBe(true);

    const text = read(root, '.github/workflows/ai-workflows.yml');
    const judge = parse(text) as Record<string, any>;
    const red = parse(read(root, '.github/workflows/ai-workflows-red-test.yml')) as Record<string, any>;
    const on = judge['on'] as Record<string, any>;
    for (const event of ['issue_comment', 'merge_group', 'pull_request_target', 'workflow_dispatch', 'workflow_run']) {
      expect(Object.keys(on), event).toContain(event);
    }
    expect(Object.keys(on)).not.toContain('pull_request');
    expect(on['workflow_dispatch']?.inputs?.pr).toBeDefined();
    expect(on['workflow_run']?.workflows).toContain(red['name']);

    const jobs = Object.values(judge['jobs'] as Record<string, Record<string, any>>);
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as Record<string, any>;
    expect(job['permissions']).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'read',
      checks: 'read',
      actions: 'read',
      statuses: 'write',
    });
    expect(['ai-workflows', 'ai-workflows/advisory']).not.toContain(job['name']);
    expect(Object.keys(judge['jobs'])).not.toContain('ai-workflows');
    expect(String(job['if'])).toContain('github.event.issue.pull_request');

    const step = judgeStep(root);
    expect(step['uses']).toBe(`luismichelcf/ai-workflows@${SHA}`);
    expect(step['with']?.['task']).toBe('judge');
    expect(String(step['with']?.['mode'])).toMatch(/\$\{\{\s*vars\.AI_WORKFLOWS_MODE\s*\}\}/);
    expect(String(step['with']?.['also-protect'])).toContain('.github/workflows/ai-workflows-red-test.yml');

    expect(text).not.toMatch(/secrets\./);
    for (const candidate of job['steps'] as Record<string, any>[]) {
      if (typeof candidate['run'] === 'string') expect(candidate['run']).not.toContain('${{');
    }
    const all = [...text.matchAll(ENGINE_USES)].map((match) => match[0]);
    expect(all.length).toBeGreaterThan(0);
    for (const uses of all) expect(uses).toBe(`luismichelcf/ai-workflows@${SHA}`);
  });
});

// PLAN-13-R6 §15 (fixes after the flock). INTERFACE added here (the builder implements it):
//
//   - init refuses to run from a subfolder of a git repository (cwd is not the top level): it
//     writes nothing, installs nothing, and says why, naming the root (`raíz` / `root`). A folder
//     that is not a repository keeps today's behaviour.
//   - init speaks the `locale` of `.ai-workflows/pipeline.yml` as it stands after step 2 (the example
//     recipe, `locale: es`, when init wrote it): `es…` -> Spanish; anything else, missing or
//     unreadable -> English. The per-file lines are
//       es: `Creado <path>`  and  `<path> ya existía; init no lo sobrescribe.`
//       en: `Created <path>` and  `<path> already exists; init does not overwrite it.`
//     and none of the English lines appears in a Spanish run.
//   - The closing text carries the exact commands `gh variable set AI_WORKFLOWS_MODE --body advisory`
//     and `gh variable set AI_WORKFLOWS_MODE --body off`, and the line
//       es: `Guarda estos archivos con un commit en una rama de pieza, no en la rama principal.`
//       en: `Commit these files on a piece branch, not on the main branch.`
//   - When the three workflows already exist, a full init reports each one as already there and
//     still installs the hooks (the all-or-nothing rule is about writing the three, not the hooks).
//   - New optional seams in the options of recipeCommand:
//       spawnProcess?: (command: string, args: readonly string[], options: { cwd: string;
//         shell?: boolean | string; windowsHide?: boolean; stdio?: unknown }) => ChildProcess-like
//         How the default installer (used when runPackageInstall is omitted) starts the package
//         manager. It must request no shell and start no shell program (cmd, powershell, sh…).
//       templatesDir?: string
//         The folder the four templates are read from (default: the package's templates/).
//       removeFile?: (path: string) => Promise<void>
//         Every removal of a rollback (renamed workflows and the temporary file) goes through it.
//   - The judge template's anchor for the `branches` input is the engine step's line
//     `          token: ${{ github.token }}`. If the recipe declares branches and the template has no
//     anchor, init fails naming `branches` and the template, and writes none of the three.
//   - The `branches` value is written as a quoted YAML scalar, so any git-valid name survives.
//   - A rollback whose removal fails names the file that remains and never claims that none of
//     the three was written.

const ES_COMMIT = 'Guarda estos archivos con un commit en una rama de pieza, no en la rama principal.';
const EN_COMMIT = 'Commit these files on a piece branch, not on the main branch.';
const MODE_ADVISORY = 'gh variable set AI_WORKFLOWS_MODE --body advisory';
const MODE_OFF = 'gh variable set AI_WORKFLOWS_MODE --body off';
const ENGLISH_LINES = ['Created ', 'already exists; init does not overwrite it.', 'Next, by hand', 'Added ai-workflows'];

const RECIPE_EN = RECIPE_WITH_BRANCHES.replace('locale: es', 'locale: en');
const RECIPE_WITHOUT_BRANCHES = RECIPE_WITH_BRANCHES.replace(
  lines('branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }'),
  '',
);
const SEALED_PACKAGE = `${JSON.stringify({ name: 'app', private: true, devDependencies: { 'ai-workflows': RELEASE_URL } }, null, 2)}\n`;
const norm = (path: string) => path.split('\\').join('/');

describe('R6 §15: init runs only from the root of the repository', () => {
  for (const argv of [['init'], ['init', '--judge-only']]) {
    it(`${argv.join(' ')} from a subfolder refuses with the reason and writes nothing`, async () => {
      const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES, 'package.json': PACKAGE_JSON, 'packages/app/README.md': '# app\n' });
      const sub = join(root, 'packages', 'app');
      const before = filesUnder(root);
      const install = forbiddenInstall();

      const output = await recipeCommand(argv, { cwd: sub, seal: SEAL, runPackageInstall: install.run });

      expect(output.ok).toBe(false);
      expect(output.text).not.toContain('Usage:');
      expect(output.text).toMatch(/ra[ií]z|root/i);
      expect(install.calls).toEqual([]);
      expect(filesUnder(root)).toEqual(before);
      expect(hooksPathOf(root)).toBe('');
    });
  }
});

describe('R6 §15: init speaks the language of the recipe', () => {
  it('a new project gets the example recipe (locale: es), and the whole report is Spanish', async () => {
    const root = repository({ 'README.md': '# app\n' });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(output.ok, output.text).toBe(true);
    for (const path of [RECIPE, ...WORKFLOW_PATHS]) expect(output.text).toContain(`Creado ${path}`);
    for (const english of ENGLISH_LINES) expect(output.text).not.toContain(english);
  });

  it('a Spanish recipe that exists: "ya existía" for it and "Creado" for the workflows', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES, 'package.json': PACKAGE_JSON });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(output.text).toContain(`${RECIPE} ya existía; init no lo sobrescribe.`);
    for (const path of WORKFLOW_PATHS) expect(output.text).toContain(`Creado ${path}`);
    for (const english of ENGLISH_LINES) expect(output.text).not.toContain(english);
  });

  it('an English recipe keeps the English lines', async () => {
    const root = repository({ [RECIPE]: RECIPE_EN, 'package.json': PACKAGE_JSON });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(output.text).toContain(`${RECIPE} already exists; init does not overwrite it.`);
    for (const path of WORKFLOW_PATHS) expect(output.text).toContain(`Created ${path}`);
    expect(output.text).not.toContain('Creado ');
    expect(output.text).not.toContain('ya existía');
  });
});

describe('R6 §15: the closing text gives the exact commands and where to commit', () => {
  it('Spanish (the example recipe): both switch commands and the piece-branch line', async () => {
    const root = repository({ 'README.md': '# app\n' });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(output.text).toContain(MODE_ADVISORY);
    expect(output.text).toContain(MODE_OFF);
    expect(output.text).toContain(ES_COMMIT);
  });

  it('English recipe: both switch commands and the piece-branch line', async () => {
    const root = repository({ [RECIPE]: RECIPE_EN, 'package.json': PACKAGE_JSON });

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(output.text).toContain(MODE_ADVISORY);
    expect(output.text).toContain(MODE_OFF);
    expect(output.text).toContain(EN_COMMIT);
  });

  it('init --judge-only says the same', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES });

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(output.text).toContain(MODE_ADVISORY);
    expect(output.text).toContain(MODE_OFF);
    expect(output.text).toContain(ES_COMMIT);
  });
});

describe('R6 §15: re-running init where the three workflows already exist', () => {
  it('reports them as already there, leaves them, and installs the hooks', async () => {
    const files: Record<string, string> = { [RECIPE]: RECIPE_WITH_BRANCHES, 'package.json': SEALED_PACKAGE, 'pnpm-lock.yaml': '\n' };
    for (const path of WORKFLOW_PATHS) files[path] = 'mine\n';
    const root = repository(files);

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall: fakeInstall().run });

    for (const path of WORKFLOW_PATHS) {
      expect(output.text).toContain(`${path} ya existía; init no lo sobrescribe.`);
      expect(read(root, path), path).toBe('mine\n');
    }
    expect(output.ok, output.text).toBe(true);
    expect(exists(root, '.claude/settings.json')).toBe(true);
    expect(hooksPathOf(root)).not.toBe('');
  });
});

describe('R6 §15: the package manager is started without a shell', () => {
  it('the default installer asks for no shell and starts no shell program', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
    const spawned: { command: string; args: string[]; options: Record<string, any> }[] = [];
    const spawnProcess = (command: string, args: readonly string[], options: Record<string, any>) => {
      spawned.push({ command, args: [...args], options });
      write(root, 'node_modules/ai-workflows/package.json', `${JSON.stringify({ name: 'ai-workflows', version: VERSION })}\n`);
      write(root, 'node_modules/ai-workflows/engine.json', `${JSON.stringify(SEAL)}\n`);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: null, pid: 4242, kill: () => true });
      setImmediate(() => {
        stdout.end();
        stderr.end();
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    };

    const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });

    expect(spawned, 'the installer goes through the spawnProcess seam').toHaveLength(1);
    const [call] = spawned;
    expect(call?.options['shell'] ?? false, 'shell option').toBe(false);
    const program = basename(norm(call?.command ?? '')).toLowerCase();
    expect(program).not.toMatch(/^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/);
    expect(program, 'a .cmd or .bat needs a shell on Windows').not.toMatch(/\.(cmd|bat)$/);
    expect([call?.command ?? '', ...(call?.args ?? [])].join(' ')).toMatch(/pnpm/i);
    expect(call?.args).toContain('install');
    expect(resolve(String(call?.options['cwd'] ?? ''))).toBe(resolve(root));
    expect(output.ok, output.text).toBe(true);
    expect(exists(root, '.claude/settings.json')).toBe(true);
  });
});

describe('R6 §15: the branches input of the judge workflow', () => {
  /** The four templates in a folder of their own, the judge's without the branches anchor. */
  function templatesWithoutAnchor(): string {
    const dir = emptyFolder();
    cpSync(new URL('../templates', import.meta.url), dir, { recursive: true });
    const judge = join(dir, 'ai-workflows.yml');
    const text = readFileSync(judge, 'utf8');
    const anchor = '          token: ${{ github.token }}\n';
    expect(text).toContain(anchor);
    writeFileSync(judge, text.replace(anchor, ''));
    return dir;
  }

  it('a template without the anchor and a recipe that declares branches: init fails naming the reason and writes none', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES });

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run, templatesDir: templatesWithoutAnchor() });

    expect(output.ok, output.text).toBe(false);
    expect(output.text).toContain('branches');
    expect(output.text).toContain('ai-workflows.yml');
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(false);
  });

  it('the same template with a recipe without branches is fine: there is nothing to write there', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITHOUT_BRANCHES });
    expect(RECIPE_WITHOUT_BRANCHES).not.toContain('branches:');

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run, templatesDir: templatesWithoutAnchor() });

    expect(output.ok, output.text).toBe(true);
    for (const path of WORKFLOW_PATHS) expect(exists(root, path), path).toBe(true);
  });

  it('the value is written quoted', async () => {
    const root = repository({ [RECIPE]: RECIPE_WITH_BRANCHES });

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(read(root, '.github/workflows/ai-workflows.yml')).toMatch(/^ {10}branches: (["'])staging, main\1[ \t]*$/m);
  });

  it('git-valid names that YAML would misread plain survive: a leading # and a double quote', async () => {
    const recipe = RECIPE_WITH_BRANCHES
      .replace('  into: [staging, main]', `  into: ["#hotfix", 'say"hi', main]`)
      .replace('    - { from: staging, to: main }', '    - { from: "#hotfix", to: main }');
    const root = repository({ [RECIPE]: recipe });

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run });

    expect(output.ok, output.text).toBe(true);
    expect(judgeStep(root)['with']?.['branches']).toBe('#hotfix, say"hi, main');
  });
});

describe('R6 §15: a rollback that cannot remove a file says which one remains', () => {
  it('the second rename fails and removing the first fails too: the message names the file left behind', async () => {
    const root = repository({ [RECIPE]: RECIPE_EN });
    const renameFile = async (from: string, to: string) => {
      if (norm(to).endsWith('.github/workflows/ai-workflows-red-test.yml')) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      await rename(from, to);
    };
    const removeFile = async (path: string) => {
      if (norm(path).endsWith('.github/workflows/ai-workflows.yml')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
      }
      await rm(path, { force: true });
    };

    const output = await recipeCommand(['init', '--judge-only'], { cwd: root, seal: SEAL, runPackageInstall: forbiddenInstall().run, renameFile, removeFile });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('.github/workflows/ai-workflows.yml');
    expect(output.text).toContain('ai-workflows-red-test.yml');
    expect(output.text).not.toContain('None of the three workflows was written');
    expect(exists(root, '.github/workflows/ai-workflows.yml'), 'the file the rollback could not remove').toBe(true);
  });
});

describe('R6 §15 (§9.2 step 3): hooks only when node_modules/ai-workflows carries this seal', () => {
  const cases: readonly { label: string; landed?: unknown }[] = [
    { label: 'the install writes no engine.json' },
    { label: 'the engine.json has another sha', landed: { version: VERSION, sha: 'ffffffffffffffffffffffffffffffffffffffff' } },
  ];
  for (const { label, landed } of cases) {
    it(`${label}: no hooks, and it says so`, async () => {
      const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
      const runPackageInstall = async (request: InstallRequest) => {
        mkdirSync(join(request.cwd, 'node_modules', 'ai-workflows'), { recursive: true });
        if (landed !== undefined) write(request.cwd, 'node_modules/ai-workflows/engine.json', `${JSON.stringify(landed)}\n`);
        return { ok: true as const };
      };

      const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, runPackageInstall });

      expectNoHooks(root);
      expect(output.text).toContain('node_modules/ai-workflows');
    });
  }
});
