import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ENGINE_PROTECTED_PATHS,
  installHooks,
  runJudge,
  type JudgeGitHub,
  type JudgeInput,
  type PullRequestComment,
} from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R6 §2: the judge's own files — the fixed list of the engine and the engine version,
// field by field. Git is real (a temporary repository is the checkout of the trusted main and
// already holds every pull request's objects); GitHub is the external edge, a fake port.
//
// Interface these tests define for the builder:
// - `ENGINE_PROTECTED_PATHS: readonly string[]`, exported from `src/index.ts`: the single list
//   shared by the judge and `hooks install`. Entries are repository-relative, forward slashes, in
//   lower case; an entry ending in `/` covers every path under that folder, any other entry is one
//   exact path. A path is compared in lower case (§2.1, "sin distinguir mayúsculas"). It holds at
//   least the literal paths of §2.1, `.ai-workflows/` and the folder `.opencode/plugins/`.
// - `runJudge` (unchanged signature): a pull request that touches a protected path, or the engine
//   version of §2.2 (compared against the merge base, fail-closed, 50 MB cap), is rejected
//   (`failure`) unless the owner attests the head with `/approve-judge-change <16 chars>`. The
//   `judgePath` and `alsoProtect` comparisons are case-insensitive too. The published description
//   keeps today's text; what was touched goes to the run log (`report.summary`), naming the file.
//
// Commits are built with git plumbing on a temporary index, so a path is committed exactly as
// written (`.Claude/settings.json` next to `.claude/settings.json`) whatever the file system does.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const REPO = 'duena/proyecto';
const RUN = 111;
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
const WORKFLOW = '.github/workflows/ai-workflows.yml';
const OWNER = 'duena';
const BRANCH = 'feat/13-algo';

const RECIPE = lines(
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'stages:',
  '  - id: checks',
  '    summary: "Todas las pruebas en verde"',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/command@1',
  '      with: { command: "node ran.mjs" }',
  '    server: { require-check: todo-verde }',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: checks',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

// ---------------------------------------------------------------------------------------------
// The fake GitHub port: only what a pull_request_target run reads, and what it publishes.

interface Published { sha: string; context: string; state: string; description: string; targetUrl: string }
interface Status { context: string; state: string; targetUrl: string | null; createdAt: string }
interface PullRequest { number: number; state: string; headSha: string; headRef: string; baseRef: string; headRepo: string }

class FakeGitHub implements JudgeGitHub {
  readonly published: Published[] = [];
  readonly prs = new Map<number, PullRequest>();
  readonly commentList = new Map<number, PullRequestComment[]>();
  readonly green = new Set<string>();
  private readonly statusList = new Map<string, Status[]>();
  private clock = 0;

  constructor(private readonly root: string) {}

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 8, 29, 12, 0, this.clock)).toISOString();
  }

  addStatus(sha: string, status: Omit<Status, 'createdAt'>): void {
    const list = this.statusList.get(sha) ?? [];
    list.unshift({ ...status, createdAt: this.stamp() });
    this.statusList.set(sha, list);
  }

  async defaultBranch() { return 'main'; }
  async branchHead(branch: string) { return git(this.root, 'rev-parse', `refs/heads/${branch}`); }
  async pullRequest(n: number) {
    const pr = this.prs.get(n);
    if (pr === undefined) throw new Error(`no PR ${n}`);
    return { ...pr };
  }
  async openPullRequestsWithHead(sha: string) {
    return [...this.prs.values()].filter((pr) => pr.headSha === sha).map((pr) => pr.number);
  }
  async openPullRequests() {
    return [...this.prs.values()].map(({ number, headRef, headSha, baseRef }) => ({ number, headRef, headSha, baseRef }));
  }
  async mergeQueue() { return []; }
  async comments(n: number) { return this.commentList.get(n) ?? []; }
  async issueComments() { return []; }
  async reviews() { return []; }
  async checkRuns(sha: string, name: string) {
    return name === 'todo-verde' && this.green.has(sha)
      ? [{ id: 1, status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]
      : [];
  }
  async statuses(sha: string) { return [...(this.statusList.get(sha) ?? [])]; }
  async workflowRun(id: number) { return id === RUN ? { path: WORKFLOW, event: 'pull_request_target' } : undefined; }
  async forcePushedHeads() { return []; }
  async publishStatus(sha: string, status: { context: string; state: string; description: string; targetUrl: string }) {
    this.published.push({ sha, ...status });
    this.addStatus(sha, { context: status.context, state: status.state, targetUrl: status.targetUrl });
  }
  async upsertTraceComment() {}

  on(context = 'ai-workflows'): Published[] {
    return this.published.filter((entry) => entry.context === context);
  }
}

const byOwner = (body: string): PullRequestComment => ({
  body,
  author: OWNER,
  authorType: 'User',
  performedViaApp: false,
  edited: false,
});

// ---------------------------------------------------------------------------------------------
// A world: the trusted main, and pull requests committed on it with plumbing.

/** `null` deletes the path. */
type Changes = Readonly<Record<string, string | null>>;

/** A commit on `parent` with `changes` applied, built on a temporary index: the checkout is untouched. */
function commitOn(root: string, parent: string, changes: Changes, message: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'aiw-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(folder, 'index') };
    const plumbing = (args: string[], input?: string): string =>
      execFileSync('git', ['-c', 'core.ignorecase=false', ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        ...(input === undefined ? {} : { input }),
      }).trim();
    plumbing(['read-tree', parent]);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        plumbing(['update-index', '--force-remove', '--', path]);
        continue;
      }
      const blob = plumbing(['hash-object', '-w', '--stdin'], content);
      plumbing(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
    const tree = plumbing(['write-tree']);
    return plumbing(['commit-tree', tree, '-p', parent, '-m', message]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

interface World {
  readonly root: string;
  readonly github: FakeGitHub;
  /** A pull request `n` from the current main with `changes`, green on every stage. Returns its head. */
  pr(changes: Changes, n?: number): string;
  /** Moves main forward with a real commit in the checkout. */
  advanceMain(files: Readonly<Record<string, string>>): string;
  attest(n: number, head: string): void;
  judge(overrides?: Partial<JudgeInput>): ReturnType<typeof runJudge>;
}

function world(mainFiles: Readonly<Record<string, string>> = {}): World {
  const root = repository({
    '.ai-workflows/pipeline.yml': RECIPE,
    'ran.mjs': 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", "ran");\n',
    'README.md': 'proyecto\n',
    ...mainFiles,
  });
  git(root, 'switch', '-q', 'main');
  const github = new FakeGitHub(root);
  let current: { n: number; head: string } | undefined;

  const self: World = {
    root,
    github,
    pr(changes, n = 7) {
      const head = commitOn(root, git(root, 'rev-parse', 'main'), changes, `PR ${n}`);
      github.prs.set(n, { number: n, state: 'open', headSha: head, headRef: BRANCH, baseRef: 'main', headRepo: REPO });
      github.green.add(head);
      current = { n, head };
      return head;
    },
    advanceMain(files) {
      for (const [path, content] of Object.entries(files)) write(root, path, content);
      return commit(root, 'main moves');
    },
    attest(n, head) {
      github.commentList.set(n, [byOwner(`/approve-judge-change ${head.slice(0, 16)}`)]);
    },
    judge(overrides = {}) {
      const target = current;
      if (target === undefined) throw new Error('no pull request yet');
      github.addStatus(target.head, { context: 'ai-workflows', state: 'pending', targetUrl: RUN_URL });
      const input: JudgeInput = {
        eventName: 'pull_request_target',
        event: {
          pull_request: {
            number: target.n,
            head: { sha: target.head, ref: BRANCH, repo: { full_name: REPO } },
            base: { sha: git(root, 'rev-parse', 'main'), ref: 'main' },
          },
          repository: { full_name: REPO, default_branch: 'main' },
        },
        mode: 'on',
        context: 'ai-workflows',
        repository: REPO,
        workflowRef: `${REPO}/${WORKFLOW}@refs/heads/main`,
        actionRef: 'a'.repeat(40),
        runId: RUN,
        serverUrl: 'https://github.com',
        // Nothing from the input: every path below is protected by the engine itself (§2.1).
        alsoProtect: [],
        root,
        ...overrides,
      };
      return runJudge(input, { github, sleep: async () => {}, fetchObjects: async () => {} });
    },
  };
  return self;
}

const states = (w: World): string[] => w.github.on().map((entry) => entry.state);

/** The motive published today for the judge's own files, with the sixteen characters of the head. */
function expectRejectedForOwnFiles(w: World, head: string, report: Awaited<ReturnType<typeof runJudge>>): void {
  expect(w.github.on()).toEqual([
    expect.objectContaining({ sha: head, state: 'failure', description: expect.stringContaining(`/approve-judge-change ${head.slice(0, 16)}`) }),
  ]);
  expect(report.pieces[0]?.verdict).toBe('rejected');
}

// ---------------------------------------------------------------------------------------------
// The harness itself: a change to nothing of the judge's passes (positive control).

describe('R6 §2 harness', () => {
  it('positive control: a pull request that touches only docs passes with success', async () => {
    const w = world();
    const head = w.pr({ 'docs/x.md': 'hola\n' });
    const report = await w.judge();
    expect(w.github.on()).toEqual([expect.objectContaining({ sha: head, state: 'success' })]);
    expect(report.pieces[0]?.verdict).toBe('passed');
  });
});

// ---------------------------------------------------------------------------------------------
// §2.4 test 1: each new path of §2.1, without and with the owner's attestation.

const NEW_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
  '.opencode/plugins/ai-workflows.js',
  '.opencode/plugins/otro.js',
  '.pnpmfile.cjs',
  '.github/workflows/ai-workflows-red-test.yml',
  '.github/workflows/ai-workflows-review-signal.yml',
];

describe('R6 §2.4 (1): every engine-protected path needs the owner attestation', () => {
  for (const path of NEW_PATHS) {
    it(`touching ${path} without attestation → failure with the order and 16 characters of the head`, async () => {
      const w = world();
      const head = w.pr({ 'docs/x.md': 'hola\n', [path]: 'cambiado\n' });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain(`/approve-judge-change ${head.slice(0, 16)}`);
      // §2.3: what was touched goes to the run log, not to the published status.
      expect(report.summary).toContain(path);
    });

    it(`touching ${path} with the owner's attestation for this head → success`, async () => {
      const w = world();
      const head = w.pr({ 'docs/x.md': 'hola\n', [path]: 'cambiado\n' });
      w.attest(7, head);
      await w.judge();
      expect(states(w)).toEqual(['success']);
    });
  }
});

describe('R6 §2.4 (2): deleting a protected file', () => {
  it('deleting .claude/settings.json → failure', async () => {
    const w = world({ '.claude/settings.json': '{ "hooks": {} }\n' });
    const head = w.pr({ '.claude/settings.json': null });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('R6 §2.4 (3): matching is case-insensitive', () => {
  for (const path of ['.Claude/settings.json', '.AI-Workflows/pipeline.yml', '.GitHub/Workflows/AI-Workflows.yml']) {
    it(`${path} → failure`, async () => {
      const w = world();
      const head = w.pr({ [path]: 'cambiado\n' });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
    });
  }

  it('an also-protect entry matches a path in another case → failure', async () => {
    const w = world();
    const head = w.pr({ 'Infra/Deploy.yml': 'cambiado\n' });
    const report = await w.judge({ alsoProtect: ['infra/deploy.yml'] });
    expectRejectedForOwnFiles(w, head, report);
  });
});

// ---------------------------------------------------------------------------------------------
// §2.2: the engine version, field by field.

const ENGINE = 'github:luismichelcf/ai-workflows#v0.3.0';
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const BASE_PACKAGE = {
  name: 'proyecto',
  version: '1.0.0',
  private: true,
  scripts: { test: 'vitest run' },
  dependencies: { react: '18.2.0' },
  devDependencies: { 'ai-workflows': ENGINE, vitest: '2.0.0' },
};
type Pkg = Record<string, unknown>;
const pkg = (change: (p: Pkg) => void): string => {
  const copy = structuredClone(BASE_PACKAGE) as Pkg;
  change(copy);
  return json(copy);
};
const field = (p: Pkg, key: string): Record<string, unknown> => {
  const existing = p[key];
  if (existing !== undefined) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  p[key] = created;
  return created;
};

describe('R6 §2.4 (4): package.json changes that decide the engine → failure', () => {
  const cases: [string, string][] = [
    ['the engine version changes', pkg((p) => { field(p, 'devDependencies')['ai-workflows'] = 'github:luismichelcf/ai-workflows#v0.4.0'; })],
    ['the engine moves from devDependencies to dependencies', pkg((p) => {
      delete field(p, 'devDependencies')['ai-workflows'];
      field(p, 'dependencies')['ai-workflows'] = ENGINE;
    })],
    ['a new optionalDependencies entry for the engine', pkg((p) => { field(p, 'optionalDependencies')['ai-workflows'] = ENGINE; })],
    ['a new peerDependencies entry for the engine', pkg((p) => { field(p, 'peerDependencies')['ai-workflows'] = ENGINE; })],
    ['a new pnpm.overrides entry for the engine', pkg((p) => { p.pnpm = { overrides: { 'ai-workflows': 'github:otra/cosa#v9' } }; })],
    ['a new overrides entry that reaches the engine through a parent', pkg((p) => { p.overrides = { 'algo>ai-workflows': '9.9.9' }; })],
    ['a new resolutions entry for a pinned engine', pkg((p) => { p.resolutions = { 'ai-workflows@0.3.0': '9.9.9' }; })],
    ['a new pnpm.patchedDependencies entry for the engine', pkg((p) => { p.pnpm = { patchedDependencies: { 'ai-workflows@0.3.0': 'patches/ai-workflows.patch' } }; })],
  ];
  for (const [what, text] of cases) {
    it(`${what} → failure`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      const head = w.pr({ 'package.json': text });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });
  }

  it('moving from dependencies to devDependencies (the design literal) → failure', async () => {
    const inDependencies = pkg((p) => {
      delete field(p, 'devDependencies')['ai-workflows'];
      field(p, 'dependencies')['ai-workflows'] = ENGINE;
    });
    const w = world({ 'package.json': inDependencies });
    const head = w.pr({ 'package.json': json(BASE_PACKAGE) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('R6 §2.4 (5): package.json changes that do not decide the engine → success', () => {
  const reordered = `${JSON.stringify({
    devDependencies: { vitest: '2.0.0', 'ai-workflows': ENGINE },
    dependencies: { react: '18.2.0' },
    scripts: { test: 'vitest run' },
    private: true,
    version: '1.0.0',
    name: 'proyecto',
  }, null, 4)}\n`;
  const cases: [string, string][] = [
    ['only dependencies.react', pkg((p) => { field(p, 'dependencies').react = '18.3.1'; })],
    ['only scripts.test', pkg((p) => { field(p, 'scripts').test = 'vitest run --coverage'; })],
    ['the same pin, reordered and reformatted', reordered],
    // Changed by the third delta review (PLAN-13-R6 §15, last paragraph): `overrides` is not in the
    // list of harmless changes, so any new override now needs the attestation (see «the allow-list
    // of harmless changes» below). The name that only starts like the engine is kept as a
    // dependency entry, which is harmless for any package other than the engine.
    ['a dependency of another package whose name only starts like the engine', pkg((p) => { field(p, 'dependencies')['ai-workflows-extra'] = '1.0.0'; })],
  ];
  for (const [what, text] of cases) {
    it(`${what} → success`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      w.pr({ 'package.json': text });
      await w.judge();
      expect(states(w)).toEqual(['success']);
    });
  }
});

// A pnpm lockfile (format 9) with the engine and one other package.
const LOCK = (engineIntegrity = 'sha512-AAAA', reactIntegrity = 'sha512-RRRR', engineVersion = '0.3.0'): string => lines(
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      react:',
  '        specifier: 18.2.0',
  '        version: 18.2.0',
  '    devDependencies:',
  '      ai-workflows:',
  `        specifier: ${ENGINE}`,
  `        version: ${engineVersion}`,
  '',
  'packages:',
  '',
  `  ai-workflows@${engineVersion}:`,
  `    resolution: {integrity: ${engineIntegrity}}`,
  '',
  '  react@18.2.0:',
  `    resolution: {integrity: ${reactIntegrity}}`,
  '',
  'snapshots:',
  '',
  `  ai-workflows@${engineVersion}: {}`,
  '',
  '  react@18.2.0: {}',
);

describe('R6 §2.4 (6): pnpm-lock.yaml', () => {
  it('only the engine integrity changes → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': LOCK('sha512-BBBB') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-lock.yaml');
  });

  it('the engine version of the importer changes → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': LOCK('sha512-AAAA', 'sha512-RRRR', '0.4.0') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a new lockfile override naming the engine → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const withOverride = LOCK().replace('importers:', lines('overrides:', '  ai-workflows: 9.9.9', '', 'importers:').trimEnd());
    const head = w.pr({ 'pnpm-lock.yaml': withOverride });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('only the integrity of another package changes → success', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    w.pr({ 'pnpm-lock.yaml': LOCK('sha512-AAAA', 'sha512-SSSS') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('R6 §2.4 (7): pnpm-workspace.yaml', () => {
  const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', `  ai-workflows: "${ENGINE}"`, '  react: 18.2.0');

  it('a new override of the engine → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'overrides:', '  ai-workflows: 9.9.9')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  it('the catalog entry of the engine changes → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': WORKSPACE.replace('#v0.3.0', '#v0.4.0') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a new named catalog with the engine → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'catalogs:', '  viejo:', '    ai-workflows: 0.1.0')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a new patchedDependencies entry for the engine → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'patchedDependencies:', '  ai-workflows@0.3.0: patches/x.patch')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  // Changed after the second delta review (R32, PLAN-13-R6 §15): another folder in `packages`
  // enlists its package.json, whose install scripts then run on install without that file
  // changing, so it now needs the attestation (covered by the M-d test below). The guard that an
  // ordinary workspace change passes is the catalog version of another package.
  it('the catalog version of another package changes → success', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    w.pr({ 'pnpm-workspace.yaml': WORKSPACE.replace('  react: 18.2.0', '  react: 18.3.0') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('R6 §2.2: package-lock.json and yarn.lock', () => {
  const NPM_LOCK = (engine = 'sha512-AAAA', react = 'sha512-RRRR'): string => json({
    name: 'proyecto',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'proyecto', version: '1.0.0', dependencies: { react: '18.2.0' }, devDependencies: { 'ai-workflows': ENGINE } },
      'node_modules/ai-workflows': { version: '0.3.0', resolved: 'git+ssh://git@github.com/luismichelcf/ai-workflows.git#abc', integrity: engine, dev: true },
      'node_modules/react': { version: '18.2.0', resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz', integrity: react },
    },
  });
  const YARN_LOCK = (engine = 'abc', react = 'sha512-RRRR'): string => lines(
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    '# yarn lockfile v1',
    '',
    '',
    `"ai-workflows@${ENGINE}":`,
    '  version "0.3.0"',
    `  resolved "https://codeload.github.com/luismichelcf/ai-workflows/tar.gz/${engine}"`,
    '',
    'react@18.2.0:',
    '  version "18.2.0"',
    '  resolved "https://registry.yarnpkg.com/react/-/react-18.2.0.tgz"',
    `  integrity ${react}`,
  );

  it('package-lock.json: the engine entry changes → failure', async () => {
    const w = world({ 'package-lock.json': NPM_LOCK() });
    const head = w.pr({ 'package-lock.json': NPM_LOCK('sha512-BBBB') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package-lock.json: another package changes → success', async () => {
    const w = world({ 'package-lock.json': NPM_LOCK() });
    w.pr({ 'package-lock.json': NPM_LOCK('sha512-AAAA', 'sha512-SSSS') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  it('yarn.lock: the engine block changes → failure', async () => {
    const w = world({ 'yarn.lock': YARN_LOCK() });
    const head = w.pr({ 'yarn.lock': YARN_LOCK('def') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('yarn.lock: another block changes → success', async () => {
    const w = world({ 'yarn.lock': YARN_LOCK() });
    w.pr({ 'yarn.lock': YARN_LOCK('abc', 'sha512-SSSS') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('R6 §2.2: a version file added or deleted counts as touched', () => {
  it('deleting pnpm-lock.yaml → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': null });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('adding yarn.lock → failure', async () => {
    const w = world();
    const head = w.pr({ 'yarn.lock': lines('# yarn lockfile v1', '', 'react@18.2.0:', '  version "18.2.0"') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('adding package.json → failure', async () => {
    const w = world();
    const head = w.pr({ 'package.json': json({ name: 'proyecto', dependencies: { react: '18.2.0' } }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('R6 §2.4 (8): compared against the merge base, never the tip of main', () => {
  it('main bumps the engine after the PR branched; the PR changes only scripts.test → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ 'package.json': pkg((p) => { field(p, 'scripts').test = 'vitest run --coverage'; }) });
    w.advanceMain({ 'package.json': pkg((p) => { field(p, 'devDependencies')['ai-workflows'] = 'github:luismichelcf/ai-workflows#v0.4.0'; }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  it('main bumps the engine after the PR branched; the PR does not touch package.json → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ 'docs/x.md': 'hola\n' });
    w.advanceMain({ 'package.json': pkg((p) => { field(p, 'devDependencies')['ai-workflows'] = 'github:luismichelcf/ai-workflows#v0.4.0'; }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('R6 §2.4 (9): fail-closed parsing', () => {
  it('package.json broken in the head → failure, not error', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': '{ "name": "proyecto", \n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package.json broken in the merge base, fixed by the PR with an unrelated change → failure', async () => {
    const w = world({ 'package.json': '{ "name": "proyecto", \n' });
    const head = w.pr({ 'package.json': json({ name: 'proyecto', dependencies: { react: '18.2.0' } }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('pnpm-lock.yaml that is not YAML in the head → failure, not error', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': 'importers: [\n  : :\n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('R6 §2.4 (10): the 50 MB cap', () => {
  const MiB = 1024 * 1024;

  it('a pnpm-lock.yaml over 1 MB with a change to another package → success', async () => {
    const padding = `# ${'x'.repeat(Math.floor(1.5 * MiB))}\n`;
    const w = world({ 'pnpm-lock.yaml': `${LOCK()}${padding}` });
    w.pr({ 'pnpm-lock.yaml': `${LOCK('sha512-AAAA', 'sha512-SSSS')}${padding}` });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  }, 60_000);

  it('a pnpm-lock.yaml over the cap, even with only a comment added → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': `${LOCK()}# ${'x'.repeat(51 * MiB)}\n` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  }, 120_000);
});

describe('R6 §2.4 (11) and (13): the key that decides node_modules/ai-workflows', () => {
  it('package.json without any ai-workflows key and an unrelated change → success', async () => {
    const without = { name: 'proyecto', dependencies: { react: '18.2.0' } };
    const w = world({ 'package.json': json(without) });
    w.pr({ 'package.json': json({ ...without, dependencies: { react: '18.3.1' } }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  it('the ai-workflows key changes to npm:otro@1.0.0 → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { field(p, 'devDependencies')['ai-workflows'] = 'npm:otro@1.0.0'; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  // Changed by the fourth delta review (PLAN-13-R6 §15, «Cuarta revisión del delta»): a dependency
  // that is not the engine is harmless only when its value is a registry range, version or tag, or
  // uses `workspace:` or `catalog:`; an `npm:` alias counts as touched whatever package it names.
  // The guard that an ordinary dependency of another package passes is §2.4 (5) above.
  it('an alias under another key ("x": "npm:ai-workflows@9.9.9"), the ai-workflows key untouched → failure (npm: is not a registry spec)', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies').x = 'npm:ai-workflows@9.9.9'; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

// ---------------------------------------------------------------------------------------------
// §2.1 and §2.4 test 12: one list, shared with the installer.

/** The documented matching rule of the list: lower case; `x/` covers the folder, anything else is exact. */
const covered = (path: string): boolean => {
  const lower = path.toLowerCase();
  return ENGINE_PROTECTED_PATHS.some((entry) => (entry.endsWith('/') ? lower.startsWith(entry) : lower === entry));
};

describe('R6 §2.1: the engine-fixed protected list', () => {
  it('holds every literal path of §2.1, in lower case', () => {
    expect(ENGINE_PROTECTED_PATHS).toEqual(expect.arrayContaining([
      '.ai-workflows/',
      '.claude/settings.json',
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
    ]));
    for (const entry of ENGINE_PROTECTED_PATHS) expect(entry).toBe(entry.toLowerCase());
  });

  it('does not protect package.json or the lockfiles whole (they are compared field by field)', () => {
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock']) {
      expect(covered(path)).toBe(false);
    }
  });
});

describe('R6 §2.4 (12): every file hooks install --apply writes is in the protected list', () => {
  const INSTALL_RECIPE = lines(
    'version: 1',
    'locale: es',
    `owner: ${OWNER}`,
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
  const allFiles = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .filter((path) => !path.startsWith('.git/'));

  it('the set written by the installer is contained in ENGINE_PROTECTED_PATHS', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': INSTALL_RECIPE, 'README.md': 'x\n' });
    git(root, 'switch', '-q', '-c', 'feat/13-x');
    const before = new Set(allFiles(root));
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(true);
    const written = allFiles(root).filter((path) => !before.has(path));
    expect(written).toContain('.claude/settings.json');
    expect(written.filter((path) => !covered(path))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PLAN-13-R6 §15 and R32 (the flock of slice 6): what runs when dependencies are installed is the
// judge's own. Changing the project's lifecycle scripts (`preinstall`, `install`, `postinstall`,
// `prepare`), the installer's configuration (`.npmrc`, `.yarnrc.yml`, the pnpmfile path,
// `onlyBuiltDependencies`) or OpenCode's plugin and tool folders needs the owner's attestation,
// like every other file of the judge. Also: lockfile keys with a leading `/` (older pnpm
// lockfiles) name the engine too.
//
// Interface fixed here (for the builder): `ENGINE_PROTECTED_PATHS` also holds `.npmrc`,
// `.yarnrc.yml`, `.opencode/plugin/`, `.opencode/tool/` and `.opencode/tools/`; the projection of
// package.json also holds `scripts.{preinstall,install,postinstall,prepare}` and
// `pnpm.onlyBuiltDependencies`; the projection of pnpm-workspace.yaml also holds
// `onlyBuiltDependencies` and `pnpmfile`; a pnpm-lock key `/ai-workflows@…` counts like
// `ai-workflows@…`.

describe('R32: lifecycle scripts of package.json', () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    it(`scripts.${script} added → failure`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      const head = w.pr({ 'package.json': pkg((p) => { field(p, 'scripts')[script] = 'node x.js'; }) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });

    it(`scripts.${script} changed → failure`, async () => {
      const w = world({ 'package.json': pkg((p) => { field(p, 'scripts')[script] = 'node a.js'; }) });
      const head = w.pr({ 'package.json': pkg((p) => { field(p, 'scripts')[script] = 'node b.js'; }) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
    });
  }

  it('control: another script added (lint) → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ 'package.json': pkg((p) => { field(p, 'scripts').lint = 'eslint .'; }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  it('control: scripts.test changed → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ 'package.json': pkg((p) => { field(p, 'scripts').test = 'vitest run --coverage'; }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('R32: the installer configuration', () => {
  for (const path of ['.npmrc', '.yarnrc.yml']) {
    it(`${path} added → failure`, async () => {
      const w = world();
      const head = w.pr({ [path]: 'pnpmfile=otro.cjs\n' });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain(path);
    });
  }

  it('package.json pnpm.onlyBuiltDependencies added → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependencies: ['esbuild'] }; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package.json pnpm.onlyBuiltDependencies changed → failure', async () => {
    const w = world({ 'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependencies: ['esbuild'] }; }) });
    const head = w.pr({ 'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependencies: ['esbuild', 'otro'] }; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  const WORKSPACE = lines('packages:', '  - apps/*');
  for (const [what, extra] of [
    ['onlyBuiltDependencies added', lines('', 'onlyBuiltDependencies:', '  - esbuild')],
    ['pnpmfile added', lines('', 'pnpmfile: otro.cjs')],
  ] as const) {
    it(`pnpm-workspace.yaml ${what} → failure`, async () => {
      const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
      const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${extra}` });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('pnpm-workspace.yaml');
    });
  }

  it('pnpm-workspace.yaml pnpmfile changed → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'pnpmfile: uno.cjs')}` });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'pnpmfile: dos.cjs')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('R32: OpenCode plugin and tool folders', () => {
  for (const path of ['.opencode/plugin/x.js', '.opencode/tool/x.js', '.opencode/tools/x.js']) {
    it(`${path} → failure`, async () => {
      const w = world();
      const head = w.pr({ [path]: 'export default {};\n' });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain(path);
    });
  }

  it('the list holds the new entries of R32, in lower case', () => {
    expect(ENGINE_PROTECTED_PATHS).toEqual(expect.arrayContaining([
      '.npmrc',
      '.yarnrc.yml',
      '.opencode/plugin/',
      '.opencode/tool/',
      '.opencode/tools/',
    ]));
  });

  // Guards (the flock's surviving mutant of the folder rule): the bare folder name is covered too.
  it('a pull request adding .opencode/plugins as a file → failure', async () => {
    const w = world();
    const head = w.pr({ '.opencode/plugins': 'no soy carpeta\n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a pull request adding .opencode/plugins as a symlink → failure', async () => {
    const w = world();
    // The attestation is looked up on PR 7, registered first with a harmless change; its head is
    // then replaced by a commit whose only change is the symlink.
    w.pr({ 'docs/x.md': 'hola\n' });
    const main = git(w.root, 'rev-parse', 'main');
    const head = commitSymlink(w.root, main, '.opencode/plugins', '../otro');
    w.github.prs.set(7, { number: 7, state: 'open', headSha: head, headRef: BRANCH, baseRef: 'main', headRepo: REPO });
    w.github.green.add(head);
    const report = await w.judge({
      event: {
        pull_request: {
          number: 7,
          head: { sha: head, ref: BRANCH, repo: { full_name: REPO } },
          base: { sha: main, ref: 'main' },
        },
        repository: { full_name: REPO, default_branch: 'main' },
      },
    });
    expect(w.github.on().filter((entry) => entry.sha === head)).toEqual([
      expect.objectContaining({ state: 'failure', description: expect.stringContaining(`/approve-judge-change ${head.slice(0, 16)}`) }),
    ]);
    expect(report.pieces[0]?.verdict).toBe('rejected');
  });
});

/** A commit on `parent` that adds `path` as a symbolic link to `target` (mode 120000). */
function commitSymlink(root: string, parent: string, path: string, target: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'aiw-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(folder, 'index') };
    const plumbing = (args: string[], input?: string): string =>
      execFileSync('git', args, { cwd: root, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) }).trim();
    plumbing(['read-tree', parent]);
    const blob = plumbing(['hash-object', '-w', '--stdin'], target);
    plumbing(['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`]);
    const tree = plumbing(['write-tree']);
    return plumbing(['commit-tree', tree, '-p', parent, '-m', 'symlink']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('flock 6: engine entries of pnpm-lock.yaml that the tests did not reach', () => {
  // An older pnpm lockfile (format 6): the package keys start with `/`.
  const OLD_LOCK = (engineIntegrity = 'sha512-AAAA', reactIntegrity = 'sha512-RRRR'): string => lines(
    "lockfileVersion: '6.0'",
    '',
    'devDependencies:',
    '  ai-workflows:',
    `    specifier: ${ENGINE}`,
    '    version: 1.0.0',
    '',
    'packages:',
    '',
    '  /ai-workflows@1.0.0:',
    `    resolution: {integrity: ${engineIntegrity}}`,
    '    dev: true',
    '',
    '  /react@18.2.0:',
    `    resolution: {integrity: ${reactIntegrity}}`,
    '    dev: false',
  );

  it('the package key /ai-workflows@1.0.0 changes its integrity → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': OLD_LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': OLD_LOCK('sha512-BBBB') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('control: the package key /react@18.2.0 changes its integrity → success', async () => {
    const w = world({ 'pnpm-lock.yaml': OLD_LOCK() });
    w.pr({ 'pnpm-lock.yaml': OLD_LOCK('sha512-AAAA', 'sha512-SSSS') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  // Guards (surviving mutants of the flock): they pass today and must keep passing.
  it('only the importer changes, to a link with no package entry → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const importerOnly = LOCK().replace('version: 0.3.0', 'version: link:../otro');
    expect(importerOnly).not.toBe(LOCK());
    const head = w.pr({ 'pnpm-lock.yaml': importerOnly });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('only the snapshot of ai-workflows@ changes its dependencies → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const snapshot = LOCK().replace('  ai-workflows@0.3.0: {}', lines('  ai-workflows@0.3.0:', '    dependencies:', '      yaml: 2.5.0').trimEnd());
    expect(snapshot).not.toBe(LOCK());
    const head = w.pr({ 'pnpm-lock.yaml': snapshot });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package.json that is not JSON on both sides, with different content → failure', async () => {
    const w = world({ 'package.json': '{ "name": "proyecto", \n' });
    const head = w.pr({ 'package.json': '{ "name": "otro", \n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

// ---------------------------------------------------------------------------------------------
// Delta review of the flock fixes (R32), findings B3 and M1: more of what runs when dependencies
// are installed, or decides which installer runs, is the judge's own.
//
// Interface fixed here (for the builder):
//   - B3. The lifecycle scripts of R32 also include `pnpm:devPreinstall`, `preprepare`,
//     `postprepare`, `prepublish` and `dependencies` (each one runs during an install), and they
//     count in the package.json of every workspace member too (`packages/a/package.json`), not
//     only in the root one. An ordinary script of a member (`test`) stays out.
//   - M1. `.yarnrc` (yarn classic's configuration), and the folders `.yarn/releases/` and
//     `.yarn/plugins/` (the yarn binary and its plugins, which run on install) are protected paths.
//     The projection of package.json also holds `packageManager` (it picks the installer through
//     corepack) and `pnpm.onlyBuiltDependenciesFile`; the projection of pnpm-workspace.yaml also
//     holds `dangerouslyAllowAllBuilds`, `onlyBuiltDependenciesFile` and `neverBuiltDependencies`.

describe('B3: every lifecycle script that runs on install', () => {
  for (const script of ['pnpm:devPreinstall', 'preprepare', 'postprepare', 'prepublish', 'dependencies']) {
    it(`scripts.${script} added to the root package.json → failure`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      const head = w.pr({ 'package.json': pkg((p) => { field(p, 'scripts')[script] = 'node x.js'; }) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });
  }

  const MEMBER = 'packages/a/package.json';
  const member = (scripts: Record<string, string>) => json({ name: 'a', version: '1.0.0', private: true, scripts });
  const monorepo = () => world({
    'package.json': pkg((p) => { p.workspaces = ['packages/*']; }),
    'pnpm-workspace.yaml': lines('packages:', '  - packages/*'),
    [MEMBER]: member({ test: 'vitest run' }),
  });

  it('scripts.postinstall added to a workspace member → failure', async () => {
    const w = monorepo();
    const head = w.pr({ [MEMBER]: member({ test: 'vitest run', postinstall: 'node x.js' }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  // Guard: it passes today and must keep passing.
  it('control: scripts.test changed in a workspace member → success', async () => {
    const w = monorepo();
    w.pr({ [MEMBER]: member({ test: 'vitest run --coverage' }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('M1: yarn classic configuration, the yarn binary and its plugins', () => {
  for (const path of ['.yarnrc', '.yarn/releases/x.cjs', '.yarn/plugins/x.cjs']) {
    it(`${path} edited → failure`, async () => {
      const w = world({ [path]: 'uno\n' });
      const head = w.pr({ [path]: 'dos\n' });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain(path);
    });
  }
});

describe('M1: the installer and its build allow-list', () => {
  it('package.json packageManager changed → failure', async () => {
    const w = world({ 'package.json': pkg((p) => { p.packageManager = 'pnpm@10.0.0'; }) });
    const head = w.pr({ 'package.json': pkg((p) => { p.packageManager = 'pnpm@10.0.1'; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package.json pnpm.onlyBuiltDependenciesFile added → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependenciesFile: 'built.json' }; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  const WORKSPACE = lines('packages:', '  - apps/*');
  for (const [what, extra] of [
    ['dangerouslyAllowAllBuilds added', lines('', 'dangerouslyAllowAllBuilds: true')],
    ['onlyBuiltDependenciesFile added', lines('', 'onlyBuiltDependenciesFile: built.json')],
    ['neverBuiltDependencies added', lines('', 'neverBuiltDependencies:', '  - esbuild')],
  ] as const) {
    it(`pnpm-workspace.yaml ${what} → failure`, async () => {
      const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
      const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${extra}` });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('pnpm-workspace.yaml');
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Second delta review of the flock fixes (R32), findings M-c and M-d.
//
// Interface fixed here (for the builder):
//   - M-c. A package.json of a workspace member (any `…/package.json` other than the root one) that
//     is ADDED or DELETED is compared like an edited one: the missing side counts as a package.json
//     without any of the fields of the projection. So a new member with only `name` and ordinary
//     dependencies passes, a new member with a lifecycle script (`scripts.postinstall`) needs the
//     attestation, and deleting a member without lifecycle scripts passes. The ROOT package.json
//     added or removed stays touched, and a member that cannot be read as JSON stays touched.
//   - M-d. More of what decides which packages are installed, or which of them run code, is in the
//     projections: `workspaces` of the root package.json (which folders are members, so whose
//     lifecycle scripts run) and `dependenciesMeta`; `packages`, `configDependencies` and
//     `allowBuilds` of pnpm-workspace.yaml. And the file NAMED by `onlyBuiltDependenciesFile` (in
//     pnpm-workspace.yaml or in `pnpm` of package.json, as read on the trusted side) is one of the
//     judge's own files: editing it needs the attestation, and the run log names it.

describe('M-c: a workspace member package.json added or deleted is compared field by field', () => {
  const MEMBER = 'packages/x/package.json';

  it('a new member with only name and dependencies.lodash → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ [MEMBER]: json({ name: 'x', dependencies: { lodash: '4.17.21' } }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  // Guard: it passes today and must keep passing.
  it('a new member with scripts.postinstall → failure with /approve-judge-change', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [MEMBER]: json({ name: 'x', dependencies: { lodash: '4.17.21' }, scripts: { postinstall: 'node x.js' } }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('deleting a member without lifecycle scripts → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: json({ name: 'x', scripts: { test: 'vitest run' }, dependencies: { lodash: '4.17.21' } }) });
    w.pr({ [MEMBER]: null });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  // Guards: they pass today and must keep passing. (Adding the root package.json is the guard
  // «adding package.json → failure» of §2.2 above.)
  it('deleting the root package.json → failure', async () => {
    const w = world({ 'package.json': json({ name: 'proyecto', dependencies: { react: '18.2.0' } }) });
    const head = w.pr({ 'package.json': null });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a new member that is not valid JSON → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [MEMBER]: '{ "name": "x", \n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('a member edited into invalid JSON → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: json({ name: 'x' }) });
    const head = w.pr({ [MEMBER]: '{ "name": "x", \n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('M-d: workspaces, build settings and the build allow-list file', () => {
  it('only workspaces of the root package.json changed → failure', async () => {
    const w = world({ 'package.json': pkg((p) => { p.workspaces = ['apps/*']; }) });
    const head = w.pr({ 'package.json': pkg((p) => { p.workspaces = ['apps/*', 'packages/*']; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('package.json');
  });

  it('only dependenciesMeta of package.json added → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { p.dependenciesMeta = { esbuild: { built: true } }; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  const WORKSPACE = lines('packages:', '  - apps/*');
  for (const [what, after] of [
    ['only packages changed', lines('packages:', '  - apps/*', '  - packages/*')],
    ['only configDependencies added', `${WORKSPACE}${lines('', 'configDependencies:', '  pnpm-plugin-x: "1.0.0+sha512-AAAA"')}`],
    ['only allowBuilds added', `${WORKSPACE}${lines('', 'allowBuilds:', '  esbuild: true')}`],
  ] as const) {
    it(`pnpm-workspace.yaml ${what} → failure`, async () => {
      const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
      const head = w.pr({ 'pnpm-workspace.yaml': after });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('pnpm-workspace.yaml');
    });
  }

  const BUILDS = '.pnpm-builds.json';
  it(`${BUILDS}, named by onlyBuiltDependenciesFile in pnpm-workspace.yaml, edited → failure naming it`, async () => {
    const w = world({
      'pnpm-workspace.yaml': `${WORKSPACE}${lines('', `onlyBuiltDependenciesFile: ${BUILDS}`)}`,
      [BUILDS]: json(['esbuild']),
    });
    const head = w.pr({ [BUILDS]: json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(BUILDS);
  });

  it(`${BUILDS}, named by pnpm.onlyBuiltDependenciesFile in package.json, edited → failure naming it`, async () => {
    const w = world({
      'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependenciesFile: BUILDS }; }),
      [BUILDS]: json(['esbuild']),
    });
    const head = w.pr({ [BUILDS]: json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(BUILDS);
  });

  // Guard: it passes today and must keep passing. The same file name, not named by any setting, is
  // an ordinary file.
  it(`control: ${BUILDS} edited when no setting names it → success`, async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE, [BUILDS]: json(['esbuild']) });
    w.pr({ [BUILDS]: json(['esbuild', 'postinstall-x']) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

// ---------------------------------------------------------------------------------------------
// Third delta review of the flock fixes (PLAN-13-R6 §15, last paragraph): protecting the package
// manifests with a list of dangerous keys never closes (another manifest format, another installer
// option), so the rule is inverted. In a package manifest (`package.json`, `package.yaml`,
// `package.json5`, at any depth) and in `pnpm-workspace.yaml`, EVERY change counts as touched
// except a short list of harmless ones.
//
// Interface fixed here (for the builder):
//   - Harmless in a package manifest: the entries of `dependencies`, `devDependencies`,
//     `optionalDependencies` and `peerDependencies` whose key is not the engine (`ai-workflows`);
//     `name` when it is not `ai-workflows`; `version`, `description`, `keywords`, `author`,
//     `contributors`, `license`, `repository`, `homepage`, `bugs`, `private`; and the scripts that
//     do not run on install (any other than preinstall, install, postinstall, prepare, preprepare,
//     postprepare, prepublish, dependencies, pnpm:devPreinstall). Anything else changing — a key
//     added, removed or edited anywhere outside that list — is touched.
//   - Harmless in pnpm-workspace.yaml: only the entries of `catalog` and `catalogs` whose key is
//     not the engine.
//   - A member manifest (any manifest that is not the root `package.json`) added or deleted is
//     compared against an empty one with the same rule; the root package.json added or removed
//     stays touched; a manifest that cannot be read as its format is touched.
//   - `package.json5` (pinned here): touched whenever it changes, harmless fields included. No
//     JSON5 reader is needed, so no new dependency.
//   - `binding.gyp`, at any depth, is touched whenever it changes (npm runs `node-gyp rebuild` on
//     install when a package has one and no install script).
//   - The build allow-list file named by `onlyBuiltDependenciesFile` on the trusted side is the
//     judge's own whichever setting names it: `pnpm-workspace.yaml`, `pnpm` of package.json (both,
//     when both name different files) and `only-built-dependencies-file` of `.npmrc`; the name is
//     normalized (`x/../b.json` is `b.json`).
//   The run log names the touched file.

describe('third delta: a package manifest of any format, anywhere', () => {
  const FOLDER = 'packages/x';

  it(`a new ${FOLDER}/package.yaml with scripts.postinstall → failure naming it`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [`${FOLDER}/package.yaml`]: lines('name: x', 'scripts:', '  postinstall: node x.js') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(`${FOLDER}/package.yaml`);
  });

  it(`${FOLDER}/package.json deleted and ${FOLDER}/package.yaml with postinstall added in the same PR → failure`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [`${FOLDER}/package.json`]: json({ name: 'x', dependencies: { lodash: '4.17.21' } }) });
    const head = w.pr({
      [`${FOLDER}/package.json`]: null,
      [`${FOLDER}/package.yaml`]: lines('name: x', 'dependencies:', '  lodash: 4.17.21', 'scripts:', '  postinstall: node x.js'),
    });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(`${FOLDER}/package.yaml`);
  });

  // Guard: it passes today and must keep passing (a member added with only harmless fields).
  it(`a new ${FOLDER}/package.yaml with only name and dependencies → success`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ [`${FOLDER}/package.yaml`]: lines('name: x', 'dependencies:', '  lodash: 4.17.21') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });

  it(`a new ${FOLDER}/package.yaml that is not YAML → failure`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [`${FOLDER}/package.yaml`]: 'name: [x\n  : :\n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it(`${FOLDER}/package.json5 whose only change is description → failure (package.json5 is touched whenever it changes)`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [`${FOLDER}/package.json5`]: "{ name: 'x', description: 'uno' }\n" });
    const head = w.pr({ [`${FOLDER}/package.json5`]: "{ name: 'x', description: 'dos' }\n" });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(`${FOLDER}/package.json5`);
  });

  it(`a new member ${FOLDER}/package.json named ai-workflows → failure`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [`${FOLDER}/package.json`]: json({ name: 'ai-workflows', version: '1.0.0' }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(`${FOLDER}/package.json`);
  });

  for (const path of ['binding.gyp', `${FOLDER}/binding.gyp`]) {
    it(`${path} added → failure naming it`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      const head = w.pr({ [path]: "{ 'targets': [ { 'target_name': 'x', 'sources': [ 'x.cc' ] } ] }\n" });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain(path);
    });
  }
});

describe('third delta: the root package.json outside the list of harmless changes', () => {
  const cases: [string, string][] = [
    ['only pnpm.neverBuiltDependencies added', pkg((p) => { p.pnpm = { neverBuiltDependencies: ['esbuild'] }; })],
    ['only pnpm.ignoredBuiltDependencies added', pkg((p) => { p.pnpm = { ignoredBuiltDependencies: ['esbuild'] }; })],
    ['only main added', pkg((p) => { p.main = 'x.js'; })],
    ['only exports added', pkg((p) => { p.exports = { '.': './x.js' }; })],
    ['only bin added', pkg((p) => { p.bin = { x: './x.js' }; })],
    ['only type added', pkg((p) => { p.type = 'module'; })],
    ['only an override of another package added', pkg((p) => { p.overrides = { react: '18.3.1' }; })],
    ['only name changed to ai-workflows', pkg((p) => { p.name = 'ai-workflows'; })],
  ];
  for (const [what, text] of cases) {
    it(`${what} → failure`, async () => {
      const w = world({ 'package.json': json(BASE_PACKAGE) });
      const head = w.pr({ 'package.json': text });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });
  }

  // Guards: they pass today and must keep passing.
  const withLodash = pkg((p) => { field(p, 'dependencies').lodash = '4.17.20'; });
  const harmless: [string, string, string][] = [
    ['only description changed', json(BASE_PACKAGE), pkg((p) => { p.description = 'otro'; })],
    ['only the dependency version of lodash changed', withLodash, pkg((p) => { field(p, 'dependencies').lodash = '4.17.21'; })],
    ['only scripts.test changed', json(BASE_PACKAGE), pkg((p) => { field(p, 'scripts').test = 'vitest run --coverage'; })],
    ['every other harmless field at once (name, version, keywords, author, contributors, license, repository, homepage, bugs, private, scripts.lint)', json(BASE_PACKAGE), pkg((p) => {
      p.name = 'otro';
      p.version = '2.0.0';
      p.keywords = ['x'];
      p.author = 'Alguien';
      p.contributors = ['Otra'];
      p.license = 'MIT';
      p.repository = 'github:duena/proyecto';
      p.homepage = 'https://example.com';
      p.bugs = 'https://example.com/bugs';
      p.private = false;
      field(p, 'scripts').lint = 'eslint .';
    })],
  ];
  for (const [what, before, after] of harmless) {
    it(`control: ${what} → success`, async () => {
      const w = world({ 'package.json': before });
      w.pr({ 'package.json': after });
      await w.judge();
      expect(states(w)).toEqual(['success']);
    });
  }
});

describe('third delta: pnpm-workspace.yaml outside its catalogs', () => {
  const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.2.0');
  for (const [what, extra] of [
    ['only scriptShell added', lines('', 'scriptShell: ./x.sh')],
    ['only nodeOptions added', lines('', 'nodeOptions: --require ./x.cjs')],
    ['only linkWorkspacePackages added', lines('', 'linkWorkspacePackages: true')],
    ['only packageExtensions added', lines('', 'packageExtensions:', '  react:', '    dependencies:', '      x: 1.0.0')],
  ] as const) {
    it(`${what} → failure`, async () => {
      const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
      const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${extra}` });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('pnpm-workspace.yaml');
    });
  }

  // Guard: it passes today and must keep passing (the catalog guard of §2.4 (7) covers `catalog`).
  it('control: only a named catalog of another package added → success', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', 'catalogs:', '  viejo:', '    react: 17.0.2')}` });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('third delta: every setting that names the build allow-list file', () => {
  it('pnpm-workspace.yaml names a.json and package.json#pnpm names b.json; b.json edited → failure naming it', async () => {
    const w = world({
      'pnpm-workspace.yaml': lines('packages:', '  - apps/*', '', 'onlyBuiltDependenciesFile: a.json'),
      'package.json': pkg((p) => { p.pnpm = { onlyBuiltDependenciesFile: 'b.json' }; }),
      'a.json': json(['esbuild']),
      'b.json': json(['esbuild']),
    });
    const head = w.pr({ 'b.json': json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('b.json');
  });

  it('.npmrc with only-built-dependencies-file=b.json in the base; b.json edited → failure naming it', async () => {
    const w = world({ '.npmrc': 'only-built-dependencies-file=b.json\n', 'b.json': json(['esbuild']) });
    const head = w.pr({ 'b.json': json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('b.json');
  });

  it('onlyBuiltDependenciesFile: x/../b.json; b.json edited → failure naming it', async () => {
    const w = world({
      'pnpm-workspace.yaml': lines('packages:', '  - apps/*', '', 'onlyBuiltDependenciesFile: x/../b.json'),
      'b.json': json(['esbuild']),
    });
    const head = w.pr({ 'b.json': json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('b.json');
  });
});
// ---------------------------------------------------------------------------------------------
// Fourth delta review of the flock fixes (PLAN-13-R6 §15, «Cuarta revisión del delta»): on the
// rule by list of harmless changes, what the judge reads can differ from what the installer reads.
//
// Interface fixed here (for the builder):
//   - A YAML document (package.yaml, pnpm-workspace.yaml, pnpm-lock.yaml) that holds a merge key
//     (`<<`) at any depth, on a side that changes, is touched: the judge and the installer do not
//     read it the same way. (Superseded by the fifth delta, below: any anchor or alias is touched
//     too.)
//   - A key `__proto__` at any depth of a package manifest or of pnpm-workspace.yaml, on a side
//     that changes, is touched (a plain JS object drops it, so the judge would not see it).
//   - A dependency entry that is not the engine (in `dependencies`, `devDependencies`,
//     `optionalDependencies`, `peerDependencies`) and a catalog entry that is not the engine are
//     harmless only when the value is a registry range, version or tag, or starts with
//     `workspace:` or `catalog:`. `file:`, `link:`, `git…`, `github:`, `npm:`, `patch:`,
//     `portal:`, a URL or a `.tgz` count as touched.
//   - The engine name is compared without case in the keys of dependency sections, catalogs and
//     lockfiles (`AI-Workflows` is the engine).
//   - `only-built-dependencies-file` in `.npmrc` is read the way the installer reads it: a value in
//     double or single quotes is unquoted, and EVERY occurrence of the key names a file of the
//     judge's own.
//   The run log names the touched file.

describe('fourth delta: YAML merge keys are touched', () => {
  const MEMBER = 'packages/x/package.yaml';
  const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.2.0');

  it(`a new ${MEMBER} with scripts: {<<: {postinstall}} → failure naming it`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [MEMBER]: lines('name: x', 'scripts:', "  <<: { postinstall: 'node x.js' }") });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('pnpm-workspace.yaml catalog gains <<: {ai-workflows: github:e/x} → failure naming it', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines("  <<: { ai-workflows: 'github:e/x' }")}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  it(`${MEMBER} dependencies gain a merge of an ordinary registry entry (<<: {react: 18.2.0}) → failure`, async () => {
    const before = lines('name: x', 'dependencies:', '  lodash: 4.17.21');
    const w = world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: before });
    const head = w.pr({ [MEMBER]: `${before}${lines('  <<: { react: 18.2.0 }')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it("pnpm-lock.yaml importers['.'].dependencies gain <<: {ai-workflows: …} → failure naming it", async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const merged = LOCK().replace(
      lines('    dependencies:', '      react:'),
      lines('    dependencies:', "      <<: { ai-workflows: { specifier: 'github:e/x', version: 9.9.9 } }", '      react:'),
    );
    expect(merged).not.toBe(LOCK());
    const head = w.pr({ 'pnpm-lock.yaml': merged });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-lock.yaml');
  });

  // Changed by the fifth delta review (PLAN-13-R6 §15, «Quinta revisión del delta»): these two were
  // guards expecting success («anchors and aliases without `<<` compare as their values»). Any
  // anchor or alias is now an advanced YAML feature, touched without being read, so both expect
  // failure.
  it(`${MEMBER} with an anchor and an alias only in harmless fields → failure (fifth delta: anchors and aliases are touched)`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: lines('name: x', 'description: uno') });
    const head = w.pr({ [MEMBER]: lines('name: x', 'description: &d dos', 'keywords: [*d]') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('pnpm-workspace.yaml catalog entries of other packages through an anchor and an alias → failure (fifth delta: anchors and aliases are touched)', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': lines('packages:', '  - apps/*', '', 'catalog:', '  react: &r 18.3.0', '  react-dom: *r') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  it(`control: ${MEMBER} whose alias puts a lifecycle script (postinstall: *s) → failure`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: lines('name: x', 'scripts:', '  test: node x.js') });
    const head = w.pr({ [MEMBER]: lines('name: x', 'scripts:', '  test: &s node x.js', '  postinstall: *s') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('fourth delta: a __proto__ key is touched', () => {
  const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.2.0');

  it('pnpm-workspace.yaml gains __proto__: {dangerouslyAllowAllBuilds: true} → failure naming it', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('', '__proto__:', '  dangerouslyAllowAllBuilds: true')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  it('pnpm-workspace.yaml catalog gains __proto__: {ai-workflows: …} → failure', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('  __proto__:', "    ai-workflows: 'github:e/x'")}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  // The base already holds an empty `pnpm`, so the only change is the `__proto__` key inside it.
  const withPnpm = pkg((p) => { p.pnpm = {}; });

  it('package.json "pnpm": {} gains "__proto__": {"x": 1} → failure naming it', async () => {
    const w = world({ 'package.json': withPnpm });
    const after = withPnpm.replace('"pnpm": {}', '"pnpm": { "__proto__": { "x": 1 } }');
    expect(after).not.toBe(withPnpm);
    const head = w.pr({ 'package.json': after });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('package.json');
  });

  it('package.json gains a top-level "__proto__": {"scripts": {"postinstall": …}} → failure', async () => {
    const before = json(BASE_PACKAGE);
    const after = before.replace('{\n', '{\n  "__proto__": { "scripts": { "postinstall": "node x.js" } },\n');
    expect(after).not.toBe(before);
    const w = world({ 'package.json': before });
    const head = w.pr({ 'package.json': after });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('fourth delta: a dependency that is not the engine is harmless only with a registry spec', () => {
  const base = pkg((p) => { field(p, 'dependencies').esbuild = '^0.21.0'; });
  const withEsbuild = (spec: string): string => pkg((p) => { field(p, 'dependencies').esbuild = spec; });

  for (const spec of ['file:./e.tgz', 'github:a/b', 'git+https://x/y.git', 'https://x/e.tgz', 'link:../e', 'npm:other@1']) {
    it(`dependencies.esbuild from ^0.21.0 to ${spec} → failure naming package.json`, async () => {
      const w = world({ 'package.json': base });
      const head = w.pr({ 'package.json': withEsbuild(spec) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });
  }

  // Guards: they pass today and must keep passing.
  for (const spec of ['^0.22.0', 'workspace:*', 'catalog:']) {
    it(`control: dependencies.esbuild from ^0.21.0 to ${spec} → success`, async () => {
      const w = world({ 'package.json': base });
      w.pr({ 'package.json': withEsbuild(spec) });
      await w.judge();
      expect(states(w)).toEqual(['success']);
    });
  }

  it('a new member package.json with dependencies.x = link:../x → failure naming it', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'packages/x/package.json': json({ name: 'x', dependencies: { x: 'link:../x' } }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('packages/x/package.json');
  });

  const WORKSPACE = (spec: string): string => lines('packages:', '  - apps/*', '', 'catalog:', `  esbuild: "${spec}"`);

  it('pnpm-workspace.yaml catalog.esbuild from ^0.21.0 to github:a/b → failure naming it', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE('^0.21.0') });
    const head = w.pr({ 'pnpm-workspace.yaml': WORKSPACE('github:a/b') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  // Guard: it passes today and must keep passing.
  it('control: pnpm-workspace.yaml catalog.esbuild from ^0.21.0 to ^0.22.0 → success', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE('^0.21.0') });
    w.pr({ 'pnpm-workspace.yaml': WORKSPACE('^0.22.0') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('fourth delta: the engine name is compared without case', () => {
  it('package.json gains dependencies["AI-Workflows"] = "npm:x@1" → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies')['AI-Workflows'] = 'npm:x@1'; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  // A registry version, so only the case rule (not the registry-spec rule) can catch it.
  it('package.json gains dependencies["AI-Workflows"] = "9.9.9" → failure', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies')['AI-Workflows'] = '9.9.9'; }) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('pnpm-workspace.yaml catalog["AI-Workflows"] from 1.0.0 to 9.9.9 → failure', async () => {
    const workspace = (version: string): string => lines('packages:', '  - apps/*', '', 'catalog:', `  AI-Workflows: ${version}`);
    const w = world({ 'pnpm-workspace.yaml': workspace('1.0.0') });
    const head = w.pr({ 'pnpm-workspace.yaml': workspace('9.9.9') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  const UPPER_LOCK = (importerVersion = '1.0.0', integrity = 'sha512-AAAA', extra: readonly string[] = []): string => lines(
    "lockfileVersion: '9.0'",
    '',
    ...extra,
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      AI-Workflows:',
    `        specifier: ${importerVersion}`,
    `        version: ${importerVersion}`,
    '',
    'packages:',
    '',
    '  AI-Workflows@1.0.0:',
    `    resolution: {integrity: ${integrity}}`,
    '',
    'snapshots:',
    '',
    '  AI-Workflows@1.0.0: {}',
  );

  it('pnpm-lock.yaml: only the importer entry AI-Workflows changes → failure naming it', async () => {
    const w = world({ 'pnpm-lock.yaml': UPPER_LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': UPPER_LOCK('9.9.9') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-lock.yaml');
  });

  it('pnpm-lock.yaml: a new override keyed AI-Workflows → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': UPPER_LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': UPPER_LOCK('1.0.0', 'sha512-AAAA', ['overrides:', '  AI-Workflows: 9.9.9', '']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  // Guard: it passes today and must keep passing (package keys are already folded).
  it('control: pnpm-lock.yaml: the package AI-Workflows@1.0.0 changes its integrity → failure', async () => {
    const w = world({ 'pnpm-lock.yaml': UPPER_LOCK() });
    const head = w.pr({ 'pnpm-lock.yaml': UPPER_LOCK('1.0.0', 'sha512-BBBB') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });

  it('package-lock.json: the entry node_modules/AI-Workflows changes → failure', async () => {
    const npmLock = (integrity: string): string => json({
      name: 'proyecto',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'proyecto', dependencies: { 'AI-Workflows': '1.0.0' } },
        'node_modules/AI-Workflows': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity },
      },
    });
    const w = world({ 'package-lock.json': npmLock('sha512-AAAA') });
    const head = w.pr({ 'package-lock.json': npmLock('sha512-BBBB') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
  });
});

describe('fourth delta: .npmrc only-built-dependencies-file read as the installer reads it', () => {
  for (const [what, npmrc] of [
    ['in double quotes', 'only-built-dependencies-file="allow.json"\n'],
    ['in single quotes', "only-built-dependencies-file='allow.json'\n"],
  ] as const) {
    it(`.npmrc names allow.json ${what}; allow.json edited → failure naming it`, async () => {
      const w = world({ '.npmrc': npmrc, 'allow.json': json(['esbuild']) });
      const head = w.pr({ 'allow.json': json(['esbuild', 'postinstall-x']) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('allow.json');
    });
  }

  const TWICE = lines('only-built-dependencies-file=a.json', 'only-built-dependencies-file=b.json');

  // Guard: it passes today (the first occurrence is read) and must keep passing.
  it('.npmrc with the key twice (a.json, then b.json); a.json edited → failure naming it', async () => {
    const w = world({ '.npmrc': TWICE, 'a.json': json(['esbuild']), 'b.json': json(['esbuild']) });
    const head = w.pr({ 'a.json': json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('a.json');
  });

  it('.npmrc with the key twice (a.json, then b.json); b.json edited → failure naming it', async () => {
    const w = world({ '.npmrc': TWICE, 'a.json': json(['esbuild']), 'b.json': json(['esbuild']) });
    const head = w.pr({ 'b.json': json(['esbuild', 'postinstall-x']) });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('b.json');
  });
});

// ---------------------------------------------------------------------------------------------
// Fifth delta review of the flock fixes (PLAN-13-R6 §15, «Quinta revisión del delta»): to cut the
// difference between YAML readers, and to keep registry specs strict.
//
// Interface fixed here (for the builder):
//   - A `package.yaml` (any depth), `pnpm-workspace.yaml` or `pnpm-lock.yaml` that uses ANY advanced
//     YAML feature on either side of a change is touched, without being interpreted: a directive
//     (`%YAML`, `%TAG`), an anchor or an alias, an explicit tag (`!!str`, `!!merge`, `!x`), a key
//     that is not a scalar, a merge key (`<<`), more than one document, or any error of the reader
//     (a duplicated key included). A plain YAML change of a harmless field keeps passing.
//   - A dependency or catalog value that is not the engine is harmless only when it is a registry
//     range or version written with the characters of semver, a tag without dots or slashes, or it
//     starts with `workspace:` or `catalog:`. A `.tgz`, `.tar` or `.tar.gz` (any case), or a value
//     starting with `\` or `~/`, is touched.
//   - `.npmrc` is read the way the `ini` reader reads it: an inline comment (` ; …` or ` # …`)
//     ends the value, and a key in quotes is unquoted before it is compared.
//   The run log names the touched file.

describe('fifth delta: advanced YAML is touched without being read', () => {
  const MEMBER = 'packages/x/package.yaml';
  const MEMBER_BASE = lines('name: x', 'description: uno');
  const memberWorld = (): World => world({ 'package.json': json(BASE_PACKAGE), [MEMBER]: MEMBER_BASE });
  const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.2.0');

  it(`the reviewer's case: a new ${MEMBER} with a complex key holding an anchored merge, and scripts: *s → failure naming it`, async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    const head = w.pr({ [MEMBER]: 'name: probe\nrepository:\n  ? &s {<<: {postinstall: "x"}}\n  : x\nscripts: *s\n' });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it(`${MEMBER} gains a %YAML 1.1 directive (and a new description) → failure naming it`, async () => {
    const w = memberWorld();
    const head = w.pr({ [MEMBER]: lines('%YAML 1.1', '---', 'name: x', 'description: dos') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it(`${MEMBER} gains a !!merge tagged key that only merges a description → failure naming it`, async () => {
    const w = memberWorld();
    const head = w.pr({ [MEMBER]: lines('name: x', 'description: uno', '!!merge extra: { description: dos }') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it(`${MEMBER} description written with an explicit !!str tag → failure naming it`, async () => {
    const w = memberWorld();
    const head = w.pr({ [MEMBER]: lines('name: x', 'description: !!str dos') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('pnpm-lock.yaml: the integrity of another package written with an explicit !!str tag → failure naming it', async () => {
    const w = world({ 'pnpm-lock.yaml': LOCK() });
    const tagged = LOCK().replace('{integrity: sha512-RRRR}', '{integrity: !!str sha512-SSSS}');
    expect(tagged).not.toBe(LOCK());
    const head = w.pr({ 'pnpm-lock.yaml': tagged });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-lock.yaml');
  });

  it(`${MEMBER} gains a non-scalar key inside repository (? [a, b] : c) → failure naming it`, async () => {
    const w = memberWorld();
    const head = w.pr({ [MEMBER]: lines('name: x', 'description: uno', 'repository:', '  ? [a, b]', '  : c') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('pnpm-workspace.yaml gains a second document after --- → failure naming it', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('---', 'onlyBuiltDependencies:', '  - esbuild')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  it(`${MEMBER} with a duplicated key (scripts twice, the first with postinstall) → failure naming it`, async () => {
    const w = memberWorld();
    const head = w.pr({ [MEMBER]: lines('name: x', 'description: uno', 'scripts:', '  postinstall: node x.js', 'scripts:', '  test: vitest') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain(MEMBER);
  });

  it('pnpm-workspace.yaml whose BASE side uses an anchor and an alias, changed by the PR to plain YAML → failure naming it', async () => {
    const w = world({ 'pnpm-workspace.yaml': lines('packages:', '  - apps/*', '', 'catalog:', '  react: &r 18.2.0', '  react-dom: *r') });
    const head = w.pr({ 'pnpm-workspace.yaml': lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.3.0', '  react-dom: 18.3.0') });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  // Guard: it passes today and must keep passing.
  it(`control: ${MEMBER} with only a plain change of description → success`, async () => {
    const w = memberWorld();
    w.pr({ [MEMBER]: lines('name: x', 'description: dos') });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

describe('fifth delta: a registry spec is written with the characters of semver', () => {
  const base = pkg((p) => { field(p, 'dependencies').esbuild = '^0.21.0'; });

  // `~/z` and `tags/next` already fail today (they hold a slash); they stay as guards of the rule.
  for (const [name, spec] of [
    ['helper', 'helper.tgz'],
    ['x', 'X.TAR.GZ'],
    ['y', 'y.tar'],
    ['z', '~/z'],
    ['w', '\\\\srv\\w'],
    ['t', 'release.candidate'],
    ['u', 'tags/next'],
  ] as const) {
    it(`package.json gains dependencies.${name} = ${JSON.stringify(spec)} → failure naming package.json`, async () => {
      const w = world({ 'package.json': base });
      const head = w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies').esbuild = '^0.21.0'; field(p, 'dependencies')[name] = spec; }) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('package.json');
    });
  }

  it('pnpm-workspace.yaml catalog gains helper: helper.tgz → failure naming it', async () => {
    const WORKSPACE = lines('packages:', '  - apps/*', '', 'catalog:', '  react: 18.2.0');
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    const head = w.pr({ 'pnpm-workspace.yaml': `${WORKSPACE}${lines('  helper: helper.tgz')}` });
    const report = await w.judge();
    expectRejectedForOwnFiles(w, head, report);
    expect(report.summary).toContain('pnpm-workspace.yaml');
  });

  // Guards: they pass today and must keep passing.
  for (const spec of ['^1.2.3', '1.x', '>=1 <2', '1.0.0-beta.1', 'latest', 'next']) {
    it(`control: dependencies.esbuild from ^0.21.0 to ${spec} → success`, async () => {
      const w = world({ 'package.json': base });
      w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies').esbuild = spec; }) });
      await w.judge();
      expect(states(w)).toEqual(['success']);
    });
  }
});

describe('fifth delta: .npmrc read the way the ini reader reads it', () => {
  for (const [what, npmrc] of [
    ['with an inline ; comment', 'only-built-dependencies-file=allow.json ; note\n'],
    ['with an inline # comment', 'only-built-dependencies-file=allow.json # note\n'],
    ['under a quoted key', '"only-built-dependencies-file"=allow.json\n'],
  ] as const) {
    it(`.npmrc names allow.json ${what}; allow.json edited → failure naming it`, async () => {
      const w = world({ '.npmrc': npmrc, 'allow.json': json(['esbuild']) });
      const head = w.pr({ 'allow.json': json(['esbuild', 'postinstall-x']) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('allow.json');
    });
  }
});

// Sixth delta review (PLAN-13-R6 §15): in YAML read by the judge, every map key must be a plain
// string. A null key (`~`) and a `""` key collide when the judge reads the document, while pnpm's
// reader keeps both (`null` and `""`), so a non-registry catalog entry could hide behind the empty
// one. Any non-string key (null, number, boolean, timestamp) makes the file touched.
describe('sixth delta: YAML keys must be plain strings', () => {
  const BASE = 'packages: ["."]\ncatalog:\n  "": 1.0.0\n';
  for (const [what, head] of [
    ['a null key next to an empty-string key', 'packages: ["."]\ncatalog:\n  ~: github:attacker/evil\n  "": 1.0.0\n'],
    ['the same keys in flow style', 'packages: ["."]\ncatalog: {~: "github:attacker/evil", "": 1.0.0}\n'],
    ['a null catalog name next to an empty one', 'packages: ["."]\ncatalogs:\n  ~:\n    x: github:a/b\n  "":\n    x: 1.0.0\n'],
    ['a number key', 'packages: ["."]\ncatalog:\n  "": 1.0.0\n  1: 2.0.0\n'],
    ['a boolean key', 'packages: ["."]\ncatalog:\n  "": 1.0.0\n  true: 2.0.0\n'],
  ] as const) {
    it(`pnpm-workspace.yaml with ${what} → failure`, async () => {
      const w = world({ 'pnpm-workspace.yaml': BASE });
      const pr = w.pr({ 'pnpm-workspace.yaml': head });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, pr, report);
    });
  }

  it('control: a plain string key added to the catalog of another package → success', async () => {
    const w = world({ 'pnpm-workspace.yaml': BASE });
    w.pr({ 'pnpm-workspace.yaml': 'packages: ["."]\ncatalog:\n  "": 1.0.0\n  react: 18.3.0\n' });
    await w.judge();
    expect(states(w)).toEqual(['success']);
  });
});

// Sixth delta review: `.npmrc` values end at any unescaped `;` or `#`, as the ini reader does.
describe('sixth delta: .npmrc comments without a space before them', () => {
  for (const [what, npmrc] of [
    ['a ; with no space', 'only-built-dependencies-file=allow.json;x\n'],
    ['a # with no space', 'only-built-dependencies-file=allow.json#x\n'],
  ] as const) {
    it(`.npmrc names allow.json with ${what}; allow.json edited → failure naming it`, async () => {
      const w = world({ '.npmrc': npmrc, 'allow.json': json(['esbuild']) });
      const head = w.pr({ 'allow.json': json(['esbuild', 'postinstall-x']) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('allow.json');
    });
  }
});

// Seventh delta review (PLAN-13-R6 §15): `.npmrc` single quotes and bare carriage returns read as
// ini reads them. ini strips single quotes and then JSON-decodes what is left when it can, and it
// ends a line at any `\r` or `\n`.
describe('seventh delta: .npmrc single quotes and bare carriage returns', () => {
  for (const [what, npmrc] of [
    ['a single-quoted JSON value', `only-built-dependencies-file='"allow.json"'\n`],
    ['a single-quoted JSON key', `'"only-built-dependencies-file"'=allow.json\n`],
    ['a line that ends with a bare carriage return', 'foo=bar\ronly-built-dependencies-file=allow.json\n'],
  ] as const) {
    it(`.npmrc names allow.json with ${what}; allow.json edited → failure naming it`, async () => {
      const w = world({ '.npmrc': npmrc, 'allow.json': json(['esbuild']) });
      const head = w.pr({ 'allow.json': json(['esbuild', 'postinstall-x']) });
      const report = await w.judge();
      expectRejectedForOwnFiles(w, head, report);
      expect(report.summary).toContain('allow.json');
    });
  }
});
