import { describe, expect, it } from 'vitest';

import { parseTestRun, runGateCommand } from '../src/index.js';

// The gates that run something and read what came back. These are the ones the spec calls
// "recompute": the engine produces the result again rather than believing a report. It is
// the rule the house learned the hard way — a builder's "all green" caught two lies only
// because the orchestrator ran the suite itself.
//
// The hard part is not running the command. It is telling a real failure from a broken
// environment: a test that failed its assertion is evidence, and one that could not even
// load is not.

describe('running a command as a gate', () => {
  it('passes when the command succeeds', async () => {
    const result = await runGateCommand({ command: 'node', args: ['-e', 'process.exit(0)'] });

    expect(result.ok).toBe(true);
  });

  it('fails when the command fails, keeping what it printed', async () => {
    const result = await runGateCommand({
      command: 'node',
      args: ['-e', 'console.error("la suite quedo roja"); process.exit(1)'],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('la suite quedo roja');
  });

  it('reports a command that does not exist instead of hanging', async () => {
    const result = await runGateCommand({ command: 'no-existe-este-comando', args: [] });

    expect(result.ok).toBe(false);
  });

  it('gives up on a command that never ends', async () => {
    const result = await runGateCommand({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.toLowerCase()).toContain('tiempo');
  });

  it('keeps the output short enough to read', async () => {
    const result = await runGateCommand({
      command: 'node',
      args: ['-e', 'console.error("x".repeat(100000)); process.exit(1)'],
    });

    expect(result.ok === false && result.reason.length).toBeLessThan(4000);
  });

  it('keeps the END of a long output, which is where the failure is', async () => {
    const result = await runGateCommand({
      command: 'node',
      args: [
        '-e',
        'console.error("ruido\\n".repeat(20000)); console.error("AQUI ESTA EL FALLO"); process.exit(1)',
      ],
    });

    expect(result.ok === false && result.reason).toContain('AQUI ESTA EL FALLO');
  });

  it('runs where it is told to run', async () => {
    const result = await runGateCommand({
      command: 'node',
      args: ['-e', 'console.log(process.cwd()); process.exit(0)'],
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(true);
  });
});

describe('reading what a test run actually did', () => {
  // A red test is only evidence when it failed for the reason it was written for. A test
  // that could not import its module is not a red test: it is a broken environment, and
  // treating it as evidence would authorise a build on nothing.
  it('sees a failure with its assertion', () => {
    const output = [
      'FAIL tests/nomina.test.ts > paga el bono completo al 100%',
      'AssertionError: expected 800 to be 1000',
      'Tests  1 failed (1)',
    ].join('\n');

    const parsed = parseTestRun({ output, exitCode: 1 });

    expect(parsed.failed).toBe(1);
    expect(parsed.brokenEnvironment).toBe(false);
  });

  it('names the test that failed', () => {
    const output = [
      'FAIL tests/nomina.test.ts > paga el bono completo al 100%',
      'AssertionError: expected 800 to be 1000',
    ].join('\n');

    expect(parseTestRun({ output, exitCode: 1 }).failures[0]).toContain('bono completo');
  });

  it('keeps the assertion message, which is what proves the reason', () => {
    const output = 'AssertionError: expected 800 to be 1000';

    expect(parseTestRun({ output, exitCode: 1 }).assertions[0]).toContain('1000');
  });

  it('tells a broken import apart from a real failure', () => {
    const output = 'Error: Failed to load url ../src/nomina.js. Does the file exist?';

    const parsed = parseTestRun({ output, exitCode: 1 });

    expect(parsed.brokenEnvironment).toBe(true);
  });

  it('treats a missing module as a broken environment too', () => {
    const output = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './falta.js'";

    expect(parseTestRun({ output, exitCode: 1 }).brokenEnvironment).toBe(true);
  });

  it('treats a syntax error as a broken environment', () => {
    const output = 'SyntaxError: Unexpected token';

    expect(parseTestRun({ output, exitCode: 1 }).brokenEnvironment).toBe(true);
  });

  it('does not call it broken when a test genuinely failed', () => {
    const output = [
      'FAIL tests/a.test.ts > algo',
      'AssertionError: expected true to be false',
      'Tests  1 failed | 3 passed (4)',
    ].join('\n');

    expect(parseTestRun({ output, exitCode: 1 }).brokenEnvironment).toBe(false);
  });

  it('reads how many passed and how many failed', () => {
    const parsed = parseTestRun({ output: 'Tests  2 failed | 170 passed (172)', exitCode: 1 });

    expect(parsed.failed).toBe(2);
    expect(parsed.passed).toBe(170);
  });

  it('reads a run where everything passed', () => {
    const parsed = parseTestRun({ output: 'Tests  172 passed (172)', exitCode: 0 });

    expect(parsed.failed).toBe(0);
    expect(parsed.passed).toBe(172);
  });

  it('reports a run that produced nothing as broken, not as passing', () => {
    // Silence is not success. A run that printed nothing and exited zero is the kind of
    // thing that quietly turns an unrun check into a green one.
    const parsed = parseTestRun({ output: '', exitCode: 0 });

    expect(parsed.brokenEnvironment).toBe(true);
  });

  it('does not trust the exit code alone when the output says otherwise', () => {
    const parsed = parseTestRun({ output: 'Tests  1 failed | 1 passed (2)', exitCode: 0 });

    expect(parsed.failed).toBe(1);
  });
});

describe('what a red test has to show to count as evidence', () => {
  it('counts a failure whose assertion matches what was expected', () => {
    const parsed = parseTestRun({
      output: 'FAIL tests/a.test.ts > el bono\nAssertionError: expected 800 to be 1000',
      exitCode: 1,
    });

    expect(parsed.failed).toBe(1);
    expect(parsed.brokenEnvironment).toBe(false);
    expect(parsed.assertions.join(' ')).toContain('1000');
  });

  it('does not count a failure with no assertion at all', () => {
    const parsed = parseTestRun({ output: 'FAIL tests/a.test.ts > el bono', exitCode: 1 });

    expect(parsed.assertions).toEqual([]);
  });
});
