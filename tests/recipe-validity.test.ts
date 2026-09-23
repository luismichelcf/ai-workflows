import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type BlockDefinition,
  type GateResult,
  type JournalEntry,
  type Recipe,
  type Store,
} from '../src/index.js';
import { recordCleanUpdate } from '../src/recipe/validity.js';

import { advanceMain, commit, git, mergeMain, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §2.3, §5 and §6: a recipe becomes the engine's configuration, every stage's
// evidence is sealed by the engine with what it judged, and each validity rule keeps or drops
// that evidence exactly as the table of PLAN-13 §3.3 says. A stage whose evidence still holds
// is not run again; one whose evidence expired is. The count of calls to a probe block is how
// these tests see which happened. Git is real; the store is the memory reference store.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

/** A block that counts its calls and answers what the test says. */
function probe(answer: () => GateResult | Promise<GateResult> = () => ({ ok: true })) {
  const calls: unknown[] = [];
  const block: BlockDefinition = {
    manifest: {
      name: 'probe',
      kind: 'module',
      natures: ['recompute', 'structure', 'execution-record', 'attest'],
      inputs: {},
    },
    create: () => async (context) => {
      calls.push(context.change);
      return answer();
    },
  };
  return { block, calls };
}

/** Holds every piece at the merge, so each run re-evaluates the probe stage and stops. */
const hold: BlockDefinition = {
  manifest: { name: 'hold', kind: 'module', natures: ['recompute'], inputs: {} },
  create: () => () => ({ ok: false, reason: 'held at the merge on purpose' }),
};

/** One probed stage with the given validity, then the merge. */
const validityRecipe = (validWhile: string) =>
  recipeOf(lines(
    'version: 1',
    'locale: es',
    'stages:',
    '  - id: probe',
    '    summary: "Paso vigilado"',
    '    nature: recompute',
    `    valid-while: ${validWhile}`,
    '    gate:',
    '      uses: ai-workflows/probe@1',
    '  - id: merge',
    '    summary: "Se une"',
    '    after: probe',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/hold@1',
  ));

async function pieceOver(root: string, recipe: Recipe, block: BlockDefinition, store: Store = createMemoryStore()) {
  const compiled = await compileRecipe(recipe, {
    root,
    baseRef: 'main',
    declared: () => ({}),
    store,
    extraBlocks: { 'ai-workflows/probe@1': block, 'ai-workflows/hold@1': hold },
  });
  const engine = createEngine({
    config: compiled.config,
    store,
    describeChange: compiled.describeChange,
    confirmFacts: compiled.confirmFacts,
  });
  return { engine, store, compiled, run: () => engine.run('42') };
}

describe('§6 same-sha', () => {
  it('keeps the evidence while the commit and the unsaved state stay the same', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-sha'), block);
    await piece.run();
    await piece.run();
    expect(calls).toHaveLength(1);
  });

  it('drops it with a new commit', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-sha'), block);
    await piece.run();
    write(root, 'app/page.tsx', 'y\n');
    commit(root, 'd');
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('drops it with an unsaved edit on the same commit, also when resuming', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-sha'), block);
    await piece.run();
    write(root, 'app/page.tsx', 'unsaved\n');
    await piece.run();
    expect(calls).toHaveLength(2);
  });
});

describe('§6 same-fingerprint', () => {
  it('keeps the evidence across a new commit with the same changes', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-fingerprint'), block);
    await piece.run();
    git(root, 'commit', '-q', '--amend', '-m', 'same changes, new commit');
    await piece.run();
    expect(calls).toHaveLength(1);
  });

  it('drops it when an unsaved edit changes what is judged', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-fingerprint'), block);
    await piece.run();
    write(root, 'app/page.tsx', 'y\n');
    await piece.run();
    expect(calls).toHaveLength(2);
  });
});

describe('§6 forever', () => {
  it('keeps the evidence through new commits', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('forever'), block);
    await piece.run();
    write(root, 'app/page.tsx', 'y\n');
    commit(root, 'd');
    await piece.run();
    expect(calls).toHaveLength(1);
  });
});

describe('§6 same-fingerprint-or-clean-update', () => {
  const LIST = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const edit = (text: string, index: number, value: string) => {
    const rows = text.split('\n');
    rows[index] = value;
    return rows.join('\n');
  };

  /** A piece that edits line 1 of a shared file, judged once, and its store. */
  async function judged() {
    const root = repository({ 'app/list.txt': LIST });
    write(root, 'app/list.txt', edit(LIST, 0, 'piece edits line 1'));
    const sha = commit(root, 'piece');
    const { block, calls } = probe();
    const store = createMemoryStore();
    const piece = await pieceOver(root, validityRecipe('same-fingerprint-or-clean-update'), block, store);
    await piece.run();
    expect(calls).toHaveLength(1);
    return { root, sha, calls, store, piece };
  }

  const record = (root: string, store: Store, from: string, to: string) =>
    recordCleanUpdate({ store, root, baseRef: 'main', piece: '42', from, to });

  it('keeps it with the same commit', async () => {
    const { calls, piece } = await judged();
    await piece.run();
    expect(calls).toHaveLength(1);
  });

  it('keeps it across a recorded clean merge that touched another line of the same file', async () => {
    const { root, sha, calls, store, piece } = await judged();
    advanceMain(root, { 'app/list.txt': edit(LIST, 10, 'main edits line 11') });
    const merged = mergeMain(root);
    await record(root, store, sha, merged);
    await piece.run();
    expect(calls).toHaveLength(1);
  });

  it('keeps it across two recorded clean merges in a row', async () => {
    const { root, sha, calls, store, piece } = await judged();
    advanceMain(root, { 'docs/a.md': 'a\n' });
    const first = mergeMain(root);
    await record(root, store, sha, first);
    advanceMain(root, { 'docs/b.md': 'b\n' });
    const second = mergeMain(root);
    await record(root, store, first, second);
    await piece.run();
    expect(calls).toHaveLength(1);
  });

  it('drops it across a clean merge nobody recorded', async () => {
    const { root, calls, piece } = await judged();
    advanceMain(root, { 'docs/a.md': 'a\n' });
    mergeMain(root);
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('refuses to record a merge whose conflict was resolved by hand, and drops the evidence', async () => {
    const { root, sha, calls, store, piece } = await judged();
    advanceMain(root, { 'app/list.txt': edit(LIST, 0, 'main edits line 1 too') });
    expect(() => git(root, 'merge', '-q', '--no-edit', 'main')).toThrow();
    write(root, 'app/list.txt', edit(LIST, 0, 'resolved by hand'));
    const merged = commit(root, 'resolve');
    await expect(record(root, store, sha, merged)).rejects.toThrow(/not a clean update/);
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('refuses a clean merge with an extra change slipped into the merge commit', async () => {
    const { root, sha, calls, store, piece } = await judged();
    advanceMain(root, { 'docs/a.md': 'a\n' });
    mergeMain(root);
    write(root, 'app/page.tsx', 'slipped in\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--amend', '--no-edit');
    const merged = git(root, 'rev-parse', 'HEAD');
    await expect(record(root, store, sha, merged)).rejects.toThrow(/not a clean update/);
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('a record written straight into the store does not count without its shape in git', async () => {
    const { root, sha, calls, store, piece } = await judged();
    write(root, 'app/page.tsx', 'a new commit of the piece\n');
    const next = commit(root, 'not a merge');
    const forged: JournalEntry = {
      stage: '@clean-update',
      outcome: 'passed',
      evidence: { from: sha, to: next, base: git(root, 'rev-parse', 'main') },
      at: 1,
      runId: 'forger',
      pipeline: '',
    };
    await store.append('42', forged);
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('drops it after a force push, even when the new commit has the same changes', async () => {
    const { root, calls, store, piece } = await judged();
    git(root, 'commit', '-q', '--amend', '-m', 'rewritten');
    const rewritten = git(root, 'rev-parse', 'HEAD');
    advanceMain(root, { 'docs/a.md': 'a\n' });
    const merged = mergeMain(root);
    await record(root, store, rewritten, merged);
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('drops it with a new commit of the piece', async () => {
    const { root, calls, piece } = await judged();
    write(root, 'app/page.tsx', 'more\n');
    commit(root, 'more');
    await piece.run();
    expect(calls).toHaveLength(2);
  });

  it('drops it when what was judged was not saved, even if the commit is the same now', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    write(root, 'app/page.tsx', 'unsaved while judged\n');
    const { block, calls } = probe();
    const piece = await pieceOver(root, validityRecipe('same-fingerprint-or-clean-update'), block);
    await piece.run();
    git(root, 'checkout', '--', 'app/page.tsx');
    await piece.run();
    expect(calls).toHaveLength(2);
  });
});

describe('§2.3 the engine seals what each stage judged', () => {
  it('stores the block evidence under block, and what was judged beside it', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    const sha = commit(root, 'c');
    const { block } = probe(() => ({ ok: true, evidence: { judged: { sha: 'forged' }, seen: 1 } }));
    const piece = await pieceOver(root, validityRecipe('same-sha'), block);
    await piece.run();
    const entry = (await piece.store.journal('42')).find((item) => item.stage === 'probe');
    expect(entry?.evidence).toEqual({
      judged: {
        sha,
        snapshot: git(root, 'rev-parse', 'HEAD^{tree}'),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      block: { judged: { sha: 'forged' }, seen: 1 },
    });
  });

  it('refuses a result produced while the working tree changed under the stage', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block } = probe(() => {
      writeFileSync(join(root, 'app/page.tsx'), 'changed during the stage\n');
      return { ok: true };
    });
    const piece = await pieceOver(root, validityRecipe('same-sha'), block);
    const outcome = await piece.run();
    expect(outcome).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:technical', stage: 'probe', reason: expect.stringMatching(/working tree changed while the stage ran/) },
    });
    const journal = await piece.store.journal('42');
    expect(journal.some((item) => item.stage === 'probe' && item.outcome === 'passed')).toBe(false);
  });
});

describe('§6 the final check before done', () => {
  it('confirmFacts says nothing while the facts hold, and why once they do not', async () => {
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const { block } = probe();
    const { compiled } = await pieceOver(root, validityRecipe('same-sha'), block);
    const change = await compiled.describeChange('42');
    expect(await compiled.confirmFacts(change)).toBeUndefined();
    write(root, 'app/page.tsx', 'changed after the facts were read\n');
    expect(await compiled.confirmFacts(change)).toMatch(/changed during the run/);
  });

  it('a piece whose facts no longer hold at the end is blocked, never done', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => ({ ok: true }) }] },
      store,
      describeChange: () => ({}),
      confirmFacts: async () => 'the working tree changed during the run',
    });
    expect(await engine.run('42')).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:technical', reason: 'the working tree changed during the run' },
    });
  });
});

describe('§6 records of the engine are not stages', () => {
  it('an entry whose stage starts with @ does not block the piece as an unknown stage', async () => {
    const store = createMemoryStore();
    await store.append('42', {
      stage: '@clean-update',
      outcome: 'passed',
      evidence: { from: 'a', to: 'b', base: 'c' },
      at: 1,
      runId: 'engine',
      pipeline: '',
    });
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => ({ ok: true }) }] },
      store,
    });
    expect(await engine.run('42')).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
  });
});

describe('§5 from the recipe to the engine', () => {
  it('runs a stage only when applies-if holds on the effective kind', async () => {
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'classify:',
      '  money: ["lib/calc/**"]',
      'kinds:',
      '  names: [behavior, visual-only]',
      '  default: behavior',
      '  elevate:',
      '    - when: { touches-any: [money], kind-any: [visual-only] }',
      '      to: behavior',
      'stages:',
      '  - id: probe',
      '    summary: "Solo con comportamiento"',
      '    nature: recompute',
      '    applies-if: { kind-any: [behavior] }',
      '    gate:',
      '      uses: ai-workflows/probe@1',
      '  - id: merge',
      '    summary: "Se une"',
      '    after: probe',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/hold@1',
    ));
    const root = repository();
    write(root, 'lib/calc/tax.ts', 'export const tax = 2;\n');
    commit(root, 'money');
    const { block, calls } = probe();
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, {
      root,
      baseRef: 'main',
      declared: () => ({ kind: 'visual-only' }),
      store,
      extraBlocks: { 'ai-workflows/probe@1': block, 'ai-workflows/hold@1': hold },
    });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    await engine.run('42');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ declaredKind: 'visual-only', kind: 'behavior' });
  });

  it('hands a block its inputs with the manifest defaults, in camelCase, and the privileged deps', async () => {
    const received: unknown[] = [];
    const custom: BlockDefinition = {
      manifest: {
        name: 'custom',
        kind: 'module',
        natures: ['recompute'],
        inputs: {
          'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
          'red-stage': { type: 'string' },
        },
      },
      create: (inputs, deps) => {
        received.push(inputs, typeof deps.recordCleanUpdate);
        return () => ({ ok: true });
      },
    };
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: only',
      '    summary: "Uno"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/custom@1',
      '      with: { red-stage: first }',
    ));
    await compileRecipe(recipe, {
      root: repository(),
      baseRef: 'main',
      declared: () => ({}),
      store: createMemoryStore(),
      extraBlocks: { 'ai-workflows/custom@1': custom },
    });
    expect(received).toEqual([{ timeoutMinutes: 30, redStage: 'first' }, 'function']);
  });

  it('refuses retry and required: false until slice 4, instead of ignoring them', async () => {
    const base = (extra: string) => recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: only',
      '    summary: "Uno"',
      '    phase: merge',
      '    nature: recompute',
      extra,
      '    gate:',
      '      uses: ai-workflows/probe@1',
    ));
    const deps = {
      root: repository(),
      baseRef: 'main',
      declared: () => ({}),
      store: createMemoryStore(),
      extraBlocks: { 'ai-workflows/probe@1': probe().block },
    };
    await expect(compileRecipe(base('    retry: { attempts: 2 }'), deps)).rejects.toThrow(/retry.*slice 4/);
    await expect(compileRecipe(base('    required: false'), deps)).rejects.toThrow(/required: false.*slice 4/);
  });

  it('refuses a block it does not know', async () => {
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: only',
      '    summary: "Uno"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/ghost@1',
    ));
    await expect(compileRecipe(recipe, {
      root: repository(),
      baseRef: 'main',
      declared: () => ({}),
      store: createMemoryStore(),
    })).rejects.toThrow(/unknown engine block "ai-workflows\/ghost@1"/);
  });

  it('a block of slice 4 blocks the piece technically, saying so', async () => {
    const recipe = recipeOf(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: only',
      '    summary: "Uno"',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/github-merge@1',
    ));
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    expect(await engine.run('42')).toMatchObject({
      outcome: 'ran',
      status: { state: 'blocked:technical', stage: 'only', reason: expect.stringMatching(/not built yet \(slice 4\)/) },
    });
  });
});
