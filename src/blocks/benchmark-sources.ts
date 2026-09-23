import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Gate, GateResult, JsonValue } from '../contract.js';
import type { BlockDefinition, EngineBlockDeps, ServerContext, ServerResult } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { analyzeDocument, canonicalText, collectSourceUrls, countDistinctSources } from '../gates.js';
import { classifyFiles } from '../recipe/glob.js';

// PLAN-13-R2 §3.2 (CN-01): `benchmark-sources@1` counts the distinct providers a benchmark
// document links to, per category, and optionally asks whether each counted source answers. A
// written waiver with its motive skips the stage, never passes it. Every title, path and
// threshold arrives through `with:`; nothing of any project lives in the engine.

const REQUEST_TIMEOUT_MS = 10_000;

// Many sites answer 403 or 404 to a request with no user agent, which would read as "does not
// respond" for a source that a person can open. The header only says a browser is asking.
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

export const manifest: BlockManifest = {
  name: 'benchmark-sources',
  kind: 'module',
  natures: ['structure'],
  server: ['recompute', 'require-check'],
  inputs: {
    files: { type: 'glob-list', required: true },
    categories: {
      type: 'object-list',
      items: {
        heading: { type: 'string', required: true },
        min: { type: 'integer', required: true, min: 0, max: 100 },
      },
    },
    'min-total': { type: 'integer', min: 0, max: 1000, default: 0 },
    sections: { type: 'string-list' },
    waiver: { type: 'string' },
    spec: { type: 'string' },
    'check-reachable': { type: 'boolean', default: false },
  },
};

interface Category {
  readonly heading: string;
  readonly min: number;
}

type Evaluation = { readonly ok: true; readonly evidence: JsonValue } | { readonly ok: false; readonly reason: string };

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

function readCategories(value: unknown): Category[] {
  if (!Array.isArray(value)) return [];
  const categories: Category[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const heading = asString(record['heading']);
    const min = record['min'];
    if (heading === undefined || typeof min !== 'number') continue;
    categories.push({ heading, min });
  }
  return categories;
}

/** The motive written after the waiver tag on some line, when it is not empty. */
function waiverMotive(text: string, waiver: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(waiver)) continue;
    const rest = line.slice(waiver.length);
    for (const separator of [' — ', ' - ']) {
      if (rest.startsWith(separator)) {
        const motive = rest.slice(separator.length).trim();
        if (motive.length > 0) return motive;
      }
    }
  }
  return undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Every file of the tree, relative to the root, with forward slashes. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk('');
  return files;
}

async function matchingFiles(root: string, globs: readonly string[]): Promise<string[]> {
  const all = await listFiles(root);
  const matched = new Set<string>();
  for (const file of all) {
    for (const glob of globs) {
      if (classifyFiles({ hit: [glob] }, [file]).length > 0) {
        matched.add(file);
        break;
      }
    }
  }
  return [...matched].sort();
}

/** The URL that answered, or undefined when none did. A redirect is not followed: a 3xx is an
 * answer, and following it could reach an internal address the document never cited. */
async function respondingUrl(url: string): Promise<string | undefined> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  const candidates = origin === url ? [url] : [url, origin];

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      try {
        const head = await fetch(candidate, {
          method: 'HEAD',
          redirect: 'manual',
          headers: BROWSER_HEADERS,
          signal: controller.signal,
        });
        if (head.status < 400) return candidate;
      } catch {
        // A HEAD that does not answer falls through to a GET.
      }
      const get = await fetch(candidate, {
        method: 'GET',
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      });
      if (get.status < 400) return candidate;
    } catch {
      // The candidate is unreachable; the next one, or the refusal, decides.
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

async function evaluateFile(
  file: string,
  text: string,
  sections: readonly string[],
  categories: readonly Category[],
  minTotal: number,
  checkReachable: boolean,
  spanish: boolean,
): Promise<Evaluation> {
  const analysis = analyzeDocument(text);

  const missingSections = sections.filter((name) => {
    const wanted = canonicalText(name);
    return !analysis.sections.some(
      (section) => canonicalText(section.title) === wanted && section.hasContent,
    );
  });
  if (missingSections.length > 0) {
    return {
      ok: false,
      reason: spanish
        ? `Faltan secciones con contenido: ${list(missingSections, spanish)}.`
        : `Missing sections with content: ${list(missingSections, spanish)}.`,
    };
  }

  const counts: Record<string, number> = {};
  const matchedTexts: string[] = [];
  const citedUrls = new Set<string>();

  // A heading of level 1 or 2 belongs to the FIRST category, in the order written, whose
  // heading its title contains. One section goes to exactly one category.
  const assigned = new Map<string, string[]>();
  for (const section of analysis.sections) {
    if (section.level > 2) continue;
    const title = canonicalText(section.title);
    const category = categories.find((item) => title.includes(canonicalText(item.heading)));
    if (category === undefined) continue;
    const bucket = assigned.get(category.heading) ?? [];
    bucket.push(section.lines.join('\n'));
    assigned.set(category.heading, bucket);
  }

  for (const category of categories) {
    const texts = assigned.get(category.heading);
    if (texts === undefined) {
      return {
        ok: false,
        reason: spanish
          ? `Falta la sección ${quoted(category.heading, spanish)}.`
          : `Missing section ${quoted(category.heading, spanish)}.`,
      };
    }
    const joined = texts.join('\n');
    const count = countDistinctSources(joined);
    counts[category.heading] = count;
    matchedTexts.push(joined);
    for (const source of collectSourceUrls(joined)) citedUrls.add(source.url);
    if (count < category.min) {
      return {
        ok: false,
        reason: spanish
          ? `La sección ${quoted(category.heading, spanish)} tiene ${count} proveedores distintos y hacen falta al menos ${category.min}.`
          : `The section ${quoted(category.heading, spanish)} has ${count} distinct providers and at least ${category.min} are required.`,
      };
    }
  }

  const total = countDistinctSources(matchedTexts.join('\n'));
  if (total < minTotal) {
    return {
      ok: false,
      reason: spanish
        ? `Hay ${total} proveedores distintos en total y hacen falta al menos ${minTotal}.`
        : `There are ${total} distinct providers in total and at least ${minTotal} are required.`,
    };
  }

  let reachable: Record<string, string> | undefined;
  if (checkReachable) {
    reachable = {};
    for (const url of citedUrls) {
      const answered = await respondingUrl(url);
      if (answered === undefined) {
        return {
          ok: false,
          reason: spanish
            ? `La fuente ${quoted(url, spanish)} no responde.`
            : `The source ${quoted(url, spanish)} does not respond.`,
        };
      }
      reachable[url] = answered;
    }
  }

  return {
    ok: true,
    evidence: { file, counts, ...(reachable === undefined ? {} : { reachable }) },
  };
}

function createGate(
  files: readonly string[],
  categories: readonly Category[],
  minTotal: number,
  sections: readonly string[],
  waiver: string | undefined,
  spec: string | undefined,
  checkReachable: boolean,
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    const spanish = isSpanish(context.locale);
    const piece = context.piece;
    const globs = files.map((glob) => glob.replaceAll('{piece}', piece));

    if (waiver !== undefined && spec !== undefined) {
      const specPath = spec.replaceAll('{piece}', piece);
      const specText = await readIfExists(join(deps.root, specPath));
      if (specText !== undefined) {
        const motive = waiverMotive(specText, waiver);
        if (motive !== undefined) return { ok: 'skipped', reason: motive };
      }
    }

    const candidates = await matchingFiles(deps.root, globs);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: spanish
          ? `No hay benchmark en ${quoted(globs.join(', '), spanish)}.`
          : `There is no benchmark in ${quoted(globs.join(', '), spanish)}.`,
      };
    }

    let lastReason: string | undefined;
    for (const file of candidates) {
      const text = await readFile(join(deps.root, file), 'utf8');
      const result = await evaluateFile(
        file,
        text,
        sections,
        categories,
        minTotal,
        checkReachable,
        spanish,
      );
      if (result.ok) return { ok: true, evidence: result.evidence };
      lastReason = result.reason;
    }

    return { ok: false, reason: lastReason ?? '' };
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The files of a commit (already listed) that match any of the globs, in sorted order. */
function matchingNames(all: readonly string[], globs: readonly string[]): string[] {
  const matched = new Set<string>();
  for (const file of all) {
    for (const glob of globs) {
      if (classifyFiles({ hit: [glob] }, [file]).length > 0) {
        matched.add(file);
        break;
      }
    }
  }
  return [...matched].sort();
}

/**
 * PLAN-13-R3 §1.3: the same count, read from the judged commit. On the server it never asks a
 * source to answer (`check-reachable: true` is refused on GitHub by `validate`), so the evidence
 * it leaves says exactly what it checked: counts, and nothing about reachability.
 */
async function recompute(
  inputs: Record<string, unknown>,
  context: ServerContext,
): Promise<ServerResult> {
  const spanish = isSpanish(context.locale);
  const piece = context.piece;
  const globs = asStringList(inputs['files']).map((glob) => glob.replaceAll('{piece}', piece));
  const categories = readCategories(inputs['categories']);
  const minTotal = typeof inputs['minTotal'] === 'number' ? inputs['minTotal'] : 0;
  const sections = asStringList(inputs['sections']);
  const waiver = asString(inputs['waiver']);
  const spec = asString(inputs['spec']);

  if (waiver !== undefined && spec !== undefined) {
    const specPath = spec.replaceAll('{piece}', piece);
    let specText: string | undefined;
    try {
      specText = await context.files.read(specPath);
    } catch (error) {
      return { outcome: 'technical', reason: reasonOf(error) };
    }
    if (specText !== undefined) {
      const motive = waiverMotive(specText, waiver);
      if (motive !== undefined) return { outcome: 'skipped', reason: motive };
    }
  }

  let all: string[];
  try {
    all = await context.files.list();
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }

  const candidates = matchingNames(all, globs);
  if (candidates.length === 0) {
    return {
      outcome: 'rejected',
      reason: spanish
        ? `No hay benchmark en ${quoted(globs.join(', '), spanish)}.`
        : `There is no benchmark in ${quoted(globs.join(', '), spanish)}.`,
    };
  }

  let lastReason: string | undefined;
  for (const file of candidates) {
    let text: string | undefined;
    try {
      text = await context.files.read(file);
    } catch (error) {
      return { outcome: 'technical', reason: reasonOf(error) };
    }
    if (text === undefined) continue;
    const result = await evaluateFile(file, text, sections, categories, minTotal, false, spanish);
    if (result.ok) return { outcome: 'passed', evidence: result.evidence };
    lastReason = result.reason;
  }

  return { outcome: 'rejected', reason: lastReason ?? '' };
}

export const benchmarkSourcesBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    return createGate(
      asStringList(inputs['files']),
      readCategories(inputs['categories']),
      typeof inputs['minTotal'] === 'number' ? inputs['minTotal'] : 0,
      asStringList(inputs['sections']),
      asString(inputs['waiver']),
      asString(inputs['spec']),
      inputs['checkReachable'] === true,
      deps,
    );
  },
  server: { recompute },
};
