import { describe, expect, it } from 'vitest';

import { buildInvocation, detectProvider, type RawRun, type RunRequest } from '../src/index.js';

// Second review of the part 3 fixes (13-sep-2026):
//   - The model filter only accepted one slash: 4410 of the 7784 models in opencode's cache on
//     the owner's machine look like `openrouter/qwen/qwen3.7-max` and stopped being listed.
//   - opencode prints its errors in colour (`ESC[91mESC[1mError: `) or inside a box (`│  Error:`),
//     and neither was noticed.
//   - A model made only of spaces was accepted.

const installed = { 'opencode --version': { output: '1.18.30', exitCode: 0 } };

const runner =
  (answers: Record<string, RawRun>, calls: string[] = []) =>
  async (command: string, args: readonly string[]): Promise<RawRun> => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    return answers[key] ?? { output: '', exitCode: null };
  };

describe('models with more than one slash are models', () => {
  it('lists provider/vendor/model lines and still ignores noise that contains a slash', async () => {
    const output = [
      'deepseek/deepseek-flash',
      'openrouter/qwen/qwen3.7-max',
      'tokengo/deepseek/deepseek-v4-flash',
      'see https://opencode.ai/docs for help',
      'WARN a/b could not be loaded',
      'openrouter/anthropic/claude-opus-5:beta',
    ].join('\n');
    const detection = await detectProvider(
      'opencode',
      runner({ ...installed, 'opencode models': { output, exitCode: 0 }, 'opencode auth list': { output: '└  1 credentials', exitCode: 0 } }),
    );

    expect(detection.models).toEqual([
      'deepseek/deepseek-flash',
      'openrouter/qwen/qwen3.7-max',
      'tokengo/deepseek/deepseek-v4-flash',
      'openrouter/anthropic/claude-opus-5:beta',
    ]);
  });
});

describe('an error is noticed however opencode dresses it', () => {
  for (const [name, output] of [
    ['in colour', '\u001b[91m\u001b[1mError: \u001b[0mfailed to decrypt auth.json'],
    ['inside a box', '┌  Credentials\n│  Error: failed to decrypt auth.json\n└  1 credentials'],
  ] as const) {
    it(`does not count a sign-in when the error comes ${name}`, async () => {
      const detection = await detectProvider(
        'opencode',
        runner({ ...installed, 'opencode models': { output: '', exitCode: 0 }, 'opencode auth list': { output, exitCode: 0 } }),
      );

      expect(detection.authenticated).toBe(false);
    });
  }

  it('does not mistake a word that only starts with error for an error', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({ ...installed, 'opencode models': { output: '', exitCode: 0 }, 'opencode auth list': { output: '┌  Credentials\n│  Errorless api\n└  1 credentials', exitCode: 0 } }),
    );

    expect(detection.authenticated).toBe(true);
  });
});

describe('values are checked for what they contain', () => {
  const request = (over: Partial<RunRequest>): RunRequest => ({
    provider: 'claude',
    model: 'claude-opus-5',
    cwd: 'C:/GitHub/ai-workflows',
    prompt: 'x',
    mode: 'review',
    ...over,
  });

  it('refuses a model made only of spaces', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
      expect(() => buildInvocation(request({ provider, model: '   ' })), provider).toThrow();
    }
  });

  it('refuses a fractional probe timeout without running a probe', async () => {
    const calls: string[] = [];
    const detection = await detectProvider('opencode', runner(installed, calls), { timeoutMs: 1.5 });

    expect(detection.problem ?? '').toMatch(/timeoutMs/);
    expect(calls).toEqual([]);
  });
});
