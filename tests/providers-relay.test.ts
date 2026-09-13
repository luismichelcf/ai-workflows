import { describe, expect, it } from 'vitest';

import {
  decideRelay,
  detectProvider,
  type Assignment,
  type RawRun,
  type RelayState,
  type RunReport,
} from '../src/index.js';

// When a model fails, what happens next. The owner's rules, all of them already written
// down in the project this engine serves:
//
//   - He picks the builder AND its relay in one answer. A quota or sign-in failure hands the
//     work to that relay on its own, and says so. Nothing outside his list is ever picked.
//   - A quality failure does not relay on its own: changing models for quality is his call.
//   - A timeout is not a quota. Something that hung is inspected, not silently relayed.
//   - Two rounds stuck on the same point means changing heads, which he decides.

const deepseek: Assignment = { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high' };
const astra: Assignment = { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' };

const report = (over: Partial<RunReport> = {}): RunReport => ({
  status: 'success',
  modelConfirmed: false,
  ...over,
});

const state = (over: Partial<RelayState> = {}): RelayState => ({
  chain: [deepseek, astra],
  tried: [deepseek],
  stuckRounds: 0,
  ...over,
});

describe('after a run', () => {
  it('continues when it succeeded', () => {
    expect(decideRelay(report(), state()).action).toBe('continue');
  });

  it('hands the work to the named relay when the builder ran out of quota', () => {
    const decision = decideRelay(report({ status: 'quota' }), state());

    expect(decision.action).toBe('relay');
    expect(decision.action === 'relay' && decision.to).toEqual(astra);
  });

  it('says why it relayed', () => {
    const decision = decideRelay(report({ status: 'quota', reason: 'usage limit' }), state());

    expect(decision.action === 'relay' && decision.reason.length).toBeGreaterThan(5);
  });

  it('hands the work to the named relay when the builder is not signed in', () => {
    expect(decideRelay(report({ status: 'auth' }), state()).action).toBe('relay');
  });

  it('asks the owner when the chain is exhausted', () => {
    const decision = decideRelay(report({ status: 'quota' }), state({ tried: [deepseek, astra] }));

    expect(decision.action).toBe('ask-owner');
  });

  it('never picks a model outside the owner s chain', () => {
    const decision = decideRelay(report({ status: 'quota' }), state({ chain: [deepseek], tried: [deepseek] }));

    expect(decision.action).not.toBe('relay');
  });

  it('never relays back to one already tried for this block', () => {
    const decision = decideRelay(
      report({ status: 'quota' }),
      state({ chain: [deepseek, astra, deepseek], tried: [deepseek, astra] }),
    );

    expect(decision.action).not.toBe('relay');
  });

  it('does not relay on its own when the failure is about quality', () => {
    // Changing models because the work was poor is the owner's decision.
    const decision = decideRelay(report({ status: 'failed', reason: 'la prueba sigue roja' }), state());

    expect(decision.action).toBe('ask-owner');
  });

  it('inspects instead of relaying when the run hung or was cut off', () => {
    // A timeout is not a quota: the process and the work are looked at first.
    const decision = decideRelay(report({ status: 'incomplete' }), state());

    expect(decision.action).toBe('inspect');
  });

  it('asks the owner after two rounds stuck on the same point', () => {
    const decision = decideRelay(report({ status: 'failed' }), state({ stuckRounds: 2 }));

    expect(decision.action).toBe('ask-owner');
    expect(decision.action === 'ask-owner' && decision.reason.length).toBeGreaterThan(5);
  });

  it('does not ask the owner for a single stuck round that can still be inspected', () => {
    expect(decideRelay(report({ status: 'incomplete' }), state({ stuckRounds: 1 })).action).toBe('inspect');
  });
});

describe('finding out what is installed', () => {
  const runner =
    (answers: Record<string, RawRun>) =>
    async (command: string, args: readonly string[]): Promise<RawRun> =>
      answers[[command, ...args].join(' ')] ?? { output: `${command}: command not found`, exitCode: null };

  it('reports a CLI that is not installed, without throwing', async () => {
    const detection = await detectProvider('opencode', runner({}));

    expect(detection.installed).toBe(false);
    expect(detection.authenticated).toBe(false);
    expect(detection.models).toEqual([]);
  });

  it('says what to do when it is not installed', async () => {
    const detection = await detectProvider('opencode', runner({}));

    expect((detection.problem ?? '').length).toBeGreaterThan(10);
  });

  it('does not throw when the runner itself fails', async () => {
    const broken = async (): Promise<RawRun> => {
      throw new Error('spawn EINVAL');
    };

    await expect(detectProvider('codex', broken)).resolves.toMatchObject({ installed: false });
  });

  it('lists the models opencode offers', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({
        'opencode --version': { output: '1.18.30', exitCode: 0 },
        'opencode models': {
          output: 'deepseek/deepseek-flash\ndeepseek/deepseek-v4-flash\ndeepseek/deepseek-v4-pro\n',
          exitCode: 0,
        },
        'opencode auth list': { output: 'DeepSeek api', exitCode: 0 },
      }),
    );

    expect(detection.installed).toBe(true);
    expect(detection.models).toContain('deepseek/deepseek-flash');
  });

  it('tells installed apart from signed in', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({
        'opencode --version': { output: '1.18.30', exitCode: 0 },
        'opencode models': { output: '', exitCode: 0 },
        'opencode auth list': { output: '0 credentials', exitCode: 0 },
      }),
    );

    expect(detection.installed).toBe(true);
    expect(detection.authenticated).toBe(false);
  });
});
