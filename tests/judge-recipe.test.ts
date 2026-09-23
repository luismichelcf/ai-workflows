import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRecipe,
  engineBlockManifest,
  explainRecipe,
  parseRecipe,
  type Recipe,
  type RecipeError,
} from '../src/index.js';

// PLAN-13-R3 §1: what the judge needs from the recipe. R19 adds `pieces:` (which branch is which
// piece, and where a piece declares its kind); §1.2 makes every pre-merge stage say how GitHub
// checks it (`server:`), within what the block's manifest allows (§1.3); §1.4 makes `explain` say
// it in plain words. The `server:` rules that need manifests live in `checkRecipe` (validate,
// explain and the judge), not in `parseRecipe`: the engine next to the agent never uses them.

const FILE = '.ai-workflows/pipeline.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const TEMPLATE = readFileSync(new URL('../templates/pipeline.yml', import.meta.url), 'utf8');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-judge-recipe-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function place(rows: readonly string[], row: number, token: string) {
  const index = (rows[row - 1] ?? '').indexOf(token);
  if (index < 0) throw new Error(`fixture: "${token}" not found in row ${row}`);
  return { line: row, column: index + 1 };
}

const at = (where: { line: number; column: number }, message: RegExp, file = FILE) =>
  expect.objectContaining({ file, ...where, message: expect.stringMatching(message) });

function parsed(rows: readonly string[]): Recipe {
  const result = parseRecipe(lines(...rows), FILE);
  if (!result.ok) {
    throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  }
  return result.recipe;
}

function parseErrors(rows: readonly string[]): readonly RecipeError[] {
  const result = parseRecipe(lines(...rows), FILE);
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

async function checkErrors(rows: readonly string[], root = project()): Promise<readonly RecipeError[]> {
  const result = await checkRecipe(lines(...rows), FILE, { root });
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

async function checked(rows: readonly string[], root = project()): Promise<Recipe> {
  const result = await checkRecipe(lines(...rows), FILE, { root });
  if (!result.ok) {
    const shown = result.errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`).join('\n');
    throw new Error(`expected a valid recipe, got:\n${shown}`);
  }
  return result.recipe;
}

// ---------------------------------------------------------------------------------------------
// R19: pieces

/** A recipe whose rows 6… are the `pieces:` section; one stage and the merge follow. */
function withPieces(pieceRows: readonly string[], head: readonly string[] = [
  'kinds:', //                                  3
  '  names: [behavior, docs]', //               4
  '  default: behavior', //                     5
]): string[] {
  return [
    'version: 1', //                              1
    'locale: es', //                              2
    ...head,
    ...pieceRows,
    'stages:',
    '  - id: check',
    '    summary: "Comprobación"',
    '    nature: recompute',
    '    gate:',
    '      run: node c.mjs',
    '    server: { require-check: ci }',
    '  - id: merge',
    '    summary: "Se une"',
    '    after: check',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      run: node m.mjs',
  ];
}

const PIECES_OK = [
  'pieces:', //                                                  6
  '  branch: ["*/{piece}", "*/{piece}-*"]', //                   6
  '  exclude-branches: ["libre/*"]', //                          7
  '  declared-kind:', //                                         8
  '    file: "docs/plans/PLAN-{piece}.md"', //                   9
  '    line: "Tipo de cambio"', //                              10
];

describe('R19: the pieces section', () => {
  it('reads branch patterns, exclusions and where the kind is declared', () => {
    expect(parsed(withPieces(PIECES_OK)).pieces).toEqual({
      branch: ['*/{piece}', '*/{piece}-*'],
      excludeBranches: ['libre/*'],
      declaredKind: { file: 'docs/plans/PLAN-{piece}.md', line: 'Tipo de cambio' },
    });
  });

  it('is optional, and so are its exclusions and declared kind', () => {
    expect(parsed(withPieces([])).pieces).toBeUndefined();
    expect(parsed(withPieces(['pieces:', '  branch: ["feat/{piece}"]'])).pieces).toEqual({
      branch: ['feat/{piece}'],
      excludeBranches: [],
    });
  });

  it('rejects a branch pattern without {piece}, at the pattern', () => {
    const rows = withPieces(['pieces:', '  branch: ["feat/*"]']);
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 7, '"feat/*"'), /branch pattern "feat\/\*" must contain \{piece\} exactly once/),
    );
  });

  it('rejects a branch pattern with {piece} twice', () => {
    const rows = withPieces(['pieces:', '  branch: ["{piece}/{piece}"]']);
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 7, '"{piece}/{piece}"'), /must contain \{piece\} exactly once/),
    );
  });

  it('rejects characters outside letters, digits, . _ - / * in a branch pattern', () => {
    for (const bad of ['feat/{piece}?', 'feat/[{piece}]', 'feat/{piece} x', 'feat/{name}-{piece}']) {
      const rows = withPieces(['pieces:', `  branch: ["${bad}"]`]);
      expect(parseErrors(rows), bad).toContainEqual(
        at(place(rows, 7, `"${bad}"`), /unsupported character in branch pattern/),
      );
    }
  });

  it('rejects an empty branch list', () => {
    const rows = withPieces(['pieces:', '  branch: []']);
    expect(parseErrors(rows).length).toBeGreaterThan(0);
  });

  it('rejects {piece} in an excluded branch', () => {
    const rows = withPieces(['pieces:', '  branch: ["*/{piece}"]', '  exclude-branches: ["libre/{piece}"]']);
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 8, '"libre/{piece}"'), /an excluded branch cannot contain \{piece\}/),
    );
  });

  it('rejects a declared-kind file without {piece}, absolute or leaving the project', () => {
    for (const bad of ['docs/plan.md', '/docs/PLAN-{piece}.md', '../PLAN-{piece}.md', 'docs/../x/PLAN-{piece}.md']) {
      const rows = withPieces([
        'pieces:',
        '  branch: ["*/{piece}"]',
        '  declared-kind:',
        `    file: "${bad}"`,
        '    line: "Tipo de cambio"',
      ]);
      expect(parseErrors(rows), bad).toContainEqual(
        at(place(rows, 9, `"${bad}"`), /declared-kind file/),
      );
    }
  });

  it('rejects an empty declared-kind line', () => {
    const rows = withPieces([
      'pieces:',
      '  branch: ["*/{piece}"]',
      '  declared-kind:',
      '    file: "docs/PLAN-{piece}.md"',
      '    line: ""',
    ]);
    expect(parseErrors(rows).length).toBeGreaterThan(0);
  });

  it('rejects declared-kind in a recipe without kinds, at declared-kind', () => {
    const rows = withPieces(PIECES_OK, []);
    // Without the two kinds rows, pieces starts at row 3 and declared-kind is row 6.
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 6, 'declared-kind'), /declared-kind needs kinds/),
    );
  });

  it('rejects an unknown key inside pieces', () => {
    const rows = withPieces(['pieces:', '  branch: ["*/{piece}"]', '  colour: blue']);
    expect(parseErrors(rows)).toContainEqual(at(place(rows, 8, 'colour'), /unknown key "colour"/));
  });
});

// ---------------------------------------------------------------------------------------------
// §1.3: the server modes each engine block allows

describe('§1.3: manifests declare the server modes they allow', () => {
  const expected: Record<string, string[]> = {
    'spec-structure': ['recompute', 'require-check'],
    'benchmark-sources': ['recompute', 'require-check'],
    'scope-reconcile': ['recompute', 'require-check'],
    command: ['require-check'],
    'red-test': ['require-check'],
    'build-verify': ['require-check'],
    'browser-qa': ['require-check'],
    'preview-deployment': ['require-check'],
    'approval-comment': ['attestation', 'require-check'],
    'independent-review': ['attestation', 'require-check'],
    'sandboxed-review': ['attestation', 'require-check'],
    'github-merge': [],
    'post-merge': [],
    cleanup: [],
  };
  for (const [name, modes] of Object.entries(expected)) {
    it(`${name}@1 allows ${modes.length === 0 ? 'none' : modes.join(', ')}`, () => {
      expect([...(engineBlockManifest(`ai-workflows/${name}@1`)?.server ?? ['missing'])].sort())
        .toEqual([...modes].sort());
    });
  }
});

// ---------------------------------------------------------------------------------------------
// §1.2: server in validate

/** One pre-merge stage (rows 4… from `stageRows`) and a merge stage. */
function stageRecipe(stageRows: readonly string[], head: readonly string[] = []): string[] {
  return [
    'version: 1', //                    1
    'locale: es', //                    2
    ...head,
    'stages:', //                       3 (+head)
    '  - id: check', //                 4 (+head)
    '    summary: "Comprobación"', //   5 (+head)
    ...stageRows, //                    6… (+head)
    '  - id: merge',
    '    summary: "Se une"',
    '    after: check',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      run: node m.mjs',
  ];
}

const commandStage = (...rest: string[]) => [
  '    nature: recompute', //                          6
  '    gate:', //                                      7
  '      uses: ai-workflows/command@1', //             8
  '      with: { command: "pnpm check" }', //          9
  ...rest, //                                         10…
];

describe('§1.2 rule 1: every pre-merge stage says how GitHub checks it', () => {
  it('rejects a required pre-merge stage without server, at its id', async () => {
    const rows = stageRecipe(commandStage());
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 4, 'check'), /stage "check" is pre-merge and needs server:/),
    );
  });

  it('rejects an optional pre-merge stage without server too', async () => {
    const rows = stageRecipe(commandStage('    required: false'));
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 4, 'check'), /stage "check" is pre-merge and needs server:/),
    );
  });

  it('positive: a pre-merge stage with require-check', async () => {
    const rows = stageRecipe(commandStage('    server: { require-check: todo-verde }'));
    expect((await checked(rows)).stages[0]?.server).toEqual({ requireCheck: 'todo-verde' });
  });

  it('positive: an optional pre-merge stage may be local-only', async () => {
    const rows = stageRecipe(commandStage('    required: false', '    server: local-only'));
    expect((await checked(rows)).stages[0]?.server).toBe('local-only');
  });

  it('parseRecipe alone does not ask for server: the engine next to the agent never uses it', () => {
    expect(parsed(stageRecipe(commandStage())).stages[0]?.server).toBeUndefined();
  });
});

describe('§1.2 rule 2: merge and post-merge stages only take local-only', () => {
  it('rejects server: recompute on the merge stage, at the server value', () => {
    const rows = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: merge',
      '    summary: "Se une"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m.mjs',
      '    server: recompute', //                    10
    ];
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 10, 'recompute'), /a merge or post-merge stage only takes server: local-only/),
    );
  });

  it('rejects server: attestation on a post-merge stage', () => {
    const rows = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: merge',
      '    summary: "Se une"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m.mjs',
      '  - id: after',
      '    summary: "Después"',
      '    after: merge',
      '    phase: post-merge',
      '    nature: recompute',
      '    gate:',
      '      run: node a.mjs',
      '    server: attestation', //                  17
    ];
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 17, 'attestation'), /a merge or post-merge stage only takes server: local-only/),
    );
  });

  it('positive: a post-merge stage with local-only or with nothing', () => {
    const rows = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: merge',
      '    summary: "Se une"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m.mjs',
      '  - id: after',
      '    summary: "Después"',
      '    after: merge',
      '    phase: post-merge',
      '    nature: recompute',
      '    gate:',
      '      run: node a.mjs',
      '    server: local-only',
    ];
    expect(parsed(rows).stages[1]?.server).toBe('local-only');
  });
});

describe('§1.2 rule 3: the server mode must be one the block allows', () => {
  it('rejects recompute on command@1, at the server value', async () => {
    const rows = stageRecipe(commandStage('    server: recompute'));
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 10, 'recompute'), /block "ai-workflows\/command@1" cannot use server: recompute; it allows: require-check/),
    );
  });

  it('rejects attestation on spec-structure', async () => {
    const rows = stageRecipe([
      '    nature: structure',
      '    gate:',
      '      uses: ai-workflows/spec-structure@1',
      '      with: { file: "docs/PLAN-{piece}.md" }',
      '    server: attestation', //                 10
    ]);
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 10, 'attestation'), /cannot use server: attestation; it allows: recompute, require-check/),
    );
  });

  it('rejects recompute and attestation on a run: command, which only takes require-check', async () => {
    for (const mode of ['recompute', 'attestation']) {
      const rows = stageRecipe([
        '    nature: recompute',
        '    gate:',
        '      run: node c.mjs',
        `    server: ${mode}`, //                      9
      ]);
      expect(await checkErrors(rows), mode).toContainEqual(
        at(place(rows, 9, mode), /a project block or run: only takes server: require-check/),
      );
    }
  });

  it('rejects recompute on a project module block', async () => {
    const root = project({
      '.ai-workflows/blocks/mine/block.yml': lines('kind: module', 'natures: [recompute]', 'main: index.mjs'),
      '.ai-workflows/blocks/mine/index.mjs': 'export default () => ({ ok: true });',
    });
    const rows = stageRecipe([
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/mine',
      '    server: recompute', //                    9
    ]);
    expect(await checkErrors(rows, root)).toContainEqual(
      at(place(rows, 9, 'recompute'), /a project block or run: only takes server: require-check/),
    );
  });

  it('positive: spec-structure recomputed on GitHub, a project block by require-check', async () => {
    const spec = stageRecipe([
      '    nature: structure',
      '    gate:',
      '      uses: ai-workflows/spec-structure@1',
      '      with: { file: "docs/PLAN-{piece}.md" }',
      '    server: recompute',
    ]);
    expect((await checked(spec)).stages[0]?.server).toBe('recompute');

    const root = project({
      '.ai-workflows/blocks/mine/block.yml': lines('kind: module', 'natures: [recompute]', 'main: index.mjs'),
      '.ai-workflows/blocks/mine/index.mjs': 'export default () => ({ ok: true });',
    });
    const mine = stageRecipe([
      '    nature: recompute',
      '    gate:',
      '      uses: ./.ai-workflows/blocks/mine',
      '    server: { require-check: mine }',
    ]);
    expect((await checked(mine, root)).stages[0]?.server).toEqual({ requireCheck: 'mine' });
  });
});

describe('§1.2 rule 4: the name of a required check', () => {
  it('rejects a name longer than 100 characters, at the name', () => {
    const long = 'x'.repeat(101);
    const rows = stageRecipe(commandStage(`    server: { require-check: ${long} }`));
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 10, long), /a required check name has 1 to 100 characters/),
    );
  });

  it('rejects a control character', () => {
    const rows = stageRecipe(commandStage('    server: { require-check: "todo\\tverde" }'));
    expect(parseErrors(rows)).toContainEqual(
      at(place(rows, 10, '"todo'), /control character/),
    );
  });

  it("rejects the judge's own statuses", () => {
    for (const own of ['ai-workflows', 'ai-workflows/advisory']) {
      const rows = stageRecipe(commandStage(`    server: { require-check: ${own} }`));
      expect(parseErrors(rows), own).toContainEqual(
        at(place(rows, 10, own), /cannot require the judge's own status/),
      );
    }
  });

  it('positive: ai-workflows/red-test and a 100-character name', () => {
    for (const name of ['ai-workflows/red-test', 'y'.repeat(100)]) {
      const rows = stageRecipe(commandStage(`    server: { require-check: ${name} }`));
      expect(parsed(rows).stages[0]?.server, name).toEqual({ requireCheck: name });
    }
  });
});

describe('§1.2 rule 5: an attested approval needs an owner', () => {
  const approval = [
    '    nature: attest', //                                  6 (+head)
    '    needs-human: true',
    '    gate:',
    '      uses: ai-workflows/approval-comment@1',
    '      with: { command: /visto-bueno }',
    '    server: attestation', //                            11 (+head)
  ];

  it('rejects approval-comment with server: attestation and no owner, at the server value', async () => {
    const rows = stageRecipe(approval);
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 11, 'attestation'), /server: attestation of approval-comment needs owner: in the recipe/),
    );
  });

  it('positive: with an owner', async () => {
    const rows = stageRecipe(approval, ['owner: luismichelcf']);
    expect((await checked(rows)).owner).toBe('luismichelcf');
  });
});

describe('§1.2 rule 6: the server never approves a rule it did not check', () => {
  const benchmark = (reachable: string, mode: string) => [
    '    nature: structure',
    '    gate:',
    '      uses: ai-workflows/benchmark-sources@1',
    `      with: { files: ["docs/research/{piece}/*.md"], check-reachable: ${reachable} }`,
    `    server: ${mode}`, //                                        10
  ];

  it('rejects benchmark-sources recomputed on GitHub when it must check that sources answer', async () => {
    const rows = stageRecipe(benchmark('true', 'recompute'));
    expect(await checkErrors(rows)).toContainEqual(
      at(place(rows, 10, 'recompute'), /check-reachable cannot be recomputed on GitHub; use require-check/),
    );
  });

  it('positive: the same stage by require-check, or without reachability', async () => {
    expect((await checked(stageRecipe(benchmark('true', '{ require-check: fuentes }')))).stages[0]?.server)
      .toEqual({ requireCheck: 'fuentes' });
    expect((await checked(stageRecipe(benchmark('false', 'recompute')))).stages[0]?.server).toBe('recompute');
  });
});

describe('the example recipe of init', () => {
  it('declares its pieces and passes every check', async () => {
    const result = await checkRecipe(TEMPLATE, 'pipeline.yml', { root: project() });
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.recipe.pieces?.branch.length).toBeGreaterThan(0);
    expect(result.recipe.pieces?.declaredKind?.file).toContain('{piece}');
  });
});

// ---------------------------------------------------------------------------------------------
// §1.4: explain

describe('§1.4: explain says how GitHub checks each step', () => {
  const recipeWith = (locale: string, stage: readonly string[], extra: readonly string[] = []) =>
    parsed([
      'version: 1',
      `locale: ${locale}`,
      'owner: luismichelcf',
      ...extra,
      'stages:',
      '  - id: check',
      '    summary: "Paso"',
      ...stage,
      '  - id: merge',
      '    summary: "Se une"',
      '    after: check',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node m.mjs',
    ]);

  const recompute = [
    '    nature: structure',
    '    gate:',
    '      uses: ai-workflows/spec-structure@1',
    '      with: { file: "docs/PLAN-{piece}.md" }',
    '    server: recompute',
  ];
  const requireCheck = [
    '    nature: recompute',
    '    gate:',
    '      run: node c.mjs',
    '    server: { require-check: todo-verde }',
  ];
  const redTest = [
    '    nature: execution-record',
    '    valid-while: forever',
    '    gate:',
    '      uses: ai-workflows/red-test@1',
    '      with: { command: "pnpm vitest run {tests}" }',
    '    server: { require-check: ai-workflows/red-test }',
  ];
  const attestation = (validWhile: string) => [
    '    nature: attest',
    `    valid-while: ${validWhile}`,
    '    gate:',
    '      uses: ai-workflows/approval-comment@1',
    '    server: attestation',
  ];
  const optionalLocal = [
    '    nature: recompute',
    '    required: false',
    '    gate:',
    '      run: node c.mjs',
    '    server: local-only',
  ];

  it('in Spanish, one line per mode, after the validity line', () => {
    const text = (stage: readonly string[]) => explainRecipe(recipeWith('es', stage)).split('\n');
    const after = (rows: string[], line: string) => rows[rows.findIndex((row) => row.startsWith('   Vale')) + 1] === line;

    expect(after(text(recompute), '   En GitHub: se vuelve a comprobar antes de fusionar.')).toBe(true);
    expect(after(text(requireCheck), '   En GitHub: se exige que un check lo confirme en verde sobre esta misma versión.')).toBe(true);
    expect(after(text(attestation('same-sha')), '   En GitHub: se busca la aprobación publicada en el PR.')).toBe(true);
    expect(after(text(optionalLocal), '   En GitHub: solo se comprueba junto al agente.')).toBe(true);
  });

  it('in Spanish, says what GitHub cannot see', () => {
    expect(explainRecipe(recipeWith('es', redTest))).toContain(
      '   El orden en que se escribió solo lo vigila el motor junto al agente.',
    );
    expect(explainRecipe(recipeWith('es', attestation('same-fingerprint-or-clean-update')))).toContain(
      '   En GitHub, una actualización con la versión principal pide aprobarla otra vez.',
    );
    expect(explainRecipe(recipeWith('es', attestation('same-sha')))).not.toContain('pide aprobarla otra vez');
  });

  it('in English', () => {
    const text = (stage: readonly string[]) => explainRecipe(recipeWith('en', stage));
    expect(text(recompute)).toContain('   On GitHub: checked again before joining the main line.');
    expect(text(requireCheck)).toContain('   On GitHub: a check must confirm it in green on this same version.');
    expect(text(attestation('same-sha'))).toContain('   On GitHub: the approval published on the pull request is looked for.');
    expect(text(optionalLocal)).toContain('   On GitHub: only checked next to the agent.');
    expect(text(redTest)).toContain('   The order in which it was written is only watched by the engine next to the agent.');
    expect(text(attestation('same-fingerprint-or-clean-update'))).toContain(
      '   On GitHub, an update with the main version asks for it to be approved again.',
    );
  });

  it('says nothing about GitHub for a stage without server or after the merge', () => {
    const text = explainRecipe(recipeWith('es', ['    nature: recompute', '    gate:', '      run: node c.mjs']));
    expect(text).not.toContain('En GitHub');
  });

  it('says how a piece is recognized, right after the heading', () => {
    const kinds = ['kinds:', '  names: [behavior, docs]', '  default: behavior'];
    const pieces = [
      'pieces:',
      '  branch: ["*/{piece}"]',
      '  declared-kind:',
      '    file: "docs/plans/PLAN-{piece}.md"',
      '    line: "Tipo de cambio"',
    ];
    const es = explainRecipe(recipeWith('es', requireCheck, [...kinds, ...pieces])).split('\n');
    expect(es.slice(1, 5)).toEqual([
      '',
      'Cada pieza se reconoce por el nombre de su rama; una rama sin pieza nunca se fusiona.',
      'Su tipo de cambio lo declara la línea «Tipo de cambio» de «docs/plans/PLAN-{piece}.md».',
      '',
    ]);
    const en = explainRecipe(recipeWith('en', requireCheck, [...kinds, ...pieces])).split('\n');
    expect(en.slice(1, 5)).toEqual([
      '',
      'Each piece is recognized by the name it works under; work without a piece never joins the main line.',
      'Its kind of change is declared by the line "Tipo de cambio" of "docs/plans/PLAN-{piece}.md".',
      '',
    ]);
    const noKind = explainRecipe(recipeWith('es', requireCheck, [...kinds, 'pieces:', '  branch: ["*/{piece}"]'])).split('\n');
    expect(noKind.slice(1, 4)).toEqual([
      '',
      'Cada pieza se reconoce por el nombre de su rama; una rama sin pieza nunca se fusiona.',
      '',
    ]);
  });
});
