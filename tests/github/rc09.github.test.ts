import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { compileRecipe, createEngine, createMemoryStore, parseRecipe, type Recipe } from '../../src/index.js';

import { emptyFolder, git, removeRepositories, write } from '../git-fixtures.js';

// PLAN-13 RC-09 against GitHub itself (PLAN-13-R2 §7): a module block opens a real pull request
// through runEffect, the engine "dies" right after it is opened and before it is recorded, and
// the next run reconciles against GitHub instead of opening a second one.
//
// It needs credentials, so it never runs in the public CI. It runs only through
// `pnpm test:github` with AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo> pointing at the test
// repository (socialabs-margin/ai-workflows-pruebas), and it FAILS — never skips — when asked
// to run without that variable or without a logged-in `gh`. It closes the pull request and
// deletes the branch it made, whatever happens.

const REPO = process.env.AI_WORKFLOWS_GITHUB_TEST_REPO ?? '';
const gh = (...args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' }).trim();

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const BRANCH = `rc09-${randomUUID().slice(0, 8)}`;

afterAll(() => {
  if (REPO !== '') {
    try {
      for (const number of gh('pr', 'list', '--repo', REPO, '--head', BRANCH, '--state', 'all', '--json', 'number', '--jq', '.[].number').split('\n').filter(Boolean)) {
        gh('pr', 'close', number, '--repo', REPO, '--delete-branch');
      }
    } finally {
      try {
        gh('api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${BRANCH}`);
      } catch {
        // Already deleted by `pr close --delete-branch`: there is nothing left to remove.
      }
      removeRepositories();
    }
  }
});

const OPENER = [
  'import { execFileSync } from "node:child_process";',
  'import { existsSync, rmSync } from "node:fs";',
  'const run = (cmd, args, cwd) => execFileSync(cmd, args, { encoding: "utf8", cwd }).trim();',
  'export default async function (context, inputs) {',
  '  const pr = await context.runEffect("open-pr", async () => {',
  '    run("git", ["push", "-q", "origin", `HEAD:refs/heads/${inputs.branch}`], inputs.dir);',
  '    const url = run("gh", ["pr", "create", "--repo", inputs.repo, "--head", inputs.branch, "--base", inputs.base, "--title", "RC-09 prueba del motor", "--body", "Prueba automática de ai-workflows; se cierra sola."], inputs.dir);',
  '    const crash = process.env.AIW_TEST_CRASH;',
  '    if (crash && existsSync(crash)) { rmSync(crash); throw new Error("the engine died here"); }',
  '    return { url };',
  '  });',
  '  return { ok: true, evidence: pr };',
  '}',
  'export async function reconcile(operationId, context) {',
  '  if (operationId !== "open-pr") return undefined;',
  '  const branch = process.env.AIW_TEST_BRANCH;',
  '  const found = run("gh", ["pr", "list", "--repo", process.env.AI_WORKFLOWS_GITHUB_TEST_REPO, "--head", branch, "--state", "all", "--json", "url", "--jq", ".[0].url // empty"]);',
  '  return found === "" ? { didNotHappen: true } : { confirmed: { url: found } };',
  '}',
  '',
].join('\n');

describe('RC-09 against GitHub', () => {
  it('is asked to run with a test repository and a logged-in gh', () => {
    expect(REPO, 'set AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo>').toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(() => gh('auth', 'status')).not.toThrow();
  });

  it('opens exactly one pull request although the engine died after opening it', async () => {
    const root = emptyFolder();
    git(root, 'clone', '-q', '--depth', '1', `https://github.com/${REPO}.git`, '.');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'ai-workflows test');
    const base = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(root, 'switch', '-q', '-c', BRANCH);
    write(root, '.ai-workflows/blocks/opener/block.yml', lines(
      'kind: module',
      'natures: [recompute]',
      'inputs:',
      '  repo: { type: string, required: true }',
      '  branch: { type: string, required: true }',
      '  base: { type: string, required: true }',
      '  dir: { type: string, required: true }',
      'main: index.mjs',
    ));
    write(root, '.ai-workflows/blocks/opener/index.mjs', OPENER);
    write(root, `rc09/${BRANCH}.md`, `Prueba RC-09 ${BRANCH}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `RC-09 ${BRANCH}`);

    const marker = join(emptyFolder(), 'crash-once');
    write(join(marker, '..'), 'crash-once', 'x');
    process.env.AIW_TEST_CRASH = marker;
    process.env.AIW_TEST_BRANCH = BRANCH;

    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: open',
      '    summary: "Abre la solicitud de cambio"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/opener',
      `      with: { repo: "${REPO}", branch: "${BRANCH}", base: "${base}", dir: "${root.replace(/\\/g, '/')}" }`,
    ));
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: `origin/${base}`, declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });

    const first = await engine.run('rc09');
    expect(first, JSON.stringify(first)).toMatchObject({ status: { state: 'blocked:technical', reason: expect.stringMatching(/the engine died here/) } });
    const second = await engine.run('rc09');
    expect(second, JSON.stringify(second)).toMatchObject({ status: { state: 'done' } });

    const opened = gh('pr', 'list', '--repo', REPO, '--head', BRANCH, '--state', 'all', '--json', 'number', '--jq', 'length');
    expect(opened).toBe('1');
  }, 180_000);
});
