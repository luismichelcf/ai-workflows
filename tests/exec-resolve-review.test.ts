import { describe, expect, it } from 'vitest';

import { resolveExecutable, type ExecutableEnvironment } from '../src/index.js';

// Review of the part 3 fixes (13-sep-2026). What can be launched without a shell:
//   - `wsl` without `--exec` hands its arguments to the Linux shell, and cscript, wscript, mshta
//     and conhost run what they are given; all of them resolved as ordinary programs.
//   - An absolute path skipped every rule: `C:\WINDOWS\system32\cmd.exe` ran `echo uno & exit`.
//   - A shim in a shape nobody verified was still turned into `node <script>`, dropping flags or
//     changing the interpreter.

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

const shim = (...invocation: string[]) =>
  ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', ...invocation].join('\r\n');

const nodeShim = (script: string, prog: readonly string[] = ['  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%'], call = `"%_prog%"  "%dp0%\\${script}" %*`) =>
  shim('', 'IF EXIST "%dp0%\\node.exe" (', ...prog, ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${call}`);

const windows = (files: Record<string, string | true>, over: Partial<ExecutableEnvironment> = {}): ExecutableEnvironment => {
  const norm = (file: string) => file.replace(/\//g, '\\').toLowerCase();
  const table = new Map(Object.entries(files).map(([file, content]) => [norm(file), content]));
  return {
    platform: 'win32',
    path: `C:\\Windows\\System32;${NPM};C:\\tools`,
    pathExt: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1',
    nodePath: NODE,
    exists: (file) => table.has(norm(file)),
    readText: (file) => {
      const content = table.get(norm(file));
      return typeof content === 'string' ? content : undefined;
    },
    ...over,
  };
};

const posix = (files: readonly string[]): ExecutableEnvironment => ({
  platform: 'linux',
  path: '/usr/local/bin:/usr/bin:/bin',
  nodePath: '/usr/bin/node',
  exists: (file) => files.includes(file),
  readText: () => undefined,
});

describe('launchers that read their arguments again are refused like shells', () => {
  for (const name of ['wsl', 'wscript', 'cscript', 'mshta', 'conhost', 'bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']) {
    it(`refuses ${name}.exe found on the PATH`, () => {
      const result = resolveExecutable(name, windows({ [`C:\\Windows\\System32\\${name}.exe`]: true }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(name);
    });
  }

  it('refuses a shim whose target is wsl.exe', () => {
    const env = windows({
      [`${NPM}\\tool.cmd`]: shim('"%dp0%\\..\\..\\..\\..\\..\\Windows\\System32\\wsl.exe"   %*'),
      'C:\\Windows\\System32\\wsl.exe': true,
    });

    expect(resolveExecutable('tool', env).ok).toBe(false);
  });

  it('refuses a short 8.3 name, which may hide a shell such as POWERS~1', () => {
    expect(resolveExecutable('POWERS~1', windows({ 'C:\\Windows\\System32\\POWERS~1.EXE': true })).ok).toBe(false);
  });
});

describe('an absolute path follows the same rules as a name', () => {
  it('uses an absolute .exe that exists', () => {
    expect(resolveExecutable('C:\\tools\\rg.exe', windows({ 'C:\\tools\\rg.exe': true }))).toEqual({
      ok: true,
      command: 'C:\\tools\\rg.exe',
      prefixArgs: [],
    });
  });

  it('refuses an absolute path to cmd.exe or wsl.exe', () => {
    for (const file of ['C:\\WINDOWS\\system32\\cmd.exe', 'C:\\Windows\\System32\\wsl.exe']) {
      expect(resolveExecutable(file, windows({ [file]: true })).ok, file).toBe(false);
    }
  });

  it('reads an absolute .cmd shim and runs the program behind it', () => {
    const env = windows({
      [`${NPM}\\pnpm.cmd`]: nodeShim('node_modules\\pnpm\\bin\\pnpm.cjs'),
      [`${NPM}\\node_modules\\pnpm\\bin\\pnpm.cjs`]: true,
    });

    expect(resolveExecutable(`${NPM}\\pnpm.cmd`, env)).toEqual({
      ok: true,
      command: NODE,
      prefixArgs: [`${NPM}\\node_modules\\pnpm\\bin\\pnpm.cjs`],
    });
  });

  it('refuses an absolute .bat, .ps1, a file without extension, and one that does not exist', () => {
    const env = windows({ 'C:\\tools\\a.bat': 'echo', 'C:\\tools\\b.ps1': 'x', 'C:\\tools\\c': 'x' });

    for (const file of ['C:\\tools\\a.bat', 'C:\\tools\\b.ps1', 'C:\\tools\\c', 'C:\\tools\\missing.exe']) {
      expect(resolveExecutable(file, env).ok, file).toBe(false);
    }
  });

  it('POSIX: uses an absolute path that exists and refuses /bin/sh', () => {
    const env = posix(['/usr/local/bin/rg', '/bin/sh']);

    expect(resolveExecutable('/usr/local/bin/rg', env)).toEqual({ ok: true, command: '/usr/local/bin/rg', prefixArgs: [] });
    expect(resolveExecutable('/bin/sh', env).ok).toBe(false);
  });
});

describe('a shim in a shape nobody verified is not run', () => {
  it('refuses a shim that runs its script with another interpreter', () => {
    const env = windows({
      [`${NPM}\\tool.cmd`]: nodeShim('node_modules\\tool\\cli.js', ['  SET "_prog=%dp0%\\bun.exe"', ') ELSE (', '  SET "_prog=bun"']),
      [`${NPM}\\node_modules\\tool\\cli.js`]: true,
    });

    expect(resolveExecutable('tool', env).ok).toBe(false);
  });

  it('refuses a shim that passes its own flags to node', () => {
    const env = windows({
      [`${NPM}\\tool.cmd`]: nodeShim('node_modules\\tool\\cli.js', undefined, `"%_prog%" --smol "%dp0%\\node_modules\\tool\\cli.js" %*`),
      [`${NPM}\\node_modules\\tool\\cli.js`]: true,
    });

    expect(resolveExecutable('tool', env).ok).toBe(false);
  });

  it('refuses a shim that sets NODE_OPTIONS', () => {
    const content = nodeShim('node_modules\\tool\\cli.js').replace('SETLOCAL', 'SETLOCAL\r\nSET NODE_OPTIONS=--require "%dp0%\\hook.js"');
    const env = windows({ [`${NPM}\\tool.cmd`]: content, [`${NPM}\\node_modules\\tool\\cli.js`]: true });

    expect(resolveExecutable('tool', env).ok).toBe(false);
  });

  it('never returns the .cmd a shim points to', () => {
    const env = windows({
      [`${NPM}\\tool.cmd`]: shim('"%dp0%\\node_modules\\tool\\bin\\tool.cmd"   %*'),
      [`${NPM}\\node_modules\\tool\\bin\\tool.cmd`]: 'echo',
    });
    const result = resolveExecutable('tool', env);

    expect(result.ok).toBe(false);
  });

  it('refuses an Electron-style shim that pairs an exe with a script', () => {
    const env = windows({
      [`${NPM}\\app.cmd`]: shim('"%dp0%\\node_modules\\electron\\dist\\electron.exe" "%dp0%\\node_modules\\app\\main.js" %*'),
      [`${NPM}\\node_modules\\electron\\dist\\electron.exe`]: true,
      [`${NPM}\\node_modules\\app\\main.js`]: true,
    });

    expect(resolveExecutable('app', env).ok).toBe(false);
  });
});

describe('a PATH written the way Windows really writes it', () => {
  it('reads a quoted PATH entry', () => {
    const env = windows({ 'C:\\Program Files\\Tool\\rg.exe': true }, { path: `"C:\\Program Files\\Tool";${NPM}` });

    expect(resolveExecutable('rg', env)).toEqual({ ok: true, command: 'C:\\Program Files\\Tool\\rg.exe', prefixArgs: [] });
  });

  it('skips a relative PATH entry instead of returning a relative path', () => {
    const env = windows({ '.\\bin\\rg.exe': true, 'C:\\tools\\rg.exe': true }, { path: '.\\bin;C:\\tools' });

    expect(resolveExecutable('rg', env)).toEqual({ ok: true, command: 'C:\\tools\\rg.exe', prefixArgs: [] });
  });
});
