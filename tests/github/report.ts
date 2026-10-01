// PLAN-13-R5 §3: the report of the negative suite on real GitHub.
//
// This is a test tool, not part of the engine. It keeps the fixed manifest of cases, records each
// case as one JSON line, reads those records back strictly, and renders the report the owner
// reads. The report is saved in a public repository, so every field that came from a record is
// checked against machine paths, tokens and foreign links before it reaches the text.

import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { escapeReportText } from '../../src/judge/summary.js';

export type SuiteCaseKind = 'negative' | 'limit' | 'check';

export interface SuiteOwnerActs {
  readonly button?: true;
  readonly orders?: readonly string[];
  readonly pushes?: true;
  readonly dispatches?: true;
  /** PLAN-13-R6 §11: the suite cancels runs of the judge by hand with the owner account (R22). */
  readonly cancels?: true;
  /** PLAN-13-R6 §11: the suite writes, with the owner account, comments that are not orders (R22). */
  readonly comments?: true;
}

export interface SuiteManifestEntry {
  readonly id: string;
  /** The file under tests/github/ that runs the case. */
  readonly file: string;
  readonly kind: SuiteCaseKind;
  /** The owner acts EXPECTED in the case; the record must match them exactly. */
  readonly owner?: SuiteOwnerActs;
  /**
   * A slice of the test name that runs this case. It exists only for the cases a short final run
   * may redo on its own (R23), so the task can point vitest at exactly those tests.
   */
  readonly test?: string;
  /**
   * PLAN-13-R6 §11 (R29): the case is part of the evidence of slice 6, which a run may take on its
   * own. Such a run reports only these cases and refers to the earlier report for the rest.
   */
  readonly slice?: 6;
}

// §3.1 and the encargo: fixed order, thirteen negatives first, then the server cases, the recipe
// cases, the destination case, the queue, the run-through, the complete-piece control and the
// clean-up. The owner acts come from the real orders the tests write today; a test that changes an
// order changes this manifest in the same change.
export const SUITE_MANIFEST: readonly SuiteManifestEntry[] = [
  { id: 'CN-01', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-02', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-03', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-03e', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-04', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-05b', file: 'negative-suite', kind: 'negative', owner: { button: true } },
  { id: 'CN-05c', file: 'judge', kind: 'negative', owner: { orders: ['/approve'] } },
  { id: 'CN-06', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-07', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-08', file: 'judge', kind: 'negative' },
  { id: 'CN-09', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-10', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-11a', file: 'negative-suite', kind: 'negative' },
  { id: 'CN-11b', file: 'negative-suite', kind: 'limit' },
  { id: 'CN-12', file: 'final-stages', kind: 'negative' },
  { id: 'CN-13', file: 'final-stages', kind: 'negative' },
  { id: 'SV-01', file: 'judge', kind: 'negative' },
  { id: 'SV-02', file: 'judge', kind: 'negative' },
  { id: 'SV-03a', file: 'negative-suite', kind: 'negative', owner: { dispatches: true } },
  { id: 'SV-03b', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-03c', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-03d', file: 'negative-suite', kind: 'negative', owner: { dispatches: true } },
  { id: 'SV-04', file: 'judge', kind: 'negative', owner: { orders: ['/approve-judge-change'] } },
  { id: 'SV-04s', file: 'negative-suite', kind: 'negative', owner: { orders: ['/approve-judge-change'], pushes: true, dispatches: true } },
  { id: 'SV-05', file: 'judge', kind: 'negative' },
  { id: 'SV-06', file: 'judge', kind: 'negative' },
  { id: 'SV-07', file: 'judge', kind: 'negative' },
  { id: 'SV-08', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-09', file: 'judge', kind: 'negative' },
  { id: 'SV-DESTINO', file: 'judge', kind: 'check', owner: { orders: ['/approve'] } },
  { id: 'RC-06', file: 'judge', kind: 'negative', owner: { orders: ['/approve-judge-change'] } },
  { id: 'RC-09', file: 'rc09', kind: 'negative' },
  { id: 'COLA-6', file: 'negative-suite', kind: 'check', test: 'COLA-6' },
  { id: 'RECORRIDO', file: 'final-stages', kind: 'check', owner: { button: true }, test: 'a piece goes from the pull request to the merge queue' },
  { id: 'PIEZA-COMPLETA', file: 'negative-suite', kind: 'check' },
  // PLAN-13-R6 §11 (R29): the real evidence of slice 6. None of them needs an Approve button.
  { id: 'SV-04s+', file: 'negative-suite', kind: 'negative', owner: { orders: ['/approve-judge-change'] }, test: 'R29: SV-04s\+', slice: 6 },
  { id: 'CN-14', file: 'negative-suite', kind: 'negative', owner: { pushes: true, dispatches: true }, test: 'R29: CN-14', slice: 6 },
  { id: 'RAMA-1', file: 'negative-suite', kind: 'negative', test: 'R29: RAMA', slice: 6 },
  { id: 'RAMA-2', file: 'negative-suite', kind: 'negative', owner: { orders: ['/approve-judge-change'] }, test: 'R29: RAMA', slice: 6 },
  { id: 'A-T3', file: 'negative-suite', kind: 'check', owner: { cancels: true }, test: 'R29: A-T3', slice: 6 },
  { id: 'B-T6', file: 'negative-suite', kind: 'negative', owner: { cancels: true }, test: 'R29: B-T6', slice: 6 },
  { id: 'BOT-1', file: 'negative-suite', kind: 'negative', owner: { comments: true }, test: 'R29: BOT-1', slice: 6 },
  { id: 'LIMPIEZA', file: 'negative-suite', kind: 'check' },
];

/**
 * The cases a run reports on: the whole manifest, or — for the evidence of slice 6 (R29) — only
 * that slice and the clean-up of the run.
 */
export function manifestFor(scope: SuiteScope | undefined): readonly SuiteManifestEntry[] {
  if (scope === undefined) return SUITE_MANIFEST;
  return SUITE_MANIFEST.filter((entry) => entry.slice === scope.slice || entry.id === 'LIMPIEZA');
}

export type Stopper = 'gancho' | 'motor' | 'juez' | 'github';
export type NegativeOutcome = 'frenado' | 'no-frenado' | 'limite' | 'error';
export type PositiveOutcome = 'pasó' | 'falló' | 'no-aplica';
export type CheckResult = 'pasó' | 'falló';

export interface OwnerActs {
  readonly button?: true;
  readonly ordersBySuite?: readonly string[];
  readonly pushesBySuite?: true;
}

export interface CaseRecord {
  readonly run: string;
  readonly id: string;
  readonly attempt: string;
  readonly stoppedBy: readonly Stopper[];
  readonly negative: NegativeOutcome;
  readonly positive: PositiveOutcome;
  readonly evidence: readonly string[];
  readonly partial?: string;
  readonly result?: CheckResult;
  readonly owner?: OwnerActs;
}

/**
 * R23: an earlier run this report joins with the final one. `cases` is what that run gives; `run`
 * is the final run of the header, never one of these.
 */
export interface SuiteJoinedRun {
  readonly run: string;
  readonly engineSha: string;
  readonly testsPassed: boolean;
  readonly cases: readonly string[];
}

/**
 * PLAN-13-R6 §11 (R29): a run that gives only the evidence of one slice. `earlierReport` is the
 * report (a path in this repository) that holds the evidence of every other case of the suite.
 */
export interface SuiteScope {
  readonly slice: 6;
  readonly earlierReport: string;
}

export interface SuiteReportMeta {
  readonly run: string;
  readonly date: string;
  readonly engineSha: string;
  readonly repository: string;
  readonly testsPassed: boolean;
  /** The earlier runs joined with the final one, newest knowledge in the manifest order. */
  readonly runs?: readonly SuiteJoinedRun[];
  /** Only the cases of this slice (R29); the rest of the suite is in `earlierReport`. */
  readonly scope?: SuiteScope;
}

export interface SuiteReport {
  readonly text: string;
  readonly complete: boolean;
}

const STOPPERS: readonly Stopper[] = ['gancho', 'motor', 'juez', 'github'];
const NEGATIVES: readonly NegativeOutcome[] = ['frenado', 'no-frenado', 'limite', 'error'];
const POSITIVES: readonly PositiveOutcome[] = ['pasó', 'falló', 'no-aplica'];
const RESULTS: readonly CheckResult[] = ['pasó', 'falló'];

const RECORD_KEYS = new Set([
  'run',
  'id',
  'attempt',
  'stoppedBy',
  'negative',
  'positive',
  'evidence',
  'partial',
  'result',
  'owner',
]);
const REQUIRED_KEYS = ['run', 'id', 'attempt', 'stoppedBy', 'negative', 'positive', 'evidence'] as const;

// §3.1: each file records a case only when it ran; without the variable, nothing is written.
export function recordCase(record: CaseRecord): void {
  const target = process.env.AI_WORKFLOWS_SUITE_REPORT;
  if (target === undefined || target.length === 0) return;
  appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
}

function readString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw new Error(`Registro ilegible en la ${where}: "${key}" no es texto.`);
  return value;
}

function readStringList(value: unknown, key: string, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Registro ilegible en la ${where}: "${key}" no es una lista de textos.`);
  }
  return value as string[];
}

function readOwner(value: unknown, where: string): OwnerActs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Registro ilegible en la ${where}: "owner" no es un objeto.`);
  }
  const owner = value as Record<string, unknown>;
  for (const key of Object.keys(owner)) {
    if (key !== 'button' && key !== 'ordersBySuite' && key !== 'pushesBySuite') {
      throw new Error(`Registro ilegible en la ${where}: campo desconocido "owner.${key}".`);
    }
  }
  let button: true | undefined;
  if ('button' in owner) {
    if (owner.button !== true) throw new Error(`Registro ilegible en la ${where}: "owner.button" no es verdadero.`);
    button = true;
  }
  let ordersBySuite: string[] | undefined;
  if ('ordersBySuite' in owner) {
    ordersBySuite = readStringList(owner.ordersBySuite, 'owner.ordersBySuite', where);
  }
  let pushesBySuite: true | undefined;
  if ('pushesBySuite' in owner) {
    if (owner.pushesBySuite !== true) throw new Error(`Registro ilegible en la ${where}: "owner.pushesBySuite" no es verdadero.`);
    pushesBySuite = true;
  }
  return {
    ...(button === undefined ? {} : { button }),
    ...(ordersBySuite === undefined ? {} : { ordersBySuite }),
    ...(pushesBySuite === undefined ? {} : { pushesBySuite }),
  };
}

function parseCaseRecord(value: unknown, line: number): CaseRecord {
  const where = `línea ${line}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Registro ilegible en la ${where}: no es un objeto.`);
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!RECORD_KEYS.has(key)) throw new Error(`Registro ilegible en la ${where}: campo desconocido "${key}".`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in object)) throw new Error(`Registro ilegible en la ${where}: falta el campo "${key}".`);
  }

  const run = readString(object, 'run', where);
  const id = readString(object, 'id', where);
  const attempt = readString(object, 'attempt', where);

  const stoppedBy = readStringList(object.stoppedBy, 'stoppedBy', where);
  for (const stopper of stoppedBy) {
    if (!STOPPERS.includes(stopper as Stopper)) throw new Error(`Registro ilegible en la ${where}: "stoppedBy" con valor fuera de su lista.`);
  }

  const negative = readString(object, 'negative', where);
  if (!NEGATIVES.includes(negative as NegativeOutcome)) throw new Error(`Registro ilegible en la ${where}: "negative" con valor fuera de su lista.`);
  const positive = readString(object, 'positive', where);
  if (!POSITIVES.includes(positive as PositiveOutcome)) throw new Error(`Registro ilegible en la ${where}: "positive" con valor fuera de su lista.`);

  const evidence = readStringList(object.evidence, 'evidence', where);

  let partial: string | undefined;
  if ('partial' in object) partial = readString(object, 'partial', where);

  let result: CheckResult | undefined;
  if ('result' in object) {
    const raw = readString(object, 'result', where);
    if (!RESULTS.includes(raw as CheckResult)) throw new Error(`Registro ilegible en la ${where}: "result" con valor fuera de su lista.`);
    result = raw as CheckResult;
  }

  const owner = 'owner' in object ? readOwner(object.owner, where) : undefined;

  return {
    run,
    id,
    attempt,
    stoppedBy: stoppedBy as Stopper[],
    negative: negative as NegativeOutcome,
    positive: positive as PositiveOutcome,
    evidence,
    ...(partial === undefined ? {} : { partial }),
    ...(result === undefined ? {} : { result }),
    ...(owner === undefined ? {} : { owner }),
  };
}

// §3.1: one JSON line per case; a line that cannot be read names its line number, and a record with
// an unknown field or a value outside its list throws.
export function readCaseRecords(file: string): CaseRecord[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const records: CaseRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`No se pudo leer el registro: la línea ${index + 1} no es JSON válido.`);
    }
    records.push(parseCaseRecord(parsed, index + 1));
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// §3.3: sanitising. A record may not smuggle a machine path, a token, a private key or a link
// outside the rehearsal repository into a public report.

const PATH_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\/Users\//,
  /\/home\//,
  // A UNC path (`\\server\share`) starts with two backslashes.
  /\\\\/,
  // A Git Bash path (`/c/...`) has one letter between two slashes.
  /(^|[^A-Za-z0-9])\/[A-Za-z]\//,
  /(^|[^A-Za-z0-9])\/tmp\//,
];

// Three base64url parts separated by dots, headed by `eyJ`: the shape of a JWT.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function systemTemp(): string {
  return tmpdir().replace(/\\/g, '/').toLowerCase();
}

function findLeak(value: string): string | undefined {
  if (PATH_PATTERNS.some((pattern) => pattern.test(value))) return 'una ruta de la PC';
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  const temp = systemTemp();
  if (temp.length > 0 && normalized.includes(temp)) return 'una ruta de la PC';
  if (/gh[pousr]_[A-Za-z0-9]{8,}/.test(value)) return 'un token de GitHub';
  if (/github_pat_[A-Za-z0-9_]{20,}/.test(value)) return 'un token de GitHub';
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return 'una llave privada';
  if (JWT_PATTERN.test(value)) return 'algo con forma de token';
  return undefined;
}

function auditText(id: string, label: string, value: string): void {
  const leak = findLeak(value);
  if (leak !== undefined) throw new Error(`Caso ${id}: "${label}" lleva ${leak}.`);
}

/**
 * A path segment that is exactly `..` (or its percent-encoded form) climbs out of the repository;
 * the three dots inside a name (`compare/abc...def`) are a legitimate link, not a climb.
 */
function climbsOutOfRepository(link: string): boolean {
  for (const raw of link.split('/')) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      segment = raw;
    }
    if (segment === '..') return true;
  }
  return false;
}

function evidencePrefix(repository: string): string {
  return `https://github.com/${repository}/`;
}

function auditRecord(record: CaseRecord, repository: string): void {
  auditText(record.id, 'run', record.run);
  auditText(record.id, 'id', record.id);
  auditText(record.id, 'attempt', record.attempt);
  for (const stopper of record.stoppedBy) auditText(record.id, 'stoppedBy', stopper);
  auditText(record.id, 'negative', record.negative);
  auditText(record.id, 'positive', record.positive);
  if (record.partial !== undefined) auditText(record.id, 'partial', record.partial);
  if (record.result !== undefined) auditText(record.id, 'result', record.result);

  if (record.owner?.ordersBySuite !== undefined) {
    const orders = record.owner.ordersBySuite;
    if (orders.length === 0) throw new Error(`Caso ${record.id}: "ordersBySuite" está vacío.`);
    for (const order of orders) {
      auditText(record.id, 'ordersBySuite', order);
      if (!order.startsWith('/')) throw new Error(`Caso ${record.id}: la orden "${order}" no empieza con "/".`);
    }
  }

  const prefix = evidencePrefix(repository);
  for (const link of record.evidence) {
    auditText(record.id, 'evidence', link);
    if (climbsOutOfRepository(link) || /@/.test(link)) {
      throw new Error(`Caso ${record.id}: la evidencia "${link}" lleva una ruta que sale del repositorio de ensayo.`);
    }
    if (!link.startsWith(prefix)) {
      throw new Error(`Caso ${record.id}: la evidencia "${link}" no es del repositorio de ensayo.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// §3.2: rendering.

const STOPPER_LABEL: Readonly<Record<Stopper, string>> = {
  gancho: 'un gancho',
  motor: 'el motor',
  juez: 'el juez',
  github: 'GitHub',
};

function sameOrders(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((order, index) => order === actual[index]);
}

function sameOwner(expected: SuiteOwnerActs | undefined, actual: OwnerActs | undefined): boolean {
  const expectedButton = expected?.button === true;
  const actualButton = actual?.button === true;
  if (expectedButton !== actualButton) return false;
  const expectedPushes = expected?.pushes === true;
  const actualPushes = actual?.pushesBySuite === true;
  if (expectedPushes !== actualPushes) return false;
  return sameOrders(expected?.orders ?? [], actual?.ordersBySuite ?? []);
}

function stopperText(record: CaseRecord): string {
  if (record.stoppedBy.length === 0) return 'nadie';
  return record.stoppedBy.map((stopper) => STOPPER_LABEL[stopper]).join(', ');
}

interface Problem {
  readonly reason: string;
  readonly ids: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// R23: a dropped earlier record "passed" under the same rules as a counted one: a negative attempt
// stayed stopped (frenado, or limite for its declared limit), no positive control failed and a
// control case reported "pasó".
function droppedRecordPassed(entry: SuiteManifestEntry, record: CaseRecord): boolean {
  if (entry.kind === 'limit') {
    if (record.negative !== 'limite') return false;
  } else if (entry.kind === 'negative') {
    if (record.negative !== 'frenado') return false;
  }
  if (record.positive === 'falló') return false;
  if (entry.kind === 'check' && record.result !== 'pasó') return false;
  return true;
}

function droppedRecordText(entry: SuiteManifestEntry, record: CaseRecord): string {
  const detail = entry.kind === 'check'
    ? `resultado: ${escapeReportText(record.result ?? '')}`
    : `control positivo: ${escapeReportText(record.positive)}`;
  return `${escapeReportText(record.id)} (${escapeReportText(record.negative)}, ${detail})`;
}

/**
 * R23 and R35: the cases an earlier run gives when it is joined with a final run. They are its own
 * ids minus the clean-up (the one that counts is the final run's), minus every id the final run
 * recorded, and minus every retaken case: a retaken case comes only from the final run's real
 * records, so an earlier record of it never counts, even when the final run left it without one.
 */
export function earlierRunCases(earlier: readonly CaseRecord[], final: readonly CaseRecord[], retake: readonly string[]): string[] {
  const finalIds = new Set(final.map((record) => record.id));
  return unique(earlier.map((record) => record.id)).filter(
    (id) => id !== 'LIMPIEZA' && !finalIds.has(id) && !retake.includes(id),
  );
}

/**
 * The owner decision that joins runs: R23 for the suite, R35 for the evidence of slice 6.
 */
function joinDecision(scope: SuiteScope | undefined): string {
  return scope === undefined ? 'R23' : 'R35';
}

function joinNames(runs: readonly string[]): string {
  return runs.join(', ').replace(/, ([^,]*)$/, ' y $1');
}

export function renderSuiteReport(records: readonly CaseRecord[], meta: SuiteReportMeta): SuiteReport {
  // The header reaches the public report too: it goes through the same audit as every record.
  auditText('la corrida', 'run', meta.run);
  auditText('la corrida', 'date', meta.date);
  auditText('la corrida', 'engineSha', meta.engineSha);
  auditText('la corrida', 'repository', meta.repository);

  const joinedRuns = meta.runs ?? [];
  for (const run of joinedRuns) {
    auditText('la corrida', 'run', run.run);
    auditText('la corrida', 'engineSha', run.engineSha);
    for (const id of run.cases) auditText('la corrida', 'cases', id);
  }

  if (meta.scope !== undefined) auditText('la corrida', 'earlierReport', meta.scope.earlierReport);

  for (const record of records) auditRecord(record, meta.repository);

  // R29: the evidence of one slice reports only its cases; every other record is foreign to it.
  const manifest = manifestFor(meta.scope);

  const manifestById = new Map(manifest.map((entry) => [entry.id, entry]));
  const earlierRuns = new Map(joinedRuns.map((run) => [run.run, run]));

  // R23: a record counts if it is from the final run, or from a declared earlier run that gives the
  // case (`cases`). A record of an earlier run whose case it does not give does not count: it is
  // neither repeated nor "from another run", and the case is missing if nobody else gives it. The
  // clean-up of an earlier run is never a case (the final one decides), though it is shown.
  const firstById = new Map<string, CaseRecord>();
  const recordsById = new Map<string, CaseRecord[]>();
  const extras: string[] = [];
  const undeclared: string[] = [];
  // R23: a record of an earlier run whose case that run does not give is dropped from the count,
  // but it is not silent: it is listed per run and, if it did not pass, it keeps the report from
  // being complete. The clean-up is shown in its own run's line and never lands here.
  const droppedByRun = new Map<string, CaseRecord[]>();

  for (const record of records) {
    if (!manifestById.has(record.id)) {
      extras.push(record.id);
      continue;
    }
    if (record.run !== meta.run) {
      const earlier = earlierRuns.get(record.run);
      if (earlier === undefined) {
        undeclared.push(record.id);
        continue;
      }
      if (record.id === 'LIMPIEZA') continue;
      if (!earlier.cases.includes(record.id)) {
        const dropped = droppedByRun.get(record.run) ?? [];
        dropped.push(record);
        droppedByRun.set(record.run, dropped);
        continue;
      }
    }
    const seen = recordsById.get(record.id) ?? [];
    seen.push(record);
    recordsById.set(record.id, seen);
    if (!firstById.has(record.id)) firstById.set(record.id, record);
  }

  // A case is repeated if two runs give it — the final one (by its record) and an earlier one (by
  // its declaration) — or if one run gives it twice.
  const declaringRuns = new Map<string, Set<string>>();
  const declare = (id: string, run: string): void => {
    const runs = declaringRuns.get(id) ?? new Set<string>();
    runs.add(run);
    declaringRuns.set(id, runs);
  };
  for (const run of joinedRuns) for (const id of run.cases) if (manifestById.has(id)) declare(id, run.run);
  for (const record of records) if (record.run === meta.run && manifestById.has(record.id)) declare(record.id, meta.run);

  const repeated = manifest.filter((entry) => {
    const list = recordsById.get(entry.id) ?? [];
    const runs = new Set(list.map((record) => record.run));
    return runs.size !== list.length || (declaringRuns.get(entry.id)?.size ?? 0) > 1;
  }).map((entry) => entry.id);

  const problems: Problem[] = [];

  const missing = manifest.filter((entry) => !firstById.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) problems.push({ reason: 'faltan casos del manifiesto', ids: missing });

  if (extras.length > 0) problems.push({ reason: 'hay casos que no están en el manifiesto', ids: unique(extras) });
  if (repeated.length > 0) problems.push({ reason: 'hay casos repetidos', ids: repeated });
  if (undeclared.length > 0) problems.push({ reason: `hay casos de otra corrida`, ids: unique(undeclared) });

  const notStopped: string[] = [];
  const positivesFailed: string[] = [];
  const badResult: string[] = [];
  const noEvidence: string[] = [];
  const partials: string[] = [];
  const ownerMismatch: string[] = [];

  for (const entry of manifest) {
    const record = firstById.get(entry.id);
    if (record === undefined) continue;

    if (entry.kind === 'limit') {
      if (record.negative !== 'limite') notStopped.push(entry.id);
    } else if (entry.kind === 'negative') {
      if (record.negative !== 'frenado') notStopped.push(entry.id);
    }

    if (entry.kind === 'negative' && record.positive === 'falló') positivesFailed.push(entry.id);

    if (entry.kind === 'check') {
      if (record.result !== 'pasó') badResult.push(entry.id);
    } else if (record.result !== undefined) {
      badResult.push(entry.id);
    }

    if (record.evidence.length === 0) noEvidence.push(entry.id);
    if (record.partial !== undefined) partials.push(entry.id);
    if (!sameOwner(entry.owner, record.owner)) ownerMismatch.push(entry.id);
  }

  if (notStopped.length > 0) problems.push({ reason: 'intentos que no quedaron frenados', ids: notStopped });
  if (positivesFailed.length > 0) problems.push({ reason: 'controles positivos que no pasaron', ids: positivesFailed });
  if (badResult.length > 0) problems.push({ reason: 'casos de control sin resultado "pasó" o negativos con resultado', ids: badResult });
  if (noEvidence.length > 0) problems.push({ reason: 'casos sin evidencia', ids: noEvidence });
  if (partials.length > 0) problems.push({ reason: 'casos parciales', ids: partials });
  if (ownerMismatch.length > 0) problems.push({ reason: 'actos del dueño que no coinciden con el manifiesto', ids: ownerMismatch });

  const dropped = [...droppedByRun.values()].flat();
  const droppedNotPassed = manifest.filter((entry) =>
    dropped.some((record) => record.id === entry.id && !droppedRecordPassed(entry, record)),
  ).map((entry) => entry.id);
  if (droppedNotPassed.length > 0) problems.push({ reason: 'registros anteriores que no pasaron', ids: droppedNotPassed });

  const complete = meta.testsPassed && problems.length === 0;

  const lines: string[] = [];
  const scopeText = meta.scope === undefined ? '' : ` para la evidencia de la rebanada ${meta.scope.slice} (R29)`;
  const decision = joinDecision(meta.scope);
  const names = joinNames([...joinedRuns.map((run) => run.run), meta.run]);
  if (complete) {
    if (joinedRuns.length > 0) {
      lines.push(
        `# Completo${scopeText}: ${manifest.length} casos en ${joinedRuns.length + 1} corridas juntadas por decisión del dueño (${decision}): ${names}; cada intento frenado y cada control positivo en verde.`,
      );
    } else {
      lines.push(`# Completo${scopeText}: ${manifest.length} casos, todos en la corrida ${meta.run}, cada intento frenado y cada control positivo en verde.`);
    }
  } else {
    const reasons: string[] = [];
    if (!meta.testsPassed) reasons.push('las pruebas de la corrida no terminaron en verde');
    for (const problem of problems) reasons.push(`${problem.reason}: ${problem.ids.join(', ')}`);
    const heading = meta.testsPassed ? 'Incompleto' : 'Falló';
    // R23 and R35: the first line declares the joined runs whatever the outcome.
    const joinedText = joinedRuns.length === 0
      ? ''
      : ` ${manifest.length} casos en ${joinedRuns.length + 1} corridas juntadas por decisión del dueño (${decision}): ${names}.`;
    lines.push(`# ${heading}${scopeText}: ${reasons.join('; ')}.${joinedText}`);
  }

  if (meta.scope !== undefined) {
    // R29: the report says which cases come from this run and where the rest of the suite is; it
    // never claims a case it did not run. R35: joined, it is the report, not one run, that gives them.
    const own = manifest.map((entry) => entry.id).filter((id) => id !== 'LIMPIEZA');
    lines.push(
      joinedRuns.length === 0
        ? `Alcance: esta corrida da solo la evidencia de la rebanada ${meta.scope.slice} (R29): ${own.join(', ')}, más su limpieza. No repitió los demás casos de la suite: su evidencia es el informe ${meta.scope.earlierReport}, que esta corrida no cambia.`
        : `Alcance: este informe da solo la evidencia de la rebanada ${meta.scope.slice} (R29), juntando ${joinedRuns.length + 1} corridas (${decision}): ${own.join(', ')}, más la limpieza de la corrida final. No repitió los demás casos de la suite: su evidencia es el informe ${meta.scope.earlierReport}, que este informe no cambia.`,
    );
  }
  lines.push(`Corrida: ${meta.run}`);
  for (const run of joinedRuns) {
    const cleanup = records.find((record) => record.run === run.run && record.id === 'LIMPIEZA');
    const cleanupText = cleanup?.result === 'pasó' ? 'pasó' : cleanup?.result === 'falló' ? 'falló' : 'sin registro';
    const cases = manifest.map((entry) => entry.id).filter((id) => run.cases.includes(id));
    lines.push(
      `Corrida anterior: ${run.run} (motor ${run.engineSha}; pruebas: ${run.testsPassed ? 'en verde' : 'no en verde'}; limpieza: ${cleanupText}) aporta: ${cases.length === 0 ? 'nada' : cases.join(', ')}.`,
    );
    const droppedRecords = droppedByRun.get(run.run) ?? [];
    if (droppedRecords.length > 0) {
      const items: string[] = [];
      for (const entry of manifest) {
        for (const record of droppedRecords) {
          if (record.id === entry.id) items.push(droppedRecordText(entry, record));
        }
      }
      lines.push(
        `Registros de ${run.run} que no cuentan (los rehízo la corrida final o no se aportan): ${items.join(', ')}.`,
      );
    }
  }
  if (joinedRuns.length > 0) {
    // R23 and R35: the final run is declared like the earlier ones; its clean-up is the one that counts.
    const cleanup = records.find((record) => record.run === meta.run && record.id === 'LIMPIEZA');
    const cleanupText = cleanup?.result === 'pasó' ? 'pasó' : cleanup?.result === 'falló' ? 'falló' : 'sin registro';
    const cases = manifest.map((entry) => entry.id).filter(
      (id) => id !== 'LIMPIEZA' && records.some((record) => record.run === meta.run && record.id === id),
    );
    lines.push(
      `Corrida final: ${meta.run} (motor ${meta.engineSha}; pruebas: ${meta.testsPassed ? 'en verde' : 'no en verde'}; limpieza: ${cleanupText}, la que cuenta) aporta: ${cases.length === 0 ? 'nada' : cases.join(', ')}.`,
    );
  }
  lines.push(`Fecha: ${meta.date}`);
  lines.push(`Motor: ${meta.engineSha}`);
  lines.push(`Repositorio: ${meta.repository}`);
  lines.push(`Pruebas de la corrida: ${meta.testsPassed ? 'en verde' : 'no en verde'}`);

  const attempted = manifest.filter((entry) => firstById.has(entry.id)).length;
  const stopped = manifest.filter((entry) => {
    const record = firstById.get(entry.id);
    if (record === undefined) return false;
    if (entry.kind === 'limit') return record.negative === 'limite';
    if (entry.kind === 'negative') return record.negative === 'frenado';
    return false;
  }).length;
  const pending = unique(problems.flatMap((problem) => problem.ids));
  lines.push(`Intentos: ${attempted} de ${manifest.length} casos del manifiesto.`);
  lines.push(`Frenados: ${stopped} intentos quedaron frenados.`);
  lines.push(`Falta: ${pending.length === 0 ? 'nada' : pending.join(', ')}.`);

  lines.push('', '## Qué hizo el dueño y qué se hizo con su cuenta', '');
  // The section says what the records really carry, not only what the manifest expects.
  const buttonCases = manifest.filter((entry) => firstById.get(entry.id)?.owner?.button === true).map((entry) => entry.id);
  const orderCases = manifest.map((entry) => ({ entry, record: firstById.get(entry.id) }))
    .filter((item) => (item.record?.owner?.ordersBySuite?.length ?? 0) > 0)
    .map((item) => ({ id: item.entry.id, orders: item.record?.owner?.ordersBySuite ?? [] }));
  lines.push(
    buttonCases.length > 0
      ? `El dueño pulsó «Approve» en persona en: ${buttonCases.join(', ')}.`
      : 'El dueño no pulsó «Approve» en persona en ningún caso.',
  );
  lines.push(
    orderCases.length > 0
      ? `La suite escribió órdenes del dueño con su cuenta (R22): ${orderCases.map((item) => `${item.id} (${item.orders.join(', ')})`).join(', ')}.`
      : 'La suite no escribió órdenes del dueño con su cuenta.',
  );
  const pushCases = manifest.filter((entry) => firstById.get(entry.id)?.owner?.pushesBySuite === true).map((entry) => entry.id);
  lines.push(
    pushCases.length > 0
      ? `La suite subió con la cuenta del dueño cambios que GitHub no deja subir a los agentes (R22): ${pushCases.join(', ')}.`
      : 'Ningún caso necesitó subir con la cuenta del dueño un cambio que GitHub no deja subir a los agentes.',
  );
  const judgeCases = manifest.filter((entry) => (entry.file === 'judge' || entry.file === 'rc09') && firstById.has(entry.id)).map((entry) => entry.id);
  if (judgeCases.length > 0) {
    lines.push(
      `Estos casos actúan en GitHub con la cuenta del dueño, no con la aplicación de los agentes: suben sus ramas y abren sus PRs y, según el caso, editan PRs, arman fusiones, lanzan o cancelan corridas del juez (R22): ${judgeCases.join(', ')}.`,
    );
  }
  const dispatchCases = manifest.filter((entry) => entry.owner?.dispatches === true && firstById.has(entry.id)).map((entry) => entry.id);
  if (dispatchCases.length > 0) {
    lines.push(
      `La suite lanzó a mano corridas del juez con la cuenta del dueño, en vez de esperar un evento (R22): ${dispatchCases.join(', ')}.`,
    );
  }
  const cancelCases = manifest.filter((entry) => entry.owner?.cancels === true && firstById.has(entry.id)).map((entry) => entry.id);
  if (cancelCases.length > 0) {
    lines.push(`La suite canceló a mano corridas del juez con la cuenta del dueño, para ver qué estado dejan (R22): ${cancelCases.join(', ')}.`);
  }
  const commentCases = manifest.filter((entry) => entry.owner?.comments === true && firstById.has(entry.id)).map((entry) => entry.id);
  if (commentCases.length > 0) {
    lines.push(`La suite escribió con la cuenta del dueño comentarios que no son órdenes, como control de que un comentario de una persona sí despierta al juez (R22): ${commentCases.join(', ')}.`);
  }
  const branchCases = manifest.filter((entry) => (entry.id === 'RAMA-1' || entry.id === 'RAMA-2') && firstById.has(entry.id)).map((entry) => entry.id);
  if (branchCases.length > 0) {
    lines.push(`Para ${branchCases.join(' y ')} la suite creó con la cuenta del dueño la rama staging, escribió en ella y cambió en main la receta y el flujo del juez para declarar las ramas de trabajo; todo se repuso al final (R22).`);
  }
  lines.push('La suite también usó la cuenta del dueño para preparar y restaurar el ensayo, crear los issues y las ramas de las piezas, cambiar la variable del motor, prender y apagar flujos, quitar y reponer checks exigidos en la protección de main, escribir a mano registros del motor en las trampas que los falsifican y crear despliegues de prueba (R22).');

  lines.push('', '| Caso | Qué se intentó | Quién lo frenó | Control positivo | Por qué sabemos que no pasó nada |');
  lines.push('|---|---|---|---|---|');
  for (const entry of manifest) {
    const record = firstById.get(entry.id);
    if (record === undefined) continue;
    const evidence = record.evidence.map((link) => escapeReportText(link)).join(' ');
    lines.push(
      `| ${escapeReportText(entry.id)} | ${escapeReportText(record.attempt)} | ${escapeReportText(stopperText(record))} | ${escapeReportText(record.positive)} | ${evidence} |`,
    );
  }

  const limitEntries = manifest.filter((entry) => entry.kind === 'limit');
  const partialRecords = manifest.map((entry) => firstById.get(entry.id)).filter(
    (record): record is CaseRecord => record !== undefined && record.partial !== undefined,
  );
  if (limitEntries.length > 0 || partialRecords.length > 0) {
    lines.push('', '## Casos parciales y límites');
    for (const entry of limitEntries) {
      lines.push(`- ${entry.id}: límite declarado; no lo frena nadie y se muestra como límite, nunca como frenado.`);
    }
    for (const record of partialRecords) {
      lines.push(`- ${escapeReportText(record.id)} (parcial): ${escapeReportText(record.partial ?? '')}`);
    }
  }

  return { text: lines.join('\n'), complete };
}
