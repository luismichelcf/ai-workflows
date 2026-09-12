import { describe, expect, it } from 'vitest';

import { validateConfig } from '../src/index.js';

// PLAN-997 §7 (slice 1): `validate` must reject a malformed pipeline before anything runs,
// and must name what is wrong. A config whose stage order cannot be resolved is not a
// pipeline — the engine would have no defined transition to check.

const stage = (name: string, after?: string) => ({
  name,
  ...(after === undefined ? {} : { after }),
  gate: () => ({ ok: true as const }),
});

describe('validateConfig', () => {
  it('accepts a pipeline whose stages resolve to a single order', () => {
    const result = validateConfig({
      locale: 'es',
      stages: [stage('spec'), stage('build', 'spec'), stage('gate', 'build')],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a pipeline with no stages', () => {
    const result = validateConfig({ locale: 'es', stages: [] });

    expect(result.ok).toBe(false);
  });

  it('rejects duplicated stage names, naming the duplicate', () => {
    const result = validateConfig({
      locale: 'es',
      stages: [stage('spec'), stage('spec', 'spec')],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(' ')).toContain('spec');
  });

  it('rejects a stage that depends on an unknown stage, naming it', () => {
    const result = validateConfig({
      locale: 'es',
      stages: [stage('spec'), stage('build', 'review')],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(' ')).toContain('review');
  });

  it('rejects a cycle instead of looping forever', () => {
    const result = validateConfig({
      locale: 'es',
      stages: [stage('a', 'b'), stage('b', 'a')],
    });

    expect(result.ok).toBe(false);
  });
});
