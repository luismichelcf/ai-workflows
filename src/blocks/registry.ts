import type { BlockDefinition } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { approvalCommentBlock } from './approval-comment.js';
import { approvalReviewBlock } from './approval-review.js';
import { benchmarkSourcesBlock } from './benchmark-sources.js';
import { browserQaBlock } from './browser-qa.js';
import { buildVerifyBlock } from './build-verify.js';
import { cleanupBlock } from './cleanup.js';
import { commandBlock } from './command.js';
import { githubMergeBlock } from './github-merge.js';
import { independentReviewBlock } from './independent-review.js';
import { postMergeBlock } from './post-merge.js';
import { previewDeploymentBlock } from './preview-deployment.js';
import { redTestBlock } from './red-test.js';
import { sandboxedReviewBlock } from './sandboxed-review.js';
import { scopeReconcileBlock } from './scope-reconcile.js';
import { specStructureBlock } from './spec-structure.js';

// PLAN-13-R2 §2.1, §3 and §3.8: the engine blocks. Their definitions — manifest included — live
// in their own files, so there is one source of truth for each.

/** The blocks built so far, by name. */
const BUILT: Readonly<Record<string, BlockDefinition>> = {
  'spec-structure': specStructureBlock,
  'benchmark-sources': benchmarkSourcesBlock,
  command: commandBlock,
  'red-test': redTestBlock,
  'build-verify': buildVerifyBlock,
  'sandboxed-review': sandboxedReviewBlock,
  'scope-reconcile': scopeReconcileBlock,
  'independent-review': independentReviewBlock,
  'approval-review': approvalReviewBlock,
  'approval-comment': approvalCommentBlock,
  'preview-deployment': previewDeploymentBlock,
  'browser-qa': browserQaBlock,
  'github-merge': githubMergeBlock,
  'post-merge': postMergeBlock,
  cleanup: cleanupBlock,
};

const ENGINE_MAJOR = 1;
const ENGINE_USES = /^ai-workflows\/([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

export const ENGINE_BLOCKS: Readonly<Record<string, BlockDefinition>> = BUILT;

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
