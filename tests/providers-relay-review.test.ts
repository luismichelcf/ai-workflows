import { describe, expect, it } from 'vitest';

import { decideRelay, type Assignment, type RelayState, type RunReport } from '../src/index.js';

// Adversarial review of the relay decision (13-sep-2026), plus the rule stated to the owner
// the same day: when a model runs out of quota, the replacement is never another model from
// the same company, because they share that quota.

const flash: Assignment = { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high' };
const pro: Assignment = { provider: 'opencode', model: 'deepseek/deepseek-v4-pro', effort: 'high' };
const astraMedium: Assignment = { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' };
const astraHigh: Assignment = { provider: 'codex', model: 'gpt-6-astra', effort: 'high' };
const opus: Assignment = { provider: 'claude', model: 'claude-opus-5', effort: 'high' };

const failedBy = (who: Assignment, status: RunReport['status'] = 'quota'): RunReport => ({
  status,
  modelConfirmed: false,
  identity: { provider: who.provider, model: who.model, session: 's-1' },
});

const state = (over: Partial<RelayState>): RelayState => ({ chain: [], tried: [], stuckRounds: 0, ...over });

describe('who failed is who the report says', () => {
  it('does not relay back to the model that just failed, even when tried is empty', () => {
    const decision = decideRelay(failedBy(flash), state({ chain: [flash, astraMedium], tried: [] }));

    expect(decision.action).toBe('relay');
    expect(decision.action === 'relay' && decision.to).toEqual(astraMedium);
  });

  it('names the model that actually failed in the reason', () => {
    const decision = decideRelay(failedBy(astraMedium), state({ chain: [flash, astraMedium, opus], tried: [flash, astraMedium] }));

    expect(decision.action === 'relay' && decision.reason).toContain('gpt-6-astra');
    expect(decision.action === 'relay' && decision.reason).not.toContain('deepseek');
  });
});

describe('a quota is shared by the company, not by the effort', () => {
  it('does not relay to the same model at a higher effort', () => {
    // Same model, same account, same quota: raising the effort cannot help.
    const decision = decideRelay(failedBy(astraMedium), state({ chain: [astraMedium, astraHigh, opus], tried: [astraMedium] }));

    expect(decision.action === 'relay' && decision.to).toEqual(opus);
  });

  it('does not relay to another model of the same company', () => {
    const decision = decideRelay(failedBy(flash), state({ chain: [flash, pro, astraMedium], tried: [flash] }));

    expect(decision.action === 'relay' && decision.to).toEqual(astraMedium);
  });

  it('asks the owner when every remaining option shares the quota that ran out', () => {
    const decision = decideRelay(failedBy(flash), state({ chain: [flash, pro], tried: [flash] }));

    expect(decision.action).toBe('ask-owner');
  });

  it('applies the same caution to a sign-in failure', () => {
    const decision = decideRelay(failedBy(astraMedium, 'auth'), state({ chain: [astraMedium, astraHigh, opus], tried: [astraMedium] }));

    expect(decision.action === 'relay' && decision.to).toEqual(opus);
  });
});

describe('the relay is the NEXT one in the owner s order', () => {
  it('does not go back to an earlier option the owner ranked above the one that failed', () => {
    const decision = decideRelay(failedBy(opus), state({ chain: [flash, astraMedium, opus], tried: [opus] }));

    expect(decision.action).toBe('ask-owner');
  });

  it('moves forward past what was tried', () => {
    const decision = decideRelay(failedBy(astraMedium), state({ chain: [flash, astraMedium, opus], tried: [flash, astraMedium] }));

    expect(decision.action === 'relay' && decision.to).toEqual(opus);
  });
});

describe('a state it cannot trust is the owner s call', () => {
  for (const stuckRounds of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    it(`asks the owner when stuckRounds is ${stuckRounds}`, () => {
      const decision = decideRelay(failedBy(flash), state({ chain: [flash, astraMedium], tried: [flash], stuckRounds }));

      expect(decision.action).toBe('ask-owner');
    });
  }

  it('still continues after a success, whatever the counter says', () => {
    expect(decideRelay({ status: 'success', modelConfirmed: false }, state({ stuckRounds: 99 })).action).toBe('continue');
  });
});
