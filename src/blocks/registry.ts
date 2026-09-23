import type { BlockDefinition } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { benchmarkSourcesBlock } from './benchmark-sources.js';
import { buildVerifyBlock } from './build-verify.js';
import { commandBlock } from './command.js';
import { redTestBlock } from './red-test.js';
import { specStructureBlock } from './spec-structure.js';

// PLAN-13-R2 §2.1, §3 and §3.8: the manifests of this slice's engine blocks. They declare
// what each block permits — natures, validity and inputs — before any of them is built. The
// blocks of slice 4 (`independent-review`, `approval-comment`, `preview-deployment`,
// `browser-qa`, `github-merge`, `post-merge`, `cleanup`) carry only a manifest here.
//
// `spec-structure`, `benchmark-sources`, `command`, `red-test` and `build-verify` are built:
// their definitions — manifest included — live in their own files, so there is one source of
// truth for each. Every other block is a `BlockDefinition` whose `create` reports it is not
// built yet.

const MANIFESTS: Readonly<Record<string, BlockManifest>> = {
  'sandboxed-review': {
    name: 'sandboxed-review',
    kind: 'module',
    natures: ['recompute', 'attest'],
    validWhile: ['same-sha', 'same-fingerprint-or-clean-update'],
    inputs: {
      reviewer: {
        type: 'object',
        fields: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          effort: { type: 'string' },
        },
      },
      prompt: { type: 'string', required: true },
      angle: { type: 'string', required: true },
      'forbid-same-family': { type: 'boolean', default: true },
      'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
    },
  },

  'scope-reconcile': {
    name: 'scope-reconcile',
    kind: 'module',
    natures: ['recompute'],
    inputs: {},
  },

  'independent-review': {
    name: 'independent-review',
    kind: 'module',
    natures: ['execution-record', 'attest'],
    inputs: {
      'forbid-same-family': { type: 'boolean', default: true },
      angles: { type: 'string-list' },
    },
  },

  'approval-comment': {
    name: 'approval-comment',
    kind: 'module',
    natures: ['attest', 'recompute'],
    inputs: {
      command: { type: 'string', default: '/approve' },
      'code-length': { type: 'integer', min: 4, max: 40, default: 7 },
    },
  },

  'preview-deployment': {
    name: 'preview-deployment',
    kind: 'module',
    natures: ['recompute'],
    inputs: {},
  },

  'browser-qa': {
    name: 'browser-qa',
    kind: 'module',
    natures: ['recompute'],
    validWhile: ['same-sha'],
    inputs: {
      command: { type: 'command' },
    },
  },

  'github-merge': {
    name: 'github-merge',
    kind: 'module',
    natures: ['recompute'],
    inputs: {},
  },

  'post-merge': {
    name: 'post-merge',
    kind: 'module',
    natures: ['recompute'],
    inputs: {},
  },

  cleanup: {
    name: 'cleanup',
    kind: 'module',
    natures: ['recompute'],
    inputs: {},
  },
};

const ENGINE_MAJOR = 1;
const ENGINE_USES = /^ai-workflows\/([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

/** The blocks of slice 4. Until they are built their gate blocks the piece saying so. */
const SLICE_FOUR: ReadonlySet<string> = new Set([
  'independent-review',
  'approval-comment',
  'preview-deployment',
  'browser-qa',
  'github-merge',
  'post-merge',
  'cleanup',
]);

/** A gate that always blocks, naming the slice that will build it. */
function notBuilt(name: string): BlockDefinition {
  const slice = SLICE_FOUR.has(name) ? 4 : 2;
  return {
    manifest: MANIFESTS[name] as BlockManifest,
    create: () => () => {
      throw new Error(`block "ai-workflows/${name}@1" is not built yet (slice ${slice})`);
    },
  };
}

/** The blocks of this slice that are actually built, with their definitions and manifests. */
const BUILT: Readonly<Record<string, BlockDefinition>> = {
  'spec-structure': specStructureBlock,
  'benchmark-sources': benchmarkSourcesBlock,
  command: commandBlock,
  'red-test': redTestBlock,
  'build-verify': buildVerifyBlock,
};

export const ENGINE_BLOCKS: Readonly<Record<string, BlockDefinition>> = Object.fromEntries([
  ...Object.keys(MANIFESTS).map((name) => [name, notBuilt(name)] as const),
  ...Object.entries(BUILT),
]);

/** The definition of `ai-workflows/<name>@<major>`, or undefined when it does not exist. */
export function engineBlock(uses: string): BlockDefinition | undefined {
  const match = ENGINE_USES.exec(uses);
  if (!match) return undefined;
  const [, name, major] = match;
  if (name === undefined || Number(major) !== ENGINE_MAJOR) return undefined;
  return Object.hasOwn(ENGINE_BLOCKS, name) ? ENGINE_BLOCKS[name] : undefined;
}

/** The manifest of `ai-workflows/<name>@<major>`, or undefined when it does not exist. */
export function engineBlockManifest(uses: string): BlockManifest | undefined {
  return engineBlock(uses)?.manifest;
}
