import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isGreenRun, parseTestRun, runGateCommand } from '../src/index.js';

// Running a command as a gate, on the machine where it really runs. Every case here was
// reproduced by the review of part 2 (13-sep-2026): a hung command froze the engine for
// good and left processes alive, a huge output crashed it, and an exit code of 0 decided
// green even when the output said red.

const node = process.execPath;
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-lifecycle-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The scripts are written to files: nesting quoted file paths inside `node -e` strings broke
// the grandchild silently, and a test that "gave up in time" was only watching a syntax error.
const writeScript = (dir: string, name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
};

// On Windows a Node process puts its children in a job that dies with it, so a Node
// intermediate hides both bugs: its grandchild is killed for free. `pnpm check` runs through
// processes that do not do that, so on Windows the intermediate is cmd.exe (a test fixture
// only; the engine itself never starts a shell). On POSIX a Node intermediate reproduces it.
const cmdExe = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';

const withGrandchild = (dir: string, mode: 'child-exits-grandchild-keeps-output' | 'child-waits-on-grandchild') => {
  const pidFile = join(dir, 'grandchild.pid');
  const grandchild = writeScript(
    dir,
    'grandchild.js',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  );

  if (process.platform === 'win32') {
    const line = mode === 'child-exits-grandchild-keeps-output' ? `start /b node ${grandchild}` : `node ${grandchild}`;
    return { command: cmdExe, args: ['/d', '/s', '/c', line], pidFile };
  }

  const child = writeScript(
    dir,
    'child.js',
    [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' });`,
      mode === 'child-exits-grandchild-keeps-output' ? 'setTimeout(() => process.exit(0), 300);' : 'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  return { command: node, args: [child], pidFile };
};

const pids: number[] = [];
afterEach(() => {
  // A test that fails must not leave its grandchild running on the owner's machine.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: that is the outcome the test wanted.
    }
  }
});

const rememberPid = (pidFile: string) => {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  pids.push(pid);
  return pid;
};

describe('a command that hangs cannot hang the engine', () => {
  it('gives up in time even when a grandchild keeps the output open', async () => {
    // The direct child ends at once, but a grandchild inherits the pipes and keeps them open.
    // Waiting for "close" waited forever.
    const dir = scratch();
    const { command, args, pidFile } = withGrandchild(dir, 'child-exits-grandchild-keeps-output');

    const started = Date.now();
    const result = await runGateCommand({ command, args, timeoutMs: 1500 });
    const took = Date.now() - started;
    const pid = rememberPid(pidFile);

    // Positive control: the grandchild really started, so the scenario really happened.
    expect(pid).toBeTypeOf('number');
    expect(took).toBeGreaterThanOrEqual(1000);
    expect(took).toBeLessThan(8000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.toLowerCase()).toMatch(/tiempo/);
  }, 15_000);

  it('kills the whole process tree when it gives up, not only the direct child', async () => {
    const dir = scratch();
    const { command, args, pidFile } = withGrandchild(dir, 'child-waits-on-grandchild');

    const result = await runGateCommand({ command, args, timeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const pid = rememberPid(pidFile);

    expect(result.ok === false && result.reason.toLowerCase()).toMatch(/tiempo/);
    expect(pid).toBeTypeOf('number');
    expect(alive(pid ?? -1)).toBe(false);
  }, 15_000);

  it('does not wait for input that will never come', async () => {
    const started = Date.now();
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      timeoutMs: 10_000,
    });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(true);
  }, 15_000);
});

describe('a timeout that makes no sense is refused, not obeyed', () => {
  for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0, 1.5, 2 ** 31]) {
    it(`refuses timeoutMs ${timeoutMs} without running anything`, async () => {
      const dir = scratch();
      const marker = join(dir, 'ran');

      const result = await runGateCommand({
        command: node,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        timeoutMs,
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason.toLowerCase()).toMatch(/timeout|tiempo/);
      expect(existsSync(marker)).toBe(false);
    });

    it(`refuses timeoutMs ${timeoutMs} before even looking for the command`, async () => {
      // Deterministic twin of the case above: obeying the timeout would race the kill against
      // node's start-up. A command that does not exist tells a refusal apart from an attempt.
      const result = await runGateCommand({
        command: join(scratch(), 'no-such-program.exe'),
        args: [],
        timeoutMs,
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason.toLowerCase()).toMatch(/timeout|tiempo/);
      expect(result.ok === false && result.reason).not.toMatch(/ENOENT|could not be started|not found/i);
    });
  }
});

describe('the output is kept honestly and safely', () => {
  it('survives an enormous output and keeps its end', async () => {
    const script = "const chunk = 'x'.repeat(1 << 20) + '\\n'; for (let i = 0; i < 60; i++) process.stdout.write(chunk); process.stderr.write('AQUI ESTA EL FALLO\\n'); process.exit(1);";

    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 60_000 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('AQUI ESTA EL FALLO');
  }, 70_000);

  it('keeps stdout and stderr in the order they arrived', async () => {
    const script = [
      "process.stdout.write('1-out\\n');",
      "setTimeout(() => { process.stderr.write('2-err\\n');",
      "  setTimeout(() => { process.stdout.write('3-out\\n'); process.exit(1); }, 50); }, 50);",
    ].join('\n');

    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 10_000 });
    const reason = result.ok === false ? result.reason : '';

    expect(reason.indexOf('1-out')).toBeGreaterThanOrEqual(0);
    expect(reason.indexOf('1-out')).toBeLessThan(reason.indexOf('2-err'));
    expect(reason.indexOf('2-err')).toBeLessThan(reason.indexOf('3-out'));
  }, 15_000);

  it('does not split a character written across two chunks', async () => {
    const script = "const b = Buffer.from('ñ'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1)); process.stdout.write('\\n'); process.exit(1); }, 50);";

    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 10_000 });

    expect(result.ok === false && result.reason).toContain('ñ');
    expect(result.ok === false && result.reason).not.toContain('�');
  }, 15_000);

  it('strips terminal colour codes from the reason a person reads', async () => {
    const script = "process.stdout.write('\\u001b[31mrojo\\u001b[0m\\n'); process.exit(1);";

    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 10_000 });

    expect(result.ok === false && result.reason).toContain('rojo');
    expect(result.ok === false && result.reason).not.toContain('\u001b');
  }, 15_000);
});

describe('an exit code of 0 does not decide on its own', () => {
  it('lets the gate read the output, so a red run that exits 0 is not green', async () => {
    const script = "process.stdout.write('FAIL t/a.test.ts > algo\\nAssertionError: expected 1 to be 2\\n Tests  1 failed | 3 passed (4)\\n'); process.exit(0);";

    const result = await runGateCommand({
      command: node,
      args: ['-e', script],
      timeoutMs: 10_000,
      interpret: (run) =>
        isGreenRun(parseTestRun(run)) ? { ok: true } : { ok: false, reason: 'la corrida no esta en verde' },
    });

    expect(result.ok).toBe(false);
  }, 15_000);

  it('still passes a genuinely green run through the same reading', async () => {
    const script = "process.stdout.write(' Tests  4 passed (4)\\n'); process.exit(0);";

    const result = await runGateCommand({
      command: node,
      args: ['-e', script],
      timeoutMs: 10_000,
      interpret: (run) =>
        isGreenRun(parseTestRun(run)) ? { ok: true } : { ok: false, reason: 'la corrida no esta en verde' },
    });

    expect(result.ok).toBe(true);
  }, 15_000);
});

describe('on this machine, for real', () => {
  it.runIf(process.platform === 'win32')('runs pnpm without a shell', async () => {
    // The gate that will run `pnpm check`. On Windows pnpm is a .cmd shim that Node will not
    // spawn without a shell; it has to be resolved to the program behind it.
    const result = await runGateCommand({ command: 'pnpm', args: ['--version'], timeoutMs: 60_000 });

    expect(result.ok).toBe(true);
  }, 70_000);
});
