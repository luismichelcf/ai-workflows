import type { GateResult } from '../contract.js';
import { effectiveKind } from '../recipe/kind.js';
import type { BlockDefinition } from './definition.js';
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
};
