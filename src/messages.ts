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
