import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readCaseRecords, renderSuiteReport } from './report.js';

// PLAN-13-R5 §3.1: `pnpm test:github:report` runs the whole GitHub suite once (the four files, one
// lock, one run), takes ITS exit code, and always writes the report — also when the suite failed —
// to docs/reports/suite-negativa-<date>.md. Whether the report says «Completo» is decided by the
// report itself (§3.2), never here. The orchestrator reads it entirely before committing it: the
// repository is public.

const ROOT = join(import.meta.dirname, '..', '..');
const REPOSITORY = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';
const HOUR = 60 * 60_000;

it('runs the GitHub suite and writes its report', () => {
  expect(REPOSITORY, 'set AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo>').toMatch(/^[\w.-]+\/[\w.-]+$/);
  const records = join(ROOT, '.test-build', 'suite-negativa.jsonl');
  mkdirSync(join(ROOT, '.test-build'), { recursive: true });
  rmSync(records, { force: true });

  const suite = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.github.config.ts'], {
    cwd: ROOT,
    env: { ...process.env, AI_WORKFLOWS_SUITE_REPORT: records },
    stdio: 'inherit',
  });
  const testsPassed = suite.status === 0;

  const read = existsSync(records) ? readCaseRecords(records) : [];
  const run = read.find((record) => record.id === 'LIMPIEZA')?.run ?? read[0]?.run ?? 'sin-corrida';
  const engineSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const date = new Date().toISOString().slice(0, 10);
  const report = renderSuiteReport(read, { run, date, engineSha, repository: REPOSITORY, testsPassed });
  mkdirSync(join(ROOT, 'docs', 'reports'), { recursive: true });
  const file = join(ROOT, 'docs', 'reports', `suite-negativa-${date}.md`);
  writeFileSync(file, `${report.text}\n`, 'utf8');
  process.stdout.write(`\ninforme: docs/reports/suite-negativa-${date}.md (${report.complete ? 'completo' : 'no completo'})\n`);
}, 8 * HOUR);
