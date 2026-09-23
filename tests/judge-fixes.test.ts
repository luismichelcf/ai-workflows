import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { gitProjectFiles, launchInGroup } from '../src/index.js';

import { emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';

// Orchestrator's review of slice 3, parts B and D: two corrections.
// 1. Reading a file of a commit must tell "not in that commit" from "git could not answer": the
//    second is an error, never an absent file (AGENTS.md: no catch that swallows an error).
// 2. The red-test job removes tokens from the environment of the tests. It must do so by giving
//    the process group its whole environment, never by swapping `process.env` of the engine,
//    even for an instant (another asynchronous task, or a launcher that reads it later, would see
//    the swap or miss it).

afterEach(removeRepositories);

describe('gitProjectFiles: an unknown commit is an error, not an absent file', () => {
  it('rejects when the commit does not exist', async () => {
    const root = repository();
    await expect(gitProjectFiles(root, 'f'.repeat(40)).read('app/page.tsx')).rejects.toThrow();
  });

  it('rejects when the folder is not a repository', async () => {
    const root = emptyFolder();
    await expect(gitProjectFiles(root, 'HEAD').read('app/page.tsx')).rejects.toThrow();
  });

  it('positive: a path that is not in an existing commit is undefined', async () => {
    const root = repository();
    const head = git(root, 'rev-parse', 'HEAD');
    expect(await gitProjectFiles(root, head).read('not/here.md')).toBeUndefined();
  });
});

describe('the environment of a process group', () => {
  it('with environment, the group sees exactly it and nothing of the engine', async () => {
    const root = emptyFolder();
    write(root, 'show.mjs', 'process.stdout.write(JSON.stringify({ probe: process.env.AIW_PROBE_SECRET ?? null, kept: process.env.AIW_KEPT ?? null }));\n');
    process.env['AIW_PROBE_SECRET'] = 'leaked';
    const before = process.env;
    try {
      const { AIW_PROBE_SECRET: _dropped, ...rest } = process.env;
      const group = launchInGroup({
        command: process.execPath,
        args: [join(root, 'show.mjs')],
        cwd: root,
        stdin: '',
        environment: { ...rest, AIW_KEPT: 'yes' },
      });
      expect(process.env).toBe(before);
      const exit = await group.wait();
      await group.terminate();
      expect(exit.kind).toBe('exited');
      if (exit.kind !== 'exited') return;
      expect(JSON.parse(exit.stdout)).toEqual({ probe: null, kept: 'yes' });
    } finally {
      delete process.env['AIW_PROBE_SECRET'];
    }
  });

  it('positive: without environment, the group inherits the engine environment as before', async () => {
    const root = emptyFolder();
    write(root, 'show.mjs', 'process.stdout.write(process.env.AIW_PROBE_SECRET ?? "none");\n');
    process.env['AIW_PROBE_SECRET'] = 'inherited';
    try {
      const group = launchInGroup({ command: process.execPath, args: [join(root, 'show.mjs')], cwd: root, stdin: '' });
      const exit = await group.wait();
      await group.terminate();
      expect(exit.kind === 'exited' ? exit.stdout : exit.kind).toBe('inherited');
    } finally {
      delete process.env['AIW_PROBE_SECRET'];
    }
  });

  it('no module of the engine assigns process.env', () => {
    const src = new URL('../src/', import.meta.url);
    const base = src.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(base);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/process\.env\s*=[^=]/);
    }
  });
});
