import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  describeChangeFromGit,
  parseRecipe,
  type BlockDefinition,
  type GateContext,
  type GateResult,
  type JournalEntry,
  type PipelineConfig,
  type Recipe,
  type StageConfig,
  type Store,
} from '../src/index.js';
import { recordCleanUpdate } from '../src/recipe/validity.js';

import { advanceMain, commit, git, mergeMain, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13 RC-07: the same process declared the v0.3.0 way (a hand-written PipelineConfig, like
// Socialabs' pipeline.config.ts) and as a recipe must agree, stage by stage, on what applies,
// the motive of every skip, which evidence is kept or expires, the final state and the effects
// asked for — over the nine kinds, the path elevations and every transition of §3.3.
//
// Expected values are LITERAL, written by hand from §3.3 and PLAN-997 §5.5. Neither side is
// used to compute them: both are checked against the table.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// ---------------------------------------------------------------------------------------
// The process, as a recipe
// ---------------------------------------------------------------------------------------

const KINDS = [
  'behavior', 'ui-behavior', 'visual-only', 'prod-config', 'prod-config-no-behavior',
  'config-no-prod', 'generated', 'docs', 'prototype',
];

const RECIPE_TEXT = lines(
  'version: 1',
  'locale: es',
  'classify:',
  '  money: ["lib/calc/**"]',
  '  security: ["**/*auth*"]',
  '  visible: ["app/**"]',
  '  production: [".github/workflows/**"]',
  'kinds:',
  `  names: [${KINDS.join(', ')}]`,
  '  default: behavior',
  '  from-paths:',
  '    docs: ["docs/**"]',
  '    prototype: ["proto/**"]',
  '  elevate:',
  '    - when: { touches-any: [money, security], kind-none: [behavior, ui-behavior] }',
  '      to: behavior',
  '    - when: { touches-any: [production], kind-any: [visual-only, config-no-prod, generated] }',
  '      to: prod-config',
  'lanes:',
  '  full: [behavior, ui-behavior, prod-config, prod-config-no-behavior]',
  '  light: [visual-only, config-no-prod, generated, docs, prototype]',
  'stages:',
  '  - id: red',
  '    summary: "Prueba roja"',
  '    nature: recompute',
  '    valid-while: forever',
  '    applies-if: { kind-any: [behavior, ui-behavior, prod-config] }',
  '    gate:',
  '      uses: ai-workflows/probe@1',
  '  - id: gate',
  '    summary: "Puerta"',
  '    after: red',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/probe@1',
  '  - id: flock',
  '    summary: "Parvada"',
  '    after: gate',
  '    nature: attest',
  '    valid-while: same-fingerprint-or-clean-update',
  '    applies-if: { kind-none: [docs, prototype, visual-only, config-no-prod, generated] }',
  '    gate:',
  '      uses: ai-workflows/probe@1',
  '  - id: qa',
  '    summary: "QA"',
  '    after: flock',
  '    nature: recompute',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/probe@1',
  '  - id: approval',
  '    summary: "Visto bueno"',
  '    after: qa',
  '    nature: attest',
  '    needs-human: true',
  '    valid-while: same-fingerprint',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/probe@1',
  '  - id: queue',
  '    summary: "Fila"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/queue@1',
);

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const RECIPE = recipeOf(RECIPE_TEXT);

// ---------------------------------------------------------------------------------------
// The same process, the v0.3.0 way: every rule written by hand in code
// ---------------------------------------------------------------------------------------

interface Facts {
  readonly sha: string;
  readonly snapshot: string;
  readonly fingerprint: string;
  readonly clean: boolean;
  readonly files: readonly string[];
  readonly declaredKind?: string;
}

const run = (root: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Socialabs-style `tipoDeCambio`: forced by paths, then raised by risk. */
function handKind(facts: Facts): string {
  const files = facts.files;
  if (files.length > 0 && files.every((file) => file.startsWith('docs/'))) return 'docs';
  if (files.length > 0 && files.every((file) => file.startsWith('proto/'))) return 'prototype';
  let kind = facts.declaredKind ?? 'behavior';
  const risky = files.some((file) => file.startsWith('lib/calc/') || /auth/.test(file.split('/').pop() ?? ''));
  if (risky && kind !== 'behavior' && kind !== 'ui-behavior') kind = 'behavior';
  const production = files.some((file) => file.startsWith('.github/workflows/'));
  if (production && ['visual-only', 'config-no-prod', 'generated'].includes(kind)) kind = 'prod-config';
  return kind;
}

const touchesVisible = (facts: Facts) => facts.files.some((file) => file.startsWith('app/'));

function handConfig(root: string, counts: Map<string, number>, effects: string[]): PipelineConfig {
  const facts = (context: GateContext) => context.change as Facts;
  const probe = (name: string) => (context: GateContext): GateResult => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const { sha, snapshot, fingerprint } = facts(context);
    return { ok: true, evidence: { sha, snapshot, fingerprint } };
  };
  const judged = (entry: JournalEntry) => entry.evidence as { sha?: string; snapshot?: string; fingerprint?: string } | undefined;
  const sameSha = (entry: JournalEntry, context: GateContext) =>
    judged(entry)?.sha === facts(context).sha && judged(entry)?.snapshot === facts(context).snapshot;
  const cleanStep = (from: string, to: string): boolean => {
    try {
      const parents = run(root, 'rev-list', '--parents', '-n', '1', to).split(' ').slice(1);
      if (parents.length !== 2 || parents[0] !== from) return false;
      const second = parents[1] ?? '';
      const tree = run(root, 'merge-tree', '--write-tree', `--merge-base=${run(root, 'merge-base', from, second)}`, from, second).split('\n')[0];
      return tree === run(root, 'rev-parse', `${to}^{tree}`);
    } catch {
      return false; // a merge-tree conflict exits non-zero: not a clean step
    }
  };
  const kindIn = (kinds: string[]) => (context: GateContext) =>
    kinds.includes(handKind(facts(context)))
      ? true
      : { skip: `No aplica: el tipo de cambio es «${handKind(facts(context))}», no ${kinds.slice(0, -1).map((k) => `«${k}»`).join(', ')} ni «${kinds[kinds.length - 1]}».` };
  const kindNotIn = (kinds: string[]) => (context: GateContext) =>
    kinds.includes(handKind(facts(context))) ? { skip: `No aplica: el tipo de cambio es «${handKind(facts(context))}».` } : true;
  const visible = (context: GateContext) => (touchesVisible(facts(context)) ? true : { skip: 'No aplica: el cambio no toca «visible».' });

  const stages: StageConfig[] = [
    { name: 'red', nature: 'recompute', appliesWhen: kindIn(['behavior', 'ui-behavior', 'prod-config']), gate: probe('red') },
    { name: 'gate', after: 'red', nature: 'recompute', stillValid: sameSha, gate: probe('gate') },
    {
      name: 'flock',
      after: 'gate',
      nature: 'attest',
      appliesWhen: kindNotIn(['docs', 'prototype', 'visual-only', 'config-no-prod', 'generated']),
      stillValid: (entry, context) => {
        if (entry.outcome === 'skipped') return false;
        if (sameSha(entry, context)) return true;
        const now = facts(context);
        const then = judged(entry);
        if (!now.clean || then?.sha === undefined || then.snapshot !== run(root, 'rev-parse', `${then.sha}^{tree}`)) return false;
        let cursor = then.sha;
        for (const record of context.journal.filter((item) => item.stage === '@clean-update')) {
          const step = record.evidence as { from: string; to: string };
          if (step.from === cursor && cleanStep(step.from, step.to)) cursor = step.to;
        }
        return cursor === now.sha;
      },
      gate: probe('flock'),
    },
    { name: 'qa', after: 'flock', nature: 'recompute', appliesWhen: visible, stillValid: sameSha, gate: probe('qa') },
    {
      name: 'approval',
      after: 'qa',
      nature: 'attest',
      needsHuman: true,
      appliesWhen: visible,
      stillValid: (entry, context) => entry.outcome === 'passed' && judged(entry)?.fingerprint !== '' && judged(entry)?.fingerprint === facts(context).fingerprint,
      gate: probe('approval'),
    },
    {
      name: 'queue',
      after: 'approval',
      nature: 'recompute',
      gate: async (context) => {
        await context.runEffect(`enqueue:${facts(context).sha}`, async () => {
          effects.push(`enqueue:${facts(context).sha}`);
          return 1;
        });
        return { ok: false, reason: 'waiting in the queue' };
      },
    },
  ];
  return { locale: 'es', stages };
}

// ---------------------------------------------------------------------------------------
// Both sides over one repository
// ---------------------------------------------------------------------------------------

interface Side {
  readonly counts: Map<string, number>;
  readonly effects: string[];
  readonly store: Store;
  run(): Promise<{ state: string; stage?: string }>;
  skipReason(stage: string): Promise<string | undefined>;
}

async function recipeSide(root: string, declared: string): Promise<Side> {
  const counts = new Map<string, number>();
  const effects: string[] = [];
  const probe: BlockDefinition = {
    manifest: { name: 'probe', kind: 'module', natures: ['recompute', 'attest'], inputs: {} },
    create: () => (context) => {
      counts.set(context.stage, (counts.get(context.stage) ?? 0) + 1);
      return { ok: true };
    },
  };
  const queue: BlockDefinition = {
    manifest: { name: 'queue', kind: 'module', natures: ['recompute'], inputs: {} },
    create: () => async (context) => {
      const sha = (context.change as Facts).sha;
      await context.runEffect(`enqueue:${sha}`, async () => {
        effects.push(`enqueue:${sha}`);
        return 1;
      });
      return { ok: false, reason: 'waiting in the queue' };
    },
  };
  const store = createMemoryStore();
  const compiled = await compileRecipe(RECIPE, {
    root,
    baseRef: 'main',
    declared: () => ({ kind: declared }),
    store,
    extraBlocks: { 'ai-workflows/probe@1': probe, 'ai-workflows/queue@1': queue },
  });
  const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
  return sideOver(engine, store, counts, effects);
}

async function handSide(root: string, declared: string): Promise<Side> {
  const counts = new Map<string, number>();
  const effects: string[] = [];
  const store = createMemoryStore();
  const engine = createEngine({
    config: handConfig(root, counts, effects),
    store,
    describeChange: (piece) => describeChangeFromGit({ root, baseRef: 'main', recipe: RECIPE, piece, declared: { kind: declared } }),
  });
  return sideOver(engine, store, counts, effects);
}

function sideOver(engine: ReturnType<typeof createEngine>, store: Store, counts: Map<string, number>, effects: string[]): Side {
  return {
    counts,
    effects,
    store,
    run: async () => {
      const outcome = await engine.run('42');
      if (outcome.outcome !== 'ran') throw new Error(`unexpected outcome ${outcome.outcome}`);
      return { state: outcome.status.state, ...(outcome.status.stage === undefined ? {} : { stage: outcome.status.stage }) };
    },
    skipReason: async (stage) => {
      const entries = (await store.journal('42')).filter((entry) => entry.stage === stage);
      const last = entries[entries.length - 1];
      return last?.outcome === 'skipped' ? last.reason : undefined;
    },
  };
}

// ---------------------------------------------------------------------------------------
// The nine kinds and the elevations
// ---------------------------------------------------------------------------------------

const RED_SKIP = (kind: string) => `No aplica: el tipo de cambio es «${kind}», no «behavior», «ui-behavior» ni «prod-config».`;
const FLOCK_SKIP = (kind: string) => `No aplica: el tipo de cambio es «${kind}».`;
const VISIBLE_SKIP = 'No aplica: el cambio no toca «visible».';

/** name, declared kind, files; then the literal expectation for red, flock, qa and approval. */
const PIECES: [string, string, Record<string, string>, (string | true)[]][] = [
  ['behavior', 'behavior', { 'lib/core/a.ts': 'a\n' }, [true, true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['ui-behavior', 'ui-behavior', { 'app/page.tsx': 'p\n' }, [true, true, true, true]],
  ['visual-only', 'visual-only', { 'app/page.tsx': 'p\n' }, [RED_SKIP('visual-only'), FLOCK_SKIP('visual-only'), true, true]],
  ['prod-config', 'prod-config', { '.github/workflows/ci.yml': 'on: push\n' }, [true, true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['prod-config-no-behavior', 'prod-config-no-behavior', { '.github/workflows/ci.yml': 'on: push\n' }, [RED_SKIP('prod-config-no-behavior'), true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['config-no-prod', 'config-no-prod', { 'config/app.json': '{}\n' }, [RED_SKIP('config-no-prod'), FLOCK_SKIP('config-no-prod'), VISIBLE_SKIP, VISIBLE_SKIP]],
  ['generated', 'generated', { 'src/generated/types.ts': 't\n' }, [RED_SKIP('generated'), FLOCK_SKIP('generated'), VISIBLE_SKIP, VISIBLE_SKIP]],
  ['docs, forced by paths', 'behavior', { 'docs/a.md': 'd\n' }, [RED_SKIP('docs'), FLOCK_SKIP('docs'), VISIBLE_SKIP, VISIBLE_SKIP]],
  ['prototype, forced by paths', 'behavior', { 'proto/x.ts': 'x\n' }, [RED_SKIP('prototype'), FLOCK_SKIP('prototype'), VISIBLE_SKIP, VISIBLE_SKIP]],
  ['money raises visual-only to behavior', 'visual-only', { 'lib/calc/tax.ts': 't\n' }, [true, true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['security raises config-no-prod to behavior', 'config-no-prod', { 'src/auth.ts': 'a\n' }, [true, true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['production raises generated to prod-config', 'generated', { '.github/workflows/ci.yml': 'on: push\n' }, [true, true, VISIBLE_SKIP, VISIBLE_SKIP]],
  ['production raises visual-only to prod-config, visible still asks QA', 'visual-only', { '.github/workflows/ci.yml': 'on: push\n', 'app/page.tsx': 'p\n' }, [true, true, true, true]],
];

describe('RC-07: the nine kinds and the elevations', () => {
  for (const [name, declared, files, [red, flock, qa, approval]] of PIECES) {
    it(name, async () => {
      for (const make of [recipeSide, handSide]) {
        const root = repository();
        for (const [file, content] of Object.entries(files)) write(root, file, content);
        commit(root, name);
        const side = await make(root, declared);
        expect(await side.run()).toEqual({ state: 'blocked:rejected', stage: 'queue' });
        const expected = { red, gate: true, flock, qa, approval };
        for (const [stage, want] of Object.entries(expected)) {
          if (want === true) {
            expect({ stage, runs: side.counts.get(stage) ?? 0, side: make.name }).toEqual({ stage, runs: 1, side: make.name });
          } else {
            expect({ stage, reason: await side.skipReason(stage), side: make.name }).toEqual({ stage, reason: want, side: make.name });
          }
        }
        expect(side.effects).toHaveLength(1);
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------------------
// The transitions of §3.3
// ---------------------------------------------------------------------------------------

/** Runs again after a transition: which of the five stages ran again, and how many effects. */
type Rerun = { red: number; gate: number; flock: number; qa: number; approval: number; effects: number };

const PAGE = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

/** A ui-behavior piece (every stage applies) judged once on both sides. */
async function judgedOnBothSides() {
  const sides: { root: string; side: Side; make: string }[] = [];
  for (const make of [recipeSide, handSide]) {
    const root = repository({ 'app/page.tsx': PAGE, 'lib/core/a.ts': 'a\n' });
    write(root, 'app/page.tsx', PAGE.replace('line 1\n', 'the piece edits line 1\n'));
    commit(root, 'piece');
    const side = await make(root, 'ui-behavior');
    await side.run();
    sides.push({ root, side, make: make.name });
  }
  return sides;
}

async function rerun(sides: { root: string; side: Side }[], transition: (root: string, store: Store) => Promise<void>) {
  const results: Rerun[] = [];
  for (const { root, side } of sides) {
    const before = new Map(side.counts);
    const effectsBefore = side.effects.length;
    await transition(root, side.store);
    const status = await side.run();
    expect(status).toEqual({ state: 'blocked:rejected', stage: 'queue' });
    const delta = (stage: string) => (side.counts.get(stage) ?? 0) - (before.get(stage) ?? 0);
    results.push({
      red: delta('red'),
      gate: delta('gate'),
      flock: delta('flock'),
      qa: delta('qa'),
      approval: delta('approval'),
      effects: side.effects.length - effectsBefore,
    });
  }
  return results;
}

const record = (root: string, store: Store, from: string, to: string) =>
  recordCleanUpdate({ store, root, baseRef: 'main', piece: '42', from, to });

describe('RC-07: every transition of §3.3, on both sides', () => {
  it('resuming with the same commit repeats nothing, not even the review, and asks for no new effect', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 0, flock: 0, qa: 0, approval: 0, effects: 0 };
    expect(await rerun(sides, async () => undefined)).toEqual([expected, expected]);
  }, 60_000);

  it('a clean update with the base, recorded: the review survives; gate and QA repeat', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 1, flock: 0, qa: 1, approval: 0, effects: 1 };
    expect(await rerun(sides, async (root, store) => {
      const from = git(root, 'rev-parse', 'HEAD');
      advanceMain(root, { 'docs/news.md': 'n\n' });
      await record(root, store, from, mergeMain(root));
    })).toEqual([expected, expected]);
  }, 60_000);

  it('a clean update nobody recorded: the review expires', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 1, flock: 1, qa: 1, approval: 0, effects: 1 };
    expect(await rerun(sides, async (root) => {
      advanceMain(root, { 'docs/news.md': 'n\n' });
      mergeMain(root);
    })).toEqual([expected, expected]);
  }, 60_000);

  it('a conflict resolved by hand: the review and the sign-off expire', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 1, flock: 1, qa: 1, approval: 1, effects: 1 };
    expect(await rerun(sides, async (root) => {
      advanceMain(root, { 'app/page.tsx': PAGE.replace('line 1\n', 'main edits line 1\n') });
      expect(() => git(root, 'merge', '-q', '--no-edit', 'main')).toThrow();
      write(root, 'app/page.tsx', PAGE.replace('line 1\n', 'resolved by hand\n'));
      commit(root, 'resolve');
    })).toEqual([expected, expected]);
  }, 60_000);

  it('a new commit of the piece: everything but the red test repeats', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 1, flock: 1, qa: 1, approval: 1, effects: 1 };
    expect(await rerun(sides, async (root) => {
      write(root, 'app/page.tsx', PAGE.replace('line 2\n', 'the piece edits line 2\n'));
      commit(root, 'more');
    })).toEqual([expected, expected]);
  }, 60_000);

  it('a force push with an identical fingerprint: the review expires, the sign-off survives', async () => {
    const sides = await judgedOnBothSides();
    const expected: Rerun = { red: 0, gate: 1, flock: 1, qa: 1, approval: 0, effects: 1 };
    expect(await rerun(sides, async (root) => {
      git(root, 'commit', '-q', '--amend', '-m', 'rewritten, same changes');
    })).toEqual([expected, expected]);
  }, 60_000);
});
