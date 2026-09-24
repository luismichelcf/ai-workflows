import type { Gate, GateResult } from '../contract.js';
import { describeChangeFromCommits } from '../recipe/facts.js';
import type { Recipe, RecipeStage } from '../recipe/types.js';
import { decideReviewApproval } from '../approval/review.js';
import { commitFingerprint } from './review-commits.js';
import type { BlockDefinition, EngineBlockDeps, ServerAttestContext, ServerResult } from './definition.js';
import { isSpanish, judgedSha, requireAgent } from './final.js';
import type { BlockManifest } from './manifest.js';
import { PullRequestRefused, pullRequestOf, reconcilePullRequestEffect } from './pull-request.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.2 (R21): the owner approves the change with GitHub's own "Approve" button. The
// pull request is opened as the agents (so the owner can approve it), the last decisive review of
// the owner decides, and the same function serves the judge on GitHub (§7).

export const manifest: BlockManifest = {
  name: 'approval-review',
  kind: 'module',
  natures: ['attest'],
  validWhile: ['same-sha', 'same-fingerprint', 'same-fingerprint-or-clean-update'],
  server: ['attestation', 'require-check'],
  inputs: {},
};

function stageOf(recipe: Recipe, id: string): RecipeStage | undefined {
  return recipe.stages.find((item) => item.id === id);
}

/** The fingerprint of `commit` against its own merge base with the principal branch. */
async function ownFingerprint(
  deps: EngineBlockDeps,
  recipe: Recipe,
  piece: string,
  commit: string,
): Promise<string> {
  const facts = await describeChangeFromCommits({
    root: deps.root,
    base: deps.baseRef,
    head: commit,
    recipe,
    piece,
  });
  return facts.fingerprint;
}

function createGate(deps: EngineBlockDeps): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'approval-review');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    const owner = deps.recipe.owner;
    if (owner === undefined) {
      throw new Error(
        spanish
          ? 'La receta no declara el dueño que aprueba.'
          : 'The recipe does not name the owner who approves.',
      );
    }
    const sha = judgedSha(context);

    const pullDeps = { root: deps.root, recipe: deps.recipe, agent };
    let pr;
    try {
      pr = await pullRequestOf(context.piece, sha, { create: true, context, deps: pullDeps });
    } catch (error) {
      if (error instanceof PullRequestRefused) return { ok: false, reason: error.message };
      throw error;
    }

    const stage = stageOf(deps.recipe, context.stage);
    const validWhile = stage?.validWhile ?? 'same-sha';
    const reviews = await agent.github.reviews(pr.number);

    const result = await decideReviewApproval({
      reviews,
      owner,
      head: sha,
      validWhile,
      needsHuman: stage?.needsHuman ?? false,
      locale: context.locale,
      prUrl: pr.url,
      sameFingerprint: async (commit) => {
        const headFingerprint = await ownFingerprint(deps, deps.recipe, context.piece, sha);
        const commitFingerprint = await ownFingerprint(deps, deps.recipe, context.piece, commit);
        return headFingerprint.length > 0 && headFingerprint === commitFingerprint;
      },
    });

    if (result.outcome === 'passed') {
      const evidence = (result.evidence ?? {}) as { readonly reviewedCommit?: string; readonly submittedAt?: string };
      return {
        ok: true,
        evidence: {
          pr: pr.number,
          ...(evidence.reviewedCommit === undefined ? {} : { reviewedCommit: evidence.reviewedCommit }),
          ...(evidence.submittedAt === undefined ? {} : { submittedAt: evidence.submittedAt }),
        },
      };
    }
    if (result.outcome === 'technical') throw new Error(result.reason);
    return { ok: false, reason: result.reason };
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PLAN-13-R4 §3.2 and §7: the same decision the engine makes next to the agent, over the
 * reviews of the pull request the judge is reading.
 */
async function attestation(
  _inputs: Record<string, unknown>,
  context: ServerAttestContext,
): Promise<ServerResult> {
  const owner = context.owner;
  if (owner === undefined) {
    return {
      outcome: 'technical',
      reason: isSpanish(context.locale)
        ? 'La receta no declara el dueño que aprueba.'
        : 'The recipe does not name the owner who approves.',
    };
  }
  let reviews;
  try {
    reviews = await context.github.reviews(context.pullRequest);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
  if (context.validWhile === 'same-fingerprint') {
    try {
      await context.fetchObjects([context.head]);
    } catch {
      // A head that cannot be fetched simply fails the fingerprint comparison below.
    }
  }
  const result = await decideReviewApproval({
    reviews,
    owner,
    head: context.head,
    validWhile: context.validWhile,
    needsHuman: context.needsHuman,
    locale: context.locale,
    prUrl: `#${context.pullRequest}`,
    sameFingerprint: async (commit) => {
      const [headFingerprint, commitFingerprintValue] = await Promise.all([
        commitFingerprint(context.root, context.trusted, context.head, context.recipe, context.piece),
        commitFingerprint(context.root, context.trusted, commit, context.recipe, context.piece),
      ]);
      return headFingerprint.length > 0 && headFingerprint === commitFingerprintValue;
    },
  });
  if (result.outcome === 'passed') {
    return result.evidence === undefined
      ? { outcome: 'passed' }
      : { outcome: 'passed', evidence: result.evidence };
  }
  if (result.outcome === 'technical') return { outcome: 'technical', reason: result.reason };
  return { outcome: result.outcome, reason: result.reason };
}

export const approvalReviewBlock: BlockDefinition = {
  manifest,
  create(_inputs, deps) {
    return createGate(deps);
  },
  server: { attestation },
  async reconcile(_inputs, operationId, context, deps) {
    const agent = deps.agent;
    if (agent === undefined) return undefined;
    const outcome = await reconcilePullRequestEffect(operationId, context, {
      root: deps.root,
      recipe: deps.recipe,
      agent,
    });
    return outcome.handled ? outcome.answer : undefined;
  },
};
