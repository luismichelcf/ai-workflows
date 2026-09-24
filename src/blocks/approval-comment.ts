import type { Gate, GateResult } from '../contract.js';
import type { ChangeFacts } from '../recipe/facts.js';
import { diskProjectFiles } from '../recipe/facts.js';
import { approvalCommentAttestation } from '../judge/attest.js';
import type { BlockDefinition, EngineBlockDeps, ServerAttestContext } from './definition.js';
import { asString, isSpanish, judgedSha, requireAgent } from './final.js';
import type { BlockManifest } from './manifest.js';
import { PullRequestRefused, pullRequestOf, reconcilePullRequestEffect } from './pull-request.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.3: the owner's comment, the fallback for projects without a separate identity.
// The same decision the judge runs on GitHub (`approvalCommentAttestation`) is called next to the
// agent, over a port on `gh`, with the pull request opened as the agents.

export const manifest: BlockManifest = {
  name: 'approval-comment',
  kind: 'module',
  natures: ['attest', 'recompute'],
  validWhile: ['same-sha', 'same-fingerprint', 'same-fingerprint-or-clean-update'],
  server: ['attestation', 'require-check'],
  inputs: {
    command: { type: 'string', default: '/approve' },
    'code-length': { type: 'integer', min: 4, max: 40, default: 7 },
  },
};

interface CommentInputs {
  readonly command?: string;
  readonly codeLength?: number;
}

function stageOf(recipe: EngineBlockDeps['recipe'], stage: string): { validWhile: ServerAttestContext['validWhile']; needsHuman: boolean } {
  const found = recipe.stages.find((item) => item.id === stage);
  return {
    validWhile: found?.validWhile ?? 'same-sha',
    needsHuman: found?.needsHuman ?? false,
  };
}

function createGate(inputs: CommentInputs, deps: EngineBlockDeps): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'approval-comment');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    const owner = deps.recipe.owner;
    if (owner === undefined) {
      throw new Error(
        spanish ? 'La receta no declara el dueño que aprueba.' : 'The recipe does not name the owner who approves.',
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
    const facts = (context.change as ChangeFacts) ?? ({} as ChangeFacts);
    const result = await approvalCommentAttestation(
      {
        ...(inputs.command === undefined ? {} : { command: inputs.command }),
        ...(inputs.codeLength === undefined ? {} : { codeLength: inputs.codeLength }),
      },
      {
        facts,
        files: diskProjectFiles(deps.root),
        locale: context.locale,
        piece: context.piece,
        recipe: deps.recipe,
        root: deps.root,
        head: sha,
        trusted: deps.baseRef,
        needsHuman: stage.needsHuman,
        validWhile: stage.validWhile,
        owner,
        stage: context.stage,
        pullRequest: pr.number,
        github: agent.github as unknown as ServerAttestContext['github'],
        fetchObjects: async () => undefined,
      },
    );

    if (result.outcome === 'passed') return { ok: true, evidence: { pr: pr.number } };
    if (result.outcome === 'skipped') return { ok: 'skipped', reason: result.reason };
    if (result.outcome === 'technical') throw new Error(result.reason);
    return { ok: false, reason: result.reason };
  };
}

export const approvalCommentBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const command = asString(inputs['command']);
    const codeLength = typeof inputs['codeLength'] === 'number' ? inputs['codeLength'] : undefined;
    return createGate(
      {
        ...(command === undefined ? {} : { command }),
        ...(codeLength === undefined ? {} : { codeLength }),
      },
      deps,
    );
  },
  server: { attestation: approvalCommentAttestation },
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
