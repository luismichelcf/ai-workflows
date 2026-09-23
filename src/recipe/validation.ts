import { isMap, isScalar, isSeq, type Node, type YAMLMap, type YAMLSeq } from 'yaml';

import { recipeSchema } from './schema.js';

export type YamlNode = Node | null;

export interface LocatedIssue {
  readonly offset: number;
  readonly message: string;
}

interface Shape {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly minItems?: number;
  readonly minProperties?: number;
  readonly uniqueItems?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, Shape>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Shape;
  readonly propertyNames?: Shape;
  readonly items?: Shape;
  readonly oneOf?: readonly Shape[];
}

export function yamlMap(node: YamlNode): YAMLMap<Node, Node> | undefined {
  return isMap(node) ? node as YAMLMap<Node, Node> : undefined;
}

export function yamlSeq(node: YamlNode): YAMLSeq<Node> | undefined {
  return isSeq(node) ? node as YAMLSeq<Node> : undefined;
}

export function yamlValue(node: YamlNode): unknown {
  if (node === null) return null;
  if (isScalar(node)) return node.value;
  const list = yamlSeq(node);
  if (list) return list.items.map((item) => yamlValue(item));
  const object = yamlMap(node);
  if (object) {
    // A null prototype keeps a YAML __proto__ key as data, never as object behavior.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of object.items) {
      const key = scalarKey(pair.key);
      if (key !== undefined) result[key] = yamlValue(pair.value);
    }
    return result;
  }
  return null;
}

export function yamlField(node: YamlNode, key: string): YamlNode {
  return yamlMap(node)?.get(key, true) ?? null;
}

export function yamlWord(node: YamlNode): string {
  return scalarKey(node) ?? '';
}

export function scalarKey(node: YamlNode): string | undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
}

export function nodeStart(node: YamlNode): number {
  return node?.range?.[0] ?? 0;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_DEPTH = 64;

interface TreeInspection {
  readonly controls: readonly LocatedIssue[];
  readonly keys: readonly LocatedIssue[];
  readonly depth: readonly LocatedIssue[];
}

/** Inspect iteratively before validation or conversion can echo an unsafe key or recurse. */
export function inspectYamlTree(root: YamlNode): TreeInspection {
  const controls: LocatedIssue[] = [];
  const keys: LocatedIssue[] = [];
  const depth: LocatedIssue[] = [];
  const pending: { node: YamlNode; level: number; key: boolean }[] = [
    { node: root, level: 0, key: false },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.node === null) continue;
    if (current.level > MAX_DEPTH) {
      depth.push({ offset: nodeStart(current.node), message: 'recipe nesting is too deep' });
      continue;
    }

    if (isScalar(current.node)) {
      if (typeof current.node.value === 'string' && CONTROL.test(current.node.value)) {
        controls.push({
          offset: nodeStart(current.node),
          message: 'control characters are not allowed',
        });
      }
    }
    if (current.key && scalarKey(current.node) === undefined) {
      keys.push({ offset: nodeStart(current.node), message: 'keys must be text' });
    }

    const list = yamlSeq(current.node);
    if (list) {
      for (const item of list.items) {
        pending.push({ node: item, level: current.level + 1, key: false });
      }
    }
    const object = yamlMap(current.node);
    if (object) {
      for (const pair of object.items) {
        pending.push({ node: pair.value, level: current.level + 1, key: false });
        pending.push({ node: pair.key, level: current.level + 1, key: true });
      }
    }
  }
  return { controls, keys, depth };
}

function issue(issues: LocatedIssue[], node: YamlNode, message: string): void {
  issues.push({ offset: nodeStart(node), message });
}

function resolveReference(reference: string): Shape {
  const prefix = '#/definitions/';
  if (!reference.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${reference}`);
  const name = reference.slice(prefix.length);
  const definitions: Readonly<Record<string, Shape>> = recipeSchema.definitions;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  if (!definition) throw new Error(`Unknown schema definition: ${name}`);
  return definition;
}

function alternativeMessage(label: string, branches: readonly Shape[]): string {
  const required = branches.map((branch) => branch.required);
  if (required.every((keys) => keys?.length === 1)) {
    const choices = required.map((keys) => `"${keys?.[0]}"`);
    return `"${label}" needs exactly one of ${choices.join(' or ')}`;
  }

  const enumValues = branches.flatMap((branch) => branch.enum ?? []);
  const mapKeys = branches
    .filter((branch) => branch.type === 'object')
    .flatMap((branch) => branch.required ?? []);
  const choices = enumValues.join(', ');
  const mapDescription = mapKeys.length > 0 ? `, or a map with ${mapKeys.join(', ')}` : '';
  return `"${label}" must be one of: ${choices}${mapDescription}`;
}

/** Interpret only the schema keywords used by the published recipe schema. */
function validateNode(node: YamlNode, shape: Shape, label: string, issues: LocatedIssue[]): void {
  if (shape.$ref) {
    validateNode(node, resolveReference(shape.$ref), label, issues);
    return;
  }

  const raw = yamlValue(node);
  if (shape.type === 'object' && !isMap(node)) {
    issue(issues, node, `${label === 'each stage' ? label : `"${label}"`} must be a map`);
    return;
  }
  if (shape.type === 'array' && !isSeq(node)) {
    issue(issues, node, `"${label}" must be a list`);
    return;
  }
  if (shape.type === 'string' && typeof raw !== 'string') {
    issue(issues, node, `"${label}" must be a string`);
    return;
  }
  if (shape.type === 'boolean' && typeof raw !== 'boolean') {
    issue(issues, node, `"${label}" must be true or false`);
    return;
  }
  if (shape.type === 'integer' && (typeof raw !== 'number' || !Number.isInteger(raw))) {
    issue(issues, node, `"${label}" must be an integer`);
    return;
  }

  if (shape.const !== undefined && raw !== shape.const) {
    issue(issues, node, `"${label}" must be ${shape.const}`);
  }
  if (shape.enum && !shape.enum.includes(raw)) {
    issue(issues, node, `"${label}" must be one of: ${shape.enum.join(', ')}`);
  }
  if (shape.pattern && typeof raw === 'string' && !new RegExp(shape.pattern).test(raw)) {
    issue(issues, node, `"${label}" must match ${shape.pattern}`);
  }
  if (shape.minLength !== undefined && typeof raw === 'string' && raw.length < shape.minLength) {
    issue(issues, node, `"${label}" must not be empty`);
  }
  if (shape.minimum !== undefined && typeof raw === 'number' && raw < shape.minimum) {
    issue(issues, node, `"${label}" must be at least ${shape.minimum}`);
  }
  if (shape.maximum !== undefined && typeof raw === 'number' && raw > shape.maximum) {
    issue(issues, node, `"${label}" must be at most ${shape.maximum}`);
  }

  const list = yamlSeq(node);
  if (list) validateList(list, shape, label, issues);

  const object = yamlMap(node);
  if (object) validateObject(object, shape, label, issues);

  if (shape.oneOf) validateAlternatives(node, shape.oneOf, label, issues);
}

function validateList(
  list: YAMLSeq<Node>,
  shape: Shape,
  label: string,
  issues: LocatedIssue[],
): void {
  if (shape.minItems !== undefined && list.items.length < shape.minItems) {
    issue(issues, list, `"${label}" must have at least ${shape.minItems} item`);
  }

  const seen = new Set<string>();
  for (const item of list.items) {
    const signature = JSON.stringify(yamlValue(item));
    if (shape.uniqueItems && seen.has(signature)) {
      issue(issues, item, `"${label}" must not repeat values`);
    }
    seen.add(signature);
    if (shape.items) {
      const itemLabel = label === 'stages' ? 'each stage' : `each item of "${label}"`;
      validateNode(item, shape.items, itemLabel, issues);
    }
  }
}

function validateObject(
  object: YAMLMap<Node, Node>,
  shape: Shape,
  label: string,
  issues: LocatedIssue[],
): void {
  if (shape.minProperties !== undefined && object.items.length < shape.minProperties) {
    issue(issues, object, `"${label}" needs at least one of its condition keys`);
  }
  for (const key of shape.required ?? []) {
    if (!object.has(key)) issue(issues, object, `missing required key "${key}"`);
  }

  for (const pair of object.items) {
    const key = yamlWord(pair.key);
    if (shape.propertyNames) validateNode(pair.key, shape.propertyNames, key, issues);

    const property = shape.properties && Object.hasOwn(shape.properties, key)
      ? shape.properties[key]
      : undefined;
    if (property) {
      validateNode(pair.value, property, key, issues);
    } else if (shape.additionalProperties === false) {
      issue(issues, pair.key, `unknown key "${key}"`);
    } else if (typeof shape.additionalProperties === 'object') {
      validateNode(pair.value, shape.additionalProperties, key, issues);
    }
  }
}

function validateAlternatives(
  node: YamlNode,
  branches: readonly Shape[],
  label: string,
  issues: LocatedIssue[],
): void {
  // Branch errors stay private. Only the count of valid branches determines oneOf.
  const matching = branches.filter((branch) => {
    const branchIssues: LocatedIssue[] = [];
    validateNode(node, branch, label, branchIssues);
    return branchIssues.length === 0;
  });
  if (matching.length !== 1) issue(issues, node, alternativeMessage(label, branches));
}

export function validateStructure(root: YamlNode): LocatedIssue[] {
  const issues: LocatedIssue[] = [];
  validateNode(root, recipeSchema, 'recipe', issues);
  return issues;
}
