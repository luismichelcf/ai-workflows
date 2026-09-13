import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isGreenRun, isRedEvidence, parseTestRun, type TestRun } from '../src/index.js';

// Reading a test run, against what vitest REALLY prints. Every fixture in
// `tests/fixtures/vitest/` was captured on 13-sep-2026 by running vitest 2.1.9 on small
// test files, with FORCE_COLOR=1 (`.color.txt`) and NO_COLOR=1 (`.plain.txt`), keeping the
// real exit code next to each (`.exit`). Local paths were scrubbed; nothing else was edited.
//
// The earlier tests used hand-written summary lines. The review showed what that missed:
// with colours — the normal case on Windows with piped output — a red run read as "nothing
// failed", and several ways of running nothing read as green.

const fixture = (name: string, kind: 'plain' | 'color' = 'plain'): TestRun => ({
  output: readFileSync(new URL(`./fixtures/vitest/${name}.${kind}.txt`, import.meta.url), 'utf8'),
  exitCode: Number(readFileSync(new URL(`./fixtures/vitest/${name}.${kind}.exit`, import.meta.url), 'utf8').trim()),
});

describe('a genuine red run', () => {
  for (const kind of ['plain', 'color'] as const) {
    it(`${kind}: counts the failure and the pass`, () => {
      const summary = parseTestRun(fixture('s1-mixed', kind));

      expect(summary.failed).toBe(1);
      expect(summary.passed).toBe(1);
    });

    it(`${kind}: names the test and keeps the assertion`, () => {
      const summary = parseTestRun(fixture('s1-mixed', kind));

      expect(summary.failures.join(' ')).toContain('paga el bono completo al 100%');
      expect(summary.assertions.join(' ')).toContain('1000');
    });

    it(`${kind}: is valid evidence of a red test`, () => {
      expect(isRedEvidence(parseTestRun(fixture('s1-mixed', kind)))).toBe(true);
    });

    it(`${kind}: is not green`, () => {
      expect(isGreenRun(parseTestRun(fixture('s1-mixed', kind)))).toBe(false);
    });
  }

  it('a red test whose text mentions SyntaxError is still a red test, not a broken environment', () => {
    // Anything that parses JSON has "SyntaxError" in its assertions. Reading that as a
    // broken environment blocks every valid red test around parsers.
    const summary = parseTestRun(fixture('s9-syntaxerror-assertion'));

    expect(summary.brokenEnvironment).toBe(false);
    expect(summary.failed).toBe(1);
    expect(isRedEvidence(summary)).toBe(true);
  });
});

describe('a suite that never loaded is not a red test', () => {
  for (const name of ['s2-syntax', 's3-import-throw', 's4-missing-import']) {
    for (const kind of ['plain', 'color'] as const) {
      it(`${name} (${kind}): is a broken environment`, () => {
        expect(parseTestRun(fixture(name, kind)).brokenEnvironment).toBe(true);
      });

      it(`${name} (${kind}): is not evidence of a red test`, () => {
        expect(isRedEvidence(parseTestRun(fixture(name, kind)))).toBe(false);
      });
    }
  }

  it('no test files found is not green', () => {
    expect(isGreenRun(parseTestRun(fixture('s8-nofiles')))).toBe(false);
  });
});

describe('running nothing is not green', () => {
  for (const kind of ['plain', 'color'] as const) {
    it(`${kind}: all skipped or todo, exiting 0, is not green`, () => {
      const summary = parseTestRun(fixture('s5-skipped', kind));

      expect(summary.ranNothing).toBe(true);
      expect(isGreenRun(summary)).toBe(false);
    });
  }
});

describe('an error outside the tests is not green', () => {
  for (const kind of ['plain', 'color'] as const) {
    it(`${kind}: tests passed but an unhandled error made vitest exit 1`, () => {
      const summary = parseTestRun(fixture('s6-unhandled', kind));

      expect(summary.errors).toBeGreaterThan(0);
      expect(isGreenRun(summary)).toBe(false);
    });
  }

  it('a non-zero exit with nothing explaining it is never green', () => {
    expect(isGreenRun(parseTestRun({ output: fixture('s7-green').output, exitCode: 1 }))).toBe(false);
  });
});

describe('a genuine green run', () => {
  for (const kind of ['plain', 'color'] as const) {
    it(`${kind}: is green`, () => {
      const summary = parseTestRun(fixture('s7-green', kind));

      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.brokenEnvironment).toBe(false);
      expect(isGreenRun(summary)).toBe(true);
    });
  }

  it('is not evidence of a red test', () => {
    expect(isRedEvidence(parseTestRun(fixture('s7-green')))).toBe(false);
  });
});

describe('several runs in one output', () => {
  it('adds up every summary instead of reading only the first', () => {
    // `vitest run && vitest run -c e2e` prints two summaries. Reading the first one only
    // turned a red second run into green.
    const green = fixture('s7-green');
    const red = fixture('s1-mixed');

    const summary = parseTestRun({ output: `${green.output}\n${red.output}`, exitCode: 1 });

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.passed).toBeGreaterThanOrEqual(3);
    expect(isGreenRun(summary)).toBe(false);
  });

  it('never reports fewer failures than tests it named as failing', () => {
    const summary = parseTestRun(fixture('s1-mixed', 'color'));

    expect(summary.failed).toBeGreaterThanOrEqual(summary.failures.length);
  });
});
