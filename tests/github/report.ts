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
}

export interface SuiteManifestEntry {
  readonly id: string;
  /** The file under tests/github/ that runs the case. */
  readonly file: string;
  readonly kind: SuiteCaseKind;
  /** The owner acts EXPECTED in the case; the record must match them exactly. */
  readonly owner?: SuiteOwnerActs;
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
  { id: 'SV-03a', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-03b', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-03c', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-03d', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-04', file: 'judge', kind: 'negative', owner: { orders: ['/approve-judge-change'] } },
  { id: 'SV-04s', file: 'negative-suite', kind: 'negative', owner: { orders: ['/approve-judge-change'], pushes: true } },
  { id: 'SV-05', file: 'judge', kind: 'negative' },
  { id: 'SV-06', file: 'judge', kind: 'negative' },
  { id: 'SV-07', file: 'judge', kind: 'negative' },
  { id: 'SV-08', file: 'negative-suite', kind: 'negative' },
  { id: 'SV-09', file: 'judge', kind: 'negative' },
  { id: 'SV-DESTINO', file: 'judge', kind: 'check', owner: { orders: ['/approve'] } },
  { id: 'RC-06', file: 'judge', kind: 'negative', owner: { orders: ['/approve-judge-change'] } },
  { id: 'RC-09', file: 'rc09', kind: 'negative' },
  { id: 'COLA-6', file: 'negative-suite', kind: 'check' },
  { id: 'RECORRIDO', file: 'final-stages', kind: 'check', owner: { button: true } },
  { id: 'PIEZA-COMPLETA', file: 'negative-suite', kind: 'check' },
  { id: 'LIMPIEZA', file: 'negative-suite', kind: 'check' },
];

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

export interface SuiteReportMeta {
  readonly run: string;
  readonly date: string;
  readonly engineSha: string;
  readonly repository: string;
  readonly testsPassed: boolean;
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

export function renderSuiteReport(records: readonly CaseRecord[], meta: SuiteReportMeta): SuiteReport {
  // The header reaches the public report too: it goes through the same audit as every record.
  auditText('la corrida', 'run', meta.run);
  auditText('la corrida', 'date', meta.date);
  auditText('la corrida', 'engineSha', meta.engineSha);
  auditText('la corrida', 'repository', meta.repository);

  for (const record of records) auditRecord(record, meta.repository);

  const manifestById = new Map(SUITE_MANIFEST.map((entry) => [entry.id, entry]));
  const firstById = new Map<string, CaseRecord>();
  const extras: string[] = [];
  const duplicates: string[] = [];
  for (const record of records) {
    if (!manifestById.has(record.id)) {
      extras.push(record.id);
      continue;
    }
    if (firstById.has(record.id)) {
      duplicates.push(record.id);
      continue;
    }
    firstById.set(record.id, record);
  }

  const problems: Problem[] = [];

  const missing = SUITE_MANIFEST.filter((entry) => !firstById.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) problems.push({ reason: 'faltan casos del manifiesto', ids: missing });

  if (extras.length > 0) problems.push({ reason: 'hay casos que no están en el manifiesto', ids: unique(extras) });
  if (duplicates.length > 0) problems.push({ reason: 'hay casos repetidos', ids: unique(duplicates) });

  const otherRun = unique(records.filter((record) => record.run !== meta.run).map((record) => record.id));
  if (otherRun.length > 0) problems.push({ reason: `hay casos de otra corrida`, ids: otherRun });

  const notStopped: string[] = [];
  const positivesFailed: string[] = [];
  const badResult: string[] = [];
  const noEvidence: string[] = [];
  const partials: string[] = [];
  const ownerMismatch: string[] = [];

  for (const entry of SUITE_MANIFEST) {
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

  const complete = meta.testsPassed && problems.length === 0;

  const lines: string[] = [];
  if (complete) {
    lines.push(`# Completo: ${SUITE_MANIFEST.length} casos, todos en la corrida ${meta.run}, cada intento frenado y cada control positivo en verde.`);
  } else {
    const reasons: string[] = [];
    if (!meta.testsPassed) reasons.push('las pruebas de la corrida no terminaron en verde');
    for (const problem of problems) reasons.push(`${problem.reason}: ${problem.ids.join(', ')}`);
    const heading = meta.testsPassed ? 'Incompleto' : 'Falló';
    lines.push(`# ${heading}: ${reasons.join('; ')}.`);
  }

  lines.push(`Corrida: ${meta.run}`);
  lines.push(`Fecha: ${meta.date}`);
  lines.push(`Motor: ${meta.engineSha}`);
  lines.push(`Repositorio: ${meta.repository}`);
  lines.push(`Pruebas de la corrida: ${meta.testsPassed ? 'en verde' : 'no en verde'}`);

  const attempted = SUITE_MANIFEST.filter((entry) => firstById.has(entry.id)).length;
  const stopped = SUITE_MANIFEST.filter((entry) => {
    const record = firstById.get(entry.id);
    if (record === undefined) return false;
    if (entry.kind === 'limit') return record.negative === 'limite';
    if (entry.kind === 'negative') return record.negative === 'frenado';
    return false;
  }).length;
  const pending = unique(problems.flatMap((problem) => problem.ids));
  lines.push(`Intentos: ${attempted} de ${SUITE_MANIFEST.length} casos del manifiesto.`);
  lines.push(`Frenados: ${stopped} intentos quedaron frenados.`);
  lines.push(`Falta: ${pending.length === 0 ? 'nada' : pending.join(', ')}.`);

  lines.push('', '## Qué hizo el dueño y qué se hizo con su cuenta', '');
  // The section says what the records really carry, not only what the manifest expects.
  const buttonCases = SUITE_MANIFEST.filter((entry) => firstById.get(entry.id)?.owner?.button === true).map((entry) => entry.id);
  const orderCases = SUITE_MANIFEST.map((entry) => ({ entry, record: firstById.get(entry.id) }))
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
  const pushCases = SUITE_MANIFEST.filter((entry) => firstById.get(entry.id)?.owner?.pushesBySuite === true).map((entry) => entry.id);
  lines.push(
    pushCases.length > 0
      ? `La suite subió con la cuenta del dueño cambios que GitHub no deja subir a los agentes (R22): ${pushCases.join(', ')}.`
      : 'Ningún caso necesitó subir con la cuenta del dueño un cambio que GitHub no deja subir a los agentes.',
  );
  const judgeCases = SUITE_MANIFEST.filter((entry) => entry.file === 'judge' && firstById.has(entry.id)).map((entry) => entry.id);
  if (judgeCases.length > 0) {
    lines.push(
      `En los casos del juez de la rebanada 3, las ramas se suben y los PRs se abren con la cuenta del dueño, no con la aplicación de los agentes (R22): ${judgeCases.join(', ')}.`,
    );
  }
  lines.push('La preparación y la restauración del ensayo también usaron la cuenta del dueño (R22).');

  lines.push('', '| Caso | Qué se intentó | Quién lo frenó | Control positivo | Por qué sabemos que no pasó nada |');
  lines.push('|---|---|---|---|---|');
  for (const entry of SUITE_MANIFEST) {
    const record = firstById.get(entry.id);
    if (record === undefined) continue;
    const evidence = record.evidence.map((link) => escapeReportText(link)).join(' ');
    lines.push(
      `| ${escapeReportText(entry.id)} | ${escapeReportText(record.attempt)} | ${escapeReportText(stopperText(record))} | ${escapeReportText(record.positive)} | ${evidence} |`,
    );
  }

  const limitEntries = SUITE_MANIFEST.filter((entry) => entry.kind === 'limit');
  const partialRecords = SUITE_MANIFEST.map((entry) => firstById.get(entry.id)).filter(
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
