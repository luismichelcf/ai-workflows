import type { GateContext, JournalEntry, JsonValue } from '../contract.js';
import type { AgentDeps, EngineBlockDeps } from './definition.js';

// PLAN-13-R4 §3: small pieces the final blocks share — the GitHub identity they need, the
// locale, the judged commit, the last passed entry of an earlier stage, and the URL glob.

export function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** The GitHub edge, or a technical failure when the final block was built without it. */
export function requireAgent(deps: EngineBlockDeps, spanish: boolean): AgentDeps {
  if (deps.agent === undefined) {
    throw new Error(
      spanish
        ? 'Este bloque necesita la identidad de GitHub de los agentes y no la tiene.'
        : 'This block needs the agents\' GitHub identity and does not have it.',
    );
  }
  return deps.agent;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The judged commit of the change, or a technical failure when the facts carry none. */
export function judgedSha(context: GateContext): string {
  const change = asObject(context.change);
  const sha = change === undefined ? undefined : asString(change['sha']);
  if (sha === undefined || sha.length === 0) {
    throw new Error('the change has no commit to judge');
  }
  return sha;
}

export function isClean(context: GateContext): boolean {
  const change = asObject(context.change);
  return change !== undefined && change['clean'] === true;
}

/** The evidence a stage seals: `{ judged, block }`; the block part is what a reader wants. */
export function blockEvidence(entry: JournalEntry | undefined): Record<string, unknown> | undefined {
  if (entry === undefined) return undefined;
  return asObject(asObject(entry.evidence)?.['block']);
}

/** The last passed entry of `stage`, whichever run wrote it. */
export function lastPassed(context: GateContext, stage: string): JournalEntry | undefined {
  for (let index = context.journal.length - 1; index >= 0; index -= 1) {
    const entry = context.journal[index];
    if (entry !== undefined && entry.stage === stage && entry.outcome === 'passed') return entry;
  }
  return undefined;
}

/** The string field `key` of a block's evidence, or undefined. */
export function evidenceString(entry: JournalEntry | undefined, key: string): string | undefined {
  const block = blockEvidence(entry);
  return block === undefined ? undefined : asString(block[key]);
}

export interface DeploymentRefusal {
  readonly reason: string;
}

/**
 * PLAN-13-R4 §3.4: a URL is acceptable when it is `https` and, when a pattern is given, its
 * host matches the pattern as a glob (`*` matches any run of characters).
 */
export function checkDeploymentUrl(
  url: string | null,
  pattern: string | undefined,
  spanish: boolean,
): string | undefined {
  if (url === null || !url.startsWith('https://')) {
    return spanish ? 'La dirección de la vista previa no es https.' : 'The preview address is not https.';
  }
  if (pattern === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return spanish ? `La dirección "${url}" no es válida.` : `The address "${url}" is not valid.`;
  }
  const source = `^${pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')}$`;
  return new RegExp(source, 'i').test(host)
    ? undefined
    : spanish
      ? `La dirección "${host}" no encaja con "${pattern}".`
      : `The address "${host}" does not match "${pattern}".`;
}

/** A JSON value that is an object, for evidence the types insist is `JsonValue`. */
export function asJsonObject(value: unknown): JsonValue {
  return value as JsonValue;
}
