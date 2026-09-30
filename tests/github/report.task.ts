import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SUITE_MANIFEST, readCaseRecords, renderSuiteReport, type CaseRecord, type SuiteJoinedRun, type SuiteScope } from './report.js';

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
//
// R29 (PLAN-13-R6 §11): with AI_WORKFLOWS_SUITE_SLICE=6 the task runs only the cases of slice 6
// (and the clean-up of its run) and writes docs/reports/evidencia-rebanada-6-<date>.md, which says
// which cases come from this run and refers to the report of 29-sep for the rest of the suite.

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
  readonly run: Omit<SuiteJoinedRun, 'cases'>;
  readonly testPattern: string | undefined;
  readonly files: readonly string[];
}

// R23: with AI_WORKFLOWS_SUITE_JOIN, read the earlier run, work out which tests the final run must
// redo and describe the earlier run for the report. Everything is checked before anything runs. The
// cases the earlier run gives are decided later, from what the final run really records.
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
  return {
    earlierRecords,
    run: { run: runId, engineSha, testsPassed: false },
    testPattern: testFilters.length === 0 ? undefined : testFilters.join('|'),
    files: [...files],
  };
}

// R29: the report that holds the evidence of every case the slice run does not repeat.
const EARLIER_REPORT = 'docs/reports/suite-negativa-2026-09-29.md';

interface Slice {
  readonly scope: SuiteScope;
  readonly testPattern: string;
  readonly files: readonly string[];
}

function prepareSlice(value: string): Slice {
  if (value !== '6') throw new Error(`AI_WORKFLOWS_SUITE_SLICE solo admite 6 (R29); vale "${value}".`);
  if (!existsSync(join(ROOT, EARLIER_REPORT))) throw new Error(`Falta el informe anterior ${EARLIER_REPORT}, al que remite la evidencia de la rebanada 6.`);
  const entries = SUITE_MANIFEST.filter((entry) => entry.slice === 6);
  const tests: string[] = [];
  for (const entry of entries) {
    if (entry.test === undefined) throw new Error(`El caso "${entry.id}" de la rebanada 6 no dice qué prueba correr (falta "test" en el manifiesto).`);
    if (!tests.includes(entry.test)) tests.push(entry.test);
  }
  return {
    scope: { slice: 6, earlierReport: EARLIER_REPORT },
    testPattern: tests.join('|'),
    files: [...new Set(entries.map((entry) => `tests/github/${entry.file}.github.test.ts`))],
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
  const sliceValue = process.env['AI_WORKFLOWS_SUITE_SLICE'];
  const slice = sliceValue !== undefined && sliceValue.length > 0 ? prepareSlice(sliceValue) : undefined;

  const args = ['run', '--config', 'vitest.github.config.ts'];
  // A retake (R23) runs exactly its cases; otherwise the slice (R29) runs all of its own.
  if (joinRun !== undefined) {
    if (joinRun.testPattern !== undefined) args.push('-t', joinRun.testPattern);
    args.push(...joinRun.files);
  } else if (slice !== undefined) {
    args.push('-t', slice.testPattern, ...slice.files);
  }

  const suite = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, AI_WORKFLOWS_SUITE_REPORT: records },
    stdio: 'inherit',
  });
  const testsPassed = suite.status === 0;

  const engineSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(join(ROOT, 'docs', 'reports'), { recursive: true });
  const name = slice === undefined ? `suite-negativa-${date}.md` : `evidencia-rebanada-${slice.scope.slice}-${date}.md`;
  const file = join(ROOT, 'docs', 'reports', name);
  // Always a report, never silence (§3.1): a record file that cannot be read, or a record that the
  // report refuses, still leaves a report that says so in its first line.
  let text: string;
  let complete = false;
  try {
    const finalRecords = existsSync(records) ? readCaseRecords(records) : [];
    const run = finalRecords.find((record) => record.id === 'LIMPIEZA')?.run ?? finalRecords[0]?.run ?? 'sin-corrida';
    const read = joinRun === undefined ? finalRecords : [...joinRun.earlierRecords, ...finalRecords];
    // R23: the earlier run gives the cases whose records the final run did NOT produce: its own ids,
    // minus the clean-up and minus every id the final run recorded. RETAKE only decides what runs.
    const finalIds = new Set(finalRecords.map((record) => record.id));
    const earlierCases = [...new Set(joinRun?.earlierRecords.map((record) => record.id) ?? [])].filter(
      (id) => id !== 'LIMPIEZA' && !finalIds.has(id),
    );
    const report = renderSuiteReport(read, {
      run,
      date,
      engineSha,
      repository: REPOSITORY,
      testsPassed,
      ...(joinRun === undefined ? {} : { runs: [{ ...joinRun.run, cases: earlierCases }] }),
      ...(slice === undefined ? {} : { scope: slice.scope }),
    });
    text = report.text;
    complete = report.complete;
  } catch (error) {
    text = `# Falló: el registro de la corrida no se pudo convertir en informe (${error instanceof Error ? error.message : String(error)}).\n`;
  }
  writeFileSync(file, `${text}\n`, 'utf8');
  process.stdout.write(`\ninforme: docs/reports/${name} (${complete ? 'completo' : 'no completo'})\n`);
}, 8 * HOUR);
