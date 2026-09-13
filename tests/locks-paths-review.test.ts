import { describe, expect, it } from 'vitest';

import { decidePreCommit, decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of part 4 (13-sep-2026). Windows writes into the same folder under many spellings
// of its path, and the hook's cwd moves with every `cd`. Both let code be written with no
// piece. Every spelling below was checked on the owner's machine: Windows wrote into the real
// folder with each of them.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };
const withPiece: LockContext = { projectRoot: root, activePiece: '997', paperPaths: ['docs'] };

const write = (file: string, cwd: string = root): HookInput => ({
  toolName: 'Write',
  toolInput: { file_path: file, content: 'x' },
  cwd,
});

describe('the project folder spelled another way is still the project', () => {
  const spellings = [
    'C:/github/socialabs/src/a.ts',
    'c:\\github\\socialabs\\src\\a.ts',
    'C:\\GITHUB\\SOCIALABS\\src\\a.ts',
    '\\\\?\\C:\\GitHub\\Socialabs\\src\\a.ts',
    '\\\\.\\C:\\GitHub\\Socialabs\\src\\a.ts',
    '//?/C:/GitHub/Socialabs/src/a.ts',
    '\\\\localhost\\c$\\GitHub\\Socialabs\\src\\a.ts',
    '\\\\127.0.0.1\\C$\\GitHub\\Socialabs\\src\\a.ts',
  ];

  for (const file of spellings) {
    it(`refuses code at ${file}`, () => {
      expect(decideToolUse(write(file), noPiece).allow).toBe(false);
    });
  }

  it('refuses a relative write when the hook reports the folder in another capitalisation', () => {
    // Git Bash after `cd /c/github/socialabs` reports the cwd exactly like this.
    expect(decideToolUse(write('src\\a.ts', 'C:\\github\\socialabs'), noPiece).allow).toBe(false);
  });

  it('refuses code with a piece nowhere, whatever the capitalisation of the cwd', () => {
    expect(decideToolUse(write('C:\\GitHub\\Socialabs\\src\\a.ts', 'C:\\github\\socialabs'), noPiece).allow).toBe(false);
  });
});

describe('a spelling that cannot be reduced to one folder is refused, not guessed', () => {
  const unreadable = [
    // An 8.3 short name: `realpath` turns C:/GitHub/SOCIAL~1 into C:\GitHub\Socialabs.
    'C:/GitHub/SOCIAL~1/src/a.ts',
    // An alternate data stream spelling of the folder itself.
    'C:/GitHub/Socialabs::$INDEX_ALLOCATION/src/a.ts',
    // A colon after the drive names a stream, not a file.
    'C:/GitHub/Socialabs/src/a.ts:hidden',
    // Another machine's share may be this very folder.
    '\\\\otro-servidor\\c$\\GitHub\\Socialabs\\src\\a.ts',
  ];

  for (const file of unreadable) {
    it(`refuses ${file} with a reason`, () => {
      const decision = decideToolUse(write(file), noPiece);

      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.reason.length).toBeGreaterThan(10);
    });
  }
});

describe('what is legitimately allowed stays allowed', () => {
  it('allows papers in any capitalisation, which Windows treats as the same folder', () => {
    expect(decideToolUse(write('C:/GitHub/Socialabs/Docs/a.md'), noPiece).allow).toBe(true);
    expect(decideToolUse(write('DOCS\\a.md'), noPiece).allow).toBe(true);
  });

  it('allows the real Windows format of Claude Code for a paper', () => {
    expect(decideToolUse(write('C:\\GitHub\\Socialabs\\docs\\a.md'), noPiece).allow).toBe(true);
  });

  it('allows writing outside the project', () => {
    expect(decideToolUse(write('C:\\Users\\Luis\\AppData\\Local\\Temp\\x.ts'), noPiece).allow).toBe(true);
    expect(decideToolUse(write('D:/otro/a.ts'), noPiece).allow).toBe(true);
  });

  it('allows code with a piece, in any spelling', () => {
    expect(decideToolUse(write('\\\\?\\C:\\GitHub\\Socialabs\\src\\a.ts'), withPiece).allow).toBe(true);
    expect(decideToolUse(write('c:/github/socialabs/src/a.ts'), withPiece).allow).toBe(true);
  });
});

describe('the project root is configured, not taken from where the session happens to be', () => {
  it('refuses code elsewhere in the project after a cd into src', () => {
    const decision = decideToolUse(write('C:\\GitHub\\Socialabs\\lib\\calc\\nomina.ts', 'C:\\GitHub\\Socialabs\\src'), noPiece);

    expect(decision.allow).toBe(false);
  });

  it('refuses ../src from inside docs', () => {
    expect(decideToolUse(write('../src/a.ts', 'C:\\GitHub\\Socialabs\\docs'), noPiece).allow).toBe(false);
  });

  it('reads paper folders against the project root, not the cwd', () => {
    // From inside docs, "a.md" is docs/a.md: a paper.
    expect(decideToolUse(write('a.md', 'C:\\GitHub\\Socialabs\\docs'), noPiece).allow).toBe(true);
    // From inside src, "docs/a.md" is src/docs/a.md: not a paper.
    expect(decideToolUse(write('docs/a.md', 'C:\\GitHub\\Socialabs\\src'), noPiece).allow).toBe(false);
  });

  it('allows ../docs from inside src', () => {
    expect(decideToolUse(write('../docs/a.md', 'C:\\GitHub\\Socialabs\\src'), noPiece).allow).toBe(true);
  });
});

describe('what it does not know, it does not guess', () => {
  it('refuses a relative path when the CLI sent no cwd', () => {
    expect(decideToolUse(write('src/a.ts', ''), noPiece).allow).toBe(false);
  });

  it('refuses a relative path when the cwd is itself relative', () => {
    expect(decideToolUse(write('a.md', 'docs'), noPiece).allow).toBe(false);
  });

  it('refuses code inside the project even when the CLI sent no cwd', () => {
    expect(decideToolUse(write('C:/GitHub/Socialabs/src/a.ts', ''), noPiece).allow).toBe(false);
  });

  it('refuses everything when the project root is not an absolute path, naming it', () => {
    for (const projectRoot of ['', '.', 'Socialabs']) {
      const decision = decideToolUse(write('C:/Users/Luis/tmp/x.md'), { ...noPiece, projectRoot });

      expect(decision.allow, projectRoot).toBe(false);
      expect(decision.allow === false && decision.reason, projectRoot).toMatch(/projectRoot/);
    }
  });
});

describe('a paper folder that would switch the lock off is refused loudly', () => {
  for (const paper of ['', '.', './', '..', '../docs', 'docs/../..', 'C:/GitHub/Socialabs/docs', '/docs']) {
    it(`refuses the paperPaths entry ${JSON.stringify(paper)} in the editor and in pre-commit alike`, () => {
      const context: LockContext = { projectRoot: root, paperPaths: [paper] };
      const editor = decideToolUse(write('C:/GitHub/Socialabs/docs/a.md'), context);
      const commit = decidePreCommit({ stagedPaths: ['docs/a.md'], context });

      expect(editor.allow).toBe(false);
      expect(commit.allow).toBe(false);
      expect(editor.allow === false && editor.reason).toMatch(/paperPaths/);
      expect(commit.allow === false && commit.reason).toMatch(/paperPaths/);
    });
  }

  it('accepts docs/, ./docs and a nested folder written with backslashes', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['docs/', 'C:/GitHub/Socialabs/docs/a.md'],
      ['./docs', 'C:/GitHub/Socialabs/docs/a.md'],
      ['docs\\adr', 'C:/GitHub/Socialabs/docs/adr/0001.md'],
    ];
    for (const [paper, file] of cases) {
      const context: LockContext = { projectRoot: root, paperPaths: [paper] };

      expect(decideToolUse(write(file), context).allow, paper).toBe(true);
      expect(decidePreCommit({ stagedPaths: [file.replace('C:/GitHub/Socialabs/', '')], context }).allow, paper).toBe(true);
    }
  });
});
