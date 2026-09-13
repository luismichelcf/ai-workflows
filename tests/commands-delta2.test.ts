import { describe, expect, it } from 'vitest';

import { parseTestRun, runGateCommand } from '../src/index.js';

// Second review of the part 3 fixes (13-sep-2026). With the output limit raised to 32 MB, a
// cleaning pattern whose time grows with the square of its input froze the engine: 256 KB of
// `ESC ]` took 21.5 s, during which a 100 ms timer never ran, and the timeout had already
// fired. At 32 MB it would take days. Every bound here is far above linear time and far below
// the quadratic one measured.

const node = process.execPath;

describe('reading what a command printed cannot freeze the engine', () => {
  it('cleans 256 KB of unterminated OSC escapes in well under a second or two', async () => {
    const started = Date.now();
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write('\\u001b]'.repeat(128000)); process.exit(1)"],
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);

  it('cleans 4 MB of OSC escapes with one open sequence per line', async () => {
    const started = Date.now();
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write(('\\u001b]x' + 'y'.repeat(60) + '\\n').repeat(65000)); process.exit(1)"],
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 60_000);

  it('does not swallow the text after a title escape that ends with BEL', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write('\\u001b]0;titulo\\u0007FALLO VISIBLE\\n'); process.exit(1)"],
      timeoutMs: 10_000,
    });

    expect(result.ok === false && result.reason).toContain('FALLO VISIBLE');
    expect(result.ok === false && result.reason).not.toContain('titulo');
  });

  it('keeps a huge output without copying it again on every chunk', async () => {
    const started = Date.now();
    const result = await runGateCommand({
      command: node,
      args: ['-e', "const c = 'x'.repeat(1 << 20) + '\\n'; for (let i = 0; i < 256; i++) process.stdout.write(c); process.exit(1)"],
      timeoutMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 90_000);
});

describe('parsing a test run is linear too', () => {
  for (const [name, line] of [
    ['a long run of digits', '1'.repeat(300_000)],
    ['a long run of opening brackets', '['.repeat(300_000)],
    ['digits and spaces without the word passed', '1 '.repeat(150_000)],
  ] as const) {
    it(`reads ${name} quickly`, () => {
      const started = Date.now();
      parseTestRun({ output: `${line}\n Tests  1 passed (1)\n`, exitCode: 0 });

      expect(Date.now() - started).toBeLessThan(2000);
    });
  }
});

describe('what interpret returns is checked strictly', () => {
  const run = (answer: unknown) =>
    runGateCommand({ command: node, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000, interpret: () => answer as { ok: true } });

  it('an ok that is only truthy is not a pass', async () => {
    expect((await run({ ok: 'yes' })).ok).toBe(false);
    expect((await run({ ok: 1 })).ok).toBe(false);
  });

  it('a reason that is not text is not a reason', async () => {
    const result = await run({ ok: false, reason: 42 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && typeof result.reason).toBe('string');
  });

  it('a reason made only of escape codes still says something', async () => {
    const result = await run({ ok: false, reason: '[31m[0m' });

    expect(result.ok === false && result.reason.trim().length).toBeGreaterThan(10);
  });
});

describe.runIf(process.platform !== 'win32')('on POSIX the process group is ended even when the child already exited', () => {
  it('kills the grandchild that kept the output open', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "require('node:fs').writeFileSync(process.env.PID_FILE, String(g.pid));",
      'setTimeout(() => process.exit(0), 200);',
    ].join('\n');
    const pidFile = `/tmp/aiw-posix-${process.pid}.pid`;
    process.env['PID_FILE'] = pidFile;

    await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, 'SIGKILL');
    expect(alive).toBe(false);
  }, 15_000);
});
