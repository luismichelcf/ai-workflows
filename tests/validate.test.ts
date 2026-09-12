import { describe, expect, it } from 'vitest';

import { fingerprint, validateConfig } from '../src/index.js';

import { pipeline, stage } from './helpers.js';

// `validate` rejects a malformed pipeline before anything runs, and names what is wrong.
//
// Ambiguity counts as malformed. The slice-1 version accepted pipelines with several valid
// orders — two stages sharing an `after`, or several with no `after` at all — and then ran
// them in whatever order the array happened to be written in. A pipeline whose order
// depends on array position is not a pipeline the owner can reason about.

describe('validateConfig', () => {
  it('accepts a pipeline whose stages resolve to a single order', () => {
    const result = validateConfig(
      pipeline([
        stage('spec'),
        stage('build', { after: 'spec' }),
        stage('gate', { after: 'build' }),
      ]),
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects a pipeline with no stages', () => {
    expect(validateConfig(pipeline([])).ok).toBe(false);
  });

  it('rejects duplicated stage names, naming the duplicate', () => {
    const result = validateConfig(pipeline([stage('spec'), stage('spec', { after: 'spec' })]));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(' ')).toContain('spec');
  });

  it('rejects a stage that depends on an unknown stage, naming it', () => {
    const result = validateConfig(pipeline([stage('spec'), stage('build', { after: 'review' })]));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(' ')).toContain('review');
  });

  it('rejects a cycle instead of looping forever', () => {
    const result = validateConfig(
      pipeline([stage('a', { after: 'b' }), stage('b', { after: 'a' })]),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a self-cycle', () => {
    expect(validateConfig(pipeline([stage('a', { after: 'a' })])).ok).toBe(false);
  });

  it('rejects two stages that both claim to run after the same one', () => {
    const result = validateConfig(
      pipeline([
        stage('spec'),
        stage('build', { after: 'spec' }),
        stage('docs', { after: 'spec' }),
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(' ')).toContain('spec');
  });

  it('rejects more than one stage with no predecessor', () => {
    const result = validateConfig(pipeline([stage('spec'), stage('docs')]));

    expect(result.ok).toBe(false);
  });

  it('accepts stages declared out of order, since the order comes from `after`', () => {
    const result = validateConfig(
      pipeline([stage('gate', { after: 'build' }), stage('build', { after: 'spec' }), stage('spec')]),
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('fingerprint', () => {
  it('is the same for the same pipeline shape', () => {
    const one = pipeline([stage('spec'), stage('build', { after: 'spec' })]);
    const two = pipeline([stage('spec'), stage('build', { after: 'spec' })]);

    expect(fingerprint(one)).toBe(fingerprint(two));
  });

  it('does not change when a gate body changes', () => {
    // Editing what a gate checks must not invalidate evidence the engine already observed;
    // otherwise every tweak to a gate re-runs every piece in flight.
    const before = pipeline([stage('spec', { gate: () => ({ ok: true }) })]);
    const after = pipeline([stage('spec', { gate: () => ({ ok: true, note: 'otra cosa' }) })]);

    expect(fingerprint(before)).toBe(fingerprint(after));
  });

  it('changes when a stage is added', () => {
    const before = pipeline([stage('spec')]);
    const after = pipeline([stage('spec'), stage('build', { after: 'spec' })]);

    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it('changes when a stage is renamed', () => {
    expect(fingerprint(pipeline([stage('qa')]))).not.toBe(
      fingerprint(pipeline([stage('quality')])),
    );
  });

  it('changes when the order changes', () => {
    const one = pipeline([stage('a'), stage('b', { after: 'a' })]);
    const two = pipeline([stage('b'), stage('a', { after: 'b' })]);

    expect(fingerprint(one)).not.toBe(fingerprint(two));
  });
});
