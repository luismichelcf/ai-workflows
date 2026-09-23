import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type Recipe,
} from '../src/index.js';

import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13 RC-03 and PLAN-13-R2 §2.2: a command block is a separate program with a strict
// contract. It reads the change as JSON on standard input and prints exactly one JSON object
// with `ok`, `reason` and `evidence`. Anything else — a non-zero exit, text that is not that
// object, a missing or unknown key, running out of time, printing too much, a program that
// does not exist — is a technical block, never an approval. `{ok:false}` is an ordinary
// rejection. The programs here are real Node scripts in a real repository.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

/** A recipe whose first stage runs `node block.mjs` from the project root. */
const commandRecipe = (run = 'node block.mjs', nature = 'recompute') => recipeOf(lines(
  'version: 1',
  'locale: es',
  'stages:',
  '  - id: check',
  '    summary: "Comprobación del proyecto"',
  `    nature: ${nature}`,
  '    gate:',
  `      run: ${run}`,
  '      with: { level: 3, names: [a, b] }',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: check',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node hold.mjs',
));

const HOLD = 'process.stdout.write(JSON.stringify({ ok: false, reason: "held" }));\n';

/** Runs the piece once with `script` as block.mjs and returns the outcome and journal. */
async function runWith(script: string, options: { run?: string; timeoutMs?: number; stdoutBytes?: number } = {}) {
  const root = repository();
  write(root, 'block.mjs', script);
  write(root, 'hold.mjs', HOLD);
  commit(root, 'blocks');
  const store = createMemoryStore();
  const compiled = await compileRecipe(commandRecipe(options.run), {
    root,
    baseRef: 'main',
    declared: () => ({}),
    store,
    limits: {
      ...(options.timeoutMs === undefined ? {} : { commandTimeoutMs: options.timeoutMs }),
      ...(options.stdoutBytes === undefined ? {} : { stdoutBytes: options.stdoutBytes }),
    },
  });
  const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
  const outcome = await engine.run('42');
  return { outcome, journal: await store.journal('42'), root };
}

const technical = (reason: RegExp) =>
  expect.objectContaining({
    outcome: 'ran',
    status: expect.objectContaining({ state: 'blocked:technical', stage: 'check', reason: expect.stringMatching(reason) }),
  });

describe('RC-03: a command block that breaks its contract never passes', () => {
  it('exits with 1', async () => {
    const { outcome, journal } = await runWith('process.stdout.write(JSON.stringify({ ok: true })); process.exit(1);\n');
    expect(outcome).toEqual(technical(/exited with code 1/));
    expect(journal.some((entry) => entry.stage === 'check' && entry.outcome === 'passed')).toBe(false);
  });

  it('prints text that is not JSON', async () => {
    expect((await runWith('process.stdout.write("todo bien");\n')).outcome).toEqual(technical(/not a JSON object/));
  });

  it('prints the object with other text around it', async () => {
    const script = 'process.stdout.write("log line\\n" + JSON.stringify({ ok: true }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/not a JSON object/));
  });

  it('prints two objects', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true }) + JSON.stringify({ ok: true }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/not a JSON object/));
  });

  it('leaves out ok', async () => {
    const script = 'process.stdout.write(JSON.stringify({ reason: "fine" }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/"ok" is missing/));
  });

  it('answers ok with something that is not true, false or "skipped"', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: "yes" }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/"ok" must be true, false or "skipped"/));
  });

  it('adds a key the contract does not have', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, approved: true }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/unknown key "approved"/));
  });

  it('says false or skipped without a reason', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: false }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/"reason" is required/));
  });

  it('runs out of time', async () => {
    const script = 'setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 10000);\n';
    expect((await runWith(script, { timeoutMs: 500 })).outcome).toEqual(technical(/ran out of time/));
  });

  it('prints more than the limit', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, reason: "x".repeat(4096) }));\n';
    expect((await runWith(script, { stdoutBytes: 1024 })).outcome).toEqual(technical(/printed more than/));
  });

  it('is a program that does not exist', async () => {
    const { outcome } = await runWith('', { run: 'no-such-program-aiw-13' });
    expect(outcome).toEqual(technical(/could not start|not found/));
  });

  it('by default allows 1 MB of output and no more', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, evidence: "x".repeat(1024 * 1024 + 10) }));\n';
    expect((await runWith(script)).outcome).toEqual(technical(/printed more than/));
  });
});

describe('RC-03: what a command block may answer', () => {
  it('ok: false with a reason is an ordinary rejection, in its own words', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: false, reason: "faltan dos fuentes" }));\n';
    expect((await runWith(script)).outcome).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:rejected', stage: 'check', reason: 'faltan dos fuentes' },
    });
  });

  it('ok: "skipped" with a reason is recorded as skipped, never as passed', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: "skipped", reason: "no aplica aquí" }));\n';
    const { journal } = await runWith(script);
    expect(journal.find((entry) => entry.stage === 'check')).toMatchObject({ outcome: 'skipped', reason: 'no aplica aquí' });
  });

  it('positive: { "ok": true } passes and its evidence is kept under block', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, evidence: { counted: 5 } }));\n';
    const { outcome, journal } = await runWith(script);
    expect(outcome).toMatchObject({ outcome: 'ran', status: { state: 'blocked:rejected', stage: 'merge' } });
    expect(journal.find((entry) => entry.stage === 'check')).toMatchObject({
      outcome: 'passed',
      evidence: { block: { counted: 5 } },
    });
  });
});

describe('§2.2: what a command block receives', () => {
  it('reads the change, its inputs and the journal as JSON on standard input', async () => {
    const script = [
      'let text = "";',
      'process.stdin.on("data", (chunk) => { text += chunk; });',
      'process.stdin.on("end", () => {',
      '  const input = JSON.parse(text);',
      '  process.stdout.write(JSON.stringify({ ok: true, evidence: input }));',
      '});',
      '',
    ].join('\n');
    const { journal, root } = await runWith(script);
    const evidence = journal.find((entry) => entry.stage === 'check')?.evidence as { block: Record<string, unknown> };
    expect(Object.keys(evidence.block).sort()).toEqual(
      ['base', 'classes', 'files', 'journal', 'kind', 'lane', 'mode', 'piece', 'sha', 'with'].sort(),
    );
    expect(evidence.block).toMatchObject({
      piece: '42',
      mode: 'run',
      files: ['block.mjs', 'hold.mjs'],
      with: { level: 3, names: ['a', 'b'] },
      journal: [],
    });
    expect(root).toBeTruthy();
  });

  it('runs from the project root, with {piece} replaced inside an argument', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, evidence: { cwd: process.cwd(), args: process.argv.slice(2) } }));\n';
    const { journal, root } = await runWith(script, { run: 'node block.mjs --piece={piece} plain' });
    const evidence = journal.find((entry) => entry.stage === 'check')?.evidence as { block: { cwd: string; args: string[] } };
    // The engine resolves the root to its real path (long names, not Windows 8.3 short ones).
    const normalize = (path: string) => realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
    expect(normalize(evidence.block.cwd)).toBe(normalize(root));
    expect(evidence.block.args).toEqual(['--piece=42', 'plain']);
  });

  it('replaces {tests} with one argument per test file of the change', async () => {
    const root = repository();
    write(root, 'block.mjs', 'process.stdout.write(JSON.stringify({ ok: true, evidence: process.argv.slice(2) }));\n');
    write(root, 'hold.mjs', HOLD);
    write(root, 'tests/a.test.ts', 'a\n');
    write(root, 'tests/b.test.ts', 'b\n');
    commit(root, 'blocks');
    const store = createMemoryStore();
    const compiled = await compileRecipe(commandRecipe('node block.mjs {tests}'), {
      root,
      baseRef: 'main',
      declared: () => ({}),
      store,
    });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    await engine.run('42');
    const entry = (await store.journal('42')).find((item) => item.stage === 'check');
    expect(entry?.evidence).toMatchObject({ block: ['tests/a.test.ts', 'tests/b.test.ts'] });
  });
});

describe('§2.2: a command block of the project', () => {
  it('runs its script from the block folder while working in the project root', async () => {
    const root = repository();
    write(root, '.ai-workflows/blocks/check/block.yml', lines('kind: command', 'natures: [recompute]', 'run: node check.mjs'));
    write(root, '.ai-workflows/blocks/check/check.mjs', 'process.stdout.write(JSON.stringify({ ok: true, evidence: { cwd: process.cwd() } }));\n');
    write(root, 'hold.mjs', HOLD);
    commit(root, 'block');
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: check',
      '    summary: "Comprobación"',
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/check',
      '  - id: merge',
      '    summary: "Se une"',
      '    after: check',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node hold.mjs',
    ));
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    await engine.run('42');
    const entry = (await store.journal('42')).find((item) => item.stage === 'check');
    // The engine resolves the root to its real path (long names, not Windows 8.3 short ones).
    const normalize = (path: string) => realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
    expect(entry?.outcome).toBe('passed');
    expect(normalize((entry?.evidence as { block: { cwd: string } }).block.cwd)).toBe(normalize(root));
  });
});

describe('§2.2: a dry run never launches a command block', () => {
  it('reports the stage as not rehearsable instead of running it', async () => {
    const root = repository();
    write(root, 'block.mjs', 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", "yes");\nprocess.stdout.write(JSON.stringify({ ok: true }));\n');
    write(root, 'hold.mjs', HOLD);
    commit(root, 'blocks');
    const store = createMemoryStore();
    const compiled = await compileRecipe(commandRecipe(), { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    const outcome = await engine.run('42', { mode: 'dry-run' });
    expect(outcome).toMatchObject({ status: { state: 'waiting:decision', reason: expect.stringMatching(/"check"/) } });
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });
});

describe('review round 1: what a command block may not see', () => {
  it('gets neither the job name nor the result path of the launcher', async () => {
    const script = 'process.stdout.write(JSON.stringify({ ok: true, evidence: Object.keys(process.env).filter((k) => /^AIW_(JOB|RESULT)$/i.test(k)) }));\n';
    const { journal } = await runWith(script);
    expect(journal.find((entry) => entry.stage === 'check')).toMatchObject({ outcome: 'passed', evidence: { block: [] } });
  });
});
