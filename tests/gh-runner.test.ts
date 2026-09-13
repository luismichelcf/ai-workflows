import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGhRunner, type GhRun } from '../src/index.js';

// How the GitHub store runs `gh` (ai-workflows#6, flock findings). `gh` itself never gives up, so a
// call that never gets an answer would hold a piece forever while its lease keeps renewing. A
// child that exits before reading a large body must not crash the engine with an uncaught write
// error. And colored output would make every JSON reply unreadable.
// These tests run a small Node script in place of `gh`, so they do not need `gh` installed.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeGh = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-gh-runner-'));
  dirs.push(dir);
  const file = join(dir, 'fake-gh.mjs');
  writeFileSync(file, source);
  return file;
};

const runnerFor = (file: string, options: { timeoutMs?: number; env?: Record<string, string> } = {}) =>
  createGhRunner({
    executable: {
      command: process.execPath,
      prefixArgs: [file],
      ...(options.env === undefined ? {} : { env: options.env }),
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ECHO = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    input,
    noColor: process.env.NO_COLOR ?? null,
    promptDisabled: process.env.GH_PROMPT_DISABLED ?? null,
    shimProbe: process.env.AIW_SHIM_PROBE ?? null,
  }));
  process.stderr.write('aviso');
  process.exitCode = 3;
});
`;

describe('the gh runner', () => {
  it('hands back what gh printed, its exit code, and what it read from stdin', async () => {
    const run = runnerFor(fakeGh(ECHO));

    const result = await run(['api', 'repos/o/r', '--input', '-'], '{"a":"ü"}');

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('aviso');
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ['api', 'repos/o/r', '--input', '-'], input: '{"a":"ü"}' });
  }, 20_000);

  it('gives a call without input an empty, closed stdin, so gh does not wait for one', async () => {
    const run = runnerFor(fakeGh(ECHO));

    const result = await run(['api', 'repos/o/r']);

    expect(JSON.parse(result.stdout)).toMatchObject({ input: '' });
  }, 20_000);

  it('turns off color and prompts, so what gh prints can be read as JSON', async () => {
    const run = runnerFor(fakeGh(ECHO));

    const parsed = JSON.parse((await run(['api', 'x'])).stdout) as { noColor: unknown; promptDisabled: unknown };

    expect(parsed.noColor).toBeTruthy();
    expect(parsed.promptDisabled).toBeTruthy();
  }, 20_000);

  it('lays the environment a shim declares over its own', async () => {
    const run = runnerFor(fakeGh(ECHO), { env: { AIW_SHIM_PROBE: 'yes' } });

    expect(JSON.parse((await run(['api', 'x'])).stdout)).toMatchObject({ shimProbe: 'yes' });
  }, 20_000);

  it('kills a call that does not finish in time, and says it timed out', async () => {
    const file = fakeGh(`
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`);
    const pidFile = join(dirs[dirs.length - 1] ?? tmpdir(), 'pid.txt');
    const run = runnerFor(file, { timeoutMs: 6_000 });
    const started = Date.now();

    await expect(run([pidFile])).rejects.toThrow(/timed out|timeout/i);

    expect(Date.now() - started).toBeLessThan(20_000);
    // The fake must have started, or this test would pass on the rejection alone without proving
    // that the process was stopped (delta review).
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(false);
  }, 40_000);

  it('removes what would force a terminal or color back on, whatever its case', async () => {
    const saved = { tty: process.env['GH_FORCE_TTY'], color: process.env['clicolor_force'] };
    process.env['GH_FORCE_TTY'] = '1';
    process.env['clicolor_force'] = '1';
    try {
      const run = runnerFor(
        fakeGh(`
const found = Object.keys(process.env).filter((name) => ['GH_FORCE_TTY', 'CLICOLOR_FORCE'].includes(name.toUpperCase()));
process.stdout.write(JSON.stringify(found));
`),
      );

      expect(JSON.parse((await run(['api', 'x'])).stdout)).toEqual([]);
    } finally {
      if (saved.tty === undefined) delete process.env['GH_FORCE_TTY'];
      else process.env['GH_FORCE_TTY'] = saved.tty;
      if (saved.color === undefined) delete process.env['clicolor_force'];
      else process.env['clicolor_force'] = saved.color;
    }
  }, 20_000);

  it('survives gh exiting before it read a large body, without an uncaught write error', async () => {
    const run = runnerFor(fakeGh('process.exit(2);'));

    const outcome = await run(['api', 'x', '--input', '-'], 'x'.repeat(8 * 1024 * 1024)).then(
      (result: GhRun) => result,
      (error: unknown) => error,
    );

    expect(outcome instanceof Error || (outcome as GhRun).exitCode === 2).toBe(true);
  }, 30_000);

  it.each([0, -5, Number.NaN])('refuses a timeout that is not a positive number: %s', (timeoutMs) => {
    expect(() => createGhRunner({ timeoutMs })).toThrow(/timeout/i);
  });
});
