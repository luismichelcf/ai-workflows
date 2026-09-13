import { describe, expect, it } from 'vitest';

import { requireSameFiles } from '../src/index.js';

// Second review of the part 3 fixes (13-sep-2026): `'​'` or `'undefined'` on both sides
// passed as the same file. A hash that is not a hash proves nothing.

const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

describe('only a real hash can match', () => {
  for (const hash of ['​', 'undefined', 'null', 'abc', 'zz39a3ee5e6b4b0d3255bfef95601890afd80709', `${sha1}0`]) {
    it(`refuses ${JSON.stringify(hash)} on both sides, naming the file`, () => {
      const result = requireSameFiles({ 'tests/x.test.ts': hash }, { 'tests/x.test.ts': hash });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('tests/x.test.ts');
    });
  }

  it('accepts hexadecimal SHA-1, SHA-256 and SHA-512 in any case', () => {
    const sha512 = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
    for (const hash of [sha1, sha256, sha512]) {
      expect(requireSameFiles({ 'tests/x.test.ts': hash }, { 'tests/x.test.ts': hash.toUpperCase() }), hash.length.toString()).toEqual({ ok: true });
    }
  });
});
