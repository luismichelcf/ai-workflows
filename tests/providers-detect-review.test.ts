import { describe, expect, it } from 'vitest';

import { buildInvocation, detectProvider, type RawRun, type RunRequest } from '../src/index.js';

// Review of the part 3 fixes (13-sep-2026):
//   - `cwd` was never checked: a cwd that looks like a flag ended up right after `--add-dir`.
//   - `/0 credentials/` also matched "10 credentials"; an `Error:` line was only noticed at the
//     very start; warnings and stack lines of a probe that exited 0 were listed as models.
//   - `timeoutMs: Infinity` was not refused, so every probe read as "not installed".
//   - Ten mutations survived, among them the opencode effort guard and the codex closed list.

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  provider: 'antigravity',
  model: 'gemini-3-pro',
  effort: 'high',
  cwd: 'C:/GitHub/ai-workflows',
  prompt: 'x',
  mode: 'review',
  ...over,
});

const runner =
  (answers: Record<string, RawRun>, calls: string[] = []) =>
  async (command: string, args: readonly string[]): Promise<RawRun> => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    return answers[key] ?? { output: '', exitCode: null };
  };

describe('every value that reaches the command line is checked', () => {
  it('refuses a cwd that is empty, relative or looks like a flag', () => {
    for (const cwd of ['', 'relativo/carpeta', '--dangerously-skip-permissions', '-p']) {
      for (const provider of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
        expect(() => buildInvocation(request({ provider, cwd, effort: undefined })), `${provider} ${cwd}`).toThrow();
      }
    }
  });

  it('accepts an absolute cwd in Windows and POSIX form', () => {
    for (const cwd of ['C:/GitHub/ai-workflows', 'C:\\GitHub\\ai-workflows', '/home/luis/ai-workflows']) {
      expect(() => buildInvocation(request({ cwd })), cwd).not.toThrow();
    }
  });

  it('refuses an empty model', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
      expect(() => buildInvocation(request({ provider, model: '', effort: undefined })), provider).toThrow();
    }
  });

  it('refuses an opencode effort that looks like a flag', () => {
    expect(() => buildInvocation(request({ provider: 'opencode', model: 'deepseek/deepseek-flash', effort: '--auto' }))).toThrow();
  });

  it('refuses a codex effort outside its closed list', () => {
    expect(() => buildInvocation(request({ provider: 'codex', model: 'gpt-6-astra', effort: 'max' }))).toThrow(/effort/);
  });

  it('keeps -p last for antigravity when it resumes a conversation', () => {
    const invocation = buildInvocation(request({ resumeSession: 'conv-123' }));

    expect(invocation.args.at(-1)).toBe('-p');
  });
});

describe('detection reads the output for what it says', () => {
  const installed = { 'opencode --version': { output: '1.18.30', exitCode: 0 } };

  it('counts "10 credentials" as signed in', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({ ...installed, 'opencode models': { output: '', exitCode: 0 }, 'opencode auth list': { output: '┌  Credentials\n│  DeepSeek api\n└  10 credentials', exitCode: 0 } }),
    );

    expect(detection.authenticated).toBe(true);
  });

  it('does not count a sign-in when an Error line appears anywhere', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({ ...installed, 'opencode models': { output: '', exitCode: 0 }, 'opencode auth list': { output: '┌  Credentials\nError: failed to decrypt auth.json', exitCode: 0 } }),
    );

    expect(detection.authenticated).toBe(false);
  });

  it('lists only provider/model lines, never warnings or stack lines', async () => {
    const output = [
      '(node:1234) DeprecationWarning: The punycode module is deprecated.',
      'deepseek/deepseek-flash',
      'TypeError: fetch failed',
      'WARN  config file not found',
      '    at loadConfig (file.js:1:1)',
      'opencode/big-pickle',
    ].join('\n');
    const detection = await detectProvider(
      'opencode',
      runner({ ...installed, 'opencode models': { output, exitCode: 0 }, 'opencode auth list': { output: '└  1 credentials', exitCode: 0 } }),
    );

    expect(detection.models).toEqual(['deepseek/deepseek-flash', 'opencode/big-pickle']);
  });

  it('refuses a probe timeout that makes no sense without running any probe', async () => {
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 2 ** 31]) {
      const calls: string[] = [];
      const detection = await detectProvider('opencode', runner(installed, calls), { timeoutMs });

      expect(detection.problem ?? '', String(timeoutMs)).toMatch(/timeoutMs/);
      expect(calls, String(timeoutMs)).toEqual([]);
    }
  });

  it('does not give up on a probe that answers in 50 ms under the default timeout', async () => {
    const slow = async (): Promise<RawRun> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { output: '0.52.0', exitCode: 0 };
    };

    expect((await detectProvider('codex', slow)).installed).toBe(true);
  });
});
