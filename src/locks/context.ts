// PLAN-13-R5 §1.2–§1.4: the LockContext built from the recipe and the branch of a working copy.
//
// v0.3.0 left these functions pure and asked the project to build the context in its own scripts.
// This module builds it from the recipe, so the engine and the project answer the same question
// the same way: a branch that names a piece opens it, an excluded branch is libre, any other
// branch or a detached head only reaches the paper folders, and an unreadable recipe puts the lock
// in broken-recipe mode. The git commands live in hook-cli.ts; everything here is pure.

import { excludedBy, pieceOfBranch } from '../judge/pieces.js';
import type { Recipe } from '../recipe/types.js';
import type { LockContext } from './editor.js';

/** The order the judge's own change always knows, even when the recipe names no approval stage. */
export const JUDGE_CHANGE_ORDER = '/approve-judge-change';
/** The block default when an approval-comment stage names no command (`approval-comment@1`). */
const DEFAULT_APPROVAL_COMMAND = '/visto-bueno';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * §1.3: the orders only the owner writes, read from the recipe: every `with.command` of an
 * `approval-comment` stage (the block default when it is missing) and, always, the judge-change
 * attestation. An order repeated by two stages is kept once, so a command is judged, not counted.
 */
export function ownerOrdersOf(recipe: Recipe): readonly string[] {
  const orders: string[] = [];
  for (const stage of recipe.stages) {
    if (stage.gate.uses !== 'ai-workflows/approval-comment@1') continue;
    const withValue = asRecord(stage.gate.with);
    const command = withValue?.['command'];
    const order =
      typeof command === 'string' && command.length > 0 ? command : DEFAULT_APPROVAL_COMMAND;
    if (!orders.includes(order)) orders.push(order);
  }
  if (!orders.includes(JUDGE_CHANGE_ORDER)) orders.push(JUDGE_CHANGE_ORDER);
  return orders;
}

export interface LockContextInput {
  /** Absolute path of the working copy the lock guards. */
  readonly root: string;
  /** Its current branch, or `undefined` on a detached head. */
  readonly branch: string | undefined;
  /** Its recipe, or the problem that stopped it from being read. */
  readonly recipe: Recipe | { readonly invalid: string };
}

/**
 * §1.2–§1.4: the context of one working copy. `{ invalid }` means broken-recipe mode, where only
 * `.ai-workflows/` is writable and rule 0 is stricter. Without `pieces:` no branch names a piece,
 * so the context is exactly the one the old callers built: project root and paper folders.
 */
export function lockContextFor(input: LockContextInput): LockContext {
  if ('invalid' in input.recipe) {
    return {
      projectRoot: input.root,
      paperPaths: [],
      brokenRecipe: input.recipe.invalid,
    };
  }

  const recipe = input.recipe;
  const base: LockContext = {
    projectRoot: input.root,
    paperPaths: recipe.hooks?.papers ?? [],
    ownerOrders: ownerOrdersOf(recipe),
    forbidPullRequestApproval: true,
  };

  if (input.branch === undefined) return base;
  if (excludedBy(recipe, input.branch) !== undefined) {
    return { ...base, libre: true };
  }

  const named = pieceOfBranch(recipe, input.branch, 0);
  if (recipe.pieces !== undefined && 'piece' in named) {
    return { ...base, activePiece: named.piece };
  }
  return base;
}
