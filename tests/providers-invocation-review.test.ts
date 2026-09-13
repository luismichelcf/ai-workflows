import { describe, expect, it } from 'vitest';

import { buildInvocation, detectProvider, type ProviderName, type RawRun, type RunRequest } from '../src/index.js';

// Adversarial review of building the command for each CLI (13-sep-2026). The code was right
// on these points; the tests did not protect it. Thirty mutations that let a review write,
// or slipped a shell in, left every test green. These close those holes.

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  provider: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  cwd: 'C:/GitHub/ai-workflows',
  prompt: 'x',
  mode: 'review',
  ...over,
});

const reviewers: Array<[ProviderName, string, string]> = [
  ['claude', 'claude-opus-5', 'high'],
  ['codex', 'gpt-6-astra', 'high'],
  ['antigravity', 'gemini-3.8-flash-high', 'high'],
];

const WRITE_FLAGS = [
  'bypass',
  'dangerously',
  'acceptEdits',
  'accept-edits',
  'danger-full-access',
  'workspace-write',
];

describe('a review can never write, in any combination', () => {
  for (const [provider, model] of reviewers) {
    for (const resumeSession of [undefined, 'ses-1']) {
      for (const effort of ['low', 'medium', 'high']) {
        const label = `${provider} · effort ${effort} · ${resumeSession ? 'resumed' : 'fresh'}`;

        it(`${label}: carries no write permission`, () => {
          const { args } = buildInvocation(
            request({ provider, model, effort, ...(resumeSession ? { resumeSession } : {}) }),
          );
          const joined = args.join(' ');

          for (const flag of WRITE_FLAGS) {
            expect(joined, flag).not.toContain(flag);
          }
        });
      }
    }
  }

  it('claude: the read-only mode appears exactly once', () => {
    const { args } = buildInvocation(request({ provider: 'claude' }));

    expect(args.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
  });

  it('antigravity: the plan mode appears exactly once', () => {
    const { args } = buildInvocation(request({ provider: 'antigravity', model: 'gemini-3.8-flash-high' }));

    expect(args.filter((arg) => arg === '--mode')).toHaveLength(1);
  });

  it('codex resumed: sandbox_mode is set once, to read-only', () => {
    const { args } = buildInvocation(request({ provider: 'codex', model: 'gpt-6-astra', resumeSession: 't-1' }));
    const sandbox = args.filter((arg) => arg.includes('sandbox_mode'));

    expect(sandbox).toHaveLength(1);
    expect(sandbox[0]).toContain('read-only');
  });
});

describe('never a shell, not even by absolute path', () => {
  for (const [provider, model] of [...reviewers, ['opencode', 'deepseek/deepseek-flash', 'high'] as [ProviderName, string, string]]) {
    it(`${provider}: the command is not a shell and not a script shim`, () => {
      const { command } = buildInvocation(request({ provider, model, mode: 'build' }));
      const base = command.replace(/\\/g, '/').split('/').pop() ?? '';

      expect(base.replace(/\.(exe|com)$/i, '').toLowerCase()).not.toMatch(/^(cmd|powershell|pwsh|bash|sh|wsl)$/);
      expect(base).not.toMatch(/\.(cmd|bat|ps1)$/i);
    });
  }
});

describe('a value that looks like a flag is refused', () => {
  // A corrupted session id such as "--dangerously-skip-permissions" would otherwise turn on
  // the bypass inside a review. Ids come from CLI output, so this needs a tampered state —
  // which is exactly when a lock must hold.
  for (const field of ['resumeSession', 'model', 'effort'] as const) {
    it(`refuses a ${field} that starts with a dash`, () => {
      expect(() => buildInvocation(request({ [field]: '--dangerously-skip-permissions' }))).toThrow();
    });
  }

  it('refuses a session id with spaces or shell characters', () => {
    expect(() => buildInvocation(request({ resumeSession: 'abc; rm -rf /' }))).toThrow();
  });
});

describe('an effort the CLI does not know is refused, not silently ignored', () => {
  // Measured: claude prints "Unknown --effort value … using the default effort" and runs
  // anyway. A typo would quietly run at a different effort than the owner chose.
  it('claude: refuses an unknown effort', () => {
    expect(() => buildInvocation(request({ provider: 'claude', effort: 'hihg' }))).toThrow(/effort/i);
  });

  it('antigravity: refuses an effort outside low, medium, high', () => {
    expect(() => buildInvocation(request({ provider: 'antigravity', model: 'gemini-3.8-flash-high', effort: 'xhigh' }))).toThrow(/effort/i);
  });

  it('codex: accepts xhigh, which the house uses', () => {
    expect(() => buildInvocation(request({ provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }))).not.toThrow();
  });
});

describe('antigravity details the review found', () => {
  const agy = (over: Partial<RunRequest> = {}) => request({ provider: 'antigravity', model: 'gemini-3.8-flash-high', ...over });
  const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

  it('passes the effort it was given instead of dropping it', () => {
    // `agy --help` lists --effort (low|medium|high); the code claimed it did not exist.
    expect(after(buildInvocation(agy({ effort: 'medium' })).args, '--effort')).toBe('medium');
  });

  it('sets an explicit print timeout, longer for a build than for a review', () => {
    // The default is 5 minutes; every build longer than that was cut off.
    const review = after(buildInvocation(agy({ mode: 'review' })).args, '--print-timeout');
    const build = after(buildInvocation(agy({ mode: 'build' })).args, '--print-timeout');

    expect(review).toBe('10m');
    expect(build).toBe('30m');
  });

  it('puts -p last, so it cannot swallow the next flag as its value', () => {
    const { args } = buildInvocation(agy());

    expect(args.at(-1)).toBe('-p');
  });
});

describe('detecting what is installed only believes probes that succeeded', () => {
  const runner =
    (answers: Record<string, RawRun>) =>
    async (command: string, args: readonly string[]): Promise<RawRun> =>
      answers[[command, ...args].join(' ')] ?? { output: '', exitCode: null };

  it('does not report a sign-in from a probe that failed', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({
        'opencode --version': { output: '1.18.30', exitCode: 0 },
        'opencode models': { output: 'deepseek/deepseek-flash', exitCode: 0 },
        'opencode auth list': { output: 'Error: failed to read auth.json', exitCode: 1 },
      }),
    );

    expect(detection.authenticated).toBe(false);
  });

  it('does not list error lines as models', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({
        'opencode --version': { output: '1.18.30', exitCode: 0 },
        'opencode models': { output: 'Error: Provider config invalid\n    at loadConfig', exitCode: 1 },
        'opencode auth list': { output: 'DeepSeek api', exitCode: 0 },
      }),
    );

    expect(detection.models).toEqual([]);
  });

  it('does not call a CLI installed when its version probe failed', async () => {
    const detection = await detectProvider('opencode', runner({ 'opencode --version': { output: 'boom', exitCode: 1 } }));

    expect(detection.installed).toBe(false);
  });

  it('does not call a CLI missing just because a warning mentions "not found"', async () => {
    const detection = await detectProvider(
      'opencode',
      runner({
        'opencode --version': { output: 'warning: config file not found, using defaults\n1.18.30', exitCode: 0 },
        'opencode models': { output: '', exitCode: 0 },
        'opencode auth list': { output: '', exitCode: 0 },
      }),
    );

    expect(detection.installed).toBe(true);
  });

  it('gives up on a probe that hangs, instead of waiting forever', async () => {
    const hanging = () => new Promise<RawRun>(() => undefined);

    const detection = await detectProvider('codex', hanging, { timeoutMs: 200 });

    expect(detection.installed).toBe(false);
    expect((detection.problem ?? '').length).toBeGreaterThan(10);
  }, 5_000);
});
