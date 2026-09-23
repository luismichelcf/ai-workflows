import { classifyFiles } from './glob.js';
import type { Recipe, RecipeCondition } from './types.js';

// PLAN-13-R2 §4.2: the kind that decides which stages apply is the effective one — forced by
// `from-paths` when every file falls under one key, otherwise declared or defaulted, then raised
// by the `elevate` rules in order — and the lane follows it (R15, CN-10).

/** The effective kind, the lane that contains it, and the rules that acted on it. */
export interface EffectiveKind {
  readonly kind: string;
  readonly lane?: string;
  readonly raisedBy: string[];
}

/** Every clause written must hold; an absent clause does not constrain. */
function touches(condition: RecipeCondition, classes: readonly string[], kind: string): boolean {
  if (condition.touchesAny !== undefined && !condition.touchesAny.some((name) => classes.includes(name))) {
    return false;
  }
  if (condition.touchesNone !== undefined && condition.touchesNone.some((name) => classes.includes(name))) {
    return false;
  }
  if (condition.kindAny !== undefined && !condition.kindAny.includes(kind)) return false;
  if (condition.kindNone !== undefined && condition.kindNone.includes(kind)) return false;
  return true;
}

function laneOf(
  lanes: Readonly<Record<string, readonly string[]>> | undefined,
  kind: string,
): string | undefined {
  if (lanes === undefined) return undefined;
  for (const [lane, kinds] of Object.entries(lanes)) {
    if (kinds.includes(kind)) return lane;
  }
  return undefined;
}

/** The first `from-paths` key, in declaration order, under which every file falls. */
function kindFromPaths(
  fromPaths: Readonly<Record<string, readonly string[]>>,
  files: readonly string[],
): string | undefined {
  if (files.length === 0) return undefined;
  for (const [kind, patterns] of Object.entries(fromPaths)) {
    if (files.every((file) => classifyFiles({ [kind]: patterns }, [file]).length === 1)) return kind;
  }
  return undefined;
}

export function effectiveKind(
  recipe: Recipe,
  declared: string | undefined,
  files: readonly string[],
): EffectiveKind {
  const kinds = recipe.kinds;
  const lane = (kind: string): { lane?: string } => {
    const found = laneOf(recipe.lanes, kind);
    return found === undefined ? {} : { lane: found };
  };

  if (kinds === undefined) {
    const kind = declared ?? '';
    return { kind, ...lane(kind), raisedBy: [] };
  }

  if (declared !== undefined && !kinds.names.includes(declared)) {
    throw new Error(`unknown kind "${declared}"`);
  }

  const classes = classifyFiles(recipe.classify, files);
  const raisedBy: string[] = [];
  const forced = kindFromPaths(kinds.fromPaths, files);
  let kind: string;
  if (forced !== undefined) {
    kind = forced;
    raisedBy.push(`from-paths: ${forced}`);
  } else {
    kind = declared ?? kinds.default;
  }

  // Rules apply in order, each over the result of the last; a rule that leaves the kind
  // unchanged does not count, but one that changes it counts even when it returns to an
  // earlier value.
  kinds.elevate.forEach((rule, index) => {
    if (!touches(rule.when, classes, kind)) return;
    if (rule.to === kind) return;
    kind = rule.to;
    raisedBy.push(`elevate ${index + 1}`);
  });

  return { kind, ...lane(kind), raisedBy };
}
