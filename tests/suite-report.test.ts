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
      'SV-04s': { orders: ['/approve-judge-change'], pushes: true },
      RECORRIDO: { button: true },
    });
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
    const records = allGood().map((record) => (record.id === 'SV-04s' ? { ...record, owner: { ordersBySuite: ['/approve-judge-change'] } } : record));
    const text = renderSuiteReport(records, META).text;
    expect(text).toContain('Ningún caso necesitó subir con la cuenta del dueño un cambio que GitHub no deja subir a los agentes.');
    expect(text).not.toContain('La suite no subió cambios con la cuenta del dueño');
  });

  // Flock round 8: the cases of the judge file (slice 3) push their branches and open their pull
  // requests with the owner account, not the agents' app. The report must say so, naming them.
  it('names the cases whose branches and pull requests come from the owner account', () => {
    const text = renderSuiteReport(allGood(), META).text;
    const section = text.slice(text.indexOf('Qué hizo el dueño y qué se hizo con su cuenta'), text.indexOf('| Caso'));
    const row = section.split('\n').find((line) => line.includes('abren con la cuenta del dueño')) ?? '';
    const judgeIds = SUITE_MANIFEST.filter((entry) => entry.file === 'judge').map((entry) => entry.id);
    expect(judgeIds.length).toBeGreaterThan(0);
    for (const id of judgeIds) expect(row, id).toContain(id);
    for (const id of ['CN-01', 'CN-05b', 'SV-04s', 'RC-09', 'CN-12']) expect(row, id).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(row).toContain('R22');
  });

  it('only the judge cases of this run are named there', () => {
    const records = allGood().filter((record) => record.id !== 'SV-01');
    const text = renderSuiteReport(records, META).text;
    const row = text.split('\n').find((line) => line.includes('abren con la cuenta del dueño')) ?? '';
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
      'SV-01', 'SV-02', 'SV-03a', 'SV-03b', 'SV-03c', 'SV-03d', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-04s', 'SV-DESTINO', 'RC-06', 'RC-09', 'COLA-6', 'RECORRIDO', 'PIEZA-COMPLETA', 'LIMPIEZA']) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(SUITE_MANIFEST.find((entry) => entry.id === 'CN-11b')?.kind).toBe('limit');
    for (const id of ['PIEZA-COMPLETA', 'COLA-6', 'LIMPIEZA', 'RECORRIDO', 'SV-DESTINO']) expect(SUITE_MANIFEST.find((entry) => entry.id === id)?.kind, id).toBe('check');
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
    const text = renderSuiteReport(shuffled, META).text;
    const positions = ['CN-01', 'CN-02', 'CN-13', 'SV-01', 'LIMPIEZA'].map((id) => text.indexOf(id));
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
