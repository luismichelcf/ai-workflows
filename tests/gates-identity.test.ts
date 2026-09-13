import { describe, expect, it } from 'vitest';

import {
  requireDifferentBuilder,
  requireFreshVerdicts,
  sameExecution,
  type ExecutionIdentity,
  type Verdict,
} from '../src/index.js';

// The gates that actually bite. Two claims the house has always made about its process,
// and that nothing has ever checked:
//
//   "nobody approves their own work"  — which cannot be checked by GitHub account, because
//   every model here publishes through the same one. What tells them apart is the provider,
//   the model and the session the CLI reports.
//
//   "a review is of the code as it is now" — which caught a real bug once: a review of
//   diff A being used after the code became B.

const SHA_A = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const SHA_B = 'd9bbf4f0e1d2c3b4a59687766554433221100ffe';
const SHA_OLD = '1234567890abcdef1234567890abcdef12345678';

const builder: ExecutionIdentity = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  session: 's-1',
};

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  by: { provider: 'claude', model: 'claude-opus-5', session: 's-2' },
  sha: SHA_A,
  approved: true,
  angle: 'dinero',
  ...over,
});

describe('telling one execution from another', () => {
  it('two runs of the same model in the same session are the same', () => {
    expect(sameExecution(builder, { ...builder })).toBe(true);
  });

  it('a different session of the same model is a different execution', () => {
    expect(sameExecution(builder, { ...builder, session: 's-9' })).toBe(false);
  });

  it('a different model of the same provider is a different execution', () => {
    expect(sameExecution(builder, { ...builder, model: 'deepseek-pro' })).toBe(false);
  });

  it('a different provider is a different execution', () => {
    expect(sameExecution(builder, { ...builder, provider: 'codex' })).toBe(false);
  });
});

describe('nobody reviews their own work', () => {
  it('accepts a review by someone else', () => {
    expect(requireDifferentBuilder([verdict()], builder).ok).toBe(true);
  });

  it('rejects a review by the very session that wrote the code', () => {
    const result = requireDifferentBuilder([verdict({ by: builder })], builder);

    expect(result.ok).toBe(false);
  });

  it('rejects it even though both were published by the same GitHub account', () => {
    // This is the point. The account proves nothing: every model here posts through the
    // owner's account. A gate comparing accounts would reject good reviews and accept a
    // model approving itself.
    const result = requireDifferentBuilder([verdict({ by: { ...builder, session: 's-1' } })], builder);

    expect(result.ok).toBe(false);
  });

  it('rejects a review by the same model in another session, when families must differ', () => {
    // A second session of the same model shares its blind spots. When the rule asks for a
    // different family, another session of the same model is not one.
    const result = requireDifferentBuilder(
      [verdict({ by: { provider: 'deepseek', model: 'deepseek-flash', session: 's-7' } })],
      builder,
      { differentProvider: true },
    );

    expect(result.ok).toBe(false);
  });

  it('accepts another session of the same model when families need not differ', () => {
    const result = requireDifferentBuilder(
      [verdict({ by: { provider: 'deepseek', model: 'deepseek-flash', session: 's-7' } })],
      builder,
    );

    expect(result.ok).toBe(true);
  });

  it('says who the offending reviewer was', () => {
    const result = requireDifferentBuilder([verdict({ by: builder })], builder);

    expect(result.ok === false && result.reason).toContain('deepseek');
  });

  it('rejects when there is no review at all', () => {
    expect(requireDifferentBuilder([], builder).ok).toBe(false);
  });

  it('rejects when one of several reviews is the builder itself', () => {
    const result = requireDifferentBuilder([verdict(), verdict({ by: builder })], builder);

    expect(result.ok).toBe(false);
  });
});

describe('a review is of the code as it is now', () => {
  it('accepts reviews of the current code', () => {
    expect(requireFreshVerdicts([verdict({ sha: SHA_A })], SHA_A).ok).toBe(true);
  });

  it('rejects a review of code that has since changed', () => {
    // The real case: reviewed as A, pushed, now it is B, and the old verdict is used to
    // wave it through.
    const result = requireFreshVerdicts([verdict({ sha: SHA_A })], SHA_B);

    expect(result.ok).toBe(false);
  });

  it('says which review went stale and against what', () => {
    const result = requireFreshVerdicts([verdict({ sha: SHA_A })], SHA_B);

    expect(result.ok === false && result.reason).toContain(SHA_A.slice(0, 7));
    expect(result.ok === false && result.reason).toContain(SHA_B.slice(0, 7));
  });

  it('rejects when one of several reviews is stale', () => {
    const result = requireFreshVerdicts(
      [verdict({ sha: SHA_A }), verdict({ sha: SHA_B })],
      SHA_B,
    );

    expect(result.ok).toBe(false);
  });

  it('rejects when a review did not finish', () => {
    const result = requireFreshVerdicts([verdict({ approved: undefined })], SHA_A);

    expect(result.ok).toBe(false);
  });

  it('rejects when a review found something blocking', () => {
    const result = requireFreshVerdicts([verdict({ approved: false, reason: 'mueve dinero sin aviso' })], SHA_A);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('dinero');
  });

  it('rejects when there is no review at all', () => {
    expect(requireFreshVerdicts([], SHA_A).ok).toBe(false);
  });

  it('can require every angle to have been covered', () => {
    // A review of three angles where two never ran is not a review of three angles.
    const result = requireFreshVerdicts([verdict({ angle: 'dinero' })], SHA_A, {
      angles: ['dinero', 'permisos', 'arquitectura'],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('permisos');
  });

  it('passes when every required angle is covered by a fresh verdict', () => {
    const result = requireFreshVerdicts(
      [
        verdict({ angle: 'dinero' }),
        verdict({ angle: 'permisos' }),
        verdict({ angle: 'arquitectura' }),
      ],
      SHA_A,
      { angles: ['dinero', 'permisos', 'arquitectura'] },
    );

    expect(result.ok).toBe(true);
  });

  it('does not let a stale verdict cover a required angle', () => {
    const result = requireFreshVerdicts(
      [verdict({ angle: 'dinero' }), verdict({ angle: 'permisos', sha: SHA_OLD })],
      SHA_A,
      { angles: ['dinero', 'permisos'] },
    );

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Third review (13-sep): three ways the checks above could still be fooled.
// ---------------------------------------------------------------------------------------

describe('the same session under another name is still the builder', () => {
  it('counts a resumed session with a different model label as the same execution', () => {
    // Reachable: the providers module fills the model with the one REQUESTED when the CLI
    // does not report it, so resuming a session under an alias changes only the label.
    const alias = { provider: 'claude', model: 'claude-opus-5-20260901', session: 's-1' };
    const original = { provider: 'claude', model: 'claude-opus-5', session: 's-1' };

    expect(sameExecution(original, alias)).toBe(true);
  });

  it('refuses a review by the builder s own session under another model label', () => {
    const build = { provider: 'claude', model: 'claude-opus-5', session: 's-1' };
    const review = verdict({ by: { provider: 'claude', model: 'claude-opus-5-20260901', session: 's-1' } });

    expect(requireDifferentBuilder([review], build).ok).toBe(false);
  });
});

describe('an identity that cannot be told apart proves nothing', () => {
  for (const [label, by] of [
    ['an empty session', { provider: 'claude', model: 'claude-opus-5', session: '' }],
    ['an empty provider', { provider: '', model: 'claude-opus-5', session: 's-2' }],
    ['an empty model', { provider: 'claude', model: '', session: 's-2' }],
  ] as const) {
    it(`refuses a reviewer with ${label}`, () => {
      expect(requireDifferentBuilder([verdict({ by })], builder).ok).toBe(false);
    });

    it(`refuses a builder with ${label}`, () => {
      expect(requireDifferentBuilder([verdict()], by).ok).toBe(false);
    });
  }
});

describe('a verdict says yes only with a real yes', () => {
  for (const approved of ['false', 'no', 1, 'true']) {
    it(`refuses approved: ${JSON.stringify(approved)}`, () => {
      expect(requireFreshVerdicts([verdict({ approved: approved as never })], SHA_A).ok).toBe(false);
    });
  }
});

describe('a verdict names a real version', () => {
  for (const [label, sha, current] of [
    ['empty on both sides', '', ''],
    ['a symbolic ref on both sides', 'HEAD', 'HEAD'],
    ['an abbreviated SHA', SHA_A.slice(0, 7), SHA_A],
    ['something that is not hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(requireFreshVerdicts([verdict({ sha })], current).ok).toBe(false);
    });
  }

  it('accepts the full SHA regardless of letter case', () => {
    expect(requireFreshVerdicts([verdict({ sha: SHA_A.toUpperCase() })], SHA_A).ok).toBe(true);
  });
});
