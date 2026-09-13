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

/** Every heading in the document, accent-folded. Headings inside code blocks do not count. */
export function findSections(_document: string): readonly string[] {
  throw new Error('findSections: not implemented');
}

/** Requires each named section to exist AND to have something under it. */
export function requireSections(
  _document: string,
  _required: readonly string[],
): CheckResult {
  throw new Error('requireSections: not implemented');
}

/** Distinct domains linked from the document. Two links to one domain count once. */
export function countDistinctSources(_document: string): number {
  throw new Error('countDistinctSources: not implemented');
}

/** Requires enough distinct sources, and optionally enough from outside a known list. */
export function requireSources(
  _document: string,
  _requirement: SourceRequirement,
): CheckResult {
  throw new Error('requireSources: not implemented');
}
