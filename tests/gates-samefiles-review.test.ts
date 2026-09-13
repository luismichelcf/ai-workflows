import { describe, expect, it } from 'vitest';

import { requireSameFiles } from '../src/index.js';

// Review of the part 3 fixes (13-sep-2026): five of five mutations of requireSameFiles survived,
// including comparing only the first character of each hash, and an empty hash matched an
// empty hash — a green that proves nothing, like the empty record already refused.

const a = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const b = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b856';

describe('what counts as the same file', () => {
  it('passes when every name and every full hash match', () => {
    expect(requireSameFiles({ 'tests/x.test.ts': a }, { 'tests/x.test.ts': a.toUpperCase() })).toEqual({ ok: true });
  });

  it('refuses hashes that differ only in their last character, naming the file', () => {
    const result = requireSameFiles({ 'tests/x.test.ts': a }, { 'tests/x.test.ts': b });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('tests/x.test.ts');
  });

  it('refuses an empty or blank hash on either side, naming the file', () => {
    for (const [recorded, current] of [['', ''], [' ', ' '], [a, ''], ['', a]] as const) {
      const result = requireSameFiles({ 'tests/x.test.ts': recorded }, { 'tests/x.test.ts': current });

      expect(result.ok, JSON.stringify([recorded, current])).toBe(false);
      expect(result.ok === false && result.reason).toContain('tests/x.test.ts');
    }
  });

  it('names a file that disappeared and one that appeared', () => {
    const result = requireSameFiles({ 'tests/x.test.ts': a, 'tests/gone.test.ts': a }, { 'tests/x.test.ts': a, 'tests/new.test.ts': a });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('tests/gone.test.ts');
    expect(result.ok === false && result.reason).toContain('tests/new.test.ts');
  });
});
