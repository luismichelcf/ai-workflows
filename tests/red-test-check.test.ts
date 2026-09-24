import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runRedTestCheck } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R3 §5: the unprivileged job `ai-workflows/red-test`. For each piece the red-test stage
// applies to, the new or changed tests must fail by their assertion against the base and pass
// against the head. The recipe comes from the trusted commit (the live head of main); the base
// of each PR in a merge group is the base of its own queue entry. Git and the processes are real;
// the project carries a tiny runner that prints what Vitest prints, like tests/blocks-tdd.test.ts.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const RUNNER = [
  'import { pathToFileURL } from "node:url";',
  'import { resolve } from "node:path";',
  'const files = process.argv.slice(2);',
  'let passedCount = 0; let failedCount = 0; let broken = 0; const out = [];',
  'for (const file of files) {',
  '  let mod;',
  '  try { mod = await import(pathToFileURL(resolve(file)).href + "?t=" + Date.now()); }',
  '  catch (error) { broken += 1; out.push(` FAIL  ${file} [ ${file} ]`, `Error: Failed to load ${error.message.split("\\n")[0]}`); continue; }',
  '  for (const [name, fn] of Object.entries(mod.cases ?? {})) {',
  '    try { await fn(); passedCount += 1; }',
  '    catch (error) { failedCount += 1; out.push(` FAIL  ${file} > ${name}`, `AssertionError: ${error.message.split("\\n")[0]}`); }',
  '  }',
  '}',
  'if (out.length > 0) console.log(out.join("\\n"));',
  'const total = passedCount + failedCount;',
  'const failedFiles = broken + (failedCount > 0 ? 1 : 0);',
  'console.log(failedFiles > 0 ? ` Test Files  ${failedFiles} failed (${files.length})` : ` Test Files  ${files.length} passed (${files.length})`);',
  'let tests = "no tests";',
  'if (total > 0 && failedCount > 0 && passedCount > 0) tests = `${failedCount} failed | ${passedCount} passed (${total})`;',
  'if (total > 0 && failedCount > 0 && passedCount === 0) tests = `${failedCount} failed (${total})`;',
  'if (total > 0 && failedCount === 0) tests = `${passedCount} passed (${total})`;',
  'console.log(`      Tests  ${tests}`);',
  'process.exitCode = failedCount + broken > 0 ? 1 : 0;',
  '',
].join('\n');

const RECIPE = lines(
  'version: 1',
  'locale: es',
  'kinds:',
  '  names: [behavior, docs]',
  '  default: behavior',
  '  from-paths: { docs: ["docs/**"] }',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'stages:',
  '  - id: red-test',
  '    summary: "Primero una prueba que falla"',
  '    nature: execution-record',
  '    applies-if: { kind-any: [behavior] }',
  '    valid-while: forever',
  '    gate:',
  '      uses: ai-workflows/red-test@1',
  '      with: { command: "node runner.mjs {tests}", tests: ["tests/**/*.test.mjs"] }',
  '    server: { require-check: ai-workflows/red-test }',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: red-test',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const BONUS = (amount: number) => `export const bonus = () => ${amount};\n`;
const FEE = (amount: number) => `export const fee = () => ${amount};\n`;

const BONUS_TEST = lines(
  'import assert from "node:assert/strict";',
  'import { bonus } from "../src/bonus.mjs";',
  'export const cases = {',
  '  "paga el bono completo": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`),',
  '};',
);

const FEE_TEST = lines(
  'import assert from "node:assert/strict";',
  'import { fee } from "../src/fee.mjs";',
  'export const cases = {',
  '  "cobra la comisión": () => assert.equal(fee(), 30, `expected ${fee()} to be 30`),',
  '};',
);

interface Entry { position: number; headSha: string; baseSha: string; prNumber: number }

function project(extra: Readonly<Record<string, string>> = {}) {
  const root = repository({
    '.ai-workflows/pipeline.yml': RECIPE,
    '.gitignore': 'node_modules/\n',
    'runner.mjs': RUNNER,
    'src/bonus.mjs': BONUS(800),
    'src/fee.mjs': FEE(10),
    ...extra,
  });
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const prs = new Map<number, { headSha: string; headRef: string }>();
  const github = {
    queue: [] as Entry[],
    mainHead: main,
    async defaultBranch() {
      return 'main';
    },
    async branchHead() {
      return github.mainHead;
    },
    /** Successive answers of the queue list, for a queue that shows the group late; then `queue`. */
    queueSequence: [] as Entry[][],
    queueReads: 0,
    async mergeQueue() {
      github.queueReads += 1;
      const next = github.queueSequence.shift();
      return next ?? github.queue;
    },
    async pullRequest(n: number) {
      const pr = prs.get(n);
      if (pr === undefined) throw new Error(`no PR ${n}`);
      return { number: n, state: 'open', headSha: pr.headSha, headRef: pr.headRef, baseRef: 'main', headRepo: 'duena/proyecto' };
    },
  };

  return {
    root,
    main,
    github,
    pr(n: number, branch: string, files: Readonly<Record<string, string>>): string {
      git(root, 'switch', '-q', '-c', `pr-${n}`, main);
      for (const [path, content] of Object.entries(files)) write(root, path, content);
      const head = commit(root, `PR ${n}`);
      git(root, 'switch', '-q', 'main');
      prs.set(n, { headSha: head, headRef: branch });
      return head;
    },
    /** The checkout the job would have: the head being tested. */
    checkout(sha: string): void {
      git(root, 'switch', '-q', '--detach', sha);
    },
    pullRequestEvent(n: number) {
      const pr = prs.get(n);
      return {
        eventName: 'pull_request',
        event: { pull_request: { number: n, head: { sha: pr?.headSha, ref: pr?.headRef }, base: { sha: main, ref: 'main' } } },
        root,
        repository: 'duena/proyecto',
      };
    },
    deps() {
      return { github, fetchObjects: async () => {}, sleep: async () => {} };
    },
  };
}

describe('§5: a pull request', () => {
  it('positive: the new test fails against the base by its assertion and passes against the head', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    p.checkout(head);

    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());

    expect(result).toEqual({ ok: true, summary: expect.stringContaining('red-test') });
  });

  it('a test that already passes against the base is not red', async () => {
    const p = project({ 'src/bonus.mjs': BONUS(1000) });
    const head = p.pr(7, 'feat/13-bono', { 'tests/bonus.test.mjs': BONUS_TEST, 'src/other.mjs': 'x\n' });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result).toEqual({ ok: false, summary: expect.stringMatching(/no está roja|pasó/) });
  });

  it('a test that fails against the base by import, not by its assertion, does not count', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-nuevo', {
      'src/nuevo.mjs': 'export const nuevo = () => 1;\n',
      'tests/nuevo.test.mjs': lines(
        'import assert from "node:assert/strict";',
        'import { nuevo } from "../src/nuevo.mjs";',
        'export const cases = { "uno": () => assert.equal(nuevo(), 1) };',
      ),
    });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result).toEqual({ ok: false, summary: expect.stringMatching(/importación|entorno/) });
  });

  it('a test that fails against the head fails the check', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(900), 'tests/bonus.test.mjs': BONUS_TEST });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result.ok).toBe(false);
  });

  it('a behavior piece without tests fails, saying so', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000) });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result).toEqual({ ok: false, summary: expect.stringMatching(/no trae pruebas/) });
  });

  it('a piece the stage does not apply to passes, saying so', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-docs', { 'docs/nota.md': 'nota\n' });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result).toEqual({ ok: true, summary: expect.stringMatching(/No aplica/) });
  });

  it('runs the base with the dependencies installed from the head (a dependency the PR adds)', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-dep', {
      'src/bonus.mjs': 'import { base } from "dep";\nexport const bonus = () => base * 10;\n',
      'tests/bonus.test.mjs': lines(
        'import assert from "node:assert/strict";',
        'import { base } from "dep";',
        'import { bonus } from "../src/bonus.mjs";',
        'export const cases = { "bono": () => assert.equal(bonus(), base * 10, `expected ${bonus()}`) };',
      ),
    });
    p.checkout(head);
    // Installed by the project's own step from the head: not committed.
    mkdirSync(join(p.root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(p.root, 'node_modules', 'dep', 'package.json'), '{"name":"dep","type":"module","main":"index.mjs"}');
    writeFileSync(join(p.root, 'node_modules', 'dep', 'index.mjs'), 'export const base = 100;\n');

    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());

    expect(result).toEqual({ ok: true, summary: expect.any(String) });
  });

  it('the test processes see no token nor secret of the job', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-bono', {
      'src/bonus.mjs': BONUS(1000),
      'tests/bonus.test.mjs': lines(
        'import assert from "node:assert/strict";',
        'import { bonus } from "../src/bonus.mjs";',
        'const leaked = Object.keys(process.env).filter((name) => /TOKEN|SECRET|PASSWORD|KEY|^ACTIONS_|^GH_/i.test(name));',
        'export const cases = {',
        '  "paga el bono completo": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`),',
        '  "no ve secretos": () => assert.deepEqual(leaked, [], `leaked ${leaked.join(",")}`),',
        '};',
      ),
    });
    p.checkout(head);
    const planted = ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'MY_SECRET', 'DB_PASSWORD', 'AWS_ACCESS_KEY_ID'];
    for (const name of planted) process.env[name] = 'x';
    try {
      const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
      expect(result).toEqual({ ok: true, summary: expect.any(String) });
    } finally {
      for (const name of planted) delete process.env[name];
    }
  });

  it('reads the recipe from the live head of main, not from the base of the event', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000) });
    // Main moves on and drops the red-test stage; the event still names the old base.
    write(p.root, '.ai-workflows/pipeline.yml', RECIPE.replace(/ {2}- id: red-test[\s\S]*?require-check: ai-workflows\/red-test \}\n/, '').replace('    after: red-test\n', ''));
    p.github.mainHead = commit(p.root, 'main drops the stage');
    p.checkout(head);

    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());

    // Without the stage on main, nothing applies: the piece without tests passes.
    expect(result.ok).toBe(true);
  });
});

describe('§5: a merge group', () => {
  function chained() {
    const p = project();
    const seven = p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    const eight = p.pr(8, 'feat/14-fee', { 'src/fee.mjs': FEE(30), 'tests/fee.test.mjs': FEE_TEST });
    git(p.root, 'switch', '-q', '--detach', p.main);
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-7');
    const g1 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-8');
    const g2 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'switch', '-q', 'main');
    p.github.queue = [
      { position: 1, headSha: g1, baseSha: p.main, prNumber: 7 },
      { position: 2, headSha: g2, baseSha: g1, prNumber: 8 },
    ];
    return { p, seven, eight, g1, g2 };
  }

  const groupEvent = (p: ReturnType<typeof project>, head: string, base: string) => ({
    eventName: 'merge_group',
    event: { merge_group: { head_sha: head, base_sha: base } },
    root: p.root,
    repository: 'duena/proyecto',
  });

  it('each PR is tested against the base of its own entry, so an earlier PR in the base does not make it pass', async () => {
    const { p, g1, g2 } = chained();
    p.checkout(g2);
    // The group of PR 8 was built on g1, which already contains PR 7.
    const result = await runRedTestCheck(groupEvent(p, g2, g1), p.deps());
    expect(result).toEqual({ ok: true, summary: expect.stringMatching(/#7[\s\S]*#8|#8[\s\S]*#7/) });
  });

  it('a PR of the group whose test does not fail against its base fails the group', async () => {
    const p = project({ 'src/fee.mjs': FEE(30) });
    p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    p.pr(8, 'feat/14-fee', { 'tests/fee.test.mjs': FEE_TEST, 'src/x.mjs': 'x\n' });
    git(p.root, 'switch', '-q', '--detach', p.main);
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-7');
    const g1 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-8');
    const g2 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'switch', '-q', 'main');
    p.github.queue = [
      { position: 1, headSha: g1, baseSha: p.main, prNumber: 7 },
      { position: 2, headSha: g2, baseSha: g1, prNumber: 8 },
    ];
    p.checkout(g2);
    const result = await runRedTestCheck(groupEvent(p, g2, p.main), p.deps());
    expect(result).toEqual({ ok: false, summary: expect.stringContaining('#8') });
  });

  it('the recipe comes from main even when an earlier PR of the queue removed the stage', async () => {
    const p = project();
    p.pr(7, 'feat/13-receta', {
      '.ai-workflows/pipeline.yml': RECIPE.replace(/ {2}- id: red-test[\s\S]*?require-check: ai-workflows\/red-test \}\n/, '').replace('    after: red-test\n', ''),
    });
    p.pr(8, 'feat/14-sin-prueba', { 'src/fee.mjs': FEE(30) });
    git(p.root, 'switch', '-q', '--detach', p.main);
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-7');
    const g1 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-8');
    const g2 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'switch', '-q', 'main');
    p.github.queue = [
      { position: 1, headSha: g1, baseSha: p.main, prNumber: 7 },
      { position: 2, headSha: g2, baseSha: g1, prNumber: 8 },
    ];
    p.checkout(g2);
    const result = await runRedTestCheck(groupEvent(p, g2, g1), p.deps());
    // PR 8 is behavior without tests: the stage of main applies and it fails.
    expect(result).toEqual({ ok: false, summary: expect.stringMatching(/#8[\s\S]*no trae pruebas/) });
  });

  it('a queue that does not list the group fails, never passes', async () => {
    const { p, g2, g1 } = chained();
    p.github.queue = [];
    p.checkout(g2);
    const result = await runRedTestCheck(groupEvent(p, g2, g1), p.deps());
    expect(result.ok).toBe(false);
  });
});

describe('flock 1: red-test-check', () => {
  const groupEvent = (p: ReturnType<typeof project>, head: string, base: string) => ({
    eventName: 'merge_group',
    event: { merge_group: { head_sha: head, base_sha: base } },
    root: p.root,
    repository: 'duena/proyecto',
  });

  function queueOf(p: ReturnType<typeof project>, prs: number[]): string[] {
    git(p.root, 'switch', '-q', '--detach', p.main);
    const heads: string[] = [];
    let base = p.main;
    p.github.queue = [];
    prs.forEach((n, index) => {
      git(p.root, 'merge', '-q', '--no-ff', '--no-edit', `pr-${n}`);
      const head = git(p.root, 'rev-parse', 'HEAD');
      p.github.queue.push({ position: index + 1, headSha: head, baseSha: base, prNumber: n });
      heads.push(head);
      base = head;
    });
    git(p.root, 'switch', '-q', 'main');
    return heads;
  }

  it('a PR whose test needs what an earlier PR of the queue brought is tested against its own entry base', async () => {
    const p = project();
    p.pr(7, 'feat/13-base', { 'src/rate.mjs': 'export const rate = () => 3;\n', 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    p.pr(8, 'feat/14-uso', {
      'src/fee.mjs': 'import { rate } from "./rate.mjs";\nexport const fee = () => rate() * 10;\n',
      'tests/fee.test.mjs': lines(
        'import assert from "node:assert/strict";',
        'import { rate } from "../src/rate.mjs";',
        'import { fee } from "../src/fee.mjs";',
        'export const cases = { "cobra por tasa": () => assert.equal(fee(), rate() * 10, `expected ${fee()}`) };',
      ),
    });
    const [g1, g2] = queueOf(p, [7, 8]);
    p.checkout(g2 as string);
    const result = await runRedTestCheck(groupEvent(p, g2 as string, g1 as string), p.deps());
    expect(result, result.summary).toEqual({ ok: true, summary: expect.any(String) });
  });

  it('in a merge group, main must be an ancestor of the group', async () => {
    const p = project();
    p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    const [g1] = queueOf(p, [7]);
    write(p.root, 'README.md', 'otra\n');
    p.github.mainHead = commit(p.root, 'main moves elsewhere');
    p.checkout(g1 as string);
    const result = await runRedTestCheck(groupEvent(p, g1 as string, p.main), p.deps());
    expect(result).toEqual({ ok: false, summary: expect.stringMatching(/ancestro|ancestor/) });
  });

  it('with locale: en, the summary is in English', async () => {
    const p = project({ '.ai-workflows/pipeline.yml': RECIPE.replace('locale: es', 'locale: en') });
    const head = p.pr(7, 'feat/13-docs', { 'docs/nota.md': 'nota\n' });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result.summary).toMatch(/Does not apply/);
    expect(result.summary).not.toMatch(/No aplica|Etapa/);
  });

  it('escapes what comes from the pull request in the summary', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-x|<b>y', { 'src/bonus.mjs': BONUS(1000) });
    p.checkout(head);
    const result = await runRedTestCheck(p.pullRequestEvent(7), p.deps());
    expect(result.summary).not.toContain('<b>');
  });
});

describe('flock 2: red-test-check and a PR into another branch', () => {
  it('a PR into another branch is not tested, and the check does not pass', async () => {
    const p = project();
    const head = p.pr(7, 'feat/13-sin-pruebas', { 'src/bonus.mjs': BONUS(1000) });
    p.checkout(head);
    const event = p.pullRequestEvent(7);
    (event.event as { pull_request: { base: { ref: string } } }).pull_request.base.ref = 'develop';
    const result = await runRedTestCheck(event, p.deps());
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/develop/);
  });
});

describe('flock 4: a queue that lists the group late', () => {
  const groupEvent = (p: ReturnType<typeof project>, head: string, base: string) => ({
    eventName: 'merge_group',
    event: { merge_group: { head_sha: head, base_sha: base } },
    root: p.root,
    repository: 'duena/proyecto',
  });

  function oneGroup() {
    const p = project();
    p.pr(7, 'feat/13-bono', { 'src/bonus.mjs': BONUS(1000), 'tests/bonus.test.mjs': BONUS_TEST });
    git(p.root, 'switch', '-q', '--detach', p.main);
    git(p.root, 'merge', '-q', '--no-ff', '--no-edit', 'pr-7');
    const g1 = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'switch', '-q', 'main');
    p.github.queue = [{ position: 1, headSha: g1, baseSha: p.main, prNumber: 7 }];
    p.checkout(g1);
    return { p, g1 };
  }

  it('reads the list again, waiting, until it shows the group', async () => {
    const { p, g1 } = oneGroup();
    p.github.queueSequence = [[], []];
    const result = await runRedTestCheck(groupEvent(p, g1, p.main), p.deps());
    expect(result, result.summary).toEqual({ ok: true, summary: expect.any(String) });
    expect(p.github.queueReads).toBe(3);
  });

  it('gives up after several reads that never show the group, and fails', async () => {
    const { p, g1 } = oneGroup();
    p.github.queueSequence = Array.from({ length: 50 }, () => []);
    const result = await runRedTestCheck(groupEvent(p, g1, p.main), p.deps());
    expect(result.ok).toBe(false);
    expect(p.github.queueReads).toBeGreaterThan(1);
    expect(p.github.queueReads).toBeLessThan(50);
  });
});
