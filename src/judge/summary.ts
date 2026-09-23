// PLAN-13-R3 §3.8: the run summary. Everything that came from the pull request is sanitised and
// escaped before it reaches the Markdown, so a branch name or a declared kind can never inject
// markup or move a table cell.

import { safeTerminalText } from '../safe-text.js';

/** Escapes one piece of text for Markdown: controls, HTML and the table cell separator. */
export function escapeReportText(text: string): string {
  return safeTerminalText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

export interface SummaryStage {
  readonly id: string;
  readonly outcome: string;
  readonly reason?: string;
}

export interface SummaryPiece {
  readonly pr: number;
  readonly piece?: string;
  readonly verdict: string;
  readonly stages: readonly SummaryStage[];
  /** A reason that is not any single stage: the judge's own files, a missing piece. */
  readonly note?: string;
}

export interface SummaryUnofficial {
  readonly context: string;
  readonly kind: 'status' | 'check-run';
  readonly url: string | null;
  readonly app?: string;
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** PLAN-13-R3 §3.8: the whole report of one run, in the recipe's language. */
export function buildSummary(
  pieces: readonly SummaryPiece[],
  unofficial: readonly SummaryUnofficial[],
  locale: string,
): string {
  const spanish = isSpanish(locale);
  const lines: string[] = [spanish ? '# Juez de ai-workflows' : '# ai-workflows judge', ''];

  for (const piece of pieces) {
    const heading = piece.piece === undefined
      ? `## PR #${piece.pr} — ${piece.verdict}`
      : `## PR #${piece.pr} · ${spanish ? 'pieza' : 'piece'} ${escapeReportText(piece.piece)} — ${piece.verdict}`;
    lines.push(heading);
    for (const stage of piece.stages) {
      const reason = stage.reason === undefined ? '' : ` — ${escapeReportText(stage.reason)}`;
      lines.push(`- ${escapeReportText(stage.id)}: ${stage.outcome}${reason}`);
    }
    if (piece.note !== undefined) lines.push(`- ${escapeReportText(piece.note)}`);
    lines.push('');
  }

  if (unofficial.length > 0) {
    lines.push(spanish ? '## Estados de origen no oficial' : '## Statuses of unofficial origin');
    for (const entry of unofficial) {
      const detail = entry.app === undefined ? '' : ` (${escapeReportText(entry.app)})`;
      lines.push(`- ${escapeReportText(entry.context)} [${entry.kind}]${detail}: ${entry.url ?? ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
