import type { BlockDefinition } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { approvalCommentAttestation } from '../judge/attest.js';
import { benchmarkSourcesBlock } from './benchmark-sources.js';
import { buildVerifyBlock } from './build-verify.js';
import { commandBlock } from './command.js';
import { redTestBlock } from './red-test.js';
import { sandboxedReviewBlock } from './sandboxed-review.js';
import { scopeReconcileBlock } from './scope-reconcile.js';
import { specStructureBlock } from './spec-structure.js';

// PLAN-13-R2 §2.1, §3 and §3.8: the manifests of this slice's engine blocks. They declare
// what each block permits — natures, validity and inputs — before any of them is built. The
// blocks of slice 4 (`independent-review`, `approval-comment`, `preview-deployment`,
// `browser-qa`, `github-merge`, `post-merge`, `cleanup`) carry only a manifest here.
//
// `spec-structure`, `benchmark-sources`, `command`, `red-test`, `build-verify`,
// `sandboxed-review` and `scope-reconcile` are built: their definitions — manifest included —
// live in their own files, so there is one source of truth for each. Every other block is a
// `BlockDefinition` whose `create` reports it is not built yet.

const MANIFESTS: Readonly<Record<string, BlockManifest>> = {
  'independent-review': {
    name: 'independent-review',
    kind: 'module',
    natures: ['execution-record', 'attest'],
    validWhile: ['same-sha', 'same-fingerprint', 'same-fingerprint-or-clean-update'],
    server: ['attestation', 'require-check'],
    inputs: {
      'forbid-same-family': { type: 'boolean', default: true },
      angles: { type: 'string-list' },
    },
  },

  'approval-comment': {
    name: 'approval-comment',
    kind: 'module',
    natures: ['attest', 'recompute'],
    validWhile: ['same-sha', 'same-fingerprint', 'same-fingerprint-or-clean-update'],
    server: ['attestation', 'require-check'],
    inputs: {
      command: { type: 'string', default: '/approve' },
      'code-length': { type: 'integer', min: 4, max: 40, default: 7 },
    },
  },

  'preview-deployment': {
    name: 'preview-deployment',
    kind: 'module',
    natures: ['recompute'],
    server: ['require-check'],
    inputs: {},
  },

  'browser-qa': {
    name: 'browser-qa',
    kind: 'module',
    natures: ['recompute'],
    validWhile: ['same-sha'],
    server: ['require-check'],
    inputs: {
      command: { type: 'command' },
    },
  },

  'github-merge': {
    name: 'github-merge',
    kind: 'module',
    natures: ['recompute'],
    server: [],
    inputs: {},
  },

  'post-merge': {
    name: 'post-merge',
    kind: 'module',
    natures: ['recompute'],
    server: [],
    inputs: {},
  },

  cleanup: {
    name: 'cleanup',
    kind: 'module',
    natures: ['recompute'],
    server: [],
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
  'sandboxed-review': sandboxedReviewBlock,
  'scope-reconcile': scopeReconcileBlock,
  // PLAN-13-R3 §3.6: its gate next to the agent arrives in slice 4, but the judge can already
  // read the owner's approval published on the pull request.
  'approval-comment': {
    manifest: MANIFESTS['approval-comment'] as BlockManifest,
    create: () => () => {
      throw new Error('block "ai-workflows/approval-comment@1" is not built yet (slice 4)');
    },
    server: { attestation: approvalCommentAttestation },
  },
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
