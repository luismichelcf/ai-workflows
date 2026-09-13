import { describe, expect, it } from 'vitest';

import { buildInvocation, capabilities, type ProviderName, type RunRequest } from '../src/index.js';

// Building the command for each CLI. The flags asserted here are the ones documented and
// verified in `docs/agents/orquestacion.md` of the project that uses this engine — not
// guesses. Where a provider has no verified way to do something, the right answer is to
// refuse, not to improvise a flag.

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  provider: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  cwd: 'C:/GitHub/ai-workflows',
  prompt: 'Pon en verde las pruebas.',
  mode: 'build',
  ...over,
});

const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe('the prompt is data, never shell', () => {
  const hostile = 'hazlo"; rm -rf / # $(whoami) `id`';
  const shells = ['cmd', 'cmd.exe', 'bash', 'sh', 'powershell', 'pwsh', 'wsl'];
  const providers: Array<[ProviderName, string]> = [
    ['claude', 'claude-opus-5'],
    ['codex', 'gpt-6-astra'],
    ['opencode', 'deepseek/deepseek-flash'],
    ['antigravity', 'gemini-3.8-flash-high'],
  ];

  for (const [provider, model] of providers) {
    it(`${provider}: never runs through a shell`, () => {
      const invocation = buildInvocation(request({ provider, model, prompt: hostile }));

      expect(shells).not.toContain(invocation.command.toLowerCase());
    });

    it(`${provider}: carries the prompt whole, on stdin or as one argument`, () => {
      const invocation = buildInvocation(request({ provider, model, prompt: hostile }));

      const onStdin = invocation.stdin === hostile;
      const asOneArg = invocation.args.filter((arg) => arg === hostile).length === 1;
      expect(onStdin || asOneArg).toBe(true);
    });

    it(`${provider}: never splits the prompt across arguments`, () => {
      const invocation = buildInvocation(request({ provider, model, prompt: hostile }));

      for (const arg of invocation.args) {
        if (arg !== hostile) {
          expect(arg).not.toContain('rm -rf');
        }
      }
    });

    it(`${provider}: runs in the piece's own folder`, () => {
      const invocation = buildInvocation(request({ provider, model }));

      expect(invocation.cwd).toBe('C:/GitHub/ai-workflows');
    });
  }
});

describe('claude', () => {
  it('asks for the exact model and effort', () => {
    const { args } = buildInvocation(request());

    expect(after(args, '--model')).toBe('claude-opus-5');
    expect(after(args, '--effort')).toBe('high');
  });

  it('asks for structured output', () => {
    expect(after(buildInvocation(request()).args, '--output-format')).toBe('json');
  });

  it('reviews in plan mode, which cannot write', () => {
    expect(after(buildInvocation(request({ mode: 'review' })).args, '--permission-mode')).toBe(
      'plan',
    );
  });

  it('builds with edits accepted', () => {
    expect(after(buildInvocation(request({ mode: 'build' })).args, '--permission-mode')).toBe(
      'acceptEdits',
    );
  });

  it('resumes the exact session it is given', () => {
    expect(after(buildInvocation(request({ resumeSession: 'ses-42' })).args, '--resume')).toBe(
      'ses-42',
    );
  });
});

describe('codex', () => {
  const codex = (over: Partial<RunRequest> = {}) =>
    request({ provider: 'codex', model: 'gpt-6-astra', ...over });

  it('asks for the exact model', () => {
    expect(after(buildInvocation(codex()).args, '-m')).toBe('gpt-6-astra');
  });

  it('passes the reasoning effort', () => {
    const { args } = buildInvocation(codex({ effort: 'medium' }));

    expect(args.some((arg) => arg.includes('model_reasoning_effort') && arg.includes('medium'))).toBe(true);
  });

  it('never asks for the fast or priority tier', () => {
    // The owner's rule: that tier burns far more tokens, and Astra never runs on it.
    const { args } = buildInvocation(codex());

    expect(args.join(' ')).not.toContain('service_tier');
  });

  it('asks for structured events', () => {
    expect(buildInvocation(codex()).args).toContain('--json');
  });

  it('reviews read-only', () => {
    expect(buildInvocation(codex({ mode: 'review' })).args.join(' ')).toContain('read-only');
  });

  it('resumes the exact thread it is given', () => {
    const { args } = buildInvocation(codex({ resumeSession: 'thread-7' }));

    expect(args).toContain('resume');
    expect(args).toContain('thread-7');
  });

  it('keeps a resumed review read-only, through config rather than a flag resume rejects', () => {
    // `codex exec resume` does not accept --sandbox; the read-only rule has to travel as
    // configuration, or the resumed review would quietly be able to write.
    const { args } = buildInvocation(codex({ mode: 'review', resumeSession: 'thread-7' }));

    expect(args).not.toContain('--sandbox');
    expect(args.some((arg) => arg.includes('sandbox_mode') && arg.includes('read-only'))).toBe(true);
  });
});

describe('opencode', () => {
  const opencode = (over: Partial<RunRequest> = {}) =>
    request({ provider: 'opencode', model: 'deepseek/deepseek-flash', ...over });

  it('asks for the exact model', () => {
    expect(after(buildInvocation(opencode()).args, '-m')).toBe('deepseek/deepseek-flash');
  });

  it('passes the effort as its variant', () => {
    expect(after(buildInvocation(opencode({ effort: 'high' })).args, '--variant')).toBe('high');
  });

  it('points it at the piece folder', () => {
    expect(after(buildInvocation(opencode()).args, '--dir')).toBe('C:/GitHub/ai-workflows');
  });

  it('asks for structured events', () => {
    expect(after(buildInvocation(opencode()).args, '--format')).toBe('json');
  });

  it('resumes the exact session it is given', () => {
    expect(after(buildInvocation(opencode({ resumeSession: 'ses_9' })).args, '-s')).toBe('ses_9');
  });

  it('refuses to review, since no read-only mode has been verified for it', () => {
    // Improvising one would let a "review" write files. Refusing is the honest answer.
    // The refusal must say why. A stub that throws "not implemented" would pass a bare
    // toThrow() for the wrong reason.
    expect(() => buildInvocation(opencode({ mode: 'review' }))).toThrow(/read-only|review/i);
  });
});

describe('antigravity', () => {
  const agy = (over: Partial<RunRequest> = {}) =>
    request({ provider: 'antigravity', model: 'gemini-3.8-flash-high', ...over });

  it('asks for the exact model', () => {
    expect(after(buildInvocation(agy()).args, '--model')).toBe('gemini-3.8-flash-high');
  });

  it('adds the piece folder to what it may read', () => {
    expect(after(buildInvocation(agy()).args, '--add-dir')).toBe('C:/GitHub/ai-workflows');
  });

  it('asks for structured output', () => {
    expect(after(buildInvocation(agy()).args, '--output-format')).toBe('json');
  });

  it('reviews in plan mode', () => {
    expect(after(buildInvocation(agy({ mode: 'review' })).args, '--mode')).toBe('plan');
  });

  it('does not review with write permission', () => {
    expect(buildInvocation(agy({ mode: 'review' })).args).not.toContain('--dangerously-skip-permissions');
  });

  it('resumes the exact conversation it is given', () => {
    expect(after(buildInvocation(agy({ resumeSession: 'conv-3' })).args, '--conversation')).toBe(
      'conv-3',
    );
  });
});

describe('muse', () => {
  it('is not started by the engine directly', () => {
    // Muse runs inside a WSL jail through the project's own launcher, which moves the work
    // in as a git bundle and back out as a patch. That belongs to the project, not here.
    expect(() =>
      buildInvocation(request({ provider: 'muse', model: 'muse-spark-1.3-contributor' })),
    ).toThrow(/launcher|muse/i);
  });
});

describe('what each provider has been verified to do', () => {
  const all: ProviderName[] = ['claude', 'codex', 'opencode', 'antigravity', 'muse'];
  const keys = ['start', 'identifyModel', 'resume', 'readOnlyReview', 'recoverChanges', 'classifyError'];

  for (const provider of all) {
    it(`${provider}: declares every capability, as a plain yes or no`, () => {
      const declared = capabilities(provider);

      for (const key of keys) {
        expect(typeof (declared as unknown as Record<string, unknown>)[key]).toBe('boolean');
      }
    });
  }

  it('does not claim a read-only review where none has been verified', () => {
    expect(capabilities('opencode').readOnlyReview).toBe(false);
  });

  it('claims a read-only review where one has been verified', () => {
    expect(capabilities('claude').readOnlyReview).toBe(true);
    expect(capabilities('codex').readOnlyReview).toBe(true);
    expect(capabilities('antigravity').readOnlyReview).toBe(true);
  });

  it('knows which CLIs report the model they actually ran', () => {
    // Claude reports it in modelUsage; Muse echoes it as run.model.configured.
    expect(capabilities('claude').identifyModel).toBe(true);
    expect(capabilities('muse').identifyModel).toBe(true);
  });

  it('agrees with buildInvocation: no read-only review, no review invocation', () => {
    for (const provider of all) {
      if (!capabilities(provider).readOnlyReview) {
        expect(() =>
          buildInvocation(request({ provider, model: 'cualquiera', mode: 'review' })),
        ).toThrow(/read-only|review|launcher/i);
      }
    }
  });
});
