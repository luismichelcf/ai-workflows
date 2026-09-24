import type { GateResult } from '../contract.js';
import { effectiveKind } from '../recipe/kind.js';
import type { BlockDefinition, ServerContext, ServerResult } from './definition.js';
import type { BlockManifest } from './manifest.js';

// PLAN-13-R2 §3.7 (CN-10): `scope-reconcile@1` recomputes the effective kind from the files
// that were really touched and records it next to the declared one, naming every rule that
// raised it. Raising the kind raises the lane with it, and the engine re-evaluates `applies-if`
// against the effective kind and lane on every run, so a stage that was skipped before now
// runs. The block only writes the evidence; the engine does the rest.

export const manifest: BlockManifest = {
  name: 'scope-reconcile',
  kind: 'module',
  natures: ['recompute'],
  server: ['recompute', 'require-check'],
  inputs: {},
};

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PLAN-13-R3 §1.3: on the server the judge already judges with the effective kind, so this block
 * only records that reconciliation: it always passes, with the declared and effective kinds and
 * the rules that raised it.
 */
async function recompute(
  _inputs: Record<string, unknown>,
  context: ServerContext,
): Promise<ServerResult> {
  const { facts, recipe } = context;
  let effective;
  try {
    effective = effectiveKind(recipe, facts.declaredKind, facts.files);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
  const declared = facts.declaredKind ?? recipe.kinds?.default ?? '';
  return {
    outcome: 'passed',
    evidence: { declared, effective: effective.kind, raisedBy: effective.raisedBy },
  };
}

export const scopeReconcileBlock: BlockDefinition = {
  manifest,
  create(_inputs, deps) {
    return (context): GateResult => {
      const change = readObject(context.change) ?? {};
      const declaredKind = asString(change['declaredKind']);
      const files = asStringList(change['files']);

      let effective;
      try {
        effective = effectiveKind(deps.recipe, declaredKind, files);
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }

      const declared = declaredKind ?? deps.recipe.kinds?.default ?? '';
      return {
        ok: true,
        evidence: {
          declared,
          effective: effective.kind,
          raisedBy: effective.raisedBy,
        },
      };
    };
  },
  server: { recompute },
};
