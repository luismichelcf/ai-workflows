import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { advanceMain, commit, emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R6 §9.1, §9.3 and §9.4 test 6: the seal script, on a real temporary git repository.
//
// INTERFACE this file defines:
//   node scripts/seal.mjs --main <ref> [--tag <tag>]
//   run with the package root as the working directory (it reads ./package.json and writes
//   ./engine.json). With --tag (the release): the tag must be `v<package.json version>` and HEAD
//   must be the tag's commit. Without --tag (the dry-run of the reviewed commit): HEAD is sealed.
//   Either way the sealed commit must be an ancestor of <ref>, and its tree must equal the tree of
//   the first commit of <ref>'s first-parent history that contains it (the merge of the PR), so a
//   branch that was behind main, or a squash, is refused.
//   Success: exit 0 and ./engine.json = {"version": "<version>", "sha": "<40 hex of HEAD>"}.
//   Refusal: exit code other than 0, no engine.json, and a line on stderr that starts with
//   `seal refused: ` and says why.
//
// PLAN-13-R6 §15 P4 (after the flock): <ref> must be a fully qualified branch ref, `refs/heads/…`
// or `refs/remotes/…`. Anything else (`main`, `origin/main`, `refs/tags/main`) is refused with a
// line that names both accepted forms, because git resolves a bare name to a tag first. The
// existing cases above pass `refs/heads/main` for that reason (they passed a bare `main` before).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEAL_SCRIPT = join(REPO, 'scripts', 'seal.mjs');

afterEach(removeRepositories);

const packageJson = (version: string) => `${JSON.stringify({ name: 'ai-workflows', version, private: true }, null, 2)}\n`;

function seal(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SEAL_SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * main has the base commit; branch `piece` adds the reviewed commit. With `merge`, the piece is
 * merged into main with a merge commit while up to date, as §9.3 requires.
 */
function releaseRepository(options: { version?: string; merge?: boolean; behind?: boolean } = {}) {
  const root = repository({ 'package.json': packageJson(options.version ?? '1.0.0'), 'src/a.ts': 'export const a = 1;\n' });
  write(root, 'src/b.ts', 'export const b = 1;\n');
  const reviewed = commit(root, 'reviewed');
  if (options.behind === true) advanceMain(root, { 'src/other.ts': 'export const other = 1;\n' });
  let merge: string | undefined;
  if (options.merge !== false) {
    git(root, 'switch', '-q', 'main');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'piece');
    merge = git(root, 'rev-parse', 'HEAD');
  }
  return { root, reviewed, merge };
}

function expectRefused(root: string, result: ReturnType<typeof seal>): void {
  expect(existsSync(SEAL_SCRIPT), 'scripts/seal.mjs exists').toBe(true);
  expect(result.code, result.stderr).not.toBe(0);
  expect(result.stderr).toMatch(/^seal refused: \S/m);
  expect(existsSync(join(root, 'engine.json'))).toBe(false);
}

function engineJson(root: string): unknown {
  return JSON.parse(readFileSync(join(root, 'engine.json'), 'utf8'));
}

describe('R6 §9.4 test 6: the seal script', () => {
  it('seals the commit of the tag when it is v<version>, HEAD, an ancestor of main and the same tree as its merge', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    const result = seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main');

    expect(result.code, result.stderr).toBe(0);
    expect(engineJson(root)).toEqual({ version: '1.0.0', sha: reviewed });
  });

  it('main moving on after the merge does not matter: the first merge that contains it counts', () => {
    const { root, reviewed } = releaseRepository();
    write(root, 'src/later.ts', 'export const later = 1;\n');
    commit(root, 'main moves after the release merge');
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    const result = seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main');

    expect(result.code, result.stderr).toBe(0);
    expect(engineJson(root)).toEqual({ version: '1.0.0', sha: reviewed });
  });

  it('without --tag (dry-run) seals HEAD with the same ancestry and tree checks', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'switch', '-q', '--detach', reviewed);

    const result = seal(root, '--main', 'refs/heads/main');

    expect(result.code, result.stderr).toBe(0);
    expect(engineJson(root)).toEqual({ version: '1.0.0', sha: reviewed });
  });

  it('refuses a tag that is not v<package.json version>', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.1', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.1');

    const result = seal(root, '--tag', 'v1.0.1', '--main', 'refs/heads/main');

    expectRefused(root, result);
    expect(result.stderr).toContain('v1.0.1');
  });

  it('refuses when HEAD is not the commit of the tag', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.0', reviewed);
    // HEAD is the merge commit on main, not the reviewed commit.

    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main'));
  });

  it('refuses a commit that is not an ancestor of main (never merged)', () => {
    const { root, reviewed } = releaseRepository({ merge: false });
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main'));
  });

  it('refuses when the branch was behind main: the merge tree differs from the reviewed tree', () => {
    const { root, reviewed } = releaseRepository({ behind: true });
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main'));
  });

  it('refuses a squash merge: the reviewed commit is not an ancestor of main', () => {
    const { root, reviewed } = releaseRepository({ merge: false });
    git(root, 'switch', '-q', 'main');
    git(root, 'merge', '-q', '--squash', 'piece');
    commit(root, 'squash of the piece');
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/heads/main'));
  });

  it('the dry-run refuses too when HEAD is not an ancestor of main', () => {
    const { root, reviewed } = releaseRepository({ merge: false });
    git(root, 'switch', '-q', '--detach', reviewed);

    expectRefused(root, seal(root, '--main', 'refs/heads/main'));
  });
});

/**
 * What `actions/checkout` leaves on a tag push with `fetch-depth: 0`: the branches only as
 * `refs/remotes/origin/*`, the tags, no local branch, and HEAD detached at the tag.
 */
function checkoutOfTag(origin: string, tag: string): string {
  const clone = emptyFolder();
  git(clone, 'init', '-q');
  git(clone, 'config', 'core.autocrlf', 'false');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'fetch', '-q', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*');
  git(clone, 'checkout', '-q', '--force', `refs/tags/${tag}`);
  return clone;
}

describe('R6 §15 P4: the seal on the checkout of a tag push, and only a fully qualified main', () => {
  it('a clone made like actions/checkout on a tag push seals with --main refs/remotes/origin/main', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.0', reviewed);
    const clone = checkoutOfTag(root, 'v1.0.0');
    expect(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');

    const result = seal(clone, '--tag', 'v1.0.0', '--main', 'refs/remotes/origin/main');

    expect(result.code, result.stderr).toBe(0);
    expect(engineJson(clone)).toEqual({ version: '1.0.0', sha: reviewed });
  });

  it('a name that is not fully qualified is refused with a clear message, even where it would resolve', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    for (const main of ['main', 'heads/main']) {
      const result = seal(root, '--tag', 'v1.0.0', '--main', main);
      expectRefused(root, result);
      expect(result.stderr, main).toContain('refs/heads/');
      expect(result.stderr, main).toContain('refs/remotes/');
    }

    const clone = checkoutOfTag(root, 'v1.0.0');
    for (const main of ['main', 'origin/main']) {
      const result = seal(clone, '--tag', 'v1.0.0', '--main', main);
      expectRefused(clone, result);
      expect(result.stderr, main).toContain('refs/heads/');
      expect(result.stderr, main).toContain('refs/remotes/');
    }
  });

  it('a tag named main on an unmerged history cannot stand in for the real main', () => {
    // The reviewed commit is never merged into main; a side branch merges it and a tag `main`
    // points at that merge, so a bare `main` would resolve to the tag.
    const { root, reviewed } = releaseRepository({ merge: false });
    git(root, 'switch', '-q', '-c', 'side', 'main');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'piece');
    git(root, 'tag', 'main', git(root, 'rev-parse', 'HEAD'));
    git(root, 'tag', 'v1.0.0', reviewed);
    const clone = checkoutOfTag(root, 'v1.0.0');

    for (const main of ['main', 'refs/tags/main', 'refs/remotes/origin/main']) {
      expectRefused(clone, seal(clone, '--tag', 'v1.0.0', '--main', main));
    }
  });

  it('a missing --main, or a fully qualified ref that does not exist, is refused', () => {
    const { root, reviewed } = releaseRepository();
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');

    expectRefused(root, seal(root, '--tag', 'v1.0.0'));
    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main'));
    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/remotes/origin/main'));
  });
});

// Delta review of the flock fixes (a NOTE on §15 P4): a fully qualified name is not enough if git
// is left to guess. `refs/remotes/origin/main` that does not exist must not resolve to a tag named
// `refs/tags/refs/remotes/origin/main` (git's own lookup order tries `refs/tags/<name>` too): the
// seal reads exactly the ref it was given, and refuses when that exact ref is missing.
describe('NOTE: --main is read as that exact ref, never guessed', () => {
  it('refs/remotes/origin/main missing, a tag refs/tags/refs/remotes/origin/main on a merge that contains the commit: refused', () => {
    // The reviewed commit is never merged into main; a side branch merges it and the tag points at
    // that merge, so the guessed ref would pass every other check.
    const { root, reviewed } = releaseRepository({ merge: false });
    git(root, 'switch', '-q', '-c', 'side', 'main');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'piece');
    git(root, 'update-ref', 'refs/tags/refs/remotes/origin/main', git(root, 'rev-parse', 'HEAD'));
    git(root, 'tag', 'v1.0.0', reviewed);
    git(root, 'switch', '-q', '--detach', 'v1.0.0');
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('');

    expectRefused(root, seal(root, '--tag', 'v1.0.0', '--main', 'refs/remotes/origin/main'));
  });
});