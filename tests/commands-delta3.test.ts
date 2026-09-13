import { describe, expect, it } from 'vitest';

import { isGreenRun, parseTestRun, requireSameFiles, runGateCommand, type TestRun } from '../src/index.js';

// Third review of the part 3 fixes (13-sep-2026):
//   - The `Tests …` summary line was still read with a pattern that retries from every space:
//     160 KB took 47 s, and the engine answered after 26 s with a 1 s timeout.
//   - An unterminated `ESC ]` erased everything up to the next ESC or BEL, newlines included,
//     so the reason lost the very assertion that failed.
//   - Joining the head and tail of a long output said nothing about the cut.

const node = process.execPath;

describe('reading a test run stays linear on every line it looks at', () => {
  it('a summary line with a long run of spaces', () => {
    const started = Date.now();
    parseTestRun({ output: ` Tests  1 passed${' '.repeat(160_000)}x\n`, exitCode: 0 });

    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a FAIL line with a long run of words and an open bracket', () => {
    const started = Date.now();
    parseTestRun({ output: ` FAIL  ${'a '.repeat(80_000)}[x\n Tests  1 failed (1)\n`, exitCode: 1 });

    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('the engine answers within its timeout while reading such a line', async () => {
    const started = Date.now();
    await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write(' Tests  1 passed' + ' '.repeat(120000) + 'x\\n'); process.exit(0)"],
      timeoutMs: 10_000,
      interpret: (run: TestRun) => (isGreenRun(parseTestRun(run)) ? { ok: true } : { ok: false, reason: 'no verde' }),
    });

    expect(Date.now() - started).toBeLessThan(8000);
  }, 60_000);
});

describe('the reason never loses the failure', () => {
  it('keeps the assertion after an unterminated title escape', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write('\\u001b]0;compilando\\nAssertionError: esperado 1, recibido 2\\n FAIL tests/x.test.ts > suma\\n'); process.exit(1)"],
      timeoutMs: 10_000,
    });

    expect(result.ok === false && result.reason).toContain('AssertionError: esperado 1, recibido 2');
  });

  it('keeps what interpret said after an unterminated title escape', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      interpret: () => ({ ok: false, reason: ']0;x\nel archivo de pruebas no existe' }),
    });

    expect(result.ok === false && result.reason).toContain('el archivo de pruebas no existe');
  });

  it('keeps the final failure when the cut falls inside a hyperlink, and says it cut', async () => {
    const link = `\\u001b]8;;https://example.com/${'p'.repeat(100)}\\u001b\\\\enlace\\u001b]8;;\\u001b\\\\`;
    const script = `process.stdout.write('a'.repeat(3830) + '${link}' + 'b'.repeat(5000) + '\\nAssertionError: FALLO FINAL\\n'); process.exit(1)`;
    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 10_000 });

    expect(result.ok === false && result.reason).toContain('FALLO FINAL');
    expect(result.ok === false && result.reason).toContain('recortado');
  });

  it('says it cut when head and tail of a long output are joined', async () => {
    const noise = '\\u001b[2K\\u001b[1G'.repeat(1000);
    const script = `process.stdout.write('${noise}' + 'MEDIO: la prueba X fallo\\n' + '${noise}' + 'fin\\n'); process.exit(1)`;
    const result = await runGateCommand({ command: node, args: ['-e', script], timeoutMs: 10_000 });

    expect(result.ok === false && result.reason).toMatch(/MEDIO|recortado/);
  });

  it('says there was no output when the output was only escape codes', async () => {
    const result = await runGateCommand({
      command: node,
      args: ['-e', "process.stdout.write('\\u001b[31m\\u001b[0m\\n'); process.exit(1)"],
      timeoutMs: 10_000,
    });

    expect(result.ok === false && result.reason).toContain('(no output)');
  });
});

describe('only a real digest counts (mutation guards)', () => {
  it('refuses an MD5 and a 65-character hex string', () => {
    for (const hash of ['d41d8cd98f00b204e9800998ecf8427e', 'a'.repeat(65)]) {
      expect(requireSameFiles({ 'tests/x.test.ts': hash }, { 'tests/x.test.ts': hash }).ok, String(hash.length)).toBe(false);
    }
  });
});
