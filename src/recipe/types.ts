import type { GateNature } from '../contract.js';

export interface RecipeError {
  readonly file: string;
  /** One-based position of the offending token. */
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface RecipeCondition {
  readonly touchesAny?: readonly string[];
  readonly touchesNone?: readonly string[];
  readonly kindAny?: readonly string[];
  readonly kindNone?: readonly string[];
  readonly laneAny?: readonly string[];
}

export interface RecipeGate {
  readonly uses?: string;
  readonly run?: string;
  /** Block inputs remain in their YAML shape, including kebab-case keys. */
  readonly with?: unknown;
}

export interface RecipeStage {
  readonly id: string;
  /** Text for the owner, written in the recipe's locale. */
  readonly summary: string;
  readonly after?: string;
  readonly phase: 'pre-merge' | 'merge' | 'post-merge';
  readonly required: boolean;
  readonly nature: GateNature;
  readonly appliesIf?: RecipeCondition;
  /** Always present: an absent valid-while reads as `same-sha` (R14). */
  readonly validWhile:
    | 'same-sha'
    | 'same-fingerprint'
    | 'same-fingerprint-or-clean-update'
    | 'forever';
  readonly needsHuman: boolean;
  readonly gate: RecipeGate;
  readonly server?:
    | 'recompute'
    | 'attestation'
    | 'local-only'
    | { readonly requireCheck: string };
  readonly retry?: { readonly attempts: number; readonly waitSeconds: number };
}

/** R19: how a branch names its piece, and where the piece declares its kind. */
export interface RecipePieces {
  /** Branch patterns; `{piece}` appears exactly once in each. */
  readonly branch: readonly string[];
  /** Branches that never join the main line; absent reads as empty. */
  readonly excludeBranches: readonly string[];
  readonly declaredKind?: {
    readonly file: string;
    readonly line: string;
  };
}

export interface Recipe {
  readonly version: 1;
  readonly locale: string;
  readonly owner?: string;
  /** R19: optional; without it the piece of a change is the pull request number. */
  readonly pieces?: RecipePieces;
  /** Named file classes retain declaration order for condition messages. */
  readonly classify: Readonly<Record<string, readonly string[]>>;
  readonly kinds?: {
    /** The closed vocabulary of change kinds (R15). */
    readonly names: readonly string[];
    readonly default: string;
    readonly fromPaths: Readonly<Record<string, readonly string[]>>;
    readonly elevate: readonly {
      readonly when: RecipeCondition;
      readonly to: string;
    }[];
  };
  /** Every declared kind in exactly one lane (R15). */
  readonly lanes?: Readonly<Record<string, readonly string[]>>;
  /** Owner-facing names for classes, kinds and lanes (R16). */
  readonly labels?: Readonly<Record<string, string>>;
  readonly stages: readonly RecipeStage[];
}
