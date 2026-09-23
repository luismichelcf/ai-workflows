import { describe, expect, it } from 'vitest';

import {
  appliesIfFor,
  createEngine,
  createMemoryStore,
  parseRecipe,
  runCommand,
  type GateContext,
  type JournalEntry,
  type PipelineConfig,
  type Recipe,
  type StageConfig,
} from '../src/index.js';

// PLAN-13 §3.4 and RC-04: `applies-if` is a structured condition over facts the engine
// computes, never an expression. A stage that does not apply is `skipped` WITH its motive, in
// the owner's language, and `status` shows it that way — never as "ran and passed". A fact
// the condition needs and the change does not carry blocks the stage: it never exempts it.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeWith(locale: string, ...conditions: string[]): Recipe {
  const stages = conditions.flatMap((condition, index) => [
    `  - id: s${index}`,
    `    summary: "Paso ${index}"`,
    ...(index === 0 ? [] : [`    after: s${index - 1}`]),
    '    nature: recompute',
    ...(condition.length === 0 ? [] : [`    applies-if: ${condition}`]),
    '    gate:',
    `      run: node s${index}.mjs`,
  ]);
  const text = lines(
    'version: 1',
    `locale: ${locale}`,
    'classify:',
    '  money: ["lib/calc/**"]',
    '  visible: ["app/**"]',
    '  production: [".github/workflows/**"]',
    'kinds:',
    '  names: [behavior, ui-behavior, docs]',
    '  default: behavior',
    'lanes:',
    '  full: [behavior, ui-behavior]',
    '  fast: [docs]',
    'stages:',
    ...stages,
    '  - id: merge',
    '    summary: "Se une a la versión principal"',
    `    after: s${conditions.length - 1}`,
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      run: node m.mjs',
  );
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.recipe;
}

const contextFor = (change: unknown): GateContext => ({ change }) as unknown as GateContext;

/** Asks stage s0 of a one-stage recipe whether it applies to `change`. */
async function ask(locale: string, condition: string, change: unknown) {
  const appliesWhen = appliesIfFor(recipeWith(locale, condition), 's0');
  if (appliesWhen === undefined) throw new Error('expected a condition');
  return appliesWhen(contextFor(change));
}

describe('a stage without applies-if', () => {
  it('has no condition at all: it always applies', () => {
    expect(appliesIfFor(recipeWith('es', ''), 's0')).toBeUndefined();
  });

  it('refuses a stage id the recipe does not have', () => {
    expect(() => appliesIfFor(recipeWith('es', ''), 'ghost')).toThrow(/ghost/);
  });
});

describe('RC-04: when the condition holds, the stage runs', () => {
  it('touches-any holds when one listed class is touched', async () => {
    expect(await ask('es', '{ touches-any: [money, visible] }', { files: ['app/a.tsx'] })).toBe(true);
  });

  it('touches-none holds when no listed class is touched', async () => {
    expect(await ask('es', '{ touches-none: [money] }', { files: ['app/a.tsx'] })).toBe(true);
  });

  it('kind-any, kind-none and lane-any hold on their facts', async () => {
    const change = { files: [], kind: 'behavior', lane: 'full' };
    expect(await ask('es', '{ kind-any: [docs, behavior] }', change)).toBe(true);
    expect(await ask('es', '{ kind-none: [docs] }', change)).toBe(true);
    expect(await ask('es', '{ lane-any: [full] }', change)).toBe(true);
  });

  it('every clause must hold', async () => {
    const condition = '{ touches-any: [money], kind-any: [behavior] }';
    expect(await ask('es', condition, { files: ['lib/calc/a.ts'], kind: 'behavior' })).toBe(true);
  });
});

describe('RC-04: when it does not hold, the stage is skipped saying why, in Spanish', () => {
  it('touches-any', async () => {
    expect(await ask('es', '{ touches-any: [visible] }', { files: ['lib/x.ts'] })).toEqual({
      skip: 'No aplica: el cambio no toca «visible».',
    });
    expect(await ask('es', '{ touches-any: [money, visible] }', { files: ['README.md'] })).toEqual({
      skip: 'No aplica: el cambio no toca «money» ni «visible».',
    });
    expect(
      await ask('es', '{ touches-any: [money, visible, production] }', { files: ['README.md'] }),
    ).toEqual({ skip: 'No aplica: el cambio no toca «money», «visible» ni «production».' });
  });

  it('touches-none names only the listed classes it touched', async () => {
    expect(
      await ask('es', '{ touches-none: [money, visible, production] }', {
        files: ['app/a.tsx', 'lib/calc/b.ts'],
      }),
    ).toEqual({ skip: 'No aplica: el cambio toca «money» y «visible».' });
    expect(await ask('es', '{ touches-none: [money] }', { files: ['lib/calc/b.ts'] })).toEqual({
      skip: 'No aplica: el cambio toca «money».',
    });
  });

  it('kind-any and kind-none', async () => {
    expect(await ask('es', '{ kind-any: [behavior, ui-behavior] }', { files: [], kind: 'docs' })).toEqual({
      skip: 'No aplica: el tipo de cambio es «docs», no «behavior» ni «ui-behavior».',
    });
    expect(await ask('es', '{ kind-none: [docs] }', { files: [], kind: 'docs' })).toEqual({
      skip: 'No aplica: el tipo de cambio es «docs».',
    });
  });

  it('lane-any', async () => {
    expect(await ask('es', '{ lane-any: [fast] }', { files: [], lane: 'full' })).toEqual({
      skip: 'No aplica: el carril es «full», no «fast».',
    });
  });

  it('names the first clause that fails, in the fixed order of §3.4', async () => {
    const condition = '{ kind-any: [behavior], touches-any: [money] }';
    expect(await ask('es', condition, { files: ['lib/calc/a.ts'], kind: 'docs' })).toEqual({
      skip: 'No aplica: el tipo de cambio es «docs», no «behavior».',
    });
    expect(await ask('es', condition, { files: ['README.md'], kind: 'docs' })).toEqual({
      skip: 'No aplica: el cambio no toca «money».',
    });
  });
});

describe('RC-04: the motive follows the recipe locale', () => {
  it('speaks English for a non-Spanish locale', async () => {
    expect(await ask('en', '{ touches-any: [money, visible] }', { files: ['README.md'] })).toEqual({
      skip: 'Does not apply: the change does not touch "money" or "visible".',
    });
    expect(
      await ask('en', '{ touches-none: [money, visible] }', { files: ['app/a.tsx', 'lib/calc/b.ts'] }),
    ).toEqual({ skip: 'Does not apply: the change touches "money" and "visible".' });
    expect(await ask('en', '{ kind-any: [behavior, ui-behavior] }', { files: [], kind: 'docs' })).toEqual({
      skip: 'Does not apply: the kind of change is "docs", not "behavior" or "ui-behavior".',
    });
    expect(await ask('en', '{ kind-none: [docs] }', { files: [], kind: 'docs' })).toEqual({
      skip: 'Does not apply: the kind of change is "docs".',
    });
    expect(await ask('en', '{ lane-any: [fast] }', { files: [], lane: 'full' })).toEqual({
      skip: 'Does not apply: the lane is "full", not "fast".',
    });
  });

  it('treats es-MX as Spanish', async () => {
    expect(await ask('es-MX', '{ touches-any: [money] }', { files: ['README.md'] })).toEqual({
      skip: 'No aplica: el cambio no toca «money».',
    });
  });
});

describe('a fact the condition needs and the change lacks never exempts', () => {
  it('throws when a touches clause has no list of files', async () => {
    await expect(ask('es', '{ touches-any: [money] }', {})).rejects.toThrow(/files/);
    await expect(ask('es', '{ touches-any: [money] }', { files: 'lib/calc/a.ts' })).rejects.toThrow(/files/);
    await expect(ask('es', '{ touches-any: [money] }', { files: [3] })).rejects.toThrow(/files/);
    await expect(ask('es', '{ touches-any: [money] }', undefined)).rejects.toThrow(/files/);
  });

  it('throws when a kind clause has no kind, and a lane clause no lane', async () => {
    await expect(ask('es', '{ kind-any: [behavior] }', { files: [] })).rejects.toThrow(/kind/);
    await expect(ask('es', '{ kind-none: [docs] }', { files: [], kind: 7 })).rejects.toThrow(/kind/);
    await expect(ask('es', '{ lane-any: [fast] }', { files: [] })).rejects.toThrow(/lane/);
  });

  it('names the stage it could not decide, so the block reason is findable', async () => {
    await expect(ask('es', '{ lane-any: [fast] }', { files: [] })).rejects.toThrow(/"s0"/);
  });

  it('blocks on a file path git would never list, instead of leaving it without a class', async () => {
    const odd = [
      './app/a.tsx',
      'app//a.tsx',
      '/app/a.tsx',
      'app/../lib/calc/a.ts',
      'app/./a.tsx',
      'app/',
      '',
      '"lib/calc/c\\303\\241lculo.ts"',
      // A Windows-style path would silently miss every class: it blocks instead.
      'lib\\calc\\x.ts',
      'app\\a.tsx',
    ];
    for (const file of odd) {
      await expect(ask('es', '{ touches-any: [money] }', { files: ['lib/calc/ok.ts', file] })).rejects.toThrow(
        /files/,
      );
    }
  });

  it('blocks on drive letters, control characters and holes, which git never lists either', async () => {
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    const odd = ['C:/repo/lib/calc/x.ts', 'c:lib/calc/x.ts', 'C:', `app/a.tsx${cr}`, `lib/calc${lf}/x.ts`, `a${nul}b`];
    for (const file of odd) {
      await expect(ask('es', '{ touches-any: [money] }', { files: [file] })).rejects.toThrow(/files/);
      await expect(ask('es', '{ touches-none: [money] }', { files: [file] })).rejects.toThrow(/files/);
    }
    // eslint-disable-next-line no-sparse-arrays
    for (const files of [new Array<string>(1), [, 'README.md']]) {
      await expect(ask('es', '{ touches-any: [money] }', { files })).rejects.toThrow(/files/);
      await expect(ask('es', '{ touches-none: [money] }', { files })).rejects.toThrow(/files/);
    }
  });

  it('blocks on an empty list of files: a change touches at least one, so it is a broken description', async () => {
    await expect(ask('es', '{ touches-any: [money] }', { files: [] })).rejects.toThrow(/files/);
    await expect(ask('es', '{ touches-none: [money] }', { files: [] })).rejects.toThrow(/files/);
  });

  it('positive: accents and spaces inside a name are ordinary characters', async () => {
    expect(await ask('es', '{ touches-any: [money] }', { files: ['lib/calc/cálculo final.ts'] })).toBe(true);
  });

  it('does not need facts that no clause asks for', async () => {
    expect(await ask('es', '{ kind-any: [behavior] }', { kind: 'behavior' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Through the engine and `status`, as the owner sees it.
// ---------------------------------------------------------------------------------------

function pipelineFor(recipe: Recipe, calls: string[]): PipelineConfig {
  const stages: StageConfig[] = recipe.stages.map((stage) => {
    const appliesWhen = appliesIfFor(recipe, stage.id);
    return {
      name: stage.id,
      summary: stage.summary,
      nature: stage.nature,
      ...(stage.after === undefined ? {} : { after: stage.after }),
      ...(appliesWhen === undefined ? {} : { appliesWhen }),
      gate: () => {
        calls.push(stage.id);
        return { ok: true };
      },
    };
  });
  return { locale: recipe.locale, stages };
}

const approvalRecipe = (): Recipe => {
  const result = parseRecipe(
    lines(
      'version: 1',
      'locale: es',
      'classify:',
      '  visible: ["app/**"]',
      'stages:',
      '  - id: spec',
      '    summary: "Un plan escrito"',
      '    nature: structure',
      '    gate:',
      '      run: node spec.mjs',
      '  - id: owner-approval',
      '    summary: "El dueño aprueba lo que se ve"',
      '    after: spec',
      '    nature: attest',
      '    needs-human: true',
      '    applies-if: { touches-any: [visible] }',
      '    gate:',
      '      uses: ai-workflows/approval-comment@1',
      '  - id: checks',
      '    summary: "Todas las pruebas en verde"',
      '    after: owner-approval',
      '    phase: merge',
      '    nature: recompute',
      '    gate:',
      '      run: node checks.mjs',
    ),
    'receta.yml',
  );
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.recipe;
};

describe('RC-04 end to end: the engine records the skip and status shows it', () => {
  it('skips the stage with its motive, never running its gate', async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const config = pipelineFor(approvalRecipe(), calls);
    const engine = createEngine({ config, store, describeChange: () => ({ files: ['lib/x.ts'] }) });

    const outcome = await engine.run('p1');

    expect(outcome.status.state).toBe('done');
    expect(calls).toEqual(['spec', 'checks']);
    const journal = await store.journal('p1');
    expect(journal.find((entry) => entry.stage === 'owner-approval')).toMatchObject({
      outcome: 'skipped',
      reason: 'No aplica: el cambio no toca «visible».',
    });

    const output = await runCommand(['status', 'p1'], {
      config,
      store,
      describeChange: () => ({ files: ['lib/x.ts'] }),
    });
    expect(output.ok).toBe(true);
    expect(output.text).toContain('\n  Pasos omitidos:\n');
    expect(output.text).toContain(
      '\n  - El dueño aprueba lo que se ve — No aplica: el cambio no toca «visible».',
    );
  });

  it('positive: when the condition holds, the stage runs and nothing is shown as skipped', async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const config = pipelineFor(approvalRecipe(), calls);
    const engine = createEngine({ config, store, describeChange: () => ({ files: ['app/page.tsx'] }) });

    const outcome = await engine.run('p1');

    expect(outcome.status.state).toBe('done');
    expect(calls).toEqual(['spec', 'owner-approval', 'checks']);
    const journal = await store.journal('p1');
    expect(journal.find((entry) => entry.stage === 'owner-approval')?.outcome).toBe('passed');

    const output = await runCommand(['status', 'p1'], { config, store });
    expect(output.text).not.toContain('Pasos omitidos');
  });

  it('blocks, and never skips, when the change lacks a fact the condition needs', async () => {
    const calls: string[] = [];
    const store = createMemoryStore();
    const config = pipelineFor(approvalRecipe(), calls);
    const engine = createEngine({ config, store, describeChange: () => ({ kind: 'behavior' }) });

    const outcome = await engine.run('p1');

    expect(outcome.status.state).toBe('blocked:technical');
    expect(outcome.status.stage).toBe('owner-approval');
    expect(calls).toEqual(['spec']);
    const journal = await store.journal('p1');
    expect(journal.some((entry) => entry.outcome === 'skipped')).toBe(false);
  });
});

describe('status lists the steps that did not apply', () => {
  const entry = (stage: string, outcome: JournalEntry['outcome'], reason?: string): JournalEntry => ({
    stage,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    at: 1,
    runId: 'r1',
    pipeline: '[]',
  });

  async function statusText(locale: string, entries: readonly JournalEntry[], stages: StageConfig[]) {
    const store = createMemoryStore();
    await store.saveStatus({ piece: 'p1', state: 'done' }, undefined);
    for (const item of entries) await store.append('p1', item);
    const output = await runCommand(['status', 'p1'], { config: { locale, stages }, store });
    return output.text;
  }

  const stages: StageConfig[] = [
    { name: 'spec', nature: 'structure', gate: () => ({ ok: true }) },
    { name: 'approval', after: 'spec', summary: 'El dueño aprueba', nature: 'attest', gate: () => ({ ok: true }) },
    { name: 'mutants', after: 'approval', nature: 'recompute', gate: () => ({ ok: true }) },
  ];

  it('uses the stage summary, or its name when it has none', async () => {
    const text = await statusText(
      'es',
      [entry('approval', 'skipped', 'No aplica: nada visible.'), entry('mutants', 'skipped', 'No aplica: sin dinero.')],
      stages,
    );
    expect(text).toContain(
      '\n  Pasos omitidos:\n  - El dueño aprueba — No aplica: nada visible.\n  - mutants — No aplica: sin dinero.',
    );
  });

  it('shows only stages whose latest entry is a skip', async () => {
    const text = await statusText(
      'es',
      [entry('approval', 'skipped', 'No aplica: nada visible.'), entry('approval', 'passed')],
      stages,
    );
    expect(text).not.toContain('Pasos omitidos');
  });

  it('speaks English for an English locale', async () => {
    const text = await statusText('en', [entry('mutants', 'skipped', 'Does not apply: no money.')], stages);
    expect(text).toContain('\n  Skipped steps:\n  - mutants — Does not apply: no money.');
  });

  it('keeps the plain list of pieces unchanged', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: 'p1', state: 'done' }, undefined);
    await store.append('p1', entry('approval', 'skipped', 'No aplica: nada visible.'));
    const output = await runCommand(['status'], { config: { locale: 'es', stages }, store });
    expect(output.text).not.toContain('Pasos omitidos');
  });
});
