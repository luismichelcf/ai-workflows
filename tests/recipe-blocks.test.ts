import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRecipe,
  engineBlockManifest,
  recipeCommand,
  type RecipeError,
} from '../src/index.js';

// PLAN-13-R2 §1.3 rules 4–8 and §2: every `uses:` names a block with a manifest, and the
// recipe is checked against it before anything runs — natures, validity, and every `with:`
// input. Project blocks are read from `.ai-workflows/blocks/<name>/block.yml` with the same
// strict reader. Positions are 1-based; `place` finds the literal token in the literal row.

const FILE = 'receta.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const TEMPLATE = readFileSync(new URL('../templates/pipeline.yml', import.meta.url), 'utf8');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project folder with the given files, relative to its root. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-blocks-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** A two-stage recipe: `gate` rows go under the first stage; the second is the merge. */
function recipe(stageRows: readonly string[]): string[] {
  return [
    'version: 1', //                                          1
    'locale: es', //                                          2
    'stages:', //                                             3
    '  - id: check', //                                       4
    '    summary: "Comprobación"', //                        5
    ...stageRows, //                                          6…
    '  - id: merge',
    '    summary: "Se une a la versión principal"',
    '    after: check',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      run: node m.mjs',
  ];
}

async function errorsOf(rows: readonly string[], root = project()): Promise<readonly RecipeError[]> {
  const result = await checkRecipe(lines(...rows), FILE, { root });
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

async function validOf(rows: readonly string[], root = project()) {
  const result = await checkRecipe(lines(...rows), FILE, { root });
  if (!result.ok) {
    const shown = result.errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`).join('\n');
    throw new Error(`expected a valid recipe, got:\n${shown}`);
  }
  return result.recipe;
}

function place(rows: readonly string[], row: number, token: string) {
  const index = (rows[row - 1] ?? '').indexOf(token);
  if (index < 0) throw new Error(`fixture: "${token}" not found in row ${row}`);
  return { line: row, column: index + 1 };
}

const at = (where: { line: number; column: number }, message: RegExp, file = FILE) =>
  expect.objectContaining({ file, ...where, message: expect.stringMatching(message) });

const uses = (block: string, nature: string, ...rest: string[]) => [
  `    nature: ${nature}`, //  6
  '    gate:', //              7
  `      uses: ${block}`, //   8
  ...rest, //                  9…
];

describe('§2.1: engine blocks have manifests', () => {
  const expected: Record<string, { natures: string[]; validWhile?: string[] }> = {
    'spec-structure': { natures: ['structure'] },
    'benchmark-sources': { natures: ['structure'] },
    'sandboxed-review': { natures: ['recompute', 'attest'], validWhile: ['same-sha', 'same-fingerprint-or-clean-update'] },
    'red-test': { natures: ['recompute', 'execution-record'], validWhile: ['forever'] },
    'build-verify': { natures: ['recompute', 'execution-record'], validWhile: ['same-sha'] },
    command: { natures: ['recompute'] },
    'scope-reconcile': { natures: ['recompute'] },
    'independent-review': { natures: ['execution-record', 'attest'] },
    'approval-comment': { natures: ['attest', 'recompute'] },
    'preview-deployment': { natures: ['recompute'] },
    'browser-qa': { natures: ['recompute'], validWhile: ['same-sha'] },
    'github-merge': { natures: ['recompute'] },
    'post-merge': { natures: ['recompute'] },
    cleanup: { natures: ['recompute'] },
  };

  for (const [name, want] of Object.entries(expected)) {
    it(`${name}@1 declares the natures of PLAN-13 §4.1${want.validWhile ? ' and its validity' : ''}`, () => {
      const manifest = engineBlockManifest(`ai-workflows/${name}@1`);
      expect(manifest?.kind).toBe('module');
      expect([...(manifest?.natures ?? [])].sort()).toEqual([...want.natures].sort());
      if (want.validWhile) expect([...(manifest?.validWhile ?? [])].sort()).toEqual([...want.validWhile].sort());
      else expect(manifest?.validWhile).toBeUndefined();
    });
  }

  it('knows no block outside the list', () => {
    expect(engineBlockManifest('ai-workflows/deploy@1')).toBeUndefined();
    expect(engineBlockManifest('ai-workflows/command@2')).toBeUndefined();
  });

  it('positive: the example recipe of init passes every block check', async () => {
    const result = await checkRecipe(TEMPLATE, 'pipeline.yml', { root: project() });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe('§1.3 rule 8: uses must name a block that exists', () => {
  it('rejects an unknown engine block, at the uses value', async () => {
    const rows = recipe(uses('ai-workflows/deploy@1', 'recompute'));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 8, 'ai-workflows/'), /unknown engine block "ai-workflows\/deploy@1"/),
    );
  });

  it('rejects a major version the block does not have', async () => {
    const rows = recipe(uses('ai-workflows/command@2', 'recompute', '      with: { command: "pnpm check" }'));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 8, 'ai-workflows/'), /block "ai-workflows\/command" has no version 2/),
    );
  });
});

describe('§1.3 rules 5 and 6: nature and validity come from the manifest', () => {
  it('rejects a nature the block does not allow, at the nature', async () => {
    const rows = recipe(uses('ai-workflows/command@1', 'attest', '      with: { command: "pnpm check" }'));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 6, 'attest'), /block "ai-workflows\/command@1" cannot be attest; it allows: recompute/),
    );
  });

  it('rejects red-test left on the default validity, at the uses value', async () => {
    const rows = recipe(uses('ai-workflows/red-test@1', 'execution-record', '      with: { command: "pnpm vitest run {tests}" }'));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 8, 'ai-workflows/'), /block "ai-workflows\/red-test@1" needs valid-while: forever/),
    );
  });

  it('rejects a validity the block does not allow, at the valid-while value', async () => {
    const rows = recipe([
      '    nature: recompute',
      '    valid-while: forever',
      '    gate:',
      '      uses: ai-workflows/browser-qa@1',
    ]);
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 7, 'forever'), /block "ai-workflows\/browser-qa@1" cannot use valid-while: forever; it allows: same-sha/),
    );
  });

  it('positive: red-test with valid-while: forever', async () => {
    const rows = recipe([
      '    nature: execution-record',
      '    valid-while: forever',
      '    gate:',
      '      uses: ai-workflows/red-test@1',
      '      with: { command: "pnpm vitest run {tests}" }',
    ]);
    expect((await validOf(rows)).stages[0]?.validWhile).toBe('forever');
  });
});

describe('§1.3 rule 7: with: is checked against the inputs of the manifest', () => {
  const command = (...withRows: string[]) =>
    recipe(uses('ai-workflows/command@1', 'recompute', '      with:', ...withRows));

  it('rejects an unknown input, at its key', async () => {
    const rows = command('        command: "pnpm check"', '        colour: blue');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 11, 'colour'), /unknown input "colour" for block "ai-workflows\/command@1"/),
    );
  });

  it('rejects an input of the wrong type, at its value', async () => {
    const rows = command('        command: "pnpm check"', '        timeout-minutes: "20"');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 11, '"20"'), /input "timeout-minutes" must be an integer/),
    );
  });

  it('rejects an input out of range, at its value', async () => {
    const rows = command('        command: "pnpm check"', '        timeout-minutes: 500');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 11, '500'), /input "timeout-minutes" must be at most 120/),
    );
  });

  it('rejects a value outside a closed list, at its value', async () => {
    const rows = command('        command: "pnpm check"', '        reader: jest');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 11, 'jest'), /input "reader" must be one of: exit-code, vitest/),
    );
  });

  it('rejects a missing required input, at the uses value', async () => {
    const rows = recipe(uses('ai-workflows/command@1', 'recompute'));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 8, 'ai-workflows/'), /missing required input "command" for block "ai-workflows\/command@1"/),
    );
  });

  it('applies the shell rules of §1.4 to a command input', async () => {
    const rows = command('        command: "pnpm check && rm -rf x"');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 10, '"pnpm'), /"command" cannot contain shell characters/),
    );
  });

  it('requires {tests} where the block runs the tests of the change', async () => {
    const rows = recipe([
      '    nature: execution-record',
      '    valid-while: forever',
      '    gate:',
      '      uses: ai-workflows/red-test@1',
      '      with: { command: "pnpm vitest run" }',
    ]);
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 10, '"pnpm'), /input "command" must contain \{tests\}/),
    );
  });

  it('rejects a glob the engine cannot honour inside an input', async () => {
    const rows = recipe([
      '    nature: execution-record',
      '    valid-while: forever',
      '    gate:',
      '      uses: ai-workflows/red-test@1',
      '      with: { command: "pnpm vitest run {tests}", tests: ["tests/[a-z]*.ts"] }',
    ]);
    expect(await errorsOf(rows)).toContainEqual(at(place(rows, 10, '"tests/'), /unsupported glob/));
  });

  it('checks the fields of an object input, and rejects an unknown field', async () => {
    const rows = recipe(uses(
      'ai-workflows/spec-structure@1',
      'structure',
      '      with:',
      '        file: "docs/plans/PLAN-{piece}.md"',
      '        summary: { section: "En tres líneas", colour: blue }',
    ));
    const errors = await errorsOf(rows);
    expect(errors).toContainEqual(at(place(rows, 11, 'colour'), /unknown field "colour" in input "summary"/));
    expect(errors).toContainEqual(at(place(rows, 11, '{'), /missing required field "labels" in input "summary"/));
  });

  it('checks every item of a list of objects', async () => {
    const rows = recipe(uses(
      'ai-workflows/benchmark-sources@1',
      'structure',
      '      with:',
      '        files: ["docs/research/{piece}-*.md"]',
      '        categories: [{ heading: "PSA", min: 5 }, { heading: "Otros", min: -1 }]',
    ));
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 11, '-1'), /field "min" in input "categories" must be at least 0/),
    );
  });

  it('build-verify must point at an earlier stage that uses red-test', async () => {
    const rows = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: build',
      '    summary: "Construcción"',
      '    nature: execution-record',
      '    gate:',
      '      uses: ai-workflows/build-verify@1',
      '      with: { command: "pnpm vitest run {tests}", red-stage: red }',
      '  - id: red',
      '    summary: "Prueba roja"',
      '    after: build',
      '    nature: execution-record',
      '    valid-while: forever',
      '    gate:',
      '      uses: ai-workflows/red-test@1',
      '      with: { command: "pnpm vitest run {tests}" }',
      '  - id: merge',
      '    summary: "Se une"',
      '    after: red',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m.mjs',
    ];
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, 9, 'red }'), /input "red-stage" must name an earlier stage that uses ai-workflows\/red-test@1/),
    );
  });

  it('positive: the recipe keeps with: as written; defaults belong to the block when it is created', async () => {
    const rows = recipe(uses('ai-workflows/command@1', 'recompute', '      with: { command: "pnpm check" }'));
    const result = await validOf(rows);
    expect(result.stages[0]?.gate.with).toEqual({ command: 'pnpm check' });
  });
});

describe('§2.2: project blocks', () => {
  const BLOCK = '.ai-workflows/blocks/check/block.yml';
  const projectUses = (nature: string, ...rest: string[]) =>
    recipe(uses('./.ai-workflows/blocks/check', nature, ...rest));

  it('rejects a project block without block.yml, at the uses value', async () => {
    const rows = projectUses('recompute');
    expect(await errorsOf(rows, project())).toContainEqual(
      at(place(rows, 8, './'), /project block "\.\/\.ai-workflows\/blocks\/check" has no block\.yml/),
    );
  });

  it('reports an invalid block.yml in that file, with its line and column', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', 'run: node check.mjs', 'colour: blue'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 4, column: 1 }, /unknown key "colour"/, BLOCK),
    );
  });

  it('rejects a module whose main leaves the block folder', async () => {
    const root = project({
      [BLOCK]: lines('kind: module', 'natures: [recompute]', 'main: ../other/index.mjs'),
      '.ai-workflows/blocks/other/index.mjs': '',
    });
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 3, column: 7 }, /"main" must stay inside the block folder/, BLOCK),
    );
  });

  it('rejects a command whose program leaves the block folder', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', 'run: node ../other/check.mjs'),
    });
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 3, column: 6 }, /"run" must stay inside the block folder/, BLOCK),
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a main that is a link pointing out of the folder', async () => {
    const root = project({
      [BLOCK]: lines('kind: module', 'natures: [recompute]', 'main: index.mjs'),
      'outside.mjs': 'export default () => ({ ok: true });',
    });
    symlinkSync(join(root, 'outside.mjs'), join(root, '.ai-workflows/blocks/check/index.mjs'));
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 3, column: 7 }, /"main" must stay inside the block folder/, BLOCK),
    );
  });

  it('rejects a module without main and a command without run', async () => {
    const moduleRoot = project({ [BLOCK]: lines('kind: module', 'natures: [recompute]') });
    expect(await errorsOf(projectUses('recompute'), moduleRoot)).toContainEqual(
      at({ line: 1, column: 1 }, /a module block needs "main"/, BLOCK),
    );
    const commandRoot = project({ [BLOCK]: lines('kind: command', 'natures: [recompute]') });
    expect(await errorsOf(projectUses('recompute'), commandRoot)).toContainEqual(
      at({ line: 1, column: 1 }, /a command block needs "run"/, BLOCK),
    );
  });

  it('RC-08: rejects a command block that declares attest or execution-record, in block.yml', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute, attest]', 'run: node check.mjs'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 2, column: 22 }, /a command block can only be recompute or structure/, BLOCK),
    );
  });

  it('RC-08: rejects a stage that runs a command block as attest, at the nature', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', 'run: node check.mjs'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    const rows = projectUses('attest');
    expect(await errorsOf(rows, root)).toContainEqual(
      at(place(rows, 6, 'attest'), /cannot be attest; it allows: recompute/),
    );
  });

  it('bounds the time of a command block', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', 'run: node check.mjs', 'timeout-minutes: 500'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    expect(await errorsOf(projectUses('recompute'), root)).toContainEqual(
      at({ line: 4, column: 18 }, /must be at most 120/, BLOCK),
    );
  });

  it('checks with: against the inputs a project block declares', async () => {
    const root = project({
      [BLOCK]: lines(
        'kind: command',
        'natures: [recompute]',
        'inputs: { min-psa: { type: integer, min: 0, max: 50, default: 5 } }',
        'run: node check.mjs',
      ),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    const rows = projectUses('recompute', '      with: { min-psa: 80 }');
    expect(await errorsOf(rows, root)).toContainEqual(
      at(place(rows, 9, '80'), /input "min-psa" must be at most 50/),
    );
  });

  it('positive: a valid project module block and a valid project command block', async () => {
    const moduleRoot = project({
      [BLOCK]: lines('kind: module', 'natures: [recompute, attest]', 'main: index.mjs'),
      '.ai-workflows/blocks/check/index.mjs': 'export default () => ({ ok: true });',
    });
    await validOf(projectUses('attest'), moduleRoot);
    const commandRoot = project({
      [BLOCK]: lines('kind: command', 'natures: [structure]', 'run: node check.mjs {piece}'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });
    await validOf(projectUses('structure'), commandRoot);
  });
});

describe('the CLI checks blocks too', () => {
  it('validate reports a block error with file, line and column', async () => {
    const rows = recipe(uses('ai-workflows/deploy@1', 'recompute'));
    const root = project({ '.ai-workflows/pipeline.yml': lines(...rows) });
    const output = await recipeCommand(['validate'], { cwd: root });
    expect(output.ok).toBe(false);
    expect(output.text).toContain('.ai-workflows/pipeline.yml:8:13: unknown engine block "ai-workflows/deploy@1"');
  });

  it('explain refuses a recipe whose blocks do not check', async () => {
    const rows = recipe(uses('ai-workflows/deploy@1', 'recompute'));
    const root = project({ '.ai-workflows/pipeline.yml': lines(...rows) });
    expect((await recipeCommand(['explain'], { cwd: root })).ok).toBe(false);
  });
});

describe('§2.2: block.yml inputs are declared as strictly as the recipe', () => {
  const BLOCK = '.ai-workflows/blocks/check/block.yml';
  const projectUses = () => recipe(uses('./.ai-workflows/blocks/check', 'recompute'));
  const withInputs = (inputs: string) =>
    project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', `inputs: ${inputs}`, 'run: node check.mjs'),
      '.ai-workflows/blocks/check/check.mjs': '',
    });

  it('rejects an input type it does not know, instead of reading it as text', async () => {
    const root = withInputs('{ level: { type: integr } }');
    expect(await errorsOf(projectUses(), root)).toContainEqual(
      at({ line: 3, column: 26 }, /"type" must be one of: string, integer, boolean, string-list, command, glob-list, object, object-list/, BLOCK),
    );
  });

  it('rejects a default of the wrong type, instead of dropping it', async () => {
    const root = withInputs('{ level: { type: integer, min: 0, max: 9, default: "3" } }');
    expect(await errorsOf(projectUses(), root)).toContainEqual(
      at({ line: 3, column: 60 }, /"default" must be an integer/, BLOCK),
    );
  });

  it('rejects required written as anything but true or false', async () => {
    const root = withInputs('{ level: { type: integer, required: "yes" } }');
    expect(await errorsOf(projectUses(), root)).toContainEqual(
      at({ line: 3, column: 45 }, /"required" must be true or false/, BLOCK),
    );
  });

  it('rejects an input name that is not a lowercase word with dashes', async () => {
    const root = withInputs('{ Level: { type: integer } }');
    expect(await errorsOf(projectUses(), root)).toContainEqual(
      at({ line: 3, column: 11 }, /"Level" must match/, BLOCK),
    );
  });

  it('rejects a command block whose run names no script of its own', async () => {
    const root = project({
      [BLOCK]: lines('kind: command', 'natures: [recompute]', 'run: node'),
    });
    expect(await errorsOf(projectUses(), root)).toContainEqual(
      at({ line: 3, column: 6 }, /"run" must name a script inside the block folder/, BLOCK),
    );
  });
});
