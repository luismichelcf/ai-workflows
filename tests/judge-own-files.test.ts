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
    ['an override for another package whose name only starts like the engine', pkg((p) => { p.overrides = { 'ai-workflows-extra': '1.0.0', react: '18.3.1' }; })],
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

  it('another folder in packages → success', async () => {
    const w = world({ 'pnpm-workspace.yaml': WORKSPACE });
    w.pr({ 'pnpm-workspace.yaml': WORKSPACE.replace('  - apps/*', '  - apps/*\n  - libs/*') });
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

  it('an alias under another key ("x": "npm:ai-workflows@9.9.9"), the ai-workflows key untouched → success', async () => {
    const w = world({ 'package.json': json(BASE_PACKAGE) });
    w.pr({ 'package.json': pkg((p) => { field(p, 'dependencies').x = 'npm:ai-workflows@9.9.9'; }) });
    await w.judge();
    expect(states(w)).toEqual(['success']);
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
