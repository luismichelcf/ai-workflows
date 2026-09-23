import { expect } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type BlockDefinition,
  type Invocation,
  type RawRun,
  type JournalEntry,
  type RunOutcome,
  type Store,
} from '../src/index.js';

// Runs one engine block as the first stage of a two-stage recipe over a real repository. The
// second stage holds every piece at the merge, so a block that passes ends the run as
// `blocked:rejected` at `merge`, and one that refuses ends it at `check`.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const hold: BlockDefinition = {
  manifest: { name: 'hold', kind: 'module', natures: ['recompute'], inputs: {} },
  create: () => () => ({ ok: false, reason: 'held at the merge on purpose' }),
};

export interface BlockRun {
  readonly outcome: RunOutcome;
  readonly journal: readonly JournalEntry[];
  readonly store: Store;
  /** The entry the block's stage left last. */
  readonly entry: JournalEntry | undefined;
  /** Runs the same piece again, as a later resume would. */
  again(): Promise<BlockRun>;
}

export interface BlockRunOptions {
  readonly locale?: string;
  readonly declared?: { kind?: string; builder?: { provider: string; model: string; session: string } };
  /** Extra stages written BEFORE `check`, e.g. the red test that build-verify reads. */
  readonly before?: readonly string[];
  /** Extra top-level rows (classify, kinds…) written before `stages:`. */
  readonly top?: readonly string[];
  readonly store?: Store;
  readonly extraBlocks?: Readonly<Record<string, BlockDefinition>>;
  /** Stands in for the provider CLIs, which are the external edge of a review. */
  readonly providers?: { run(invocation: Invocation): Promise<RawRun> };
}

/** `stage` holds the rows of the `check` stage after its summary (nature, valid-while, gate…). */
export async function runBlock(root: string, stage: readonly string[], options: BlockRunOptions = {}): Promise<BlockRun> {
  const before = options.before ?? [];
  const firstBefore = before.length > 0;
  const lastBefore = [...before].reverse().find((row) => /^ {2}- id: /.test(row))?.replace(/^ {2}- id: /, '');
  const text = lines(
    'version: 1',
    `locale: ${options.locale ?? 'es'}`,
    ...(options.top ?? []),
    'stages:',
    ...before,
    '  - id: check',
    '    summary: "Paso bajo prueba"',
    ...(firstBefore ? [`    after: ${lastBefore}`] : []),
    ...stage,
    '  - id: merge',
    '    summary: "Se une"',
    '    after: check',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/hold@1',
  );
  const parsed = parseRecipe(text, 'receta.yml');
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  const store = options.store ?? createMemoryStore();
  const compiled = await compileRecipe(parsed.recipe, {
    root,
    baseRef: 'main',
    declared: () => options.declared ?? {},
    store,
    extraBlocks: { 'ai-workflows/hold@1': hold, ...(options.extraBlocks ?? {}) },
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  });
  const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
  const once = async (): Promise<BlockRun> => {
    const outcome = await engine.run('42');
    const journal = await store.journal('42');
    const entry = [...journal].reverse().find((item) => item.stage === 'check');
    return { outcome, journal, store, entry, again: once };
  };
  return once();
}

/** The block passed: the piece moved on and stopped at the merge. */
export const passed = { outcome: 'ran', status: { state: 'blocked:rejected', stage: 'merge' } } as const;

/** The block refused: the piece stopped at `check`, with a reason matching `reason`. */
export const refused = (reason: RegExp | string) => ({
  outcome: 'ran',
  status: {
    state: 'blocked:rejected',
    stage: 'check',
    reason: typeof reason === 'string' ? reason : expect.stringMatching(reason),
  },
});

/** The block could not decide: a technical block at `check`. */
export const technical = (reason: RegExp) => ({
  outcome: 'ran',
  status: { state: 'blocked:technical', stage: 'check', reason: expect.stringMatching(reason) },
});
