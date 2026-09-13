import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { resolveExecutable, type ExecutableEnvironment } from '../src/index.js';

// Finding the real program behind a command name without a shell. The shim contents below
// are copied from the real files npm installed on the owner's machine (read 13-sep-2026).

const NODE_SCRIPT_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

const DIRECT_EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
].join('\r\n');

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

/** A fake Windows machine: the files that exist and what some of them contain. */
const windows = (files: Record<string, string | true>, over: Partial<ExecutableEnvironment> = {}): ExecutableEnvironment => {
  const norm = (file: string) => file.replace(/\//g, '\\').toLowerCase();
  const table = new Map(Object.entries(files).map(([file, content]) => [norm(file), content]));
  return {
    platform: 'win32',
    path: `C:\\Windows\\System32;${NPM};C:\\Users\\u\\.local\\bin`,
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

const shells = /(^|[\\/])(cmd|powershell|pwsh|bash|sh)(\.exe)?$/i;

describe('a real executable on the PATH', () => {
  it('uses an .exe directly', () => {
    const env = windows({ 'C:\\Users\\u\\.local\\bin\\claude.exe': true });

    expect(resolveExecutable('claude', env)).toEqual({
      ok: true,
      command: 'C:\\Users\\u\\.local\\bin\\claude.exe',
      prefixArgs: [],
    });
  });

  it('takes the first match along the PATH', () => {
    const env = windows({
      [`${NPM}\\tool.exe`]: true,
      'C:\\Users\\u\\.local\\bin\\tool.exe': true,
    });

    expect(resolveExecutable('tool', env)).toMatchObject({ ok: true, command: `${NPM}\\tool.exe` });
  });
});

describe('an npm shim that runs a Node script', () => {
  it('runs the script with node, without the shim', () => {
    const env = windows({
      [`${NPM}\\codex.cmd`]: NODE_SCRIPT_SHIM,
      [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: true,
    });

    expect(resolveExecutable('codex', env)).toEqual({
      ok: true,
      command: NODE,
      prefixArgs: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`],
    });
  });

  it('prefers the node.exe that sits next to the shim, as the shim itself does', () => {
    const env = windows({
      [`${NPM}\\codex.cmd`]: NODE_SCRIPT_SHIM,
      [`${NPM}\\node.exe`]: true,
      [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: true,
    });

    expect(resolveExecutable('codex', env)).toMatchObject({ ok: true, command: `${NPM}\\node.exe` });
  });

  it('refuses when the script the shim points to is missing', () => {
    const env = windows({ [`${NPM}\\codex.cmd`]: NODE_SCRIPT_SHIM });

    expect(resolveExecutable('codex', env).ok).toBe(false);
  });
});

describe('an npm shim that runs an .exe', () => {
  it('runs the .exe directly', () => {
    const env = windows({
      [`${NPM}\\opencode.cmd`]: DIRECT_EXE_SHIM,
      [`${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`]: true,
    });

    expect(resolveExecutable('opencode', env)).toEqual({
      ok: true,
      command: `${NPM}\\node_modules\\opencode-ai\\bin\\opencode.exe`,
      prefixArgs: [],
    });
  });
});

describe('never a shell', () => {
  it('does not return a .cmd it cannot read through', () => {
    const env = windows({ [`${NPM}\\raro.cmd`]: '@echo off\r\ncall algo-desconocido %*' });

    const result = resolveExecutable('raro', env);

    expect(result.ok).toBe(false);
  });

  it('does not return a .bat or a .ps1', () => {
    const env = windows({ [`${NPM}\\x.bat`]: '@echo off', [`${NPM}\\y.ps1`]: 'Write-Host hi' });

    expect(resolveExecutable('x', env).ok).toBe(false);
    expect(resolveExecutable('y', env).ok).toBe(false);
  });

  it('does not return the extensionless sh script npm leaves for Git Bash', () => {
    const env = windows({ [`${NPM}\\codex`]: '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"' });

    expect(resolveExecutable('codex', env).ok).toBe(false);
  });

  it('never resolves to a shell program, whatever the shim says', () => {
    const env = windows({
      [`${NPM}\\sneaky.cmd`]: '"%dp0%\\..\\..\\Windows\\System32\\cmd.exe" /c %*',
      'C:\\Users\\u\\AppData\\Windows\\System32\\cmd.exe': true,
    });

    const result = resolveExecutable('sneaky', env);

    expect(result.ok && shells.test(result.command)).not.toBe(true);
  });

  it('says why when it cannot resolve, in words', () => {
    const result = resolveExecutable('no-existe', windows({}));

    expect(result.ok === false && result.reason).toContain('no-existe');
  });
});

describe('on POSIX', () => {
  const posix = (files: string[]): ExecutableEnvironment => ({
    platform: 'linux',
    path: '/usr/local/bin:/usr/bin',
    nodePath: '/usr/bin/node',
    exists: (file) => files.includes(file),
    readText: () => undefined,
  });

  it('returns the first match on the PATH', () => {
    expect(resolveExecutable('codex', posix(['/usr/bin/codex']))).toEqual({
      ok: true,
      command: '/usr/bin/codex',
      prefixArgs: [],
    });
  });

  it('refuses a name that is not on the PATH', () => {
    expect(resolveExecutable('codex', posix([])).ok).toBe(false);
  });
});

describe('on this machine, for real', () => {
  // Pure tests prove the rules; this proves they work where the engine actually runs.
  it.runIf(process.platform === 'win32')('finds pnpm and runs it without a shell', async () => {
    const fs = await import('node:fs');
    const env: ExecutableEnvironment = {
      platform: process.platform,
      path: process.env.PATH ?? process.env.Path ?? '',
      ...(process.env.PATHEXT === undefined ? {} : { pathExt: process.env.PATHEXT }),
      nodePath: process.execPath,
      exists: (file) => fs.existsSync(file),
      readText: (file) => {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch {
          return undefined;
        }
      },
    };

    const resolved = resolveExecutable('pnpm', env);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const result = spawnSync(resolved.command, [...resolved.prefixArgs, '--version'], {
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
