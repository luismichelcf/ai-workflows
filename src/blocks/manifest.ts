import type { GateNature } from '../contract.js';

/** PLAN-13-R2 §6: the four validity rules a block may allow. */
export type ValidWhile =
  | 'same-sha'
  | 'same-fingerprint'
  | 'same-fingerprint-or-clean-update'
  | 'forever';

export const ALL_VALID_WHILE: readonly ValidWhile[] = [
  'same-sha',
  'same-fingerprint',
  'same-fingerprint-or-clean-update',
  'forever',
];

export interface InputSpecString {
  readonly type: 'string';
  readonly required?: boolean;
  readonly default?: string;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

export interface InputSpecInteger {
  readonly type: 'integer';
  readonly required?: boolean;
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface InputSpecBoolean {
  readonly type: 'boolean';
  readonly required?: boolean;
  readonly default?: boolean;
}

export interface InputSpecStringList {
  readonly type: 'string-list';
  readonly required?: boolean;
  readonly default?: readonly string[];
}

export interface InputSpecCommand {
  readonly type: 'command';
  readonly required?: boolean;
  readonly default?: string;
  /** The command must carry `{tests}` as a whole argument (red-test, build-verify). */
  readonly requireTests?: boolean;
}

export interface InputSpecGlobList {
  readonly type: 'glob-list';
  readonly required?: boolean;
  readonly default?: readonly string[];
  /** PLAN-13-R3 §1.1: only a block that substitutes `{piece}` may accept it in its globs. */
  readonly piece?: boolean;
}

export interface InputSpecObject {
  readonly type: 'object';
  readonly required?: boolean;
  readonly fields: Readonly<Record<string, InputSpec>>;
}

export interface InputSpecObjectList {
  readonly type: 'object-list';
  readonly required?: boolean;
  readonly items: Readonly<Record<string, InputSpec>>;
}

/** PLAN-13-R2 §2.1: one entry of a block's `inputs`, in its YAML shape. */
export type InputSpec =
  | InputSpecString
  | InputSpecInteger
  | InputSpecBoolean
  | InputSpecStringList
  | InputSpecCommand
  | InputSpecGlobList
  | InputSpecObject
  | InputSpecObjectList;

/** PLAN-13-R3 §1.3: the ways the judge on GitHub may check a block. */
export type ServerMode = 'recompute' | 'require-check' | 'attestation';

/** PLAN-13-R2 §2.1: what a block declares before anything runs against it. */
export interface BlockManifest {
  /** `'red-test'` for an engine block, or the project block path it was read from. */
  readonly name: string;
  readonly kind: 'module' | 'command';
  readonly natures: readonly GateNature[];
  /** Absent means every validity rule is allowed. */
  readonly validWhile?: readonly ValidWhile[];
  /** PLAN-13-R3 §1.3: the server modes this block allows; a project block takes `require-check`. */
  readonly server: readonly ServerMode[];
  readonly inputs: Readonly<Record<string, InputSpec>>;
}
