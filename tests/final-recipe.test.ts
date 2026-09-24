import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRecipe,
  engineBlockManifest,
  parseRecipe,
  type Recipe,
  type RecipeError,
} from '../src/index.js';

// PLAN-13-R4 §1.1, §3, §5 and §6: what the recipe gains for the final stages. `agent-account`
// is the GitHub identity the agents publish with (R21); `messages:` configures the owner's
// messages; the final blocks get their manifests and their stage references; `required: false`
// has two combinations that cannot be read.

const FILE = '.ai-workflows/pipeline.yml';
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-final-recipe-'));
  roots.push(root);
  return root;
}

function place(rows: readonly string[], row: number, token: string) {
  const index = (rows[row - 1] ?? '').indexOf(token);
  if (index < 0) throw new Error(`fixture: "${token}" not found in row ${row}`);
  return { line: row, column: index + 1 };
}

const at = (where: { line: number; column: number }, message: RegExp) =>
  expect.objectContaining({ file: FILE, ...where, message: expect.stringMatching(message) });

async function errorsOf(rows: readonly string[]): Promise<readonly RecipeError[]> {
  const result = await checkRecipe(lines(...rows), FILE, { root: project() });
  if (result.ok) throw new Error('expected the recipe to be rejected');
  return result.errors;
}

async function validOf(rows: readonly string[]): Promise<Recipe> {
  const result = await checkRecipe(lines(...rows), FILE, { root: project() });
  if (!result.ok) {
    const shown = result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n');
    throw new Error(`expected a valid recipe, got:\n${shown}`);
  }
  return result.recipe;
}

/**
 * The whole final part of a process. Row numbers are fixed so the tests can point at them; the
 * header rows can be swapped with `header`.
 */
function finalRecipe(header: readonly string[] = HEADER): string[] {
  return [
    ...header,
    'stages:',
    '  - id: review',
    '    summary: "Revisores independientes aprueban"',
    '    nature: attest',
    '    valid-while: same-fingerprint-or-clean-update',
    '    gate:',
    '      uses: ai-workflows/independent-review@1',
    '      with: { angles: [arquitectura, seguridad] }',
    '    server: attestation',
    '  - id: approval',
    '    summary: "El dueño aprueba"',
    '    after: review',
    '    nature: attest',
    '    needs-human: true',
    '    valid-while: same-fingerprint',
    '    gate:',
    '      uses: ai-workflows/approval-review@1',
    '    server: attestation',
    '  - id: preview',
    '    summary: "La vista previa está lista"',
    '    after: approval',
    '    nature: recompute',
    '    retry: { attempts: 5, wait-seconds: 60 }',
    '    gate:',
    '      uses: ai-workflows/preview-deployment@1',
    '      with: { environment: Preview, creator: "vercel[bot]", url-pattern: "*.vercel.app" }',
    '    server: { require-check: Vercel }',
    '  - id: qa',
    '    summary: "Pruebas de navegador sobre la vista previa"',
    '    after: preview',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/browser-qa@1',
    '      with:',
    '        command: "pnpm exec playwright test"',
    '        preview-stage: preview',
    '        criteria: { file: "docs/plans/PLAN-{piece}.md", section: "Casos de aceptación", id-prefix: "CA-" }',
    '        pass-env: [SUPABASE_TEST_PWD]',
    '    server: { require-check: qa }',
    '  - id: merge',
    '    summary: "Entra a la cola y se fusiona"',
    '    after: qa',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
    '      with: { method: squash }',
    '  - id: after',
    '    summary: "Lo publicado queda en verde"',
    '    after: merge',
    '    phase: post-merge',
    '    nature: recompute',
    '    retry: { attempts: 3, wait-seconds: 120 }',
    '    gate:',
    '      uses: ai-workflows/post-merge@1',
    '      with: { merge-stage: merge, checks: [deploy], deployment: { environment: Production } }',
    '    server: local-only',
    '  - id: cleanup',
    '    summary: "Se limpia la rama y la carpeta"',
    '    after: after',
    '    phase: post-merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/cleanup@1',
    '      with: { merge-stage: merge }',
    '    server: local-only',
  ];
}

const HEADER = [
  'version: 1', //                            1
  'locale: es', //                            2
  'owner: duena', //                          3
  'agent-account: "mi-motor[bot]"', //        4
  'pieces: { branch: ["*/{piece}-*"] }', //   5
];

/** The row (1-based) of the first line containing `token` in `rows`. */
function rowOf(rows: readonly string[], token: string): number {
  const index = rows.findIndex((row) => row.includes(token));
  if (index < 0) throw new Error(`fixture: "${token}" not found`);
  return index + 1;
}

function replaced(rows: readonly string[], token: string, replacement: string): string[] {
  const row = rowOf(rows, token);
  return rows.map((line, index) => (index === row - 1 ? line.replace(token, replacement) : line));
}

// ---------------------------------------------------------------------------------------------
// agent-account (R21, §1.1)

describe('agent-account (R21)', () => {
  it('positive: the whole final part of a process validates, and the recipe keeps the account', async () => {
    const recipe = await validOf(finalRecipe());
    expect(recipe.agentAccount).toBe('mi-motor[bot]');
    expect(recipe.stages.map((stage) => stage.id)).toEqual([
      'review', 'approval', 'preview', 'qa', 'merge', 'after', 'cleanup',
    ]);
  });

  it('is optional when no stage publishes as the agents', async () => {
    const rows = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: merge',
      '    summary: "Se une"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/github-merge@1',
    ];
    const recipe = await validOf(rows);
    expect(recipe.agentAccount).toBeUndefined();
  });

  for (const bad of ['"mi motor[bot]"', '"mi-motor"', '"-mi-motor[bot]"', '"mi-motor[BOT]"']) {
    it(`refuses the account ${bad}, pointing at it`, async () => {
      const rows = replaced(finalRecipe(), '"mi-motor[bot]"', bad);
      expect(await errorsOf(rows)).toContainEqual(at(place(rows, 4, bad), /agent-account/));
    });
  }

  it('approval-review needs agent-account, pointing at the block', async () => {
    const rows = finalRecipe(HEADER.filter((row) => !row.startsWith('agent-account')));
    const row = rowOf(rows, 'ai-workflows/approval-review@1');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, row, 'ai-workflows/approval-review@1'), /needs agent-account:/),
    );
  });

  it('approval-review needs owner, pointing at the block', async () => {
    const rows = finalRecipe(HEADER.filter((row) => !row.startsWith('owner')));
    const row = rowOf(rows, 'ai-workflows/approval-review@1');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, row, 'ai-workflows/approval-review@1'), /needs owner:/),
    );
  });

  it('independent-review needs agent-account and pieces:, pointing at the block', async () => {
    const noAccount = finalRecipe(HEADER.filter((row) => !row.startsWith('agent-account')));
    const accountRow = rowOf(noAccount, 'ai-workflows/independent-review@1');
    expect(await errorsOf(noAccount)).toContainEqual(
      at(place(noAccount, accountRow, 'ai-workflows/independent-review@1'), /needs agent-account:/),
    );

    const noPieces = finalRecipe(HEADER.filter((row) => !row.startsWith('pieces')));
    const piecesRow = rowOf(noPieces, 'ai-workflows/independent-review@1');
    expect(await errorsOf(noPieces)).toContainEqual(
      at(place(noPieces, piecesRow, 'ai-workflows/independent-review@1'), /needs pieces:/),
    );
  });

  const sandboxed = (server: string, header: readonly string[]) => [
    ...header,
    'stages:',
    '  - id: review',
    '    summary: "Un revisor en solo lectura"',
    '    nature: attest',
    '    gate:',
    '      uses: ai-workflows/sandboxed-review@1',
    '      with:',
    '        reviewer: { provider: claude, model: claude-opus-5 }',
    '        prompt: "docs/review-{piece}.md"',
    '        angle: correctitud',
    `    server: ${server}`,
    '  - id: merge',
    '    summary: "Se une"',
    '    after: review',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
  ];

  it('sandboxed-review with server: attestation needs agent-account and pieces:', async () => {
    const noAccount = sandboxed('attestation', HEADER.filter((row) => !row.startsWith('agent-account')));
    expect(await errorsOf(noAccount)).toContainEqual(
      at(place(noAccount, rowOf(noAccount, 'server: attestation'), 'attestation'), /needs agent-account:/),
    );
    const noPieces = sandboxed('attestation', HEADER.filter((row) => !row.startsWith('pieces')));
    expect(await errorsOf(noPieces)).toContainEqual(
      at(place(noPieces, rowOf(noPieces, 'server: attestation'), 'attestation'), /needs pieces:/),
    );
  });

  it('positive: sandboxed-review with a required check needs neither', async () => {
    await validOf(sandboxed('{ require-check: review }', ['version: 1', 'locale: es']));
  });
});

// ---------------------------------------------------------------------------------------------
// The manifests of the final blocks (§3)

describe('the manifests of the final blocks', () => {
  it('approval-review is an attestation with no inputs, checked on GitHub by attestation', () => {
    const manifest = engineBlockManifest('ai-workflows/approval-review@1');
    expect(manifest).toBeDefined();
    expect(manifest?.natures).toEqual(['attest']);
    expect([...(manifest?.validWhile ?? [])].sort()).toEqual(
      ['same-fingerprint', 'same-fingerprint-or-clean-update', 'same-sha'],
    );
    expect([...(manifest?.server ?? [])].sort()).toEqual(['attestation', 'require-check']);
    expect(manifest?.inputs).toEqual({});
  });

  it('independent-review requires at least one angle', async () => {
    const rows = replaced(finalRecipe(), 'with: { angles: [arquitectura, seguridad] }', 'with: { forbid-same-family: true }');
    const row = rowOf(rows, 'ai-workflows/independent-review@1');
    expect(await errorsOf(rows)).toContainEqual(expect.objectContaining({ line: row + 1, message: expect.stringMatching(/angles/) }));

    const empty = replaced(finalRecipe(), '[arquitectura, seguridad]', '[]');
    expect(await errorsOf(empty)).toContainEqual(
      at(place(empty, rowOf(empty, 'angles: []'), '[]'), /angles/),
    );
  });

  it('preview-deployment requires the environment', async () => {
    const rows = replaced(finalRecipe(), 'environment: Preview, ', '');
    expect((await errorsOf(rows)).some((error) => /environment/.test(error.message))).toBe(true);
  });

  it('github-merge takes only merge, squash or rebase, and bounded times', async () => {
    for (const bad of ['method: fast', 'method: squash, timeout-minutes: 0', 'method: squash, timeout-minutes: 1441', 'method: squash, poll-seconds: 5', 'method: squash, poll-seconds: 301']) {
      const rows = replaced(finalRecipe(), 'method: squash', bad);
      await expect(errorsOf(rows), bad).resolves.not.toHaveLength(0);
    }
    for (const good of ['method: merge', 'method: rebase', 'method: squash, timeout-minutes: 1440, poll-seconds: 10']) {
      await validOf(replaced(finalRecipe(), 'method: squash', good));
    }
  });

  it('browser-qa must point at an earlier preview-deployment stage', async () => {
    const rows = replaced(finalRecipe(), 'preview-stage: preview', 'preview-stage: review');
    const row = rowOf(rows, 'preview-stage: review');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, row, 'review'), /input "preview-stage" must name an earlier stage that uses ai-workflows\/preview-deployment@1/),
    );
  });

  it('browser-qa requires the criteria with its three fields', async () => {
    const rows = replaced(finalRecipe(), ', id-prefix: "CA-"', '');
    expect((await errorsOf(rows)).some((error) => /id-prefix/.test(error.message))).toBe(true);
  });

  it('post-merge and cleanup must point at an earlier github-merge stage', async () => {
    const post = replaced(finalRecipe(), 'with: { merge-stage: merge, checks', 'with: { merge-stage: qa, checks');
    expect(await errorsOf(post)).toContainEqual(
      at(place(post, rowOf(post, 'merge-stage: qa'), 'qa, checks'), /input "merge-stage" must name an earlier stage that uses ai-workflows\/github-merge@1/),
    );
    const clean = replaced(finalRecipe(), 'with: { merge-stage: merge }', 'with: { merge-stage: after }');
    expect(await errorsOf(clean)).toContainEqual(
      at(place(clean, rowOf(clean, 'merge-stage: after'), 'after }'), /input "merge-stage" must name an earlier stage that uses ai-workflows\/github-merge@1/),
    );
  });

  it('cleanup no longer takes close-issue (PLAN-13-R4 §3.8, ronda 9)', async () => {
    const rows = replaced(finalRecipe(), 'with: { merge-stage: merge }', 'with: { merge-stage: merge, close-issue: true }');
    expect((await errorsOf(rows)).some((error) => /close-issue/.test(error.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// required: false (§5)

describe('required: false (§5)', () => {
  it('cannot wait for a person', async () => {
    const rows = replaced(finalRecipe(), '    needs-human: true', '    needs-human: true\n    required: false').flatMap((row) => row.split('\n'));
    const row = rowOf(rows, 'required: false');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, row, 'false'), /required: false cannot wait for a person/),
    );
  });

  it('cannot be the merge stage', async () => {
    const rows = replaced(finalRecipe(), '    phase: merge', '    phase: merge\n    required: false').flatMap((row) => row.split('\n'));
    const row = rowOf(rows, 'required: false');
    expect(await errorsOf(rows)).toContainEqual(
      at(place(rows, row, 'false'), /the merge stage is always required/),
    );
  });

  it('positive: an optional post-merge stage validates', async () => {
    const rows = replaced(finalRecipe(), '    retry: { attempts: 3, wait-seconds: 120 }', '    required: false');
    const recipe = await validOf(rows);
    expect(recipe.stages.find((stage) => stage.id === 'after')?.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// messages: (§6)

describe('messages: (§6)', () => {
  const withMessages = (...rows: string[]) => [...HEADER, 'messages:', ...rows, ...finalRecipe([]).slice(0)];

  it('is optional: without it the recipe has no messages', async () => {
    const recipe = await validOf(finalRecipe());
    expect(recipe.messages).toBeUndefined();
  });

  it('reads the summary, the length and the extra banned words, with the defaults', async () => {
    const full = await validOf(withMessages(
      '  summary: { file: "docs/plans/PLAN-{piece}.md", section: "En tres líneas" }',
      '  max-length: 900',
      '  banned-words: ["pipeline", "sha"]',
    ));
    expect(full.messages).toEqual({
      summary: { file: 'docs/plans/PLAN-{piece}.md', section: 'En tres líneas' },
      maxLength: 900,
      bannedWords: ['pipeline', 'sha'],
    });

    const minimal = await validOf(withMessages('  max-length: 700'));
    expect(minimal.messages).toEqual({ maxLength: 700, bannedWords: [] });
  });

  it('refuses an unknown key, a length out of 140…5000 and an escaping summary file', async () => {
    const unknown = withMessages('  channel: slack');
    expect(await errorsOf(unknown)).toContainEqual(expect.objectContaining({ line: rowOf(unknown, 'channel: slack') }));

    for (const [value, message] of [['139', /at least 140/], ['5001', /at most 5000/]] as const) {
      const rows = withMessages(`  max-length: ${value}`);
      expect(await errorsOf(rows)).toContainEqual(
        at(place(rows, rowOf(rows, `max-length: ${value}`), value), message),
      );
    }

    for (const file of ['"../fuera.md"', '"/etc/passwd"', '"C:/x.md"']) {
      const rows = withMessages(`  summary: { file: ${file}, section: "Resumen" }`);
      expect(await errorsOf(rows), file).toContainEqual(expect.objectContaining({ line: rowOf(rows, file) }));
    }
  });

  it('refuses a banned word that is not text', async () => {
    const rows = withMessages('  banned-words: [1, "sha"]');
    expect(await errorsOf(rows)).toContainEqual(expect.objectContaining({ line: rowOf(rows, 'banned-words') }));
  });
});

// ---------------------------------------------------------------------------------------------
// parseRecipe agrees with checkRecipe on the forms that need no manifest

describe('parseRecipe', () => {
  it('carries agent-account and messages without reading any block', () => {
    const result = parseRecipe(lines(
      ...HEADER,
      'messages: { max-length: 800 }',
      'stages:',
      '  - id: merge',
      '    summary: "Se une"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/github-merge@1',
    ), FILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.agentAccount).toBe('mi-motor[bot]');
    expect(result.recipe.messages).toEqual({ maxLength: 800, bannedWords: [] });
  });
});
