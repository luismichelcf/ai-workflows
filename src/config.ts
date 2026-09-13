import type { PipelineConfig, StageConfig, ValidationResult } from './contract.js';

/**
 * Rejects a pipeline whose order is not fully determined. See `ValidateConfig` in the
 * contract for the six rejection cases and why ambiguity is one of them.
 */
export function validateConfig(config: PipelineConfig): ValidationResult {
  const stages = config.stages;
  const errors: string[] = [];

  if (stages.length === 0) {
    errors.push('pipeline has no stages');
  }

  const names = new Set<string>();
  for (const stage of stages) {
    if (names.has(stage.name)) {
      errors.push(`duplicate stage name "${stage.name}"`);
    }
    names.add(stage.name);
  }

  // A stage may only point at a name that exists. Unknown targets are reported here and
  // skipped by the cycle walk below, so a missing `after` is never mistaken for a loop.
  for (const stage of stages) {
    if (stage.after !== undefined && !names.has(stage.after)) {
      errors.push(`stage "${stage.name}" runs after unknown stage "${stage.after}"`);
    }
  }

  const roots = stages.filter((stage) => stage.after === undefined);
  if (roots.length > 1) {
    const rootNames = roots.map((stage) => `"${stage.name}"`).join(', ');
    errors.push(`pipeline has ${roots.length} stages without a predecessor: ${rootNames}`);
  }

  // Two stages sharing an `after` leave their relative order undecided: both are ready at
  // the same time, so the array position would silently pick the winner.
  const children = new Map<string, string[]>();
  for (const stage of stages) {
    if (stage.after === undefined) continue;
    const list = children.get(stage.after);
    if (list === undefined) children.set(stage.after, [stage.name]);
    else list.push(stage.name);
  }
  for (const [after, descendants] of children) {
    if (descendants.length > 1) {
      const childNames = descendants.map((name) => `"${name}"`).join(', ');
      errors.push(`${childNames} all declare after "${after}"`);
    }
  }

  // Depth-first colouring detects any cycle, including a stage pointing at itself. Each
  // node is walked once, so a cycle terminates instead of spinning forever.
  const byName = new Map<string, StageConfig>();
  for (const stage of stages) byName.set(stage.name, stage);

  const state = new Map<string, 'visiting' | 'done'>();
  let cyclic = false;
  const visit = (name: string): void => {
    const colour = state.get(name);
    if (colour === 'done') return;
    if (colour === 'visiting') {
      cyclic = true;
      return;
    }
    state.set(name, 'visiting');
    const after = byName.get(name)?.after;
    if (after !== undefined && byName.has(after)) visit(after);
    state.set(name, 'done');
  };
  for (const name of byName.keys()) visit(name);
  if (cyclic) {
    errors.push('pipeline has a cycle in its stage order');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Stable fingerprint of a pipeline's shape: stage names and their order. Journal entries
 * carry it so evidence produced under a different pipeline is not mistaken for current.
 * Gate function identity is deliberately NOT part of it — editing a gate's body does not
 * invalidate what the engine observed.
 */
export function fingerprint(config: PipelineConfig): string {
  // Resolve the order from `after`, not from array position: two pipelines that declare
  // the same chain differently are the same shape. Kahn's walk is bounded, so a malformed
  // (cyclic) config still terminates and whatever is left is appended as-is.
  const byName = new Map<string, StageConfig>();
  for (const stage of config.stages) {
    if (!byName.has(stage.name)) byName.set(stage.name, stage);
  }

  const children = new Map<string, string[]>();
  const queue: string[] = [];
  for (const stage of byName.values()) {
    const after = stage.after;
    if (after === undefined || !byName.has(after)) {
      queue.push(stage.name);
    } else {
      const list = children.get(after);
      if (list === undefined) children.set(after, [stage.name]);
      else list.push(stage.name);
    }
  }

  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
    for (const child of children.get(name) ?? []) queue.push(child);
  }
  for (const stage of config.stages) {
    if (!seen.has(stage.name)) {
      seen.add(stage.name);
      order.push(stage.name);
    }
  }

  // Only names and their resolved order feed the hash; gate bodies are deliberately absent.
  return JSON.stringify(order);
}
