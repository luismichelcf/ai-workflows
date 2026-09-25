import { safeTerminalText } from './safe-text.js';

export const DEFAULT_BANNED_TERMS = [
  'sha',
  'pipeline',
  'deployment',
  'workflow',
  'commit',
  'merge',
  'branch',
  'cli',
  'stack trace',
  'build',
  'runner',
  'refactor',
  'rollback',
  'endpoint',
] as const;

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Report each normalized term once while keeping its first spelling and list order. */
export function findBannedTerms(text: string, terms: readonly string[]): string[] {
  const message = normalize(text);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const normalized = normalize(term).trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const expression = normalized.split(/\s+/).map(escapeRegex).join('\\s+');
    const wholeWord = new RegExp(`(^|[^a-z0-9])${expression}([^a-z0-9]|$)`);
    if (wholeWord.test(message)) found.push(term);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// PLAN-13-R4 §6 (D53 and D54 of PLAN-997): the messages to the owner.

const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const ANY_HEADING = /^\s*#{1,6}(\s|$)/;
const MARKDOWN_ADORNMENTS = /\*\*/g;

function stripMarkdown(line: string): string {
  return line.replace(MARKDOWN_ADORNMENTS, '').trim();
}

/**
 * The three lines of the piece's summary: the first three non-empty lines of the section,
 * found without regard to case or accents and without Markdown adornments. `undefined` when
 * the section is missing or does not hold three lines.
 */
export function readOwnerSummary(document: string, section: string): string[] | undefined {
  const wanted = normalize(section);
  const lines = document.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index] ?? '');
    if (match !== null && normalize(match[1] ?? '') === wanted) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return undefined;

  const collected: string[] = [];
  for (let index = start; index < lines.length && collected.length < 3; index += 1) {
    const line = lines[index] ?? '';
    if (ANY_HEADING.test(line)) break;
    const clean = stripMarkdown(line);
    if (clean.length > 0) collected.push(clean);
  }
  return collected.length >= 3 ? collected.slice(0, 3) : undefined;
}

export type OwnerMessageKind = 'start' | 'approval' | 'question' | 'blocked' | 'close';

export interface OwnerMessageOptions {
  readonly locale: string;
  /** The piece's three summary lines, when the recipe declares where they come from. */
  readonly summary?: readonly string[];
  /** The free reason of this message, cleaned before it is shown. */
  readonly detail?: string;
  /** Where the owner has to act, for the messages that carry one. */
  readonly link?: string;
  /**
   * PLAN-13-R4 §6: the exact order to write, for the approval that goes through a comment.
   * When it is present the approval message says what to write and never mentions a button.
   */
  readonly order?: string;
  readonly maxLength: number;
  readonly banned: readonly string[];
}

type TemplateSubject = { detail?: string; link?: string; order?: string };
type Templates = Readonly<Record<OwnerMessageKind, (o: TemplateSubject) => string>>;

const SPANISH_TEMPLATES: Templates = {
  start: () => 'Empieza el trabajo de esta pieza.',
  approval: (o) =>
    o.order !== undefined
      ? `Para continuar, escribe este comentario en GitHub: ${o.order}`
      : `Para continuar, aprueba el cambio en GitHub con el botón "Approve": ${o.link ?? ''}`,
  question: (o) => `Hace falta una decisión tuya${o.detail === undefined ? '' : `: ${o.detail}`}.`,
  blocked: (o) => `No se pudo continuar${o.detail === undefined ? '' : `: ${o.detail}`}.`,
  close: () => 'El cambio se fusionó.',
};

const ENGLISH_TEMPLATES: Templates = {
  start: () => 'The work on this piece begins.',
  approval: (o) =>
    o.order !== undefined
      ? `To continue, write this comment in GitHub: ${o.order}`
      : `To continue, approve the change in GitHub with the "Approve" button: ${o.link ?? ''}`,
  question: (o) => `A decision from you is needed${o.detail === undefined ? '' : `: ${o.detail}`}.`,
  blocked: (o) => `It could not continue${o.detail === undefined ? '' : `: ${o.detail}`}.`,
  close: () => 'The change is in.',
};

/**
 * Neutralises the two halves of an HTML comment so no text the engine posts to a pull request
 * or an issue can smuggle a marker (a forged event, a message mark) inside a comment.
 */
export function neutralizeHtmlComments(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

/** Strips control characters and neutralises Markdown that could forge a link or a heading. */
function cleanDetail(detail: string): string {
  return neutralizeHtmlComments(
    safeTerminalText(detail)
      .replace(/\]\(/g, ']\\(')
      .replace(/^([ \t]*)#/gm, '$1\\#'),
  );
}

function compose(summary: readonly string[] | undefined, body: string, spanish: boolean): string {
  const parts: string[] = [];
  if (summary !== undefined && summary.length > 0) parts.push(summary.join('\n'));
  parts.push(body);
  if (summary === undefined || summary.length === 0) {
    parts.push(spanish ? '(No hay resumen de la pieza.)' : '(No summary of the piece is available.)');
  }
  return parts.join('\n\n');
}

/**
 * Renders one owner-facing message. It always starts with the piece's three summary lines when
 * they exist, never shows a banned word and never exceeds the length. When the full version
 * breaks a rule the minimal one (without the free reason) is used; when even that breaks one,
 * nothing is sent and the reason says which rule it broke.
 */
export function renderOwnerMessage(
  kind: OwnerMessageKind,
  options: OwnerMessageOptions,
): { readonly text: string } | { readonly refused: string } {
  const spanish = options.locale.toLowerCase().startsWith('es');
  const templates = spanish ? SPANISH_TEMPLATES : ENGLISH_TEMPLATES;
  const detail = options.detail === undefined ? undefined : cleanDetail(options.detail);
  // Every line the engine posts is neutralised: a summary line could otherwise carry a marker.
  const summary = options.summary?.map(neutralizeHtmlComments);
  const link = options.link === undefined ? undefined : neutralizeHtmlComments(options.link);

  const full = compose(
    summary,
    templates[kind]({
      ...(detail === undefined ? {} : { detail }),
      ...(link === undefined ? {} : { link }),
      ...(options.order === undefined ? {} : { order: options.order }),
    }),
    spanish,
  );
  const fullBanned = findBannedTerms(full, options.banned);
  if (fullBanned.length === 0 && full.length <= options.maxLength) return { text: full };

  const minimal = compose(
    summary,
    templates[kind]({
      ...(link === undefined ? {} : { link }),
      ...(options.order === undefined ? {} : { order: options.order }),
    }),
    spanish,
  );
  const minimalBanned = findBannedTerms(minimal, options.banned);
  if (minimalBanned.length > 0) {
    return {
      refused: spanish
        ? `No se envió el mensaje: la versión mínima contiene la palabra prohibida "${minimalBanned[0]}".`
        : `The message was not sent: the minimal version contains the banned word "${minimalBanned[0]}".`,
    };
  }
  if (minimal.length > options.maxLength) {
    return {
      refused: spanish
        ? `No se envió el mensaje: la versión mínima pasa de ${options.maxLength} caracteres.`
        : `The message was not sent: the minimal version is longer than ${options.maxLength} characters.`,
    };
  }
  return { text: minimal };
}

