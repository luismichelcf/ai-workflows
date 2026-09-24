import { describe, expect, it } from 'vitest';

import { DEFAULT_BANNED_TERMS, findBannedTerms, readOwnerSummary, renderOwnerMessage } from '../src/index.js';

// PLAN-13-R4 §6 (D53 and D54 of PLAN-997): every message to the owner starts with the three lines
// of the piece's summary, never shows a banned word and never exceeds the length. When the full
// message breaks a rule the minimal version of the template is sent instead; when even that
// breaks one, nothing is sent and the caller is told why. What comes from the process (reasons,
// titles) is cleaned of control characters and of Markdown that could change the message.

const SUMMARY = [
  '**Qué pasa hoy:** la pantalla de pagos no guarda el recibo.',
  '**Qué cambia:** el recibo se guarda al pagar.',
  '**Por qué importa:** el cliente puede descargarlo después.',
];

const base = { locale: 'es', maxLength: 700, banned: [...DEFAULT_BANNED_TERMS] };

describe('readOwnerSummary', () => {
  it('takes the first three non-empty lines of the section, without Markdown adornments', () => {
    const plan = [
      '# PLAN-13',
      '',
      '## En tres líneas',
      '',
      ...SUMMARY,
      'una cuarta línea que no entra',
      '',
      '## Otra sección',
    ].join('\n');
    expect(readOwnerSummary(plan, 'En tres líneas')).toEqual([
      'Qué pasa hoy: la pantalla de pagos no guarda el recibo.',
      'Qué cambia: el recibo se guarda al pagar.',
      'Por qué importa: el cliente puede descargarlo después.',
    ]);
  });

  it('finds the section without regard to accents or case, and gives nothing when it is missing or short', () => {
    expect(readOwnerSummary(`## EN TRES LINEAS\n\n${SUMMARY.join('\n')}\n`, 'En tres líneas')).toHaveLength(3);
    expect(readOwnerSummary('## Otra\n\nx\n', 'En tres líneas')).toBeUndefined();
    expect(readOwnerSummary('## En tres líneas\n\nsolo una\n\n## Fin\n', 'En tres líneas')).toBeUndefined();
  });
});

describe('renderOwnerMessage', () => {
  const summary = readOwnerSummary(`## En tres líneas\n\n${SUMMARY.join('\n')}\n`, 'En tres líneas');

  it('starts with the three lines, then says what the owner has to do', () => {
    const result = renderOwnerMessage('approval', { ...base, summary, link: 'https://github.com/duena/proyecto/pull/7' });
    expect('text' in result).toBe(true);
    if (!('text' in result)) return;
    const lines = result.text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.slice(0, 3)).toEqual(summary);
    expect(result.text).toContain('https://github.com/duena/proyecto/pull/7');
    expect(result.text).toMatch(/Approve/);
    expect(findBannedTerms(result.text, DEFAULT_BANNED_TERMS)).toEqual([]);
  });

  it('every kind renders within the length and without banned words, in Spanish and in English', () => {
    for (const locale of ['es', 'en']) {
      for (const kind of ['start', 'approval', 'question', 'blocked', 'close'] as const) {
        const result = renderOwnerMessage(kind, { ...base, locale, summary, detail: 'falta un dato', link: 'https://github.com/duena/proyecto/pull/7' });
        expect('text' in result, `${locale} ${kind}`).toBe(true);
        if (!('text' in result)) continue;
        expect(result.text.length, `${locale} ${kind}`).toBeLessThanOrEqual(700);
        expect(findBannedTerms(result.text, DEFAULT_BANNED_TERMS), `${locale} ${kind}`).toEqual([]);
      }
    }
  });

  it('without a summary, the message goes without it and says so at the end', () => {
    const result = renderOwnerMessage('blocked', { ...base, detail: 'la vista previa no respondió' });
    expect('text' in result && result.text).toMatch(/resumen/);
    expect('text' in result && result.text.split('\n')[0]).not.toMatch(/Qué pasa hoy/);
  });

  it('a detail with a banned word sends the minimal version, which leaves the detail out', () => {
    const result = renderOwnerMessage('blocked', { ...base, summary, detail: 'falló el pipeline del merge' });
    expect('text' in result).toBe(true);
    if (!('text' in result)) return;
    expect(result.text).not.toMatch(/pipeline|merge/);
    expect(result.text.split('\n').filter((line) => line.trim().length > 0).slice(0, 3)).toEqual(summary);
  });

  it('a detail too long for the limit sends the minimal version', () => {
    const result = renderOwnerMessage('question', { ...base, maxLength: 400, summary, detail: 'palabra '.repeat(200) });
    expect('text' in result && result.text.length).toBeLessThanOrEqual(400);
    expect('text' in result && result.text).not.toContain('palabra palabra palabra');
  });

  it('when even the minimal version breaks a rule, nothing is sent and the reason says which', () => {
    const bannedSummary = ['Qué pasa hoy: el pipeline falla.', 'Qué cambia: nada.', 'Por qué importa: nada.'];
    expect(renderOwnerMessage('close', { ...base, summary: bannedSummary })).toEqual({ refused: expect.stringMatching(/pipeline/) });
    expect(renderOwnerMessage('close', { ...base, maxLength: 140, summary: SUMMARY.map((line) => `${line} ${'x'.repeat(60)}`) })).toEqual({ refused: expect.stringMatching(/140/) });
  });

  it('the project\'s extra banned words count too', () => {
    const result = renderOwnerMessage('blocked', { ...base, banned: [...DEFAULT_BANNED_TERMS, 'vercel'], summary, detail: 'vercel no respondió' });
    expect('text' in result && result.text).not.toMatch(/vercel/i);
  });

  it('control characters and Markdown that could forge a link or a heading are neutralised in the detail', () => {
    const result = renderOwnerMessage('blocked', { ...base, summary, detail: 'mira \u001b[31m[aquí](https://malo.example) \n# Título falso' });
    expect('text' in result).toBe(true);
    if (!('text' in result)) return;
    expect(result.text).not.toContain('\u001b');
    expect(result.text).not.toMatch(/\]\(https:\/\/malo\.example\)/);
    expect(result.text).not.toMatch(/^# Título falso/m);
  });
});
