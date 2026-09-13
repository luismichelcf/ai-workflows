// Reusable pieces for building gates. A project composes these in its pipeline config;
// the engine knows nothing about any of them.
//
// Everything here is STRUCTURAL: it checks the shape of a document, never its truth and
// never its sufficiency. Claiming otherwise would be the engine promising a judgement no
// predicate can make — sufficiency is what the cross review is for.

export type CheckResult = { ok: true } | { ok: false; reason: string };

export interface SourceRequirement {
  /** Minimum number of distinct domains. */
  readonly min: number;
  /**
   * Also require sources from OUTSIDE a known list. Five tools of the same trade all
   * solve the problem the same way; the useful answers come from somewhere else.
   */
  readonly outside?: { readonly min: number; readonly of: readonly string[] };
}

/** ATX heading: up to three spaces, one to six hashes, then an optional title. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Trailing closing hashes of an ATX heading: `## Title ##`. */
const ATX_CLOSING = /[ \t]+#+[ \t]*$/;

/** Setext underline: a run of `=` or `-` under a paragraph line. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** A fence opener: three or more backticks or tildes, up to three spaces of indent. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A fence closer: the same character, the same or a greater length, nothing else. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Zero-width characters that must never be mistaken for text. */
const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff\u2060]/g;

/** A full HTML element, opening tag through matching closing tag, including its text. */
const HTML_ELEMENT = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>[\s\S]*?<\/\1[ \t]*>/gi;

/** Any leftover standalone HTML tag. */
const HTML_TAG = /<[^>]*>/g;

/** `&nbsp;`, whatever its casing, is whitespace, not content. */
const NBSP = /&nbsp;/gi;

/** A list bullet with no item after it. */
const LONE_BULLET = /^[-*+]$/;

/** A thematic break; `---`, `***` and `___` when not used as a setext underline. */
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;

/** Combining marks left over after NFD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Folds accents so `Investigación` and `Investigacion` compare equal (`ñ` included). */
function foldAccents(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '');
}

/** Accent-folded and lowercased, the form used for section-name comparison. */
function canonical(text: string): string {
  return foldAccents(text).toLowerCase();
}

/**
 * The name a heading carries, independent of how it was written. Numbering, emphasis and
 * trailing punctuation are presentation, not part of the name, so two spellings of one
 * title compare equal.
 */
function normalizeTitle(raw: string): string {
  const unemphasized = raw.replace(/[*_]+/g, '');
  const unnumbered = unemphasized.replace(/^\s*\d+[.)]\s*/, '');
  const unpunctuated = unnumbered.replace(/[:.]+[ \t]*$/, '');
  return foldAccents(unpunctuated.trim());
}

/**
 * The text of a line once markup is removed. HTML elements are dropped whole (including
 * the text inside them): an HTML heading is not a Markdown section's content.
 */
function contentText(raw: string): string {
  let text = raw.replace(ZERO_WIDTH, '');
  text = text.replace(HTML_ELEMENT, '');
  text = text.replace(HTML_TAG, '');
  return text.replace(NBSP, ' ').trim();
}

/** Whether a line is real content, as opposed to decoration or an empty placeholder. */
function hasRealContent(raw: string): boolean {
  const text = contentText(raw);
  if (text.length === 0) return false;
  if (LONE_BULLET.test(text)) return false;
  return !THEMATIC_BREAK.test(text);
}

interface Section {
  readonly title: string;
  readonly level: number;
  hasContent: boolean;
}

interface Analysis {
  readonly headings: readonly string[];
  readonly sections: readonly Section[];
  /** Lines outside any code fence, comments stripped: what a source scan sees. */
  readonly visible: readonly string[];
}

/** Pops every open section that the new heading closes (same or shallower level). */
function closeSections(open: Section[], level: number): void {
  while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= level) open.pop();
}

/**
 * Walks the document once. HTML comments are removed first: a heading hidden in one is not
 * a section and a comment is not content. Fenced code is tracked so examples do not become
 * headings, and each section records whether content follows before a sibling or parent
 * heading closes it. Content inside a subsection also counts for the sections containing it.
 */
function analyze(document: string): Analysis {
  const stripped = document.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripped.split(/\r?\n/);
  const headings: string[] = [];
  const sections: Section[] = [];
  const visible: string[] = [];
  const open: Section[] = [];
  let fence: { char: string; length: number } | undefined;

  // Content belongs to the innermost section and to every section that contains it.
  const markContent = (): void => {
    for (const section of open) section.hasContent = true;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (fence) {
      const closer = FENCE_CLOSE.exec(line);
      if (
        closer &&
        closer[1] &&
        closer[1][0] === fence.char &&
        closer[1].length >= fence.length
      ) {
        fence = undefined;
      } else if (line.trim().length > 0) {
        // A block with lines inside is content; an empty block is not.
        markContent();
      }
      index += 1;
      continue;
    }

    const opener = FENCE_OPEN.exec(line);
    const openerMarker = opener?.[1];
    // A backtick fence whose info string contains a backtick is not a fence at all, so
    // ```` ```js``` es un ejemplo ```` stays prose and does not swallow later headings.
    const opensFence =
      openerMarker !== undefined &&
      !(openerMarker[0] === '`' && (opener?.[2] ?? '').includes('`'));
    if (opensFence && openerMarker !== undefined) {
      fence = { char: openerMarker.charAt(0), length: openerMarker.length };
      index += 1;
      continue;
    }

    // Everything past the fence handling is prose or heading, so it is visible to a scan.
    visible.push(line);

    const atx = ATX_HEADING.exec(line);
    if (atx && atx[1]) {
      const level = atx[1].length;
      const title = normalizeTitle((atx[2] ?? '').replace(ATX_CLOSING, ''));
      closeSections(open, level);
      const section: Section = { title, level, hasContent: false };
      headings.push(title);
      sections.push(section);
      open.push(section);
      index += 1;
      continue;
    }

    // Setext heading: a paragraph line underlined by `===` (level 1) or `---` (level 2).
    const next = lines[index + 1];
    const underline = next === undefined ? null : SETEXT_UNDERLINE.exec(next);
    if (underline && underline[1] && line.trim().length > 0 && !/^ {4,}/.test(line)) {
      const level = underline[1][0] === '=' ? 1 : 2;
      const title = normalizeTitle(line.trim());
      closeSections(open, level);
      const section: Section = { title, level, hasContent: false };
      headings.push(title);
      sections.push(section);
      open.push(section);
      index += 2;
      continue;
    }

    if (hasRealContent(line)) markContent();
    index += 1;
  }

  return { headings, sections, visible };
}

/** Every heading in the document, accent-folded. Headings inside code blocks do not count. */
export function findSections(document: string): readonly string[] {
  return analyze(document).headings;
}

/** Requires each named section to exist AND to have something under it. */
export function requireSections(document: string, required: readonly string[]): CheckResult {
  const { sections } = analyze(document);

  const missing = required.filter((name) => {
    const wanted = canonical(name);
    return !sections.some((section) => canonical(section.title) === wanted && section.hasContent);
  });

  if (missing.length === 0) return { ok: true };

  // List every missing name at once, and only the missing ones, so the report tells the
  // author the full task rather than trickling it out one section per run.
  return {
    ok: false,
    reason: `Missing required sections (or they have no content under them): ${missing.join(', ')}.`,
  };
}

/** A URL token: the scheme plus everything up to whitespace or a structural delimiter. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`|]+/gi;

/** Characters that wrap a link in prose (`«url»`, `**url**`, `(url)`) and are not the URL. */
const URL_WRAPPERS = new Set(['»', '«', '*', '_', '`', '|', ')', ']', ',', '.', ';', ':', '"', "'", '>', '<']);

/** Drops the wrapping characters that a regex cannot tell apart from a URL's own tail. */
function trimWrappers(candidate: string): string {
  let end = candidate.length;
  while (end > 0 && URL_WRAPPERS.has(candidate[end - 1] ?? '')) end -= 1;
  return candidate.slice(0, end);
}

/** A dotted-quad IPv4 literal. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether a host is a local name or a literal address, none of which is a published source. */
function isNonSource(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // An IPv6 literal keeps its brackets in `URL.hostname`, e.g. `[::1]`.
  if (host.startsWith('[')) return true;
  if (IPV4.test(host)) return true;
  // Any `.local` name is a private/mDNS address, not a source on the public web.
  return host.endsWith('.local');
}

/**
 * National second-level suffixes that need three labels to reach the registrable domain.
 * A short, explicit approximation — a full answer needs the Public Suffix List, which this
 * project deliberately does not depend on.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  'com.mx',
  'org.mx',
  'gob.mx',
  'net.mx',
  'com.br',
  'com.ar',
  'com.co',
  'co.uk',
  'com.au',
  'co.jp',
]);

/** The registrable domain of a host: its last two labels, or last three for `com.mx` etc. */
function registrableDomain(host: string): string {
  const withoutWww = host.startsWith('www.') ? host.slice(4) : host;
  const labels = withoutWww.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = SECOND_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Normalizes a host the same way `URL.hostname` does, for comparing against a known list. */
function canonicalDomain(host: string): string {
  return host.trim().replace(/[.,;:]+$/, '').toLowerCase();
}

/** Maps a raw URL token to its provider domain, or `undefined` when it is not a source. */
function domainOf(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(trimWrappers(candidate));
  } catch {
    // A URL we cannot read does not count as a source.
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0 || isNonSource(host)) return undefined;
  return registrableDomain(host);
}

/**
 * Collects every distinct provider linked from the document, whether as a markdown link
 * target or a bare URL. Ports, credentials, queries and fragments are dropped; subdomains
 * collapse onto the provider. Links inside a code block or an HTML comment do not count.
 */
function collectDomains(document: string): Set<string> {
  const domains = new Set<string>();
  const visible = analyze(document).visible.join('\n');
  for (const match of visible.matchAll(URL_CANDIDATE)) {
    const candidate = match[0];
    if (!candidate) continue;
    const domain = domainOf(candidate);
    if (domain !== undefined) domains.add(domain);
  }
  return domains;
}

/** Distinct providers linked from the document. Two links to one provider count once. */
export function countDistinctSources(document: string): number {
  return collectDomains(document).size;
}

/** Requires enough distinct sources, and optionally enough from outside a known list. */
export function requireSources(document: string, requirement: SourceRequirement): CheckResult {
  const domains = collectDomains(document);

  if (domains.size < requirement.min) {
    const found = domains.size;
    return {
      ok: false,
      reason:
        `Found ${found} distinct source${found === 1 ? '' : 's'}, ` +
        `but at least ${requirement.min} are required.`,
    };
  }

  const outside = requirement.outside;
  if (outside) {
    // Compare providers, so a subdomain of a known vendor is still the known vendor.
    const known = new Set(outside.of.map((domain) => registrableDomain(canonicalDomain(domain))));
    let fromOutside = 0;
    for (const domain of domains) {
      if (!known.has(domain)) fromOutside += 1;
    }

    if (fromOutside < outside.min) {
      return {
        ok: false,
        reason:
          `Found ${fromOutside} distinct source${fromOutside === 1 ? '' : 's'} from outside ` +
          `the known list, but at least ${outside.min} are required.`,
      };
    }
  }

  return { ok: true };
}

/**
 * The files recorded earlier still have the same content now. Keys are file names, values
 * are content hashes. Names every file that changed, appeared or disappeared. An empty
 * record protects nothing, so it is refused rather than passed.
 */
export function requireSameFiles(
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): CheckResult {
  // An empty record is not a weaker check, it is no check at all: every file trivially
  // matches a set of zero expectations. Passing it would be a green that proves nothing,
  // so it is refused instead.
  if (Object.keys(recorded).length === 0) {
    return {
      ok: false,
      reason: 'No files were recorded, so there is nothing to compare against.',
    };
  }

  // Hashes are compared case-insensitively because hex digests differ only in the case of
  // their letters depending on who wrote them down.
  const normalize = (hash: string): string => hash.toLowerCase();

  const changed: string[] = [];
  const appeared: string[] = [];
  const missing: string[] = [];

  for (const name of Object.keys(recorded)) {
    if (!Object.prototype.hasOwnProperty.call(current, name)) {
      missing.push(name);
    } else if (normalize(recorded[name] ?? '') !== normalize(current[name] ?? '')) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(recorded, name)) appeared.push(name);
  }

  if (changed.length === 0 && appeared.length === 0 && missing.length === 0) {
    return { ok: true };
  }

  // Report every difference at once, grouped by kind, so the author sees the whole drift
  // rather than one file per run.
  const parts: string[] = [];
  if (changed.length > 0) parts.push(`changed: ${changed.join(', ')}`);
  if (appeared.length > 0) parts.push(`appeared: ${appeared.join(', ')}`);
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);

  return {
    ok: false,
    reason: `Files no longer match what was recorded (${parts.join('; ')}).`,
  };
}
