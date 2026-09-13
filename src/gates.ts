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

/** An ATX heading: one to six hashes followed by whitespace. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/** A fenced code block opener/closer: three or more backticks or tildes. */
const FENCE = /^(?:`{3,}|~{3,})/;

/** The authority of an http(s) URL, up to the first path/query/fragment separator. */
const URL_AUTHORITY = /https?:\/\/([^\s/)\]"'<>]+)/g;

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

/** Lowercases a host and drops a leading `www.` so both spellings name one domain. */
function canonicalDomain(host: string): string {
  const lower = host.trim().replace(/[.,;:]+$/, '').toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

interface Section {
  readonly title: string;
  hasContent: boolean;
}

interface ParseResult {
  readonly headings: readonly string[];
  readonly sections: readonly Section[];
}

/**
 * Walks the document once, tracking fenced code blocks so that a `## heading` shown as an
 * example inside a fence is not mistaken for a real section. Also records, per heading,
 * whether any non-blank content follows before the next heading.
 */
function parse(document: string): ParseResult {
  const headings: string[] = [];
  const sections: Section[] = [];
  let current: Section | undefined;
  let inFence = false;

  const lines = document.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();

    if (FENCE.test(trimmed)) {
      inFence = !inFence;
      // A code block is content: a section holding one is not empty.
      if (current) current.hasContent = true;
      continue;
    }

    if (inFence) {
      if (current) current.hasContent = true;
      continue;
    }

    const match = HEADING.exec(trimmed);
    if (match) {
      const title = foldAccents((match[2] ?? '').replace(/\s+#+\s*$/, '').trim());
      headings.push(title);
      current = { title, hasContent: false };
      sections.push(current);
      continue;
    }

    if (current && trimmed.length > 0) current.hasContent = true;
  }

  return { headings, sections };
}

/** Every heading in the document, accent-folded. Headings inside code blocks do not count. */
export function findSections(document: string): readonly string[] {
  return parse(document).headings;
}

/** Requires each named section to exist AND to have something under it. */
export function requireSections(document: string, required: readonly string[]): CheckResult {
  const { sections } = parse(document);

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

/**
 * Collects every distinct domain linked from the document, whether as a markdown link
 * target or a bare URL. Credentials and ports are dropped; `www.` is ignored.
 */
function collectDomains(document: string): Set<string> {
  const domains = new Set<string>();
  for (const match of document.matchAll(URL_AUTHORITY)) {
    const authority = match[1];
    if (!authority) continue;
    const host = authority.split('@').pop()?.replace(/:\d+$/, '') ?? '';
    if (host.length > 0) domains.add(canonicalDomain(host));
  }
  return domains;
}

/** Distinct domains linked from the document. Two links to one domain count once. */
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
    const known = new Set(outside.of.map((domain) => canonicalDomain(domain)));
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
