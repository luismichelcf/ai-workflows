import { describe, expect, it } from 'vitest';

import { detectProvider, resolveExecutable, type ExecutableEnvironment, type RawRun } from '../src/index.js';

// Third review of the part 3 fixes (13-sep-2026):
//   - A PATH folder written as an 8.3 short name (`C:\PROGRA~1\nodejs`) was skipped, so `node`
//     was not found, or another program further down the PATH silently won. The folder named in
//     PATH is what it is; only a short name for the program itself, or inside a shim's target,
//     hides which program runs.
//   - A model line with a note after it (`openai/gpt-5 (deprecated)`) must not be listed.

const windows = (files: Record<string, true>, path: string): ExecutableEnvironment => {
  const norm = (file: string) => file.replace(/\//g, '\\').toLowerCase();
  const table = new Set(Object.keys(files).map(norm));
  return {
    platform: 'win32',
    path,
    pathExt: '.COM;.EXE;.BAT;.CMD',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    exists: (file) => table.has(norm(file)),
    readText: () => undefined,
  };
};

describe('a PATH folder written as a short name is still that folder', () => {
  it('finds node in C:\\PROGRA~1\\nodejs', () => {
    const env = windows({ 'C:\\PROGRA~1\\nodejs\\node.exe': true }, 'C:\\PROGRA~1\\nodejs;C:\\tools');

    expect(resolveExecutable('node', env)).toEqual({ ok: true, command: 'C:\\PROGRA~1\\nodejs\\node.exe', prefixArgs: [] });
  });

  it('does not let a program further down the PATH win over the one in the short-named folder', () => {
    const env = windows({ 'C:\\PROGRA~1\\Git\\cmd\\tig.exe': true, 'C:\\Program Files\\Git\\usr\\bin\\tig.exe': true }, 'C:\\PROGRA~1\\Git\\cmd;C:\\Program Files\\Git\\usr\\bin');

    expect(resolveExecutable('tig', env)).toEqual({ ok: true, command: 'C:\\PROGRA~1\\Git\\cmd\\tig.exe', prefixArgs: [] });
  });

  it('still refuses a short name for the program itself', () => {
    const env = windows({ 'C:\\tools\\POWERS~1.EXE': true }, 'C:\\tools');

    expect(resolveExecutable('POWERS~1', env).ok).toBe(false);
  });
});

describe('a model line is only the model', () => {
  it('does not list a model with a note after it', async () => {
    const answers: Record<string, RawRun> = {
      'opencode --version': { output: '1.18.30', exitCode: 0 },
      'opencode models': { output: 'openai/gpt-5 (deprecated)\ndeepseek/deepseek-flash', exitCode: 0 },
      'opencode auth list': { output: '└  1 credentials', exitCode: 0 },
    };
    const detection = await detectProvider('opencode', async (command, args) => answers[[command, ...args].join(' ')] ?? { output: '', exitCode: null });

    expect(detection.models).toEqual(['deepseek/deepseek-flash']);
  });
});
