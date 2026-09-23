import type { BlockManifest, InputSpec } from '../blocks/manifest.js';

// PLAN-13-R2 §2.3: the `with:` of a stage is completed with the manifest's defaults before a
// block sees it. Engine blocks receive camelCase keys (the shape their `create` reads); project
// command blocks receive the keys exactly as written. Both the engine next to the agent
// (`compileRecipe`) and the judge on GitHub use this one function, so a default can never mean
// two different things.

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function defaultValueOf(spec: InputSpec): unknown {
  return Object.hasOwn(spec, 'default') ? (spec as { readonly default?: unknown }).default : undefined;
}

/** Applies the manifest defaults and renames the keys of an object-shaped input to camelCase. */
function fieldsWithDefaults(
  fields: Readonly<Record<string, InputSpec>>,
  raw: unknown,
): Record<string, unknown> {
  const provided = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = Object.hasOwn(provided, key) ? provided[key] : defaultValueOf(spec);
    if (value === undefined) continue;
    result[camelCase(key)] = withDefaults(spec, value);
  }
  return result;
}

function withDefaults(spec: InputSpec, value: unknown): unknown {
  if (spec.type === 'object') return fieldsWithDefaults(spec.fields, value);
  if (spec.type === 'object-list') {
    if (!Array.isArray(value)) return value;
    return value.map((item) => fieldsWithDefaults(spec.items, item));
  }
  return value;
}

/** The inputs of an engine block: defaults applied, keys in camelCase. */
export function blockInputs(manifest: BlockManifest, provided: unknown): Record<string, unknown> {
  return fieldsWithDefaults(manifest.inputs, provided);
}

/** The `with:` a project command block receives: declared defaults applied, keys as written. */
export function writtenInputs(
  fields: Readonly<Record<string, InputSpec>>,
  raw: unknown,
): Record<string, unknown> {
  const provided = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = Object.hasOwn(provided, key) ? provided[key] : defaultValueOf(spec);
    if (value === undefined) continue;
    result[key] = withDefaults(spec, value);
  }
  return result;
}
