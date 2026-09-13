import { describe, expect, it } from 'vitest';

import { resolveExecutable, type ExecutableEnvironment } from '../src/index.js';

// Second review of the part 3 fixes (13-sep-2026):
//   - Other launchers still resolved on the owner's PATH: `env`, `forfiles` (which runs cmd by
//     itself), `rundll32`, `mintty` and `git-bash.exe`.
//   - Shim shapes that slipped through: `SET _prog=…bun.exe` without quotes, the IF and the SET
//     on one line, and `SET "NODE_OPTIONS=…"` with quotes.
//   - A Node script named like a shell (`dash.js`) was refused for no reason.
//   - A quoted PATH entry holding a semicolon was split in two.
//   - Nine mutations survived; the cases below pin each rule they removed.

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

const shim = (...lines: string[]) =>
  ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', ...lines].join('\r\n');

const standardProg = ['IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')'];
const call = (script: string) => `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`;

const windows = (files: Record<string, string | true>, over: Partial<ExecutableEnvironment> = {}): ExecutableEnvironment => {
  const norm = (file: string) => file.replace(/\//g, '\\').toLowerCase();
  const table = new Map(Object.entries(files).map(([file, content]) => [norm(file), content]));
  return {
    platform: 'win32',
    path: `C:\\Windows\\System32;${NPM};C:\\Program Files\\Git\\usr\\bin`,
    pathExt: '.COM;.EXE;.BAT;.CMD',
    nodePath: NODE,
    exists: (file) => table.has(norm(file)),
    readText: (file) => {
      const content = table.get(norm(file));
      return typeof content === 'string' ? content : undefined;
    },
    ...over,
  };
};

describe('more launchers are refused', () => {
  for (const name of ['dash', 'ksh', 'csh', 'tcsh', 'fish', 'env', 'forfiles', 'rundll32', 'mintty', 'git-bash']) {
    it(`refuses ${name}`, () => {
      const env = windows({ [`C:\\Windows\\System32\\${name}.exe`]: true });

      expect(resolveExecutable(name, env).ok).toBe(false);
    });
  }

  it('refuses git-bash.exe by absolute path', () => {
    const file = 'C:\\Program Files\\Git\\git-bash.exe';

    expect(resolveExecutable(file, windows({ [file]: true })).ok).toBe(false);
  });
});

describe('shim shapes that set another interpreter or options are refused', () => {
  const script = 'node_modules\\tool\\cli.js';
  const target = { [`${NPM}\\node_modules\\tool\\cli.js`]: true } as const;

  it('refuses SET _prog without quotes', () => {
    const content = shim('SET _prog=%dp0%\\bun.exe', call(script));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, ...target })).ok).toBe(false);
  });

  it('refuses the IF and the SET of _prog on one line', () => {
    const content = shim('IF EXIST "%dp0%\\bun.exe" SET "_prog=%dp0%\\bun.exe"', ...standardProg, call(script));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, ...target })).ok).toBe(false);
  });

  it('refuses SET "NODE_OPTIONS=..." with quotes', () => {
    const content = shim('SET "NODE_OPTIONS=--require %dp0%\\hook.js"', ...standardProg, call(script));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, ...target })).ok).toBe(false);
  });

  it('refuses a node shim that never sets _prog', () => {
    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: shim(call(script)), ...target })).ok).toBe(false);
  });

  it('refuses a shim where only one of the _prog values is node', () => {
    const content = shim('IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=bun"', ')', call(script));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, ...target })).ok).toBe(false);
  });

  it('refuses a shim with two lines that forward %*', () => {
    const content = shim(...standardProg, call(script), call(script));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, ...target })).ok).toBe(false);
  });

  it('refuses a script that is not a Node script', () => {
    const content = shim(...standardProg, call('node_modules\\tool\\cli.ps1'));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, [`${NPM}\\node_modules\\tool\\cli.ps1`]: true })).ok).toBe(false);
  });

  it('refuses a shim whose target hides behind a short 8.3 folder name', () => {
    const content = shim(...standardProg, call('NODE_M~1\\tool\\cli.js'));

    expect(resolveExecutable('tool', windows({ [`${NPM}\\tool.cmd`]: content, [`${NPM}\\NODE_M~1\\tool\\cli.js`]: true })).ok).toBe(false);
  });
});

describe('what is legitimate is not refused', () => {
  it('resolves a Node script that happens to be called dash.js', () => {
    const content = shim(...standardProg, call('node_modules\\dash\\bin\\dash.js'));
    const env = windows({ [`${NPM}\\dash-tool.cmd`]: content, [`${NPM}\\node_modules\\dash\\bin\\dash.js`]: true });

    expect(resolveExecutable('dash-tool', env)).toEqual({ ok: true, command: NODE, prefixArgs: [`${NPM}\\node_modules\\dash\\bin\\dash.js`] });
  });

  it('uses an absolute .com that exists', () => {
    expect(resolveExecutable('C:\\tools\\more.com', windows({ 'C:\\tools\\more.com': true }))).toEqual({ ok: true, command: 'C:\\tools\\more.com', prefixArgs: [] });
  });

  it('refuses an absolute path with a short 8.3 name', () => {
    expect(resolveExecutable('C:\\tools\\RIPGRE~1.EXE', windows({ 'C:\\tools\\RIPGRE~1.EXE': true })).ok).toBe(false);
  });

  it('uses an absolute .exe on a network share', () => {
    const file = '\\\\srv\\share\\tools\\rg.exe';

    expect(resolveExecutable(file, windows({ [file]: true }))).toEqual({ ok: true, command: file, prefixArgs: [] });
  });

  it('keeps a quoted PATH entry that holds a semicolon as one folder', () => {
    const env = windows({ 'C:\\a;b\\rg.exe': true, 'C:\\a\\rg.exe': true }, { path: '"C:\\a;b";C:\\tools' });

    expect(resolveExecutable('rg', env)).toEqual({ ok: true, command: 'C:\\a;b\\rg.exe', prefixArgs: [] });
  });
});
