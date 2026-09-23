import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type Recipe,
} from '../src/index.js';

import { commit, emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13 RC-09 and PLAN-13-R2 §2.2 and §5: a module block of the project receives the same
// context as any gate — journal, locale, mode, cancellation signal and runEffect — and every
// external effect goes through runEffect. When the engine dies after the effect reached the
// world and before it was recorded, the next run asks the block to reconcile against the
// outside world instead of repeating it. The outside world here is a real git remote (a bare
// repository on disk); the same path against GitHub is in tests/github/.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const BLOCK_YML = lines(
  'kind: module',
  'natures: [recompute]',
  'inputs: { remote: { type: string, required: true }, dir: { type: string, required: true } }',
  'main: index.mjs',
);

/**
 * Opens a "pull request" by pushing a branch to the remote. If `crash-once` exists, it is
 * removed and the block throws right after the push — the engine dying between the effect and
 * its record. `reconcile` looks the branch up in the remote.
 */
const OPENER = (withReconcile: boolean) => [
  'import { execFileSync } from "node:child_process";',
  'import { existsSync, rmSync } from "node:fs";',
  'const branch = (piece) => `refs/heads/rc09-${piece}`;',
  'export default async function (context, inputs) {',
  '  const pushed = await context.runEffect("open-pr", async () => {',
  '    execFileSync("git", ["push", "-q", inputs.remote, `HEAD:${branch(context.piece)}`], { cwd: inputs.dir });',
  '    const crash = process.env.AIW_TEST_CRASH;',
  '    if (crash && existsSync(crash)) { rmSync(crash); throw new Error("the engine died here"); }',
  '    return { branch: branch(context.piece) };',
  '  });',
  '  return { ok: true, evidence: { pushed, recordCleanUpdate: typeof context.recordCleanUpdate, store: typeof context.store } };',
  '}',
  withReconcile
    ? [
        'export async function reconcile(operationId, context) {',
        '  if (operationId !== "open-pr") return undefined;',
        '  const found = execFileSync("git", ["ls-remote", process.env.AIW_TEST_REMOTE, branch(context.piece)], { encoding: "utf8" });',
        '  return found.trim() === "" ? { didNotHappen: true } : { confirmed: { branch: branch(context.piece) } };',
        '}',
      ].join('\n')
    : '',
  '',
].join('\n');

const HOLD = 'process.stdout.write(JSON.stringify({ ok: false, reason: "held" }));\n';

async function setUp(withReconcile: boolean, crash: boolean) {
  const remote = emptyFolder();
  git(remote, 'init', '-q', '--bare');
  process.env.AIW_TEST_REMOTE = remote;
  const root = repository();
  write(root, '.ai-workflows/blocks/opener/block.yml', BLOCK_YML);
  write(root, '.ai-workflows/blocks/opener/index.mjs', OPENER(withReconcile));
  write(root, 'hold.mjs', HOLD);
  commit(root, 'blocks');
  const marker = join(remote, 'crash-once');
  process.env.AIW_TEST_CRASH = marker;
  if (crash) write(remote, 'crash-once', 'x');
  const recipe = recipeOf(lines(
    'version: 1',
    'locale: es',
    'stages:',
    '  - id: open',
    '    summary: "Abre la solicitud de cambio"',
    '    nature: recompute',
    '    gate:',
    '      uses: ./.ai-workflows/blocks/opener',
    `      with: { remote: "${remote.replace(/\\/g, '/')}", dir: "${root.replace(/\\/g, '/')}" }`,
    '  - id: merge',
    '    summary: "Se une"',
    '    after: open',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      run: node hold.mjs',
  ));
  const store = createMemoryStore();
  const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
  const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
  const branches = () => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n').filter(Boolean);
  return { root, remote, marker, store, engine, branches };
}

describe('RC-09: an effect in doubt is reconciled, never repeated', () => {
  it('after dying between the effect and its record, the next run reconciles and does not push twice', async () => {
    const { marker, store, engine, branches } = await setUp(true, true);
    const first = await engine.run('42');
    expect(first).toMatchObject({ outcome: 'ran', status: { state: 'blocked:technical', stage: 'open' } });
    expect(branches()).toEqual(['refs/heads/rc09-42']);
    expect(existsSync(marker)).toBe(false);

    const second = await engine.run('42');
    expect(second).toMatchObject({ outcome: 'ran', status: { state: 'blocked:rejected', stage: 'merge' } });
    expect(branches()).toEqual(['refs/heads/rc09-42']);
    expect(await store.getEffect('42', 'open-pr')).toEqual({ state: 'confirmed', result: { branch: 'refs/heads/rc09-42' } });
  }, 30_000);

  it('when the effect did not happen, reconciling lets it run once', async () => {
    const { store, engine, branches, remote } = await setUp(true, true);
    await engine.run('42');
    git(remote, 'update-ref', '-d', 'refs/heads/rc09-42');
    await engine.run('42');
    expect(branches()).toEqual(['refs/heads/rc09-42']);
    expect((await store.getEffect('42', 'open-pr'))?.state).toBe('confirmed');
  }, 30_000);

  it('a block that cannot reconcile leaves the piece blocked, naming the effect', async () => {
    const { engine, branches } = await setUp(false, true);
    await engine.run('42');
    const second = await engine.run('42');
    expect(second).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:technical', stage: 'open', reason: expect.stringMatching(/"open-pr"/) },
    });
    expect(branches()).toEqual(['refs/heads/rc09-42']);
  }, 30_000);

  it('positive: without an interruption the effect happens exactly once', async () => {
    const { engine, branches } = await setUp(true, false);
    await engine.run('42');
    await engine.run('42');
    expect(branches()).toEqual(['refs/heads/rc09-42']);
  }, 30_000);
});

describe('§6: a project block holds none of the engine privileges', () => {
  it('finds neither recordCleanUpdate nor the store in its context', async () => {
    const { store, engine } = await setUp(true, false);
    await engine.run('42');
    const entry = (await store.journal('42')).find((item) => item.stage === 'open');
    expect(entry?.evidence).toMatchObject({ block: { recordCleanUpdate: 'undefined', store: 'undefined' } });
  }, 30_000);
});

describe('§2.2: a module block that throws', () => {
  it('is a technical block with its message, never a pass', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/boom/block.yml', lines('kind: module', 'natures: [recompute]', 'main: index.mjs'));
    write(root, '.ai-workflows/blocks/boom/index.mjs', 'export default () => { throw new Error("se rompió"); };\n');
    write(root, 'hold.mjs', HOLD);
    commit(root, 'block');
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: boom',
      '    summary: "Revienta"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/boom',
    ));
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    expect(await engine.run('42')).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:technical', stage: 'boom', reason: expect.stringMatching(/se rompió/) },
    });
  });
});

describe('§2.2: a module block knows the folder of the project it judges', () => {
  it('receives the project root, so its commands never act on another repository', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/where/block.yml', lines('kind: module', 'natures: [recompute]', 'main: index.mjs'));
    write(root, '.ai-workflows/blocks/where/index.mjs', 'export default (context, inputs, project) => ({ ok: true, evidence: { root: project.root } });\n');
    commit(root, 'block');
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: where',
      '    summary: "Dónde"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/where',
    ));
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    await engine.run('42');
    const entry = (await store.journal('42')).find((item) => item.stage === 'where');
    const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
    expect(normalize((entry?.evidence as { block: { root: string } }).block.root)).toBe(normalize(root));
  });
});
