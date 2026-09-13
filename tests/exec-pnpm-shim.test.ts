import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutable, runGateCommand, type ExecutableEnvironment } from '../src/index.js';

// First run on GitHub's Windows runner (13-sep-2026): pnpm was installed by pnpm itself, and its
// `node_modules/.bin/pnpm.CMD` has a third shape — the one pnpm writes for every bin in every
// project. It uses `%~dp0`, forwards `%*` on two lines (with and without a local node.exe), and
// sets NODE_PATH so the script finds its dependencies. The engine refused it, so it could not run
// `pnpm`, `vitest` or `tsc` from a pnpm project on Windows. The text below is that file.

const BIN = 'C:\\Users\\runneradmin\\setup-pnpm\\node_modules\\.bin';
const STORE = 'C:\\Users\\runneradmin\\setup-pnpm\\node_modules\\.pnpm';
const NODE_PATH_VALUE = `${STORE}\\pnpm@10.34.5\\node_modules\\pnpm\\bin\\node_modules;${STORE}\\pnpm@10.34.5\\node_modules\\pnpm\\node_modules;${STORE}\\pnpm@10.34.5\\node_modules;${STORE}\\node_modules`;

const PNPM_SHIM = [
  '@SETLOCAL',
  '@IF NOT DEFINED NODE_PATH (',
  `  @SET "NODE_PATH=${NODE_PATH_VALUE}"`,
  ') ELSE (',
  `  @SET "NODE_PATH=${NODE_PATH_VALUE};%NODE_PATH%"`,
  ')',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\pnpm\\bin\\pnpm.cjs" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\pnpm\\bin\\pnpm.cjs" %*',
  ')',
].join('\r\n');

const SCRIPT = 'C:\\Users\\runneradmin\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs';
const NODE = 'C:\\hostedtoolcache\\windows\\node\\22.23.2\\x64\\node.exe';

const windows = (files: Record<string, string | true>): ExecutableEnvironment => {
  const norm = (file: string) => file.replace(/\//g, '\\').toLowerCase();
  const table = new Map(Object.entries(files).map(([file, content]) => [norm(file), content]));
  return {
    platform: 'win32',
    path: `C:\\Program Files\\PowerShell\\7;${BIN}`,
    pathExt: '.COM;.EXE;.BAT;.CMD',
    nodePath: NODE,
    exists: (file) => table.has(norm(file)),
    readText: (file) => {
      const content = table.get(norm(file));
      return typeof content === 'string' ? content : undefined;
    },
  };
};

describe('the shim pnpm writes for its own bins', () => {
  it('resolves to node with the script, carrying the NODE_PATH the shim sets', () => {
    const env = windows({ [`${BIN}\\pnpm.CMD`]: PNPM_SHIM, [SCRIPT]: true });

    expect(resolveExecutable('pnpm', env)).toEqual({
      ok: true,
      command: NODE,
      prefixArgs: [SCRIPT],
      env: { NODE_PATH: NODE_PATH_VALUE },
    });
  });

  it('uses the node.exe next to the shim when there is one', () => {
    const env = windows({ [`${BIN}\\pnpm.CMD`]: PNPM_SHIM, [SCRIPT]: true, [`${BIN}\\node.exe`]: true });
    const result = resolveExecutable('pnpm', env);

    expect(result.ok && result.command).toBe(`${BIN}\\node.exe`);
  });

  it('refuses the shape when its two invocations run different scripts', () => {
    const tampered = PNPM_SHIM.replace('node  "%~dp0\\..\\pnpm\\bin\\pnpm.cjs" %*', 'node  "%~dp0\\..\\otro\\bin\\otro.cjs" %*');
    const env = windows({ [`${BIN}\\pnpm.CMD`]: tampered, [SCRIPT]: true, [`${BIN}\\..\\otro\\bin\\otro.cjs`]: true });

    expect(resolveExecutable('pnpm', env).ok).toBe(false);
  });

  it('refuses the shape when it also sets NODE_OPTIONS', () => {
    const tampered = PNPM_SHIM.replace('@SETLOCAL', '@SETLOCAL\r\n@SET "NODE_OPTIONS=--require %~dp0\\hook.js"');
    const env = windows({ [`${BIN}\\pnpm.CMD`]: tampered, [SCRIPT]: true });

    expect(resolveExecutable('pnpm', env).ok).toBe(false);
  });

  it('refuses the shape when an invocation runs something other than node', () => {
    const tampered = PNPM_SHIM.replace('node  "%~dp0\\..\\pnpm\\bin\\pnpm.cjs" %*', 'bun  "%~dp0\\..\\pnpm\\bin\\pnpm.cjs" %*');
    const env = windows({ [`${BIN}\\pnpm.CMD`]: tampered, [SCRIPT]: true });

    expect(resolveExecutable('pnpm', env).ok).toBe(false);
  });

  it('keeps resolving the npm shim shape without any env', () => {
    const npmShim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*',
    ].join('\r\n');
    const env = windows({ [`${BIN}\\tool.cmd`]: npmShim, [`${BIN}\\node_modules\\tool\\cli.js`]: true });
    const result = resolveExecutable('tool', env);

    expect(result.ok).toBe(true);
    expect(result.ok && 'env' in result).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('running a pnpm-shaped shim for real', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('hands the NODE_PATH the shim sets to the program it runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiw-pnpm-shim-'));
    dirs.push(root);
    const bin = join(root, 'node_modules', '.bin');
    const toolBin = join(root, 'node_modules', 'tool', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(toolBin, { recursive: true });
    writeFileSync(join(toolBin, 'tool.cjs'), "process.stdout.write('NODE_PATH=' + (process.env.NODE_PATH || '') + '\\n');\n");
    writeFileSync(
      join(bin, 'tool.CMD'),
      PNPM_SHIM.replaceAll(NODE_PATH_VALUE, 'C:\\ruta\\de\\prueba').replaceAll('..\\pnpm\\bin\\pnpm.cjs', '..\\tool\\bin\\tool.cjs'),
    );

    let seen = '';
    const result = await runGateCommand({
      command: join(bin, 'tool.CMD'),
      args: [],
      timeoutMs: 30_000,
      interpret: (run) => {
        seen = run.output;
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(seen).toContain('NODE_PATH=C:\\ruta\\de\\prueba');
  }, 40_000);
});
