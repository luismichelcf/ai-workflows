import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STAGED_PATHS_GIT_ARGS,
  decidePreCommit,
  decidePrePush,
  parsePrePushStdin,
  parseStagedPaths,
  renderGitHook,
  type LockContext,
} from '../src/index.js';

// Review of part 4 (13-sep-2026), measured with git 2.53 for Windows and its sh:
//   - `git diff --cached --name-only` prints `"docs/decisi\303\263n.md"`: a paper with an accent
//     was refused, and `git mv src/a.ts docs/a.ts` listed only `docs/a.ts`, so a commit could
//     delete code with no piece. `-z --no-renames` prints both sides, unquoted.
//   - pre-push gets `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin.
//   - A hook command written as one shell string ran `$(...)` and lost its arguments after `;`.

const context: LockContext = { projectRoot: 'C:/GitHub/Socialabs', paperPaths: ['docs'] };
const sha = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const zero = '0'.repeat(40);

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-git-input-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const gitAvailable = git(tmpdir(), '--version').status === 0;

describe('reading what is staged', () => {
  it('asks git for NUL-separated paths with renames split into both sides', () => {
    expect(STAGED_PATHS_GIT_ARGS).toEqual(['diff', '--cached', '--name-only', '-z', '--no-renames']);
  });

  it('reads NUL-separated output, accents and spaces included, without git quoting', () => {
    expect(parseStagedPaths('docs/decisión.md\0docs/mi archivo.md\0src/a.ts\0')).toEqual([
      'docs/decisión.md',
      'docs/mi archivo.md',
      'src/a.ts',
    ]);
  });

  it('reads nothing staged as an empty list', () => {
    expect(parseStagedPaths('')).toEqual([]);
  });

  it('lets a paper with an accent be committed with no piece', () => {
    expect(decidePreCommit({ stagedPaths: parseStagedPaths('docs/decisión.md\0'), context }).allow).toBe(true);
  });

  it.runIf(gitAvailable)('matches what real git prints for an accent and a move from code to papers', () => {
    const repo = scratch();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'prueba@example.com');
    git(repo, 'config', 'user.name', 'Prueba');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'inicio');
    git(repo, 'mv', 'src/a.ts', 'docs/a.ts');
    writeFileSync(join(repo, 'docs', 'decisión.md'), '# Decisión\n');
    git(repo, 'add', '.');

    const staged = git(repo, ...STAGED_PATHS_GIT_ARGS);
    const paths = parseStagedPaths(staged.stdout);

    expect([...paths].sort()).toEqual(['docs/a.ts', 'docs/decisión.md', 'src/a.ts']);
    expect(decidePreCommit({ stagedPaths: paths, context }).allow).toBe(false);
  });
});

describe('reading what git sends to pre-push', () => {
  it('takes the remote ref of every line', () => {
    const stdin = `refs/heads/feat/x ${sha} refs/heads/feat/x ${zero}\nHEAD ${sha} refs/heads/main ${zero}\n`;

    expect(parsePrePushStdin(stdin)).toEqual({ ok: true, remoteRefs: ['refs/heads/feat/x', 'refs/heads/main'] });
  });

  it('takes the ref of a deletion', () => {
    expect(parsePrePushStdin(`(delete) ${zero} refs/heads/main ${sha}\n`)).toEqual({ ok: true, remoteRefs: ['refs/heads/main'] });
  });

  it('reads Windows line endings the same', () => {
    expect(parsePrePushStdin(`HEAD ${sha} refs/heads/main ${zero}\r\n`)).toEqual({ ok: true, remoteRefs: ['refs/heads/main'] });
  });

  it('reads an empty push as no refs', () => {
    expect(parsePrePushStdin('')).toEqual({ ok: true, remoteRefs: [] });
  });

  it('refuses a line that is not four fields, instead of letting the push through', () => {
    for (const stdin of [`refs/heads/main ${sha}\n`, `HEAD ${sha} refs/heads/main ${zero} extra\n`]) {
      const result = parsePrePushStdin(stdin);

      expect(result.ok, stdin).toBe(false);
    }
  });

  it('refuses HEAD:main end to end', () => {
    const result = parsePrePushStdin(`HEAD ${sha} refs/heads/main ${zero}\n`);
    if (!result.ok) throw new Error(result.reason);

    expect(decidePrePush({ remoteRefs: result.remoteRefs, defaultBranch: 'main' }).allow).toBe(false);
  });
});

describe('the default branch name is checked, not trusted', () => {
  for (const defaultBranch of ['refs/heads/main', 'origin/main', 'main\n', '', ' main', 'ma in']) {
    it(`refuses defaultBranch ${JSON.stringify(defaultBranch)}, naming the setting`, () => {
      for (const remoteRefs of [['refs/heads/main'], ['refs/heads/feat/x']]) {
        const decision = decidePrePush({ remoteRefs, defaultBranch });

        expect(decision.allow, remoteRefs[0]).toBe(false);
        expect(decision.allow === false && decision.reason, remoteRefs[0]).toMatch(/defaultBranch/);
      }
    });
  }

  it('accepts a nested default branch name', () => {
    expect(decidePrePush({ remoteRefs: ['refs/heads/release/main'], defaultBranch: 'release/main' }).allow).toBe(false);
    expect(decidePrePush({ remoteRefs: ['refs/heads/feat/x'], defaultBranch: 'release/main' }).allow).toBe(true);
  });
});

const shPath = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh';

describe('the git hook runs exactly the command it was given', () => {
  it('quotes every argument so the shell never reads it again', () => {
    const script = renderGitHook('pre-commit', ['node', 'C:/Program Files/ai workflows/lock.js', '$(echo SUBST)']);

    expect(script).toContain(`exec 'node' 'C:/Program Files/ai workflows/lock.js' '$(echo SUBST)' 'pre-commit' "$@"`);
  });

  it('escapes a single quote inside an argument', () => {
    expect(renderGitHook('pre-push', ["it's"])).toContain(`exec 'it'\\''s' 'pre-push' "$@"`);
  });

  it('refuses an argument with a line break or a NUL, and an empty command', () => {
    for (const argv of [['node', 'a\nb'], ['node', 'a\rb'], ['node', 'a\0b'], []]) {
      expect(() => renderGitHook('pre-commit', argv), JSON.stringify(argv)).toThrow();
    }
  });

  it.runIf(existsSync(shPath))('with the real sh, the command receives the hook kind, git s arguments and stdin, and a substitution stays literal', () => {
    const dir = scratch();
    const out = join(dir, 'received.json');
    const receiver = join(dir, 'receiver.js');
    writeFileSync(
      receiver,
      `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));\n`,
    );
    const hook = join(dir, 'pre-push');
    const nodePath = process.execPath.replace(/\\/g, '/');
    writeFileSync(hook, renderGitHook('pre-push', [nodePath, receiver.replace(/\\/g, '/'), '$(echo SUBST)']));
    const stdin = `HEAD ${sha} refs/heads/feat/x ${zero}\n`;

    const run = spawnSync(shPath, [hook, 'origin', 'https://example.com/r.git'], { input: stdin, encoding: 'utf8' });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      argv: ['$(echo SUBST)', 'pre-push', 'origin', 'https://example.com/r.git'],
      stdin,
    });
  });
});
