import { describe, expect, it } from 'vitest';

import { decidePrePush } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026): the default branch name was checked against a
// closed shape that accepted `ma..in` — a name git refuses, so it never matched and every push
// passed — and refused valid names such as `release+1` or `año`, so every push was refused.
// The rules are git's own (`git check-ref-format`).

describe('the default branch name follows git s own rules', () => {
  for (const defaultBranch of ['ma..in', '.main', 'feat/.x', 'main.lock', 'main.', 'ma@{in', '@', 'main/', '/main', 'feat//x', 'ma\\in', 'ma:in', 'ma?in', 'ma*in', 'ma[in', 'ma~in', 'ma^in', 'ma in']) {
    it(`refuses ${JSON.stringify(defaultBranch)}, naming the setting`, () => {
      const decision = decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch });

      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.reason).toMatch(/defaultBranch/);
    });
  }

  for (const defaultBranch of ['release+1', 'año', 'feat/ñandú', 'v1.2', 'main_2026']) {
    it(`accepts ${JSON.stringify(defaultBranch)} and still guards it`, () => {
      expect(decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch }).allow).toBe(true);
      expect(decidePrePush({ remoteRefs: [`refs/heads/${defaultBranch}`], defaultBranch }).allow).toBe(false);
    });
  }
});
