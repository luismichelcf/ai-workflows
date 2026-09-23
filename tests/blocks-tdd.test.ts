import { afterEach, describe, expect, it } from 'vitest';

import { passed, refused, runBlock, technical } from './block-harness.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §3.4 and §3.5: the red test and the build check, as engine blocks.
//
// The projects here have no Vitest, so each one carries a tiny runner that imports every test
// file it is given and prints what Vitest prints — the output format is the only thing the
// blocks read (through `parseTestRun`). A test file exports its cases; a case throws an
// AssertionError to fail. Everything else — the repository, the commits, the retirement of the
// implementation — is real.

afterEach(removeRepositories);

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
  'process.exit(failedCount + broken > 0 ? 1 : 0);',
  '',
].join('\n');

const BONUS = (amount: number) => `export const bonus = () => ${amount};\n`;

const TEST = [
  'import assert from "node:assert/strict";',
  'import { bonus } from "../src/bonus.mjs";',
  'export const cases = {',
  '  "paga el bono completo": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`),',
  '};',
  '',
].join('\n');

/** A project whose `main` has the runner and a buggy bonus (800), on branch `piece`. */
function project(): string {
  return repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': BONUS(800), 'README.md': 'r\n' });
}

const COMMAND = 'node runner.mjs {tests}';
const TESTS = '["tests/**/*.test.mjs"]';

const RED_STAGE = [
  '    nature: execution-record',
  '    valid-while: forever',
  '    gate:',
  '      uses: ai-workflows/red-test@1',
  `      with: { command: "${COMMAND}", tests: ${TESTS} }`,
];

const RED_BEFORE = [
  '  - id: red',
  '    summary: "Prueba roja"',
  ...RED_STAGE,
];

const BUILD_STAGE = [
  '    nature: execution-record',
  '    gate:',
  '      uses: ai-workflows/build-verify@1',
  `      with: { command: "${COMMAND}", tests: ${TESTS}, red-stage: red }`,
];

describe('§3.4 red-test@1', () => {
  it('positive: a test that fails by its assertion is red, and its files, failures and assertions are kept', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST);
    commit(root, 'red test');
    const result = await runBlock(root, RED_STAGE);
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({
      block: {
        files: { 'tests/bonus.test.mjs': expect.stringMatching(/^[0-9a-f]{64}$/) },
        failures: [expect.stringContaining('paga el bono completo')],
        assertions: [expect.stringContaining('expected 800 to be 1000')],
      },
    });
  });

  it('refuses a change without test files', async () => {
    const root = project();
    write(root, 'src/bonus.mjs', BONUS(1000));
    commit(root, 'no test');
    expect((await runBlock(root, RED_STAGE)).outcome).toMatchObject(refused(/no trae pruebas/));
  });

  it('refuses a test that already passes: it is not red', async () => {
    const root = project();
    write(root, 'src/bonus.mjs', BONUS(1000));
    write(root, 'tests/bonus.test.mjs', TEST);
    commit(root, 'green already');
    expect((await runBlock(root, RED_STAGE)).outcome).toMatchObject(refused(/pasó/));
  });

  it('refuses a test that fails by import, not by its assertion', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST.replace('../src/bonus.mjs', '../src/missing.mjs'));
    commit(root, 'broken import');
    expect((await runBlock(root, RED_STAGE)).outcome).toMatchObject(refused(/importación o entorno/));
  });

  it('is a technical block when the tests cannot run at all', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST);
    commit(root, 'red test');
    const stage = RED_STAGE.map((row) => row.replace('node runner.mjs', 'no-such-runner-aiw-13'));
    expect((await runBlock(root, stage)).outcome).toMatchObject(technical(/no-such-runner-aiw-13/));
  });
});

/** Red test committed and recorded; then `implement` runs and the build check is asked. */
async function redThenBuild(implement: (root: string) => void) {
  const root = project();
  write(root, 'tests/bonus.test.mjs', TEST);
  const redSha = commit(root, 'red test');
  const first = await runBlock(root, BUILD_STAGE, { before: RED_BEFORE });
  expect(first.journal.find((entry) => entry.stage === 'red')?.outcome).toBe('passed');
  implement(root);
  const second = await first.again();
  return { root, redSha, first, second };
}

describe('§3.5 build-verify@1', () => {
  it('positive: green now, and red again by the same assertion once only the implementation is retired', async () => {
    const { root, second } = await redThenBuild((root) => {
      write(root, 'src/bonus.mjs', BONUS(1000));
      commit(root, 'implementation');
    });
    expect(second.outcome).toMatchObject(passed);
    expect(second.entry?.evidence).toMatchObject({ block: { retired: ['src/bonus.mjs'] } });
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('retires from the exact snapshot: unsaved changes and new files included', async () => {
    const { second } = await redThenBuild((root) => {
      write(root, 'src/rules.mjs', 'export const full = 1000;\n');
      write(root, 'src/bonus.mjs', 'import { full } from "./rules.mjs";\nexport const bonus = () => full;\n');
    });
    expect(second.outcome).toMatchObject(passed);
    expect(second.entry?.evidence).toMatchObject({ block: { retired: ['src/bonus.mjs', 'src/rules.mjs'] } });
  });

  it('refuses while the tests are not green', async () => {
    const { second } = await redThenBuild(() => undefined);
    expect(second.outcome).toMatchObject(refused(/verde/));
  });

  it('refuses when every changed file is a test or excluded: there is no implementation to retire', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST);
    commit(root, 'red test');
    const stage = [
      '    nature: execution-record',
      '    gate:',
      '      uses: ai-workflows/build-verify@1',
      `      with: { command: "${COMMAND}", tests: ${TESTS}, red-stage: red, implementation-exclude: ["src/**"] }`,
    ];
    const first = await runBlock(root, stage, { before: RED_BEFORE });
    write(root, 'src/bonus.mjs', BONUS(1000));
    commit(root, 'implementation, excluded on purpose');
    expect((await first.again()).outcome).toMatchObject(refused(/implementación/));
  });

  it('refuses when retiring the implementation does not reproduce the same failure', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST);
    write(root, 'src/bonus.mjs', BONUS(900));
    commit(root, 'red test with half an implementation');
    const first = await runBlock(root, BUILD_STAGE, { before: RED_BEFORE });
    expect(first.journal.find((entry) => entry.stage === 'red')?.outcome).toBe('passed');
    write(root, 'src/bonus.mjs', BONUS(1000));
    commit(root, 'rest of the implementation');
    expect((await first.again()).outcome).toMatchObject(refused(/misma/));
  });

  it('refuses without a red test in the journal', async () => {
    const root = project();
    write(root, 'tests/bonus.test.mjs', TEST);
    write(root, 'src/bonus.mjs', BONUS(1000));
    commit(root, 'no red first');
    const stage = [
      '    nature: execution-record',
      '    gate:',
      '      uses: ai-workflows/build-verify@1',
      `      with: { command: "${COMMAND}", tests: ${TESTS}, red-stage: red }`,
    ];
    // The red stage exists but was skipped by the recipe: no red evidence was ever recorded.
    const before = ['  - id: red', '    summary: "Prueba roja"', '    applies-if: { touches-any: [nothing] }', ...RED_STAGE];
    const result = await runBlock(root, stage, { before, top: ['classify:', '  nothing: ["nowhere/**"]'] });
    expect(result.outcome).toMatchObject(refused(/prueba roja registrada/));
  });
});

describe('CN-11 · a builder that edits the test it was given, through build-verify@1', () => {
  it('refuses a test that no longer matches what was seen red, naming the file', async () => {
    const { second } = await redThenBuild((root) => {
      write(root, 'src/bonus.mjs', BONUS(1000));
      write(root, 'tests/bonus.test.mjs', TEST.replace('1000', '800'));
      commit(root, 'implementation and a softer test');
    });
    expect(second.outcome).toMatchObject(refused(/tests\/bonus\.test\.mjs/));
  });

  it('refuses a test changed in one commit and put back in another, naming the commit', async () => {
    let touched = '';
    const { second } = await redThenBuild((root) => {
      write(root, 'tests/bonus.test.mjs', TEST.replace('1000', '800'));
      touched = commit(root, 'softer test');
      write(root, 'tests/bonus.test.mjs', TEST);
      write(root, 'src/bonus.mjs', BONUS(1000));
      commit(root, 'implementation, test put back');
    });
    expect(second.outcome).toMatchObject(refused(new RegExp(touched.slice(0, 7))));
  });

  it('declared limit: a test edited and put back byte for byte without a commit is NOT detected', async () => {
    const { second } = await redThenBuild((root) => {
      write(root, 'tests/bonus.test.mjs', TEST.replace('1000', '800'));
      write(root, 'tests/bonus.test.mjs', TEST);
      write(root, 'src/bonus.mjs', BONUS(1000));
      commit(root, 'implementation');
    });
    // Level A (PLAN-13 §1.1): the engine cannot see an edit that left no trace.
    expect(second.outcome).toMatchObject(passed);
  });
});
