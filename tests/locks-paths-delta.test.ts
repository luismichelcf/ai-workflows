import { describe, expect, it } from 'vitest';

import { decidePreCommit, decideToolUse, type HookInput, type LockContext } from '../src/index.js';

// Review of the part 4 fixes (13-sep-2026). Each spelling was written to disk on the owner's
// machine with Node, Python and .NET: Windows completes a path rooted at `\` with the current
// drive, and drops a dot or a space at the end of a folder name.

const root = 'C:\\GitHub\\Socialabs';
const noPiece: LockContext = { projectRoot: root, paperPaths: ['docs'] };

const write = (file: string, cwd: string = root): HookInput => ({
  toolName: 'Write',
  toolInput: { file_path: file, content: 'x' },
  cwd,
});

const patch = (file: string): HookInput => ({
  toolName: 'apply_patch',
  toolInput: { command: `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch` },
  cwd: root,
});

describe('a path rooted at the current drive is still on that drive', () => {
  for (const file of ['\\GitHub\\Socialabs\\src\\a.ts', '/GitHub/Socialabs/src/a.ts']) {
    it(`refuses code at ${file}`, () => {
      expect(decideToolUse(write(file), noPiece).allow).toBe(false);
    });
  }

  it('refuses it in a Codex patch too', () => {
    expect(decideToolUse(patch('/GitHub/Socialabs/src/evil.ts'), noPiece).allow).toBe(false);
  });
});

describe('a folder name ending in a dot or a space is the same folder to Windows', () => {
  for (const file of [
    'C:\\GitHub\\Socialabs.\\src\\a.ts',
    '\\\\.\\C:\\GitHub\\Socialabs.\\src\\a.ts',
    '//./C:/GitHub/Socialabs./src/a.ts',
    '..\\Socialabs.\\src\\a.ts',
    'C:\\GitHub\\Socialabs \\src\\a.ts',
  ]) {
    it(`refuses code at ${file}`, () => {
      expect(decideToolUse(write(file), noPiece).allow).toBe(false);
    });
  }

  it('refuses it in a Codex patch too', () => {
    expect(decideToolUse(patch('../Socialabs./src/evil.ts'), noPiece).allow).toBe(false);
  });
});

describe('a short name only hides a folder, not a file name', () => {
  it('allows a paper whose own file name has a tilde and a digit', () => {
    expect(decideToolUse(write('C:\\GitHub\\Socialabs\\docs\\notas~1.md'), noPiece).allow).toBe(true);
    expect(decidePreCommit({ stagedPaths: ['docs/notas~1.md'], context: noPiece }).allow).toBe(true);
  });

  it('still refuses a short name in a folder', () => {
    expect(decideToolUse(write('C:\\GitHub\\SOCIAL~1\\docs\\a.md'), noPiece).allow).toBe(false);
  });
});

describe('a reduced spelling lets a paper through, not only refuses code', () => {
  for (const file of [
    '\\\\.\\C:\\GitHub\\Socialabs\\docs\\a.md',
    '\\\\127.0.0.1\\C$\\GitHub\\Socialabs\\docs\\a.md',
    '\\\\localhost\\C$\\GitHub\\Socialabs\\docs\\a.md',
    '//?/c:/github/socialabs/DOCS/a.md',
  ]) {
    it(`allows a paper at ${file}`, () => {
      expect(decideToolUse(write(file), noPiece).allow).toBe(true);
    });
  }
});

describe('on POSIX, case is part of the name', () => {
  const context: LockContext = { projectRoot: '/home/luis/proj', paperPaths: ['docs'] };
  const posixWrite = (file: string): HookInput => ({ toolName: 'Write', toolInput: { file_path: file, content: 'x' }, cwd: '/home/luis/proj' });

  it('treats /home/luis/Proj as a folder other than the project', () => {
    expect(decideToolUse(posixWrite('/home/luis/Proj/src/a.ts'), context).allow).toBe(true);
    expect(decideToolUse(posixWrite('/home/luis/proj/src/a.ts'), context).allow).toBe(false);
  });
});

describe('pre-commit reads staged names exactly as git gave them', () => {
  it('refuses a staged path it cannot read', () => {
    expect(decidePreCommit({ stagedPaths: ['docs/a.md:oculto'], context: noPiece }).allow).toBe(false);
  });

  it('does not trim a staged name: " docs" is another folder', () => {
    expect(decidePreCommit({ stagedPaths: [' docs/a.md'], context: noPiece }).allow).toBe(false);
  });
});
