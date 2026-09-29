import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SUITE_MANIFEST, readCaseRecords, renderSuiteReport, type CaseRecord, type SuiteJoinedRun } from './report.js';

// PLAN-13-R5 §3.1: `pnpm test:github:report` runs the whole GitHub suite once (the four files, one
// lock, one run), takes ITS exit code, and always writes the report — also when the suite failed —
// to docs/reports/suite-negativa-<date>.md. Whether the report says «Completo» is decided by the
// report itself (§3.2), never here. The orchestrator reads it entirely before committing it: the
// repository is public.
//
// R23 (owner decision, 29-sep): the report may join a full earlier run with a short final run of
// the cases that one left without a record. With AI_WORKFLOWS_SUITE_JOIN=<earlier .jsonl> the task
// runs only the retaken cases (AI_WORKFLOWS_SUITE_RETAKE) and declares the earlier run to the
// report; without it, it does exactly what it did before.

const ROOT = join(import.meta.dirname, '..', '..');
const REPOSITORY = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';
const HOUR = 60 * 60_000;

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

interface Join {
  readonly earlierRecords: readonly CaseRecord[];
  readonly run: SuiteJoinedRun;
  readonly testPattern: string | undefined;
  readonly files: readonly string[];
}

// R23: with AI_WORKFLOWS_SUITE_JOIN, read the earlier run, work out which tests the final run must
// redo and describe the earlier run for the report. Everything is checked before anything runs.
function prepareJoin(file: string): Join {
  const earlierRecords = readCaseRecords(file);
  const runIds = [...new Set(earlierRecords.map((record) => record.run))];
  if (runIds.length !== 1) {
    throw new Error(`La corrida anterior debe tener un solo identificador de corrida; tiene ${runIds.length}: ${runIds.join(', ')}.`);
  }
  const runId = runIds[0] ?? '';
  const retake = envList('AI_WORKFLOWS_SUITE_RETAKE');
  const files = new Set<string>();
  const testFilters: string[] = [];
  for (const id of retake) {
    const entry = SUITE_MANIFEST.find((item) => item.id === id);
    if (entry === undefined) throw new Error(`El caso a rehacer "${id}" no está en el manifiesto.`);
    if (entry.test === undefined) {
      throw new Error(`El caso a rehacer "${id}" no dice qué prueba rehacer (falta "test" en el manifiesto); la corrida final no puede correr sola.`);
    }
    files.add(`tests/github/${entry.file}.github.test.ts`);
    testFilters.push(entry.test);
  }
  const engineSha = process.env['AI_WORKFLOWS_SUITE_JOIN_ENGINE'] ?? '';
  if (engineSha.length === 0) {
    throw new Error('Falta AI_WORKFLOWS_SUITE_JOIN_ENGINE con el sha del motor de la corrida anterior.');
  }
  const retaken = new Set(retake);
  const cases = [...new Set(earlierRecords.map((record) => record.id))].filter((id) => id !== 'LIMPIEZA' && !retaken.has(id));
  return {
    earlierRecords,
    run: { run: runId, engineSha, testsPassed: false, cases },
    testPattern: testFilters.length === 0 ? undefined : testFilters.join('|'),
    files: [...files],
  };
}

it('runs the GitHub suite and writes its report', () => {
  expect(REPOSITORY, 'set AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo>').toMatch(/^[\w.-]+\/[\w.-]+$/);
  const records = join(ROOT, '.test-build', 'suite-negativa.jsonl');
  mkdirSync(join(ROOT, '.test-build'), { recursive: true });
  rmSync(records, { force: true });

  const joinFile = process.env['AI_WORKFLOWS_SUITE_JOIN'];
  const joining = joinFile !== undefined && joinFile.length > 0;
  const joinRun = joining ? prepareJoin(joinFile) : undefined;

  const args = ['run', '--config', 'vitest.github.config.ts'];
  if (joinRun?.testPattern !== undefined) args.push('-t', joinRun.testPattern);
  if (joinRun !== undefined) args.push(...joinRun.files);

  const suite = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, AI_WORKFLOWS_SUITE_REPORT: records },
    stdio: 'inherit',
  });
  const testsPassed = suite.status === 0;

  const engineSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(join(ROOT, 'docs', 'reports'), { recursive: true });
  const file = join(ROOT, 'docs', 'reports', `suite-negativa-${date}.md`);
  // Always a report, never silence (§3.1): a record file that cannot be read, or a record that the
  // report refuses, still leaves a report that says so in its first line.
  let text: string;
  let complete = false;
  try {
    const finalRecords = existsSync(records) ? readCaseRecords(records) : [];
    const run = finalRecords.find((record) => record.id === 'LIMPIEZA')?.run ?? finalRecords[0]?.run ?? 'sin-corrida';
    const read = joinRun === undefined ? finalRecords : [...joinRun.earlierRecords, ...finalRecords];
    const report = renderSuiteReport(read, {
      run,
      date,
      engineSha,
      repository: REPOSITORY,
      testsPassed,
      ...(joinRun === undefined ? {} : { runs: [joinRun.run] }),
    });
    text = report.text;
    complete = report.complete;
  } catch (error) {
    text = `# Falló: el registro de la corrida no se pudo convertir en informe (${error instanceof Error ? error.message : String(error)}).\n`;
  }
  writeFileSync(file, `${text}\n`, 'utf8');
  process.stdout.write(`\ninforme: docs/reports/suite-negativa-${date}.md (${complete ? 'completo' : 'no completo'})\n`);
}, 8 * HOUR);
