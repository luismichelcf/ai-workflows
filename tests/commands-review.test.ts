import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isGreenRun, isRedEvidence, parseTestRun, runGateCommand, type TestRun } from '../src/index.js';

// Review of the part 3 fixes (13-sep-2026):
//   - The output kept for reading was the last 64 KB. A run that printed "1 failed", then a
//     long log, then "2000 passed" and exited 0 read as green: the very reading that exists so
//     exit 0 is not believed approved a red run.
//   - A reason returned by `interpret` went out raw (escape codes, 100 000 characters), and an
//     `interpret` that returned nothing resolved to nothing.
//   - An absolute path skipped the no-shell rule: cmd.exe ran `echo uno & exit /b 3`.

const node = process.execPath;
const greenReader = (run: TestRun) =>
  isGreenRun(parseTestRun(run)) ? { ok: true as const } : { ok: false as const, reason: 'la corrida no esta en verde' };

describe('a long output is read whole, and a cut-off one never reads as green', () => {
  it('still sees an early failure after 100 KB of log', async () => {
    const script =
      "process.stdout.write(' Tests  1 failed (1)\\n'); process.stdout.write(('y'.repeat(99) + '\\n').repeat(1000)); process.stdout.write(' Tests  5 passed (5)\\n'); process.exit(0);";
    let seen: TestRun | undefined;

    const result = await runGateCommand({
      command: node,
      args: ['-e', script],
      timeoutMs: 30_000,
      interpret: (run) => {
        seen = run;
        return greenReader(run);
      },
    });

    expect(result.ok).toBe(false);
    expect(seen?.truncated ?? false).toBe(false);
  }, 40_000);

  it('tells interpret the output was cut off, and a cut-off run is not green', async () => {
    const script =
      "process.stdout.write(' Tests  1 failed (1)\\n'); const chunk = 'x'.repeat(1 << 20) + '\\n'; for (let i = 0; i < 40; i++) process.stdout.write(chunk); process.stdout.write(' Tests  2000 passed (2000)\\n'); process.exit(0);";
    let seen: TestRun | undefined;

    const result = await runGateCommand({
      command: node,
      args: ['-e', script],
      timeoutMs: 60_000,
      interpret: (run) => {
        seen = run;
        return greenReader(run);
      },
    });

    expect(seen?.truncated).toBe(true);
    expect(result.ok).toBe(false);
  }, 70_000);

  it('a truncated run is neither green nor red evidence', () => {
    const run: TestRun = { output: ' Tests  5 passed (5)\n', exitCode: 0, truncated: true };
    const red: TestRun = { output: ' FAIL  t/a.test.ts > x\n Tests  1 failed (1)\n', exitCode: 1, truncated: true };

    expect(isGreenRun(parseTestRun(run))).toBe(false);
    expect(isRedEvidence(parseTestRun(red))).toBe(false);
  });
});

describe('what interpret answers is checked like any other reason', () => {
  it('cleans and clips the reason interpret returns', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      interpret: () => ({ ok: false, reason: `\u001b[31mrojo\u001b[0m ${'z'.repeat(100_000)}` }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('rojo');
    expect(result.ok === false && result.reason).not.toContain('\u001b');
    expect(result.ok === false && result.reason.length).toBeLessThan(4000);
  });

  it('treats an interpret that returns nothing as a failure, not as an answer', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      interpret: () => undefined as unknown as { ok: true },
    });

    expect(result).toBeTypeOf('object');
    expect(result.ok).toBe(false);
  });
});

describe('an absolute path follows the no-shell rule too', () => {
  it.runIf(process.platform === 'win32')('refuses cmd.exe by absolute path without running it', async () => {
    const cmd = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';

    const result = await runGateCommand({ command: cmd, args: ['/d', '/c', 'echo uno & exit /b 3'], timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).not.toContain('uno');
  });

  const pnpmShim = (process.env['PATH'] ?? process.env['Path'] ?? '')
    .split(';')
    .map((dir) => join(dir.replace(/^"|"$/g, ''), 'pnpm.cmd'))
    .find((file) => existsSync(file));

  it.runIf(process.platform === 'win32' && pnpmShim !== undefined)('runs pnpm given the absolute path of its .cmd shim', async () => {
    const result = await runGateCommand({ command: pnpmShim ?? '', args: ['--version'], timeoutMs: 60_000 });

    expect(result.ok).toBe(true);
  }, 70_000);
});
