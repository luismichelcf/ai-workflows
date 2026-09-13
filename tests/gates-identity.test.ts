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

const builder: ExecutionIdentity = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  session: 's-1',
};

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  by: { provider: 'claude', model: 'claude-opus-5', session: 's-2' },
  sha: 'abc123',
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
    expect(requireFreshVerdicts([verdict({ sha: 'abc123' })], 'abc123').ok).toBe(true);
  });

  it('rejects a review of code that has since changed', () => {
    // The real case: reviewed as A, pushed, now it is B, and the old verdict is used to
    // wave it through.
    const result = requireFreshVerdicts([verdict({ sha: 'abc123' })], 'def456');

    expect(result.ok).toBe(false);
  });

  it('says which review went stale and against what', () => {
    const result = requireFreshVerdicts([verdict({ sha: 'abc123' })], 'def456');

    expect(result.ok === false && result.reason).toContain('abc123');
    expect(result.ok === false && result.reason).toContain('def456');
  });

  it('rejects when one of several reviews is stale', () => {
    const result = requireFreshVerdicts(
      [verdict({ sha: 'abc123' }), verdict({ sha: 'def456' })],
      'def456',
    );

    expect(result.ok).toBe(false);
  });

  it('rejects when a review did not finish', () => {
    const result = requireFreshVerdicts([verdict({ approved: undefined })], 'abc123');

    expect(result.ok).toBe(false);
  });

  it('rejects when a review found something blocking', () => {
    const result = requireFreshVerdicts([verdict({ approved: false, reason: 'mueve dinero sin aviso' })], 'abc123');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('dinero');
  });

  it('rejects when there is no review at all', () => {
    expect(requireFreshVerdicts([], 'abc123').ok).toBe(false);
  });

  it('can require every angle to have been covered', () => {
    // A review of three angles where two never ran is not a review of three angles.
    const result = requireFreshVerdicts([verdict({ angle: 'dinero' })], 'abc123', {
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
      'abc123',
      { angles: ['dinero', 'permisos', 'arquitectura'] },
    );

    expect(result.ok).toBe(true);
  });

  it('does not let a stale verdict cover a required angle', () => {
    const result = requireFreshVerdicts(
      [verdict({ angle: 'dinero' }), verdict({ angle: 'permisos', sha: 'viejo' })],
      'abc123',
      { angles: ['dinero', 'permisos'] },
    );

    expect(result.ok).toBe(false);
  });
});
