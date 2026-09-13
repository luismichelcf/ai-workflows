import { describe, expect, it } from 'vitest';

import { parseTestRun, resolveExecutable, type ExecutableEnvironment } from '../src/index.js';

// Final review of part 3 (13-sep-2026):
//   - The start-of-line pattern `^[^\S\n]*` still took the square of the input when the output
//     was only whitespace broken by carriage returns or U+2028: 80 KB of `\r` took 17 s. Progress
//     bars print exactly that. `^[ \t]*` reads the same lines in linear time.
//   - A shim in a PATH folder written as a short name was refused, because its target inherited
//     the short folder; another program further down the PATH won silently.

describe('reading a run full of carriage returns stays linear', () => {
  for (const [name, output] of [
    ['80 KB of carriage returns', '\r'.repeat(80_000)],
    ['320 KB of carriage return and spaces', `\r${' '.repeat(80)}`.repeat(4000)],
    ['80 KB of U+2028', '\u2028'.repeat(80_000)],
  ] as const) {
    it(`parses ${name} quickly`, () => {
      const started = Date.now();
      parseTestRun({ output: `${output}\n Tests  1 passed (1)\n`, exitCode: 0 });

      expect(Date.now() - started).toBeLessThan(2000);
    });
  }

  it('still reads the summary, FAIL and Errors lines it read before', () => {
    const summary = parseTestRun({ output: ' FAIL  t/a.test.ts > x\nAssertionError: 1\n Tests  1 failed | 2 passed (3)\n', exitCode: 1 });

    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(2);
    expect(summary.failures.length).toBeGreaterThan(0);
  });
});

describe('a shim in a PATH folder written as a short name', () => {
  const NPM = 'C:\\PROGRA~1\\npm';
  const shim = [
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
  const script = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;

  const env = (path: string): ExecutableEnvironment => {
    const files = new Map<string, string | true>([
      [`${NPM}\\codex.cmd`.toLowerCase(), shim],
      [script.toLowerCase(), true],
      ['c:\\tools\\codex.exe', true],
    ]);
    return {
      platform: 'win32',
      path,
      pathExt: '.COM;.EXE;.BAT;.CMD',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      exists: (file) => files.has(file.replace(/\//g, '\\').toLowerCase()),
      readText: (file) => {
        const content = files.get(file.replace(/\//g, '\\').toLowerCase());
        return typeof content === 'string' ? content : undefined;
      },
    };
  };

  it('resolves the shim by name instead of letting a later folder win', () => {
    expect(resolveExecutable('codex', env(`${NPM};C:\\tools`))).toEqual({
      ok: true,
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: [script],
    });
  });

  it('resolves the shim by its absolute path', () => {
    expect(resolveExecutable(`${NPM}\\codex.cmd`, env('C:\\tools')).ok).toBe(true);
  });
});
