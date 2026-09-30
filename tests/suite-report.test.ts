import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_BANNED_TERMS, findBannedTerms } from '../src/messages.js';

import { SUITE_MANIFEST, readCaseRecords, renderSuiteReport, type CaseRecord } from './github/report.js';

// PLAN-13-R5 §3: the report of the negative suite on real GitHub. It may only say "complete" when
// every case of the fixed manifest ran in THIS run, every attempt was stopped, every positive
// control passed, each has evidence and the final clean-up was verified. The report goes into a
// public repository, so everything in it is checked for paths of the machine, tokens and foreign
// links.

const REPO = 'socialabs-margin/ai-workflows-pruebas';
const RUN = 'r-4821';
const META = { run: RUN, date: '2026-09-25', engineSha: 'a'.repeat(40), repository: REPO, testsPassed: true };
const link = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function good(id: string, index: number): CaseRecord {
  const entry = SUITE_MANIFEST.find((item) => item.id === id);
  const limit = entry?.kind === 'limit';
  return {
    run: RUN,
    id,
    attempt: `Intento ${id}: el agente trata de saltarse un paso`,
    stoppedBy: limit ? [] : ['juez'],
    negative: limit ? 'limite' : 'frenado',
    positive: limit || entry?.kind === 'check' ? 'no-aplica' : 'pasó',
    evidence: [link(100 + index)],
    ...(entry?.kind === 'check' ? { result: 'pasó' as const } : {}),
    ...(entry?.owner === undefined
      ? {}
      : { owner: { ...(entry.owner.button ? { button: true as const } : {}), ...(entry.owner.orders ? { ordersBySuite: [...entry.owner.orders] } : {}), ...(entry.owner.pushes ? { pushesBySuite: true as const } : {}) } }),
  };
}

const allGood = (): CaseRecord[] => SUITE_MANIFEST.map((entry, index) => good(entry.id, index));

describe('what the owner did and what the suite did with the owner account (R22)', () => {
  it('lists the cases with the owner button and those with orders written by the suite, citing R22', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const section = text.slice(text.indexOf('Qué hizo el dueño y qué se hizo con su cuenta'));
    expect(text).toContain('Qué hizo el dueño y qué se hizo con su cuenta');
    expect(section).toMatch(/R22/);
    const buttons = section.slice(0, section.indexOf('CN-05c'));
    expect(buttons).toContain('CN-05b');
    expect(buttons).toContain('RECORRIDO');
    expect(section).toContain('/approve-judge-change');
    expect(text.indexOf('Qué hizo el dueño')).toBeLessThan(text.indexOf('| CN-01'));
  });

  it('the manifest fixes the owner acts of each case, with the real orders', () => {
    const acts = Object.fromEntries(SUITE_MANIFEST.filter((entry) => entry.owner !== undefined).map((entry) => [entry.id, entry.owner]));
    expect(acts).toEqual({
      'CN-05b': { button: true },
      'CN-05c': { orders: ['/approve'] },
      'SV-DESTINO': { orders: ['/approve'] },
      'RC-06': { orders: ['/approve-judge-change'] },
      'SV-04': { orders: ['/approve-judge-change'] },
      'SV-04s': { orders: ['/approve-judge-change'], pushes: true, dispatches: true },
      'SV-03a': { dispatches: true },
      'SV-03d': { dispatches: true },
      RECORRIDO: { button: true },
      // PLAN-13-R6 §11 (R29): the cases of slice 6 need no Approve button.
      'SV-04s+': { orders: ['/approve-judge-change'] },
      'CN-14': { pushes: true, dispatches: true },
      'RAMA-2': { orders: ['/approve-judge-change'] },
      'A-T3': { cancels: true },
      'B-T6': { cancels: true },
      'BOT-1': { comments: true },
    });
  });

  // Flock round 9: outside the judge file, some cases start runs of the judge by hand with the
  // owner account (`gh workflow run`) instead of waiting for an event. The report names them.
  it('names the cases that start runs of the judge by hand with the owner account', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const row = text.split('\n').find((line) => line.includes('lanzó a mano corridas del juez')) ?? '';
    for (const id of ['SV-03a', 'SV-03d', 'SV-04s']) expect(row, id).toContain(id);
    for (const id of ['SV-03b', 'SV-03c', 'CN-01']) expect(row, id).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(row).toContain('R22');
    const without = renderSuiteReport(allGood().filter((record) => record.id !== 'SV-03d'), META).text;
    expect(without.split('\n').find((line) => line.includes('lanzó a mano corridas del juez'))).not.toMatch(/SV-03d/);
  });

  // Found in the real run, part 5: GitHub refuses the agents' app a change to a workflow file, so
  // for SV-04s the suite pushes that change with the owner's account (R22). The report says so.
  it('says which changes the suite pushed with the owner account, citing R22', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const section = text.slice(text.indexOf('Qué hizo el dueño y qué se hizo con su cuenta'), text.indexOf('| Caso'));
    const pushes = section.split('\n').find((row) => row.includes('subió con la cuenta del dueño')) ?? '';
    expect(pushes).toContain('SV-04s');
    expect(pushes).toContain('R22');
    expect(pushes).not.toContain('CN-01');
  });

  it('with no such change, it says so without denying the other uses of the owner account', () => {
    // CN-14 (R29) pushes its impostor workflows with the owner account too: both go without it here.
    const records = allGood().map((record) => {
      if (record.id === 'SV-04s') return { ...record, owner: { ordersBySuite: ['/approve-judge-change'] } };
      if (record.id === 'CN-14') {
        const { owner: _owner, ...rest } = record;
        return rest;
      }
      return record;
    });
    const text = renderSuiteReport(records, META).text;
    expect(text).toContain('Ningún caso necesitó subir con la cuenta del dueño un cambio que GitHub no deja subir a los agentes.');
    expect(text).not.toContain('La suite no subió cambios con la cuenta del dueño');
  });

  // Flock round 8: the cases of the judge file (slice 3) push their branches and open their pull
  // requests with the owner account, not the agents' app. The report must say so, naming them.
  it('names the cases whose branches and pull requests come from the owner account', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const section = text.slice(text.indexOf('Qué hizo el dueño y qué se hizo con su cuenta'), text.indexOf('| Caso'));
    const row = section.split('\n').find((line) => line.includes('actúan en GitHub con la cuenta del dueño')) ?? '';
    // Flock rounds 9 and 10: every act of the owner account there is named; what only some cases
    // do is said as "según el caso", never claimed for each one.
    for (const act of ['suben sus ramas y abren sus PRs', 'según el caso', 'editan PRs', 'arman fusiones', 'lanzan o cancelan corridas del juez']) expect(row, act).toContain(act);
    // The judge file of slice 3 and RC-09 act with the owner account.
    const ownerIds = SUITE_MANIFEST.filter((entry) => entry.file === 'judge' || entry.file === 'rc09').map((entry) => entry.id);
    expect(ownerIds).toContain('RC-09');
    for (const id of ownerIds) expect(row, id).toContain(id);
    for (const id of ['CN-01', 'CN-05b', 'SV-04s', 'CN-12']) expect(row, id).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(row).toContain('R22');
  });

  it('declares the other uses of the owner account during the run', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const row = text.split('\n').find((line) => line.includes('La suite también usó la cuenta del dueño')) ?? '';
    // Flock round 11: the whole list of what the harness does with that account (tests/github/sandbox.ts).
    for (const act of ['preparar y restaurar el ensayo', 'crear los issues y las ramas de las piezas', 'cambiar la variable del motor', 'prender y apagar flujos', 'quitar y reponer checks exigidos en la protección de main', 'escribir a mano registros del motor en las trampas que los falsifican', 'crear despliegues de prueba', 'R22']) expect(row, act).toContain(act);
  });

  it('only the judge cases of this run are named there', () => {
    const records = allGood().filter((record) => record.id !== 'SV-01');
    const text = renderSuiteReport(records, META).text;
    const row = text.split('\n').find((line) => line.includes('actúan en GitHub con la cuenta del dueño')) ?? '';
    expect(row).toContain('SV-02');
    expect(row).not.toMatch(/\bSV-01\b/);
  });

  it('a record may only carry pushesBySuite as true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-report-push-'));
    try {
      const file = join(dir, 'push.jsonl');
      writeFileSync(file, `${JSON.stringify({ ...good('SV-04s', 0), owner: { ordersBySuite: ['/approve-judge-change'], pushesBySuite: 'si' } })}\n`);
      expect(() => readCaseRecords(file)).toThrow(/pushesBySuite/);
      writeFileSync(file, `${JSON.stringify(good('SV-04s', 0))}\n`);
      expect(readCaseRecords(file)[0]?.owner).toEqual({ ordersBySuite: ['/approve-judge-change'], pushesBySuite: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const misattributed: Record<string, (records: CaseRecord[]) => CaseRecord[]> = {
    'a button is missing': (records) => records.map((record) => (record.id === 'RECORRIDO' ? { ...record, owner: undefined } : record)),
    'an order is missing': (records) => records.map((record) => (record.id === 'SV-04s' ? { ...record, owner: undefined } : record)),
    'the wrong order is named': (records) => records.map((record) => (record.id === 'CN-05c' ? { ...record, owner: { ordersBySuite: ['/visto-bueno'] } } : record)),
    'a button is claimed where there was none': (records) => records.map((record) => (record.id === 'CN-01' ? { ...record, owner: { button: true } } : record)),
    'an order written by the suite is shown as a button': (records) => records.map((record) => (record.id === 'SV-04' ? { ...record, owner: { button: true } } : record)),
    'a push with the owner account is missing': (records) => records.map((record) => (record.id === 'SV-04s' ? { ...record, owner: { ordersBySuite: ['/approve-judge-change'] } } : record)),
    'a push with the owner account is claimed where there was none': (records) => records.map((record) => (record.id === 'CN-01' ? { ...record, owner: { pushesBySuite: true } } : record)),
  };
  for (const [name, change] of Object.entries(misattributed)) {
    it(`${name} → not complete`, () => {
      expect(renderSuiteReport(change(allGood()), META).complete).toBe(false);
    });
  }

  it('an empty list of orders or an order without a slash invalidates the record', () => {
    for (const orders of [[], ['visto-bueno']]) {
      const records = allGood().map((record) => (record.id === 'CN-05c' ? { ...record, owner: { ordersBySuite: orders } } : record));
      expect(() => renderSuiteReport(records, META)).toThrow(/CN-05c/);
    }
  });
});
const firstLine = (text: string) => text.split('\n').find((row) => row.trim().length > 0) ?? '';

describe('the manifest is fixed, not derived from what ran', () => {
  it('names the thirteen, the server cases, the recipe cases, the queue, the control and the clean-up', () => {
    const ids = SUITE_MANIFEST.map((entry) => entry.id);
    for (const id of ['CN-01', 'CN-02', 'CN-03', 'CN-03e', 'CN-04', 'CN-05b', 'CN-05c', 'CN-06', 'CN-07', 'CN-08', 'CN-09', 'CN-10', 'CN-11a', 'CN-11b', 'CN-12', 'CN-13',
      'SV-01', 'SV-02', 'SV-03a', 'SV-03b', 'SV-03c', 'SV-03d', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-04s', 'SV-DESTINO', 'RC-06', 'RC-09', 'COLA-6', 'RECORRIDO', 'PIEZA-COMPLETA', 'LIMPIEZA',
      'SV-04s+', 'CN-14', 'RAMA-1', 'RAMA-2', 'A-T3', 'B-T6', 'BOT-1']) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(SUITE_MANIFEST.find((entry) => entry.id === 'CN-11b')?.kind).toBe('limit');
    for (const id of ['PIEZA-COMPLETA', 'COLA-6', 'LIMPIEZA', 'RECORRIDO', 'SV-DESTINO', 'A-T3']) expect(SUITE_MANIFEST.find((entry) => entry.id === id)?.kind, id).toBe('check');
  });
});

// PLAN-13-R6 §11 (R29): the evidence of slice 6 runs only the new cases. Its report says which
// cases come from this run and refers to the report of 29-sep for the rest; it never says
// «Completo» over cases it did not run.
describe('the evidence of slice 6 (R29)', () => {
  const R29 = ['SV-04s+', 'CN-14', 'RAMA-1', 'RAMA-2', 'A-T3', 'B-T6', 'BOT-1'];
  const EARLIER_REPORT = 'docs/reports/suite-negativa-2026-09-29.md';
  const SLICE_META = { ...META, scope: { slice: 6 as const, earlierReport: EARLIER_REPORT } };
  const sliceRecords = (): CaseRecord[] => allGood().filter((record) => R29.includes(record.id) || record.id === 'LIMPIEZA');

  it('the manifest marks exactly the R29 cases as slice 6, each with the test that runs it', () => {
    const slice = SUITE_MANIFEST.filter((entry) => entry.slice === 6);
    expect(slice.map((entry) => entry.id)).toEqual(R29);
    for (const entry of slice) expect(entry.test, entry.id).toMatch(/^R29: /);
  });

  it('every R29 case and the clean-up → complete for slice 6 only, naming its cases and the earlier report', () => {
    const report = renderSuiteReport(sliceRecords(), SLICE_META);
    expect(report.complete).toBe(true);
    const heading = firstLine(report.text);
    expect(heading).toMatch(/^# Completo/);
    expect(heading).toContain('rebanada 6');
    expect(heading).toContain('R29');
    expect(heading).not.toContain(`${SUITE_MANIFEST.length} casos`);
    const scope = report.text.split('\n').find((line) => line.startsWith('Alcance:')) ?? '';
    for (const id of R29) expect(scope, id).toContain(id);
    expect(scope).toContain(EARLIER_REPORT);
    expect(report.text).toContain(`Intentos: ${R29.length + 1} de ${R29.length + 1} casos`);
  });

  it('the scope line is there even when the evidence is not complete', () => {
    const text = renderSuiteReport(sliceRecords().filter((record) => record.id !== 'B-T6'), SLICE_META).text;
    expect(firstLine(text)).toMatch(/^# Incompleto/);
    expect(firstLine(text)).toContain('B-T6');
    expect(text.split('\n').find((line) => line.startsWith('Alcance:'))).toContain(EARLIER_REPORT);
  });

  it('the cases of the earlier report are not claimed: the table lists only this run', () => {
    const text = renderSuiteReport(sliceRecords(), SLICE_META).text;
    const table = text.slice(text.indexOf('| Caso'));
    expect(table).toContain('| RAMA-1 |');
    expect(table).not.toContain('| CN-01 |');
  });

  const broken: Record<string, (records: CaseRecord[]) => CaseRecord[]> = {
    'an R29 case is missing': (records) => records.filter((record) => record.id !== 'BOT-1'),
    'a case outside slice 6 is recorded': (records) => [...records, good('CN-01', 0)],
    'the clean-up is missing': (records) => records.filter((record) => record.id !== 'LIMPIEZA'),
    'the queue check has no result': (records) => records.map((record) => {
      if (record.id !== 'A-T3') return record;
      const { result: _result, ...rest } = record;
      return rest;
    }),
    'a case is partial': (records) => records.map((record) => (record.id === 'CN-14' ? { ...record, partial: 'GitHub no dio base.sha en la corrida de la prueba roja' } : record)),
    'an attempt ended in error': (records) => records.map((record) => (record.id === 'CN-14' ? { ...record, negative: 'error' } : record)),
  };
  for (const [name, change] of Object.entries(broken)) {
    it(`${name} → not complete`, () => {
      const report = renderSuiteReport(change(sliceRecords()), SLICE_META);
      expect(report.complete).toBe(false);
      expect(firstLine(report.text)).toMatch(/^# (?:Incompleto|Falló)/);
    });
  }

  it('the same records without the scope are never a complete suite', () => {
    expect(renderSuiteReport(sliceRecords(), META).complete).toBe(false);
  });

  it('a full run of the suite needs the R29 cases too', () => {
    expect(renderSuiteReport(allGood().filter((record) => record.id !== 'RAMA-2'), META).complete).toBe(false);
  });

  it('names the cases where the suite cancelled judge runs by hand and wrote owner comments that are not orders', () => {
    const text = renderSuiteReport(sliceRecords(), SLICE_META).text;
    const cancels = text.split('\n').find((line) => line.includes('canceló a mano corridas del juez')) ?? '';
    for (const id of ['A-T3', 'B-T6', 'R22']) expect(cancels, id).toContain(id);
    expect(cancels).not.toContain('BOT-1');
    const comments = text.split('\n').find((line) => line.includes('comentarios que no son órdenes')) ?? '';
    for (const id of ['BOT-1', 'R22']) expect(comments, id).toContain(id);
    const branches = text.split('\n').find((line) => line.includes('staging')) ?? '';
    for (const id of ['RAMA-1', 'RAMA-2', 'R22']) expect(branches, id).toContain(id);
  });

  it('the earlier report is audited like the header', () => {
    expect(() => renderSuiteReport(sliceRecords(), { ...META, scope: { slice: 6, earlierReport: 'C:\\Users\\alguien\\informe.md' } })).toThrow();
  });
});

describe('when the report may say complete', () => {
  it('every case, this run, stopped, positives passed, evidence, clean-up → complete', () => {
    const report = renderSuiteReport(allGood(), META);
    expect(report.complete).toBe(true);
    expect(firstLine(report.text)).toMatch(/Completo/);
  });

  it('lists the cases in manifest order, the thirteen first', () => {
    const shuffled = allGood().reverse();
    const full = renderSuiteReport(shuffled, META).text;
    // Only the table: the owner section above it also names cases (flock round 8).
    const text = full.slice(full.indexOf('| Caso'));
    const positions = ['CN-01', 'CN-02', 'CN-13', 'SV-01', 'LIMPIEZA'].map((id) => text.indexOf(`| ${id} |`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  const broken: Record<string, (records: CaseRecord[]) => CaseRecord[]> = {
    'a case is missing': (records) => records.filter((record) => record.id !== 'CN-07'),
    'a case comes from another run': (records) => records.map((record) => (record.id === 'SV-03c' ? { ...record, run: 'r-0001' } : record)),
    'an attempt was not stopped': (records) => records.map((record) => (record.id === 'CN-02' ? { ...record, negative: 'no-frenado' } : record)),
    'an attempt ended in error': (records) => records.map((record) => (record.id === 'CN-04' ? { ...record, negative: 'error' } : record)),
    'a positive control failed': (records) => records.map((record) => (record.id === 'CN-01' ? { ...record, positive: 'falló' } : record)),
    'a case has no evidence': (records) => records.map((record) => (record.id === 'CN-09' ? { ...record, evidence: [] } : record)),
    'the clean-up failed': (records) => records.map((record) => (record.id === 'LIMPIEZA' ? { ...record, result: 'falló' } : record)),
    'the queue check has no result': (records) => records.map((record) => (record.id === 'COLA-6' ? { ...record, result: undefined } : record)),
    'a negative case carries a check result': (records) => records.map((record) => (record.id === 'CN-01' ? { ...record, result: 'pasó' } : record)),
    'the complete piece control is missing': (records) => records.filter((record) => record.id !== 'PIEZA-COMPLETA'),
    'a limit is reported as stopped': (records) => records.map((record) => (record.id === 'CN-11b' ? { ...record, negative: 'frenado' } : record)),
    'a case not in the manifest': (records) => [...records, { ...good('CN-01', 0), id: 'CN-99' }],
    'a case recorded twice': (records) => [...records, good('CN-05b', 5)],
    'a case marked partial': (records) => records.map((record) => (record.id === 'SV-03c' ? { ...record, partial: 'algo no se ensayó en GitHub' } : record)),
  };

  for (const [name, change] of Object.entries(broken)) {
    it(`${name} → not complete, and the first line says why`, () => {
      const report = renderSuiteReport(change(allGood()), META);
      expect(report.complete).toBe(false);
      expect(firstLine(report.text)).toMatch(/^(?:#\s*)?(?:Incompleto|Falló)/);
    });
  }

  it('the tests of the run failed → not complete, although every record looks good', () => {
    const report = renderSuiteReport(allGood(), { ...META, testsPassed: false });
    expect(report.complete).toBe(false);
    expect(firstLine(report.text)).toMatch(/^(?:#\s*)?Falló/);
  });

  it('names the missing case and the one not stopped in the first lines', () => {
    const records = allGood().filter((record) => record.id !== 'CN-07').map((record) => (record.id === 'CN-02' ? { ...record, negative: 'no-frenado' as const } : record));
    const head = renderSuiteReport(records, META).text.split('\n').slice(0, 8).join('\n');
    expect(head).toContain('CN-07');
    expect(head).toContain('CN-02');
  });

  it('a partial case is shown as partial, says what was not tried on GitHub, and the report is not complete', () => {
    const records = allGood().map((record) => (record.id === 'SV-03c' ? { ...record, partial: 'el error interno del motor solo se prueba en la computadora' } : record));
    const report = renderSuiteReport(records, META);
    expect(report.complete).toBe(false);
    expect(report.text).toMatch(/parcial/i);
    expect(report.text).toContain('el error interno del motor solo se prueba en la computadora');
  });
});

describe('what the report may not carry', () => {
  it('its prose has none of the default banned words', () => {
    const prose = renderSuiteReport(allGood(), META).text.replace(/https:\/\/\S+/g, '');
    expect(findBannedTerms(prose, DEFAULT_BANNED_TERMS)).toEqual([]);
  });

  const leaks: Record<string, Partial<CaseRecord>> = {
    'a Windows path': { attempt: 'se escribió C:\\Users\\alguien\\AppData\\Local\\Temp\\x' },
    'a home path': { attempt: 'se escribió /home/alguien/x' },
    'a macOS path': { attempt: 'se escribió /Users/alguien/x' },
    'a token': { attempt: 'token ghs_16C7e42F292c6912E7710c838347Ae178B4a' },
    'a private key': { attempt: '-----BEGIN RSA PRIVATE KEY-----' },
    'a foreign link': { evidence: ['https://example.com/pull/1'] },
    'a link to another repository': { evidence: ['https://github.com/socialabs-margin/Socialabs/pull/1'] },
    'a link that is not https': { evidence: [`http://github.com/${REPO}/pull/1`] },
    'a link that climbs out of the repository': { evidence: [`https://github.com/${REPO}/../../otra/cosa/pull/1`] },
    'a link that climbs out with an encoded dot': { evidence: [`https://github.com/${REPO}/%2e%2e/%2E%2E/otra/pull/1`] },
    'a link with credentials': { evidence: [`https://github.com/${REPO}@evil.example.com/pull/1`] },
    'a UNC path': { attempt: 'se escribió \\\\servidor\\compartida\\x' },
    'a Git Bash path': { attempt: 'se escribió /c/GitHub/ai-workflows/x' },
    'a /tmp path': { attempt: 'se escribió /tmp/aiw-negative-x/y' },
    'a JWT': { attempt: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI1MDY2Nzg3In0.c2lnbmF0dXJh' },
  };
  for (const [name, change] of Object.entries(leaks)) {
    it(`refuses ${name}`, () => {
      const records = allGood().map((record) => (record.id === 'CN-03' ? { ...record, ...change } : record));
      expect(() => renderSuiteReport(records, META)).toThrow(/CN-03/);
    });
  }

  it('a compare link with three dots is a legitimate link, not a climb out', () => {
    const records = allGood().map((record) => (record.id === 'CN-03' ? { ...record, evidence: [`https://github.com/${REPO}/compare/abc1234...def5678`] } : record));
    expect(renderSuiteReport(records, META).complete).toBe(true);
  });

  it('the header values are audited too', () => {
    expect(() => renderSuiteReport(allGood(), { ...META, repository: 'C:\\Users\\alguien\\repo' })).toThrow();
    expect(() => renderSuiteReport(allGood(), { ...META, engineSha: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a' })).toThrow();
  });

  it('escapes markup that came from a record', () => {
    const records = allGood().map((record) => (record.id === 'CN-03' ? { ...record, attempt: 'rama <script>x</script> | celda [enlace](https://example.com)' } : record));
    const text = renderSuiteReport(records, META).text;
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('](https://example.com)');
  });
});

describe('reading the records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads one JSON line per case', () => {
    const file = join(dir, 'ok.jsonl');
    writeFileSync(file, `${allGood().slice(0, 2).map((record) => JSON.stringify(record)).join('\n')}\n`);
    expect(readCaseRecords(file).map((record) => record.id)).toEqual([SUITE_MANIFEST[0]?.id, SUITE_MANIFEST[1]?.id]);
  });

  it('throws on a line it cannot read, naming the line', () => {
    const file = join(dir, 'roto.jsonl');
    writeFileSync(file, `${JSON.stringify(good('CN-01', 0))}\n{roto\n`);
    expect(() => readCaseRecords(file)).toThrow(/2/);
  });

  it('throws on a record with a field it does not know or a value out of its list', () => {
    const file = join(dir, 'campo.jsonl');
    writeFileSync(file, `${JSON.stringify({ ...good('CN-01', 0), extra: 1 })}\n`);
    expect(() => readCaseRecords(file)).toThrow();
    writeFileSync(file, `${JSON.stringify({ ...good('CN-01', 0), negative: 'casi' })}\n`);
    expect(() => readCaseRecords(file)).toThrow();
  });
});

// R23 (owner decision, 29-sep): the report may join a full run with a short run of the cases it
// left without a record. The final (short) run is `meta.run`; each earlier run says which cases it
// gives. It is declared in the heading and per run, with that run's own clean-up outcome.
describe('a report that joins two runs (R23)', () => {
  const EARLIER = 'r-5d5f';
  const RETAKEN = ['COLA-6', 'RECORRIDO', 'LIMPIEZA'];
  const joined = () => {
    const all = allGood();
    const earlier = all.filter((record) => !RETAKEN.includes(record.id)).map((record) => ({ ...record, run: EARLIER }));
    const earlierCleanup: CaseRecord = { ...good('LIMPIEZA', 99), run: EARLIER, result: 'falló', attempt: 'la suite no pudo dejar el ensayo limpio' };
    const final = all.filter((record) => RETAKEN.includes(record.id));
    return { records: [...earlier, earlierCleanup, ...final], cases: earlier.map((record) => record.id) };
  };
  const metaWith = (cases: readonly string[], over: Partial<{ testsPassed: boolean }> = {}) => ({
    ...META,
    runs: [{ run: EARLIER, engineSha: 'b'.repeat(40), testsPassed: false, cases }],
    ...over,
  });

  it('every case from one of the two runs, the final clean-up verified → complete, and it says so', () => {
    const { records, cases } = joined();
    const report = renderSuiteReport(records, metaWith(cases));
    expect(report.complete).toBe(true);
    const heading = firstLine(report.text);
    expect(heading).toMatch(/Completo/);
    expect(heading).toContain('R23');
    expect(heading).toContain(EARLIER);
    expect(heading).toContain(RUN);
  });

  it('names each earlier run, its engine, the cases it gives and its own clean-up outcome', () => {
    const { records, cases } = joined();
    const text = renderSuiteReport(records, metaWith(cases)).text;
    const row = text.split('\n').find((line) => line.startsWith(`Corrida anterior: ${EARLIER}`)) ?? '';
    expect(row).toContain('b'.repeat(40));
    expect(row).toContain('CN-01');
    expect(row).not.toMatch(/\bCOLA-6\b/);
    expect(row).toMatch(/limpieza: falló/);
    expect(row).toMatch(/pruebas: no en verde/);
  });

  it('a case given by both runs is repeated → not complete', () => {
    const { records, cases } = joined();
    expect(renderSuiteReport(records, metaWith([...cases, 'COLA-6'])).complete).toBe(false);
  });

  it('an earlier record of a case the run does not give does not count', () => {
    const { records, cases } = joined();
    const report = renderSuiteReport(records, metaWith(cases.filter((id) => id !== 'CN-01')));
    expect(report.complete).toBe(false);
    expect(firstLine(report.text)).toMatch(/CN-01/);
  });

  it('a case the earlier run says it gives but has no record → not complete', () => {
    const { records, cases } = joined();
    const report = renderSuiteReport(records.filter((record) => record.id !== 'CN-02'), metaWith(cases));
    expect(report.complete).toBe(false);
  });

  it('a record from a run that is not declared → not complete', () => {
    const { records, cases } = joined();
    const stray = records.map((record) => (record.id === 'SV-01' ? { ...record, run: 'r-otra' } : record));
    expect(renderSuiteReport(stray, metaWith(cases)).complete).toBe(false);
  });

  it('the final run must end in green, and its clean-up must pass', () => {
    const { records, cases } = joined();
    expect(renderSuiteReport(records, metaWith(cases, { testsPassed: false })).complete).toBe(false);
    const failedCleanup = records.map((record) => (record.id === 'LIMPIEZA' && record.run === RUN ? { ...record, result: 'falló' as const } : record));
    expect(renderSuiteReport(failedCleanup, metaWith(cases)).complete).toBe(false);
  });
});

// Final review of part 5: an earlier record of a case the earlier run does not give used to be
// dropped silently. The report lists it with its result; a dropped record that did not pass keeps
// the report from being complete (R23 joins cases the earlier run left without a passing record).
describe('earlier records that do not count are shown (R23)', () => {
  const EARLIER = 'r-5d5f';
  const final = () => allGood().filter((record) => ['COLA-6', 'RECORRIDO', 'LIMPIEZA', 'CN-12'].includes(record.id));
  const earlierOf = (over: Partial<CaseRecord> = {}) => allGood()
    .filter((record) => !['COLA-6', 'RECORRIDO', 'LIMPIEZA'].includes(record.id))
    .map((record) => ({ ...record, run: EARLIER, ...(record.id === 'CN-12' ? over : {}) }));
  const meta = (cases: readonly string[]) => ({ ...META, runs: [{ run: EARLIER, engineSha: 'b'.repeat(40), testsPassed: false, cases }] });
  const given = (records: readonly CaseRecord[]) => records.map((record) => record.id).filter((id) => id !== 'CN-12');

  it('a case redone by the final run names the earlier record it replaces', () => {
    const earlier = earlierOf();
    const text = renderSuiteReport([...earlier, ...final()], meta(given(earlier))).text;
    const row = text.split('\n').find((line) => line.includes('no cuenta')) ?? '';
    expect(row).toContain(EARLIER);
    expect(row).toMatch(/CN-12 \(frenado, control positivo: pasó\)/);
    expect(renderSuiteReport([...earlier, ...final()], meta(given(earlier))).complete).toBe(true);
  });

  it('an earlier record that did not pass and was dropped keeps the report from being complete', () => {
    const earlier = earlierOf({ positive: 'falló' });
    const report = renderSuiteReport([...earlier, ...final()], meta(given(earlier)));
    expect(report.complete).toBe(false);
    expect(firstLine(report.text)).toMatch(/CN-12/);
  });
});
