import type { BlockManifest } from './manifest.js';

// PLAN-13-R2 §2.1, §3 and §3.8: the manifests of this slice's engine blocks. They declare
// what each block permits — natures, validity and inputs — before any of them is built. The
// four blocks of slice 4 (`independent-review`, `approval-comment`, `preview-deployment`,
// `browser-qa`, `github-merge`, `post-merge`, `cleanup`) carry only a manifest here.

export const ENGINE_BLOCKS: Readonly<Record<string, BlockManifest>> = {
  'spec-structure': {
    name: 'spec-structure',
    kind: 'module',
    natures: ['structure'],
    inputs: {
      file: { type: 'string', required: true },
      sections: { type: 'string-list' },
      summary: {
        type: 'object',
        fields: {
          section: { type: 'string', required: true },
          labels: { type: 'string-list', required: true },
        },
      },
      criteria: {
        type: 'object',
        fields: {
          section: { type: 'string', required: true },
          'id-prefix': { type: 'string', required: true },
          words: { type: 'string-list' },
        },
      },
      decisions: {
        type: 'object',
        fields: {
          section: { type: 'string', required: true },
          'pending-markers': {
            type: 'string-list',
            default: ['[ ]', 'pendiente', 'por decidir', 'TBD'],
          },
        },
      },
    },
  },

  'benchmark-sources': {
    name: 'benchmark-sources',
    kind: 'module',
    natures: ['structure'],
    inputs: {
      files: { type: 'glob-list', required: true },
      categories: {
        type: 'object-list',
        items: {
          heading: { type: 'string', required: true },
          min: { type: 'integer', required: true, min: 0, max: 100 },
        },
      },
      'min-total': { type: 'integer', min: 0, max: 1000, default: 0 },
      sections: { type: 'string-list' },
      waiver: { type: 'string' },
      spec: { type: 'string' },
      'check-reachable': { type: 'boolean', default: false },
    },
  },

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

  'red-test': {
    name: 'red-test',
    kind: 'module',
    natures: ['recompute', 'execution-record'],
    validWhile: ['forever'],
    inputs: {
      command: { type: 'command', required: true, requireTests: true },
      tests: { type: 'glob-list', default: ['**/*.test.ts', '**/*.test.tsx'] },
      'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
    },
  },

  'build-verify': {
    name: 'build-verify',
    kind: 'module',
    natures: ['recompute', 'execution-record'],
    validWhile: ['same-sha'],
    inputs: {
      command: { type: 'command', required: true, requireTests: true },
      tests: { type: 'glob-list', default: ['**/*.test.ts', '**/*.test.tsx'] },
      'red-stage': { type: 'string', required: true },
      'implementation-exclude': { type: 'glob-list', default: ['docs/**'] },
      'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
    },
  },

  command: {
    name: 'command',
    kind: 'module',
    natures: ['recompute'],
    inputs: {
      command: { type: 'command', required: true },
      'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
      reader: {
        type: 'string',
        enum: ['exit-code', 'vitest'],
        default: 'exit-code',
      },
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

/** The manifest of `ai-workflows/<name>@<major>`, or undefined when it does not exist. */
export function engineBlockManifest(uses: string): BlockManifest | undefined {
  const match = ENGINE_USES.exec(uses);
  if (!match) return undefined;
  const [, name, major] = match;
  if (name === undefined || Number(major) !== ENGINE_MAJOR) return undefined;
  return Object.hasOwn(ENGINE_BLOCKS, name) ? ENGINE_BLOCKS[name] : undefined;
}
