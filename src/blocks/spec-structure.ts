import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Gate, GateResult } from '../contract.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { analyzeDocument, canonicalText, type DocumentAnalysis } from '../gates.js';

// PLAN-13-R2 §3.1: `spec-structure@1` checks the shape of the plan document — never its truth.
// Every title, path and threshold arrives through `with:`, so nothing of any project lives in
// the engine. A missing section, a label of the summary that never appears, a criterion without
// its word or a pending decision are all gathered into one reason.

export const manifest: BlockManifest = {
  name: 'spec-structure',
  kind: 'module',
  natures: ['structure'],
  server: ['recompute', 'require-check'],
  inputs: {
    file: { type: 'string', required: true },
    sections: { type: 'string-list' },
    summary: {
      type: 'object',
      fields: {
        section: { type: 'string', required: true },
        labels: { type: 'string-list', required: true },
      },
    },
    criteria: {
      type: 'object',
      fields: {
        section: { type: 'string', required: true },
        'id-prefix': { type: 'string', required: true },
        words: { type: 'string-list' },
      },
    },
    decisions: {
      type: 'object',
      fields: {
        section: { type: 'string', required: true },
        'pending-markers': {
          type: 'string-list',
          default: ['[ ]', 'pendiente', 'por decidir', 'TBD'],
        },
      },
    },
  },
};

interface SummaryInput {
  readonly section: string;
  readonly labels: readonly string[];
}

interface CriteriaInput {
  readonly section: string;
  readonly idPrefix: string;
  readonly words: readonly string[];
}

interface DecisionsInput {
  readonly section: string;
  readonly pendingMarkers: readonly string[];
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function quoted(text: string, spanish: boolean): string {
  return spanish ? `«${text}»` : `"${text}"`;
}

function list(names: readonly string[], spanish: boolean): string {
  return names.map((name) => quoted(name, spanish)).join(', ');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSummary(value: unknown): SummaryInput | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const section = asString(record['section']);
  if (section === undefined) return undefined;
  return { section, labels: asStringList(record['labels']) };
}

function readCriteria(value: unknown): CriteriaInput | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const section = asString(record['section']);
  const idPrefix = asString(record['idPrefix']);
  if (section === undefined || idPrefix === undefined) return undefined;
  return { section, idPrefix, words: asStringList(record['words']) };
}

function readDecisions(value: unknown): DecisionsInput | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const section = asString(record['section']);
  if (section === undefined) return undefined;
  const provided = asStringList(record['pendingMarkers']);
  return {
    section,
    pendingMarkers: provided.length > 0 ? provided : ['[ ]', 'pendiente', 'por decidir', 'TBD'],
  };
}

function sectionOf(analysis: DocumentAnalysis, name: string): DocumentAnalysis['sections'][number] | undefined {
  const wanted = canonicalText(name);
  return analysis.sections.find((section) => canonicalText(section.title) === wanted);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `word` appears in `text` as a whole word, ignoring accents and case. */
function hasWholeWord(text: string, word: string): boolean {
  const wanted = escapeRegExp(canonicalText(word));
  if (wanted.length === 0) return true;
  return new RegExp(`(?<![\\p{L}\\p{N}])${wanted}(?![\\p{L}\\p{N}])`, 'u').test(canonicalText(text));
}

/** The identifier `<prefix><two digits>` a criterion line carries, if any. */
function criterionId(line: string, prefix: string): string | undefined {
  const match = new RegExp(`${escapeRegExp(prefix)}\\d{2}`).exec(line);
  return match?.[0];
}

/** The line without its list bullet, which is presentation and not part of the decision. */
function withoutBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}

function evaluate(
  content: string,
  sections: readonly string[],
  summary: SummaryInput | undefined,
  criteria: CriteriaInput | undefined,
  decisions: DecisionsInput | undefined,
  spanish: boolean,
): string[] {
  const analysis = analyzeDocument(content);
  const problems: string[] = [];

  const missingSections = sections.filter((name) => {
    const section = sectionOf(analysis, name);
    return section === undefined || !section.hasContent;
  });
  if (missingSections.length > 0) {
    problems.push(
      spanish
        ? `Faltan secciones con contenido: ${list(missingSections, spanish)}.`
        : `Missing sections with content: ${list(missingSections, spanish)}.`,
    );
  }

  if (summary !== undefined) {
    const text = sectionOf(analysis, summary.section)?.lines.join('\n') ?? '';
    const folded = canonicalText(text);
    const missingLabels = summary.labels.filter(
      (label) => !folded.includes(canonicalText(label)),
    );
    if (missingLabels.length > 0) {
      problems.push(
        spanish
          ? `El resumen no menciona: ${list(missingLabels, spanish)}.`
          : `The summary does not mention: ${list(missingLabels, spanish)}.`,
      );
    }
  }

  if (criteria !== undefined) {
    const lines = sectionOf(analysis, criteria.section)?.lines ?? [];
    const withId = lines
      .map((line) => ({ line, id: criterionId(line, criteria.idPrefix) }))
      .filter((entry): entry is { line: string; id: string } => entry.id !== undefined);
    if (withId.length === 0) {
      problems.push(
        spanish
          ? `No hay criterios con identificador ${quoted(criteria.idPrefix, spanish)}.`
          : `There are no criteria with identifier ${quoted(criteria.idPrefix, spanish)}.`,
      );
    } else {
      for (const entry of withId) {
        const missing = criteria.words.filter((word) => !hasWholeWord(entry.line, word));
        if (missing.length > 0) {
          problems.push(
            spanish
              ? `${quoted(entry.id, spanish)} no tiene: ${list(missing, spanish)}.`
              : `${quoted(entry.id, spanish)} is missing: ${list(missing, spanish)}.`,
          );
        }
      }
    }
  }

  if (decisions !== undefined) {
    const section = sectionOf(analysis, decisions.section);
    if (section === undefined) {
      problems.push(
        spanish
          ? `Falta la sección ${quoted(decisions.section, spanish)}.`
          : `Missing section ${quoted(decisions.section, spanish)}.`,
      );
    } else {
      const pending = decisions.pendingMarkers.map((marker) => canonicalText(marker));
      for (const line of section.lines) {
        const folded = canonicalText(line);
        if (pending.some((marker) => marker.length > 0 && folded.includes(marker))) {
          problems.push(
            spanish
              ? `Queda una decisión pendiente: ${quoted(withoutBullet(line), spanish)}.`
              : `A decision is still pending: ${quoted(withoutBullet(line), spanish)}.`,
          );
        }
      }
    }
  }

  return problems;
}

function createGate(
  file: string,
  sections: readonly string[],
  summary: SummaryInput | undefined,
  criteria: CriteriaInput | undefined,
  decisions: DecisionsInput | undefined,
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    const spanish = isSpanish(context.locale);
    const relative = file.replaceAll('{piece}', context.piece);

    let content: string;
    try {
      content = await readFile(join(deps.root, relative), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          reason: spanish
            ? `No existe el archivo del plan ${quoted(relative, spanish)}.`
            : `The plan file ${quoted(relative, spanish)} does not exist.`,
        };
      }
      throw error;
    }

    const problems = evaluate(content, sections, summary, criteria, decisions, spanish);
    if (problems.length > 0) return { ok: false, reason: problems.join(' ') };

    const sha256 = createHash('sha256').update(content).digest('hex');
    return { ok: true, evidence: { file: relative, sha256 } };
  };
}

export const specStructureBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const file = asString(inputs['file']) ?? '';
    return createGate(
      file,
      asStringList(inputs['sections']),
      readSummary(inputs['summary']),
      readCriteria(inputs['criteria']),
      readDecisions(inputs['decisions']),
      deps,
    );
  },
};
