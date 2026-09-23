import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BlockDefinition, Invocation, RawRun } from '../src/index.js';

import { passed, refused, runBlock, technical } from './block-harness.js';
import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §3.3 and §3.7: the sandboxed review and the scope reconciliation.
//
// The review is produced by the engine, not received: the block runs the reviewer itself and
// observes its identity, the tree before and after, and its verdict. The provider CLI is the
// external edge of a review, so here it is replaced by a function that answers exactly what
// Claude's CLI prints (`--output-format json`); everything else is the real block.

afterEach(removeRepositories);

const BUILDER = { provider: 'deepseek', model: 'deepseek-flash', session: 's-build' };

interface ReviewerScript {
  readonly session?: string;
  readonly model?: string;
  readonly text?: string;
  /** Written into the working tree while "reviewing". */
  readonly touches?: string;
}

/** A stand-in for the Claude CLI that records what it was asked and answers `script`. */
function claude(script: ReviewerScript = {}) {
  const calls: Invocation[] = [];
  return {
    calls,
    providers: {
      run: async (invocation: Invocation): Promise<RawRun> => {
        calls.push(invocation);
        if (script.touches !== undefined) writeFileSync(join(invocation.cwd, script.touches), 'written by the reviewer\n');
        const model = script.model ?? 'claude-opus-5-5';
        return {
          exitCode: 0,
          output: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: script.session ?? 's-review',
            result: script.text ?? 'Todo en orden.\nVERDICT:APPROVED',
            modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } },
          }),
        };
      },
    },
  };
}

const REVIEW_STAGE = (validWhile = 'same-sha') => [
  '    nature: attest',
  `    valid-while: ${validWhile}`,
  '    gate:',
  '      uses: ai-workflows/sandboxed-review@1',
  '      with:',
  '        reviewer: { provider: claude, model: claude-opus-5-5, effort: high }',
  '        prompt: "docs/review-{piece}.md"',
  '        angle: spec',
];

function project(): string {
  const root = repository();
  write(root, 'docs/review-42.md', 'Revisa el plan de la pieza 42.\n');
  write(root, 'app/page.tsx', 'export const page = 2;\n');
  commit(root, 'piece');
  return root;
}

describe('§3.3 sandboxed-review@1', () => {
  it('positive: a read-only review from another family passes, with what the engine observed', async () => {
    const root = project();
    const reviewer = claude();
    const result = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: reviewer.providers });
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({
      block: {
        reviewer: { provider: 'claude', model: 'claude-opus-5-5', session: 's-review' },
        angle: 'spec',
        approved: true,
        workspace: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it('asks the provider for its read-only mode and hands it the prompt of the piece', async () => {
    const root = project();
    const reviewer = claude();
    await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: reviewer.providers });
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(reviewer.calls[0]?.stdin).toContain('Revisa el plan de la pieza 42.');
  });

  it('refuses a REVISE verdict, in the reviewer own words', async () => {
    const root = project();
    const reviewer = claude({ text: 'Falta el caso de error.\nVERDICT:REVISE' });
    const result = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: reviewer.providers });
    expect(result.outcome).toMatchObject(refused(/Falta el caso de error/));
  });

  it('is a technical block when the reviewer gives no verdict, or both', async () => {
    for (const text of ['Me parece bien.', 'VERDICT:APPROVED\nVERDICT:REVISE']) {
      const root = project();
      const result = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: claude({ text }).providers });
      expect(result.outcome).toMatchObject(technical(/VERDICT/));
    }
  });

  it('refuses to review unsaved changes', async () => {
    const root = project();
    write(root, 'app/page.tsx', 'unsaved\n');
    const result = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: claude().providers });
    expect(result.outcome).toMatchObject(refused(/sin guardar/));
  });
});

describe('CN-02 · the builder approving its own work, through sandboxed-review@1', () => {
  const reviewAs = async (builder: typeof BUILDER | undefined, script: ReviewerScript = {}) => {
    const root = project();
    return runBlock(root, REVIEW_STAGE(), {
      ...(builder === undefined ? {} : { declared: { builder } }),
      providers: claude(script).providers,
    });
  };

  it('is refused when the observed reviewer is the declared builder', async () => {
    const self = { provider: 'claude', model: 'claude-opus-5-5', session: 's-review' };
    expect((await reviewAs(self)).outcome).toMatchObject(refused(/is the builder and cannot approve its own work/));
  });

  it('is refused when the builder session comes back under another model label', async () => {
    const same = { provider: 'claude', model: 'claude-sonnet-5', session: 's-review' };
    expect((await reviewAs(same)).outcome).toMatchObject(refused(/is the builder and cannot approve its own work/));
  });

  it('is refused for the same family even in another session', async () => {
    const family = { provider: 'claude', model: 'claude-sonnet-5', session: 's-other' };
    expect((await reviewAs(family)).outcome).toMatchObject(refused(/familia/));
  });

  it('does not believe a reviewer that writes it is someone else', async () => {
    const self = { provider: 'claude', model: 'claude-opus-5-5', session: 's-review' };
    const lie = { text: 'Soy la sesión s-otra de otro proveedor.\nVERDICT:APPROVED' };
    expect((await reviewAs(self, lie)).outcome).toMatchObject(refused(/s-review is the builder and cannot approve its own work/));
  });

  it('is refused when nobody declared who built it', async () => {
    expect((await reviewAs(undefined)).outcome).toMatchObject(refused(/quién construyó/));
  });

  it('positive control: another family, another session, passes', async () => {
    expect((await reviewAs(BUILDER)).outcome).toMatchObject(passed);
  });
});

describe('CN-03 · using the review of A after the code became B, through sandboxed-review@1', () => {
  it('reviews again after a new commit: the review of A is not evidence for B', async () => {
    const root = project();
    const reviewer = claude();
    const first = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: reviewer.providers });
    expect(first.outcome).toMatchObject(passed);
    write(root, 'app/page.tsx', 'export const page = 3;\n');
    const b = commit(root, 'B');
    const second = await first.again();
    expect(second.outcome).toMatchObject(passed);
    expect(reviewer.calls).toHaveLength(2);
    expect(second.entry?.evidence).toMatchObject({ judged: { sha: b }, block: { sha: b } });
  });

  it('a reviewer that writes in the tree never passes, even saying APPROVED', async () => {
    const root = project();
    const result = await runBlock(root, REVIEW_STAGE(), {
      declared: { builder: BUILDER },
      providers: claude({ touches: 'app/page.tsx' }).providers,
    });
    expect(result.outcome).toMatchObject({
      outcome: 'ran',
      status: { stage: 'check', state: expect.stringMatching(/^blocked:/), reason: expect.stringMatching(/modificó el árbol|changed while the stage ran/) },
    });
  });

  it('positive control: once B is reviewed, a resume on B does not review again', async () => {
    const root = project();
    const reviewer = claude();
    const first = await runBlock(root, REVIEW_STAGE(), { declared: { builder: BUILDER }, providers: reviewer.providers });
    await first.again();
    expect(reviewer.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// scope-reconcile@1
// ---------------------------------------------------------------------------------------

const TOP = [
  'classify:',
  '  money: ["lib/calc/**"]',
  'kinds:',
  '  names: [behavior, visual-only]',
  '  default: behavior',
  '  elevate:',
  '    - when: { touches-any: [money], kind-any: [visual-only] }',
  '      to: behavior',
  'lanes:',
  '  full: [behavior]',
  '  light: [visual-only]',
];

const SCOPE_STAGE = ['    nature: recompute', '    gate:', '      uses: ai-workflows/scope-reconcile@1'];

describe('§3.7 scope-reconcile@1', () => {
  it('records that nothing was raised when the change stays within what was declared', async () => {
    const root = project();
    const result = await runBlock(root, SCOPE_STAGE, { top: TOP, declared: { kind: 'visual-only' } });
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({ block: { declared: 'visual-only', effective: 'visual-only', raisedBy: [] } });
  });

  it('records the raise and the rule that caused it when the change reaches money', async () => {
    const root = project();
    write(root, 'lib/calc/tax.ts', 'export const tax = 2;\n');
    commit(root, 'money');
    const result = await runBlock(root, SCOPE_STAGE, { top: TOP, declared: { kind: 'visual-only' } });
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({ block: { declared: 'visual-only', effective: 'behavior', raisedBy: ['elevate 1'] } });
  });
});

describe('CN-10 · a piece that grows past what it declared', () => {
  function probe() {
    const calls: string[] = [];
    const block: BlockDefinition = {
      manifest: { name: 'probe', kind: 'module', natures: ['recompute'], inputs: {} },
      create: () => (context) => {
        calls.push((context.change as { lane: string }).lane);
        return { ok: true };
      },
    };
    return { calls, block };
  }

  const FULL_ONLY = [
    '    nature: recompute',
    '    applies-if: { lane-any: [full] }',
    '    gate:',
    '      uses: ai-workflows/probe@1',
  ];
  const BEFORE = ['  - id: scope', '    summary: "Alcance"', ...SCOPE_STAGE];

  it('runs the stage the wider change now demands', async () => {
    const root = project();
    const { calls, block } = probe();
    const first = await runBlock(root, FULL_ONLY, {
      top: TOP,
      declared: { kind: 'visual-only' },
      before: BEFORE,
      extraBlocks: { 'ai-workflows/probe@1': block },
    });
    expect(first.entry).toMatchObject({ outcome: 'skipped', reason: 'No aplica: el carril es «light», no «full».' });
    write(root, 'lib/calc/tax.ts', 'export const tax = 2;\n');
    commit(root, 'the piece grows into money');
    const second = await first.again();
    expect(second.outcome).toMatchObject(passed);
    expect(calls).toEqual(['full']);
    expect(second.journal.filter((entry) => entry.stage === 'scope').at(-1)?.evidence).toMatchObject({
      block: { effective: 'behavior', raisedBy: ['elevate 1'] },
    });
  });

  it('positive control: a change that stays within scope does not add stages', async () => {
    const root = project();
    const { calls, block } = probe();
    const first = await runBlock(root, FULL_ONLY, {
      top: TOP,
      declared: { kind: 'visual-only' },
      before: BEFORE,
      extraBlocks: { 'ai-workflows/probe@1': block },
    });
    write(root, 'app/page.tsx', 'export const page = 4;\n');
    commit(root, 'still visual');
    await first.again();
    expect(calls).toEqual([]);
  });
});

describe('review round 1: a review is bounded in time and can be stopped', () => {
  it('hands the provider its time limit: 30 minutes by default, or what the recipe says', async () => {
    const seen: (number | undefined)[] = [];
    const providers = {
      run: async (invocation: Invocation, options?: { timeoutMs?: number }): Promise<RawRun> => {
        seen.push(options?.timeoutMs);
        return claude().providers.run(invocation);
      },
    };
    await runBlock(project(), REVIEW_STAGE(), { declared: { builder: BUILDER }, providers });
    const oneMinute = REVIEW_STAGE().concat('        timeout-minutes: 1');
    await runBlock(project(), oneMinute, { declared: { builder: BUILDER }, providers });
    expect(seen).toEqual([30 * 60_000, 60_000]);
  });

  it('stops the reviewer when the piece is stopped, instead of waiting for it', async () => {
    let aborted = false;
    let started = false;
    const providers = {
      run: (_invocation: Invocation, options?: { signal?: AbortSignal }): Promise<RawRun> =>
        new Promise((_resolve, reject) => {
          started = true;
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('stopped'));
          });
        }),
    };
    const { createEngine, createMemoryStore, compileRecipe, parseRecipe } = await import('../src/index.js');
    const root = project();
    const text = [
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: check',
      '    summary: "Revisión"',
      '    phase: merge',
      ...REVIEW_STAGE(),
      '',
    ].join('\n');
    const parsed = parseRecipe(text, 'receta.yml');
    if (!parsed.ok) throw new Error('fixture');
    const store = createMemoryStore();
    const compiled = await compileRecipe(parsed.recipe, { root, baseRef: 'main', declared: () => ({ builder: BUILDER }), store, providers });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, cancellationPollMs: 20 });
    const running = engine.run('42');
    while (!started) await new Promise((resolve) => setTimeout(resolve, 20));
    await createEngine({ config: compiled.config, store }).stop('42', 'the owner stops it');
    const outcome = await running;
    expect(aborted).toBe(true);
    expect(outcome.outcome).toBe('parked');
  });
});

describe('review round 1: the reviewer CLI runs like any command of the engine', () => {
  it('runs out of time, is stopped by the signal, and never leaves processes behind unconfirmed', async () => {
    const { runProviderInGroup } = await import('../src/recipe/compile.js');
    const root = project();
    const hang = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, stdin: '' };
    await expect(runProviderInGroup(hang, { timeoutMs: 500 })).rejects.toThrow(/ran out of time/);
    const controller = new AbortController();
    const stopped = runProviderInGroup(hang, { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(), 300);
    await expect(stopped).rejects.toThrow();
    const { ProcessTreeSurvived } = await import('../src/index.js');
    const { launchInGroup } = await import('../src/process-group.js');
    const stubborn = {
      launch: (options: Parameters<typeof launchInGroup>[0]) => {
        const group = launchInGroup(options);
        return { ...group, terminate: async () => { await group.terminate(); return { empty: false }; } };
      },
      check: async () => ({ empty: false, reason: 'still there' }),
    };
    const quick = { command: process.execPath, args: ['-e', 'process.stdout.write("x")'], cwd: root, stdin: '' };
    await expect(runProviderInGroup(quick, { timeoutMs: 10_000, processGroups: stubborn })).rejects.toBeInstanceOf(ProcessTreeSurvived);
  });
});

describe('review round 1: the same session is the same execution, whatever its model label', () => {
  it('refuses the builder session under another model label even when families may repeat', async () => {
    const root = project();
    const stage = REVIEW_STAGE().concat('        forbid-same-family: false');
    const result = await runBlock(root, stage, {
      declared: { builder: { provider: 'claude', model: 'claude-sonnet-5', session: 's-review' } },
      providers: claude().providers,
    });
    expect(result.outcome).toMatchObject(refused(/is the builder and cannot approve its own work/));
  });

  it('positive control: another session of the same family passes when families may repeat', async () => {
    const root = project();
    const stage = REVIEW_STAGE().concat('        forbid-same-family: false');
    const result = await runBlock(root, stage, {
      declared: { builder: { provider: 'claude', model: 'claude-sonnet-5', session: 's-other' } },
      providers: claude().providers,
    });
    expect(result.outcome).toMatchObject(passed);
  });
});
