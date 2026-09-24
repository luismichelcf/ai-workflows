import type { Gate, GateContext, GateResult, JsonValue } from '../contract.js';
import { parseEventComment, readPieceEvents, type PieceEvent } from '../agent/events.js';
import { stillValidFor } from '../recipe/validity.js';
import { decideIndependentReview } from './reviews.js';
import { commitFingerprint, serverAccepts, treeOfCommit } from './review-commits.js';
import type { BlockDefinition, EngineBlockDeps, ServerAttestContext, ServerResult } from './definition.js';
import { asStringList, isClean, isSpanish, judgedSha, requireAgent } from './final.js';
import type { BlockManifest } from './manifest.js';

// PLAN-13-R4 §2.2 and §3.1: the independent review reads the published events of the piece's
// issue and decides whether fresh, approving verdicts cover every angle, from another execution
// (and family) than every builder. The same decision, over the same events, is the judge's server
// attestation.

export const manifest: BlockManifest = {
  name: 'independent-review',
  kind: 'module',
  natures: ['execution-record', 'attest'],
  validWhile: ['same-sha', 'same-fingerprint', 'same-fingerprint-or-clean-update'],
  server: ['attestation', 'require-check'],
  inputs: {
    'forbid-same-family': { type: 'boolean', default: true },
    angles: { type: 'string-list', required: true, minItems: 1 },
  },
};

function cleanReason(spanish: boolean): string {
  return spanish
    ? 'La revisión se hace sobre versiones guardadas: hay cambios sin guardar.'
    : 'A review is done on saved versions: there are unsaved changes.';
}

function noAccountReason(spanish: boolean): string {
  return spanish
    ? 'La receta no declara la identidad con la que publican los agentes.'
    : 'The recipe does not declare the identity the agents publish with.';
}

/** The fingerprint of `sha` against its own merge base with the principal, next to the agent. */
function localFingerprint(deps: EngineBlockDeps, context: GateContext, sha: string): Promise<string> {
  const declaredKind = (context.change as { readonly declaredKind?: string }).declaredKind;
  return commitFingerprint(deps.root, deps.baseRef, sha, deps.recipe, context.piece, declaredKind);
}

async function localAccepts(
  deps: EngineBlockDeps,
  context: GateContext,
  sha: string,
  head: string,
  validWhile: string,
): Promise<boolean> {
  if (validWhile === 'forever') return true;
  if (validWhile === 'same-sha') return sha === head;
  if (validWhile === 'same-fingerprint') {
    if (sha === head) return true;
    const [headFingerprint, candidate] = await Promise.all([
      localFingerprint(deps, context, head),
      localFingerprint(deps, context, sha),
    ]);
    return headFingerprint.length > 0 && headFingerprint === candidate;
  }
  // same-fingerprint-or-clean-update: the head, or a chain of recorded clean updates.
  const entry = {
    stage: '@verdict',
    outcome: 'passed' as const,
    evidence: {
      judged: {
        sha,
        snapshot: await treeOfCommit(deps.root, sha),
        fingerprint: await localFingerprint(deps, context, sha),
      },
    },
    at: 0,
    runId: 'verdict',
    pipeline: '',
  };
  return await stillValidFor('same-fingerprint-or-clean-update', entry, context, {
    root: deps.root,
    baseRef: deps.baseRef,
  });
}

function createGate(
  inputs: { readonly angles: readonly string[]; readonly forbidSameFamily: boolean },
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    if (!isClean(context)) return { ok: false, reason: cleanReason(spanish) };
    const agentAccount = deps.recipe.agentAccount;
    if (agentAccount === undefined) throw new Error(noAccountReason(spanish));

    const head = judgedSha(context);
    const events = await readPieceEvents(agent.github, Number(context.piece), { agentAccount });
    const stage = deps.recipe.stages.find((item) => item.id === context.stage);
    const validWhile = stage?.validWhile ?? 'same-sha';

    const decision = await decideIndependentReview({
      events,
      angles: inputs.angles,
      forbidSameFamily: inputs.forbidSameFamily,
      accepts: (sha) => localAccepts(deps, context, sha, head, validWhile),
      treeOf: (sha) => treeOfCommit(deps.root, sha),
      head,
      spanish,
    });
    return decision.ok ? { ok: true, evidence: decision.evidence } : { ok: false, reason: decision.reason };
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attestation(
  inputs: Record<string, unknown>,
  context: ServerAttestContext,
): Promise<ServerResult> {
  const spanish = isSpanish(context.locale);
  const agentAccount = context.recipe.agentAccount;
  if (agentAccount === undefined) return { outcome: 'technical', reason: noAccountReason(spanish) };

  let comments;
  try {
    comments = await context.github.issueComments(Number(context.piece));
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
  const events: PieceEvent[] = [];
  for (const comment of comments) {
    const parsed = parseEventComment(comment, { agentAccount, piece: context.piece });
    if (parsed !== undefined && !('invalid' in parsed)) events.push(parsed);
  }

  const angles = asStringList(inputs['angles']) ?? [];
  const forbidSameFamily = inputs['forbidSameFamily'] !== false;
  try {
    const decision = await decideIndependentReview({
      events,
      angles,
      forbidSameFamily,
      accepts: (sha) =>
        serverAccepts(context.root, context.trusted, context.head, sha, context.validWhile, context.recipe, context.piece),
      treeOf: (sha) => treeOfCommit(context.root, sha),
      head: context.head,
      spanish,
    });
    return decision.ok
      ? { outcome: 'passed', evidence: decision.evidence as JsonValue }
      : { outcome: 'rejected', reason: decision.reason };
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
}

export const independentReviewBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    return createGate(
      {
        angles: asStringList(inputs['angles']) ?? [],
        forbidSameFamily: inputs['forbidSameFamily'] !== false,
      },
      deps,
    );
  },
  server: { attestation },
};
