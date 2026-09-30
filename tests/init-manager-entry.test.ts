import { EventEmitter } from 'node:events';
import { chmodSync, existsSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recipeCommand } from '../src/index.js';

import { emptyFolder, removeRepositories, repository, write } from './git-fixtures.js';

// Delta review of the flock fixes (PLAN-13-R6 §15, «init … lanza el instalador sin consola
// intermedia»), finding B2: on Windows the package manager is started as `node <its JS entry>`.
// The entry must be the DETECTED manager's, never another one's:
//   - npm's entry is `npm-cli.js` (`<dir on PATH>/node_modules/npm/bin/npm-cli.js`, and also
//     `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`, where Node's installer puts it);
//   - pnpm's is `pnpm.cjs` (`…/node_modules/pnpm/bin/pnpm.cjs`);
//   - yarn classic's is `yarn.js` (`…/node_modules/yarn/bin/yarn.js`).
//   `npm_execpath` (set by whichever manager started this process) is used only when its file
//   name is the detected manager's entry. When no entry is found, init fails honestly naming the
//   manager; it never starts another manager in its place.
//
// The seam is `spawnProcess` (§15). The platform is stubbed to win32 and PATH/npm_execpath are
// stubbed, so the test runs the same on Windows and Linux. The fake spawn behaves like Windows
// without a shell: `node <script>` runs when the script exists; a bare program name that is not a
// file fails with ENOENT.

afterEach(removeRepositories);

const SEAL = { version: '1.2.3', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } as const;
const PACKAGE_JSON = `${JSON.stringify({ name: 'app', version: '0.0.0', private: true }, null, 2)}\n`;

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.unstubAllEnvs();
});

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
}

/** A spawn that acts like Windows without a shell, and leaves the sealed engine on success. */
function fakeSpawn(root: string) {
  const spawned: Spawned[] = [];
  const spawnProcess = (command: string, args: readonly string[]) => {
    spawned.push({ command, args: [...args] });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: null, pid: 4242, kill: () => true });
    const runnable = command === process.execPath && typeof args[0] === 'string' && existsSync(args[0]);
    setImmediate(() => {
      if (!runnable) {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
        return;
      }
      write(root, 'node_modules/ai-workflows/package.json', `${JSON.stringify({ name: 'ai-workflows', version: SEAL.version })}\n`);
      write(root, 'node_modules/ai-workflows/engine.json', `${JSON.stringify(SEAL)}\n`);
      stdout.end();
      stderr.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child as never;
  };
  return { spawned, spawnProcess };
}

/** A folder holding `node_modules/<manager>/bin/<entry>`, as a global install leaves it. */
function globalEntry(manager: string, entry: string): { dir: string; file: string } {
  const dir = emptyFolder();
  const file = join(dir, 'node_modules', manager, 'bin', entry);
  write(dir, join('node_modules', manager, 'bin', entry), '// entry\n');
  return { dir, file };
}

const scriptOf = (call: Spawned | undefined): string => (call !== undefined && call.command === process.execPath ? basename(call.args[0] ?? '') : '');

describe('B2: npm_execpath is used only when it is the detected manager', () => {
  for (const [lock, manager, entry] of [
    ['package-lock.json', 'npm', 'npm-cli.js'],
    ['yarn.lock', 'yarn', 'yarn.js'],
  ] as const) {
    it(`${lock} with npm_execpath pointing at pnpm.cjs: pnpm is never started; ${entry} or an honest failure naming ${manager}`, async () => {
      const root = repository({ 'package.json': PACKAGE_JSON, [lock]: '\n' });
      const pnpm = globalEntry('pnpm', 'pnpm.cjs');
      expect(existsSync(pnpm.file)).toBe(true);
      vi.stubEnv('npm_execpath', pnpm.file);
      vi.stubEnv('PATH', emptyFolder());
      const { spawned, spawnProcess } = fakeSpawn(root);

      const output = await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });

      for (const call of spawned) {
        expect([call.command, ...call.args].map((part) => basename(part)).join(' '), 'another manager started in place of the detected one').not.toMatch(/pnpm/i);
      }
      const launched = spawned.filter((call) => scriptOf(call) !== '');
      if (launched.length > 0) {
        expect(launched.map(scriptOf)).toEqual([entry]);
      } else {
        expect(output.ok, output.text).toBe(false);
        expect(output.text).toContain(manager);
      }
    });
  }
});

describe('B2: the entry of npm is npm-cli.js', () => {
  it('package-lock.json, npm-cli.js under a folder of PATH, no npm_execpath: node runs npm-cli.js install', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'package-lock.json': '\n' });
    const npm = globalEntry('npm', 'npm-cli.js');
    vi.stubEnv('npm_execpath', '');
    vi.stubEnv('PATH', npm.dir);
    const { spawned, spawnProcess } = fakeSpawn(root);

    // PATH holds only the fake global folder, so git (and the hooks step) is out of reach: only
    // the install step is looked at.
    await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });

    expect(spawned.map(scriptOf)).toEqual(['npm-cli.js']);
    expect(spawned[0]?.args).toContain('install');
  });

  // Guard: it passes today and must keep passing.
  it('package-lock.json with npm_execpath pointing at npm-cli.js: that script runs', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'package-lock.json': '\n' });
    const npm = globalEntry('npm', 'npm-cli.js');
    vi.stubEnv('npm_execpath', npm.file);
    vi.stubEnv('PATH', emptyFolder());
    const { spawned, spawnProcess } = fakeSpawn(root);

    // PATH holds only the fake global folder, so git (and the hooks step) is out of reach: only
    // the install step is looked at.
    await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });

    expect(spawned).toEqual([{ command: process.execPath, args: [npm.file, 'install'] }]);
  });
});

// Second delta review of the flock fixes, finding N2: a relative folder on PATH (`.`, or any path
// that is not absolute) is resolved against the folder init runs in, which is the project. A
// project that carries `node_modules/pnpm/bin/pnpm.cjs` would then have its own file run as the
// installer. Interface: only absolute PATH entries are searched for the manager's entry; a
// relative one is skipped. Here PATH is `.;<a real global pnpm>` and the process runs in the
// project, as init does.
describe('N2: a relative folder on PATH never makes init run a file of the project', () => {
  it('pnpm-lock.yaml, PATH=".;<global>", the project holds node_modules/pnpm/bin/pnpm.cjs: the project file is never run', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
    write(root, 'node_modules/pnpm/bin/pnpm.cjs', '// the project s own file\n');
    const pnpm = globalEntry('pnpm', 'pnpm.cjs');
    vi.stubEnv('npm_execpath', '');
    vi.stubEnv('PATH', `.;${pnpm.dir}`);
    const { spawned, spawnProcess } = fakeSpawn(root);

    const before = process.cwd();
    process.chdir(root);
    try {
      await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });
    } finally {
      process.chdir(before);
    }

    const scripts = spawned.filter((call) => scriptOf(call) !== '').map((call) => resolve(root, call.args[0] ?? ''));
    expect(scripts.filter((script) => script.toLowerCase().startsWith(resolve(root).toLowerCase())), 'a file of the project ran as the installer').toEqual([]);
    // The global pnpm is still found through the absolute folder of PATH.
    expect(spawned.filter((call) => scriptOf(call) !== '').map((call) => [isAbsolute(call.args[0] ?? ''), scriptOf(call)])).toEqual([[true, 'pnpm.cjs']]);
  });
});

// Third delta review (PLAN-13-R6 §15, last paragraph): «init nunca busca el gestor en la carpeta del
// proyecto ni lanza uno por nombre sin ruta absoluta». Today, when no JS entry is found on Windows,
// init falls back to spawning the bare name `pnpm`; without a shell, Windows looks for `pnpm.exe` in
// the current folder first, which is the project, so a project carrying `pnpm.exe` at its root would
// have that file run as the installer. On POSIX init always spawns the bare name.
//
// Interface these tests fix (the seam is still `spawnProcess`):
//  - Windows: only `node <absolute entry>` is ever spawned (the entry found as B2/N2 fix); when no
//    entry is found, nothing is spawned and init fails honestly naming the manager.
//  - POSIX: the manager is spawned only by an ABSOLUTE path, `<absolute PATH folder>/<manager>`,
//    found in an absolute entry of PATH (split with `path.delimiter`); relative entries are skipped.
//    When none is found, nothing is spawned and init fails honestly naming the manager.
//  - In both, nothing under the project folder is ever spawned or run as the installer.

/** Whether `file` lies in `folder` (compared case-insensitively, as Windows does). */
const inside = (folder: string, file: string): boolean => {
  const base = resolve(folder).toLowerCase();
  const target = resolve(folder, file).toLowerCase();
  return target === base || target.startsWith(`${base}${sep}`);
};

/** A spawn that runs `node <existing script>` or an absolute existing program, like the OS would. */
function fakeSpawnAbsolute(root: string) {
  const spawned: Spawned[] = [];
  const spawnProcess = (command: string, args: readonly string[]) => {
    spawned.push({ command, args: [...args] });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: null, pid: 4243, kill: () => true });
    const runnable =
      (command === process.execPath && typeof args[0] === 'string' && existsSync(args[0])) ||
      (command !== process.execPath && isAbsolute(command) && existsSync(command));
    setImmediate(() => {
      if (!runnable) {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
        return;
      }
      write(root, 'node_modules/ai-workflows/package.json', `${JSON.stringify({ name: 'ai-workflows', version: SEAL.version })}\n`);
      write(root, 'node_modules/ai-workflows/engine.json', `${JSON.stringify(SEAL)}\n`);
      stdout.end();
      stderr.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child as never;
  };
  return { spawned, spawnProcess };
}

async function initInside(root: string, spawnProcess: ReturnType<typeof fakeSpawnAbsolute>['spawnProcess']) {
  const before = process.cwd();
  process.chdir(root);
  try {
    return await recipeCommand(['init'], { cwd: root, seal: SEAL, spawnProcess });
  } finally {
    process.chdir(before);
  }
}

describe('third delta: init never spawns a manager from the project, nor by a bare name', () => {
  it('Windows, pnpm.exe at the project root, absolute PATH folders without any manager: no bare pnpm, nothing of the project; an honest failure naming pnpm', async () => {
    const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
    write(root, 'pnpm.exe', 'MZ not really a program\n');
    vi.stubEnv('npm_execpath', '');
    vi.stubEnv('PATH', `${emptyFolder()};${emptyFolder()}`);
    const { spawned, spawnProcess } = fakeSpawnAbsolute(root);

    const output = await initInside(root, spawnProcess);

    for (const call of spawned) {
      expect(isAbsolute(call.command), `spawned by a bare name: ${call.command}`).toBe(true);
      expect(inside(root, call.command), `spawned from the project: ${call.command}`).toBe(false);
      expect(inside(root, call.args[0] ?? '..'), `ran a file of the project: ${call.args[0]}`).toBe(false);
    }
    const launched = spawned.filter((call) => scriptOf(call) !== '');
    if (launched.length > 0) {
      // Only when a real global pnpm sits next to this node (dirname(process.execPath)).
      expect(launched.map(scriptOf)).toEqual(['pnpm.cjs']);
    } else {
      expect(spawned).toEqual([]);
      expect(output.ok, output.text).toBe(false);
      expect(output.text).toContain('pnpm');
    }
  });

  describe('POSIX', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
    });

    /** A folder holding an executable file named `name`, as a global install leaves it on PATH. */
    function globalProgram(name: string): { dir: string; file: string } {
      const dir = emptyFolder();
      write(dir, name, '#!/bin/sh\nexit 0\n');
      const file = join(dir, name);
      chmodSync(file, 0o755);
      return { dir, file };
    }

    it('PATH = "tools" (relative, the project holds tools/pnpm) + an empty absolute folder + a global pnpm: that absolute pnpm runs install', async () => {
      const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
      write(root, 'tools/pnpm', '#!/bin/sh\nexit 0\n');
      write(root, 'pnpm', '#!/bin/sh\nexit 0\n');
      const pnpm = globalProgram('pnpm');
      vi.stubEnv('npm_execpath', '');
      vi.stubEnv('PATH', ['tools', emptyFolder(), pnpm.dir].join(delimiter));
      const { spawned, spawnProcess } = fakeSpawnAbsolute(root);

      await initInside(root, spawnProcess);

      expect(spawned).toEqual([{ command: pnpm.file, args: ['install'] }]);
    });

    it('PATH with only a relative folder (the project holds it): nothing is spawned; an honest failure naming pnpm', async () => {
      const root = repository({ 'package.json': PACKAGE_JSON, 'pnpm-lock.yaml': '\n' });
      write(root, 'tools/pnpm', '#!/bin/sh\nexit 0\n');
      write(root, 'pnpm', '#!/bin/sh\nexit 0\n');
      vi.stubEnv('npm_execpath', '');
      vi.stubEnv('PATH', 'tools');
      const { spawned, spawnProcess } = fakeSpawnAbsolute(root);

      const output = await initInside(root, spawnProcess);

      expect(spawned).toEqual([]);
      expect(output.ok, output.text).toBe(false);
      expect(output.text).toContain('pnpm');
    });
  });
});
