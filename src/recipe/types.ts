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
  /** Absent until the recipe explicitly declares a validity rule. */
  readonly validWhile?:
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

export interface Recipe {
  readonly version: 1;
  readonly locale: string;
  readonly owner?: string;
  /** Named file classes retain declaration order for condition messages. */
  readonly classify: Readonly<Record<string, readonly string[]>>;
  readonly kinds?: {
    readonly default: string;
    readonly fromPaths: Readonly<Record<string, readonly string[]>>;
    readonly elevate: readonly {
      readonly when: RecipeCondition;
      readonly to: string;
    }[];
  };
  readonly stages: readonly RecipeStage[];
}
