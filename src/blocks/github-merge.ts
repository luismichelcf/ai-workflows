import type { Gate, GateContext, GateResult, JsonValue } from '../contract.js';
import type { PullRequestHistoryItem } from '../agent/github.js';
import type { BlockDefinition, EngineBlockDeps, ReconcileAnswer } from './definition.js';
import { asString, isSpanish, judgedSha, requireAgent } from './final.js';
import type { BlockManifest } from './manifest.js';
import { PullRequestRefused, pullRequestOf, reconcilePullRequestEffect } from './pull-request.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.6: the merge. The pull request is opened and marked ready as the agents, armed
// with `--auto --match-head-commit` on the judged head, and watched until GitHub merges it. The
// time limit is measured with the injected clock and every wait with the injected sleep, never
// the wall clock. Leaving the queue or a disarmed auto-merge is seen when two reads in a row show
// neither, and up to three read errors in a row are tolerated; the fourth is technical.

export const manifest: BlockManifest = {
  name: 'github-merge',
  kind: 'module',
  natures: ['recompute'],
  validWhile: ['same-sha'],
  server: [],
  inputs: {
    method: { type: 'string', enum: ['merge', 'squash', 'rebase'], default: 'merge' },
    'timeout-minutes': { type: 'integer', min: 1, max: 1440, default: 360 },
    'poll-seconds': { type: 'integer', min: 10, max: 300, default: 30 },
  },
};

interface MergeInputs {
  readonly method: string;
  readonly timeoutMinutes: number;
  readonly pollSeconds: number;
}

function reported(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function splitOperation(operationId: string): { readonly prefix: string; readonly pr: number; readonly sha: string } | undefined {
  const parts = operationId.split(':');
  if (parts.length !== 3) return undefined;
  const pr = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(pr)) return undefined;
  return { prefix: parts[0] ?? '', pr, sha: parts[2] ?? '' };
}

function lastHeadChange(history: readonly PullRequestHistoryItem[]): number {
  let index = -1;
  for (let at = 0; at < history.length; at += 1) {
    if (history[at]?.type === 'head-changed') index = at;
  }
  return index;
}

function isAgent(actor: string | null, deps: EngineBlockDeps): boolean {
  return deps.recipe.agentAccount !== undefined && actor === deps.recipe.agentAccount;
}

function createGate(inputs: MergeInputs, deps: EngineBlockDeps): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'github-merge');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    const sha = judgedSha(context);

    const pullDeps = { root: deps.root, recipe: deps.recipe, agent, store: deps.store };
    let pr;
    try {
      pr = await pullRequestOf(context.piece, sha, { create: true, context, deps: pullDeps });
    } catch (error) {
      if (error instanceof PullRequestRefused) return { ok: false, reason: error.message };
      throw error;
    }

    let detail = pr.detail;
    if (detail.state === 'MERGED') return merged(pr.number, sha, detail.mergeCommit ?? null);

    // An earlier attempt may have left the ready effect in doubt. It is settled even when GitHub
    // now shows the pull request ready, so a "ready" by someone else is never taken for the
    // agents' own (PLAN-13-R4 §3.0.1).
    const readyOp = `ready:${pr.number}:${sha}`;
    const recorded = await deps.store.getEffect(context.piece, readyOp);
    if (detail.isDraft) {
      // If the ready effect is already recorded and the pull request is still a draft, someone
      // turned it back by hand: the effect is not repeated and the stage refuses.
      if (recorded?.state === 'confirmed') {
        return {
          ok: false,
          reason: spanish ? 'El PR volvió a borrador.' : 'The pull request went back to draft.',
        };
      }
      await context.runEffect(readyOp, async () => {
        await agent.github.markReady(pr.number);
        return null;
      });
      detail = { ...detail, isDraft: false };
    } else if (recorded !== undefined && recorded.state !== 'confirmed') {
      await context.runEffect(readyOp, async () => {
        await agent.github.markReady(pr.number);
        return null;
      });
    }

    await context.runEffect(`merge:${pr.number}:${sha}`, async () => {
      await agent.github.enableAutoMerge(pr.number, { method: inputs.method, headSha: sha });
      return null;
    });

    const timeoutMs = inputs.timeoutMinutes * 60_000;
    const pollMs = inputs.pollSeconds * 1000;
    const startedAt = agent.now();
    let consecutiveErrors = 0;
    let lastUnarmed = false;

    for (;;) {
      let current;
      try {
        current = await agent.github.pullRequestDetail(pr.number);
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 4) throw error;
        await agent.sleep(pollMs, context.signal);
        continue;
      }

      if (current.state === 'MERGED') return merged(pr.number, sha, current.mergeCommit ?? null);
      if (current.state === 'CLOSED') {
        return { ok: false, reason: spanish ? 'El PR se cerró sin fusionarse.' : 'The pull request was closed without merging.' };
      }
      if (current.headSha !== sha) {
        return { ok: false, reason: spanish ? 'La cabeza del PR cambió.' : 'The head of the pull request moved.' };
      }

      const armed = current.autoMerge || current.inMergeQueue;
      if (!armed) {
        if (lastUnarmed) {
          return {
            ok: false,
            reason: spanish
              ? 'La fusión salió de la cola o alguien desarmó la fusión.'
              : 'The merge left the queue or someone disarmed it.',
          };
        }
        lastUnarmed = true;
      } else {
        lastUnarmed = false;
      }

      if (agent.now() - startedAt >= timeoutMs) {
        return {
          ok: false,
          reason: spanish
            ? `La fusión no terminó en ${inputs.timeoutMinutes} minuto(s).`
            : `The merge did not finish within ${inputs.timeoutMinutes} minute(s).`,
        };
      }
      await agent.sleep(pollMs, context.signal);
    }
  };
}

function merged(number: number, headSha: string, mergeSha: string | null): GateResult {
  // A pull request GitHub calls merged always carries the commit it merged: one without it is a
  // reading that cannot be confirmed, never a pass with no commit.
  if (mergeSha === null) {
    throw new Error(
      `pull request #${String(number)} is merged but does not report its merge commit`,
    );
  }
  const evidence: Record<string, JsonValue> = { pr: number, headSha, mergeSha };
  return { ok: true, evidence };
}

async function reconcilePriorEffects(
  operationId: string,
  context: GateContext,
  deps: EngineBlockDeps,
): Promise<ReconcileAnswer> {
  const agent = deps.agent;
  if (agent === undefined) return undefined;
  const parts = splitOperation(operationId);
  if (parts === undefined) return undefined;
  if (parts.prefix !== 'ready' && parts.prefix !== 'merge') return undefined;

  const history = await agent.github.pullRequestHistory(parts.pr);
  const lastHead = lastHeadChange(history);
  const wanted = parts.prefix === 'ready' ? 'ready' : ['auto-merge-enabled', 'added-to-queue'];
  const happened = history.some(
    (item, index) =>
      index > lastHead
      && (Array.isArray(wanted) ? wanted.includes(item.type) : item.type === wanted)
      && isAgent(item.actor, deps),
  );
  if (happened) return { confirmed: null };

  const detail = await agent.github.pullRequestDetail(parts.pr);
  if (detail.state === 'MERGED') return { confirmed: null };
  if (parts.prefix === 'ready') {
    return detail.isDraft ? { didNotHappen: true } : undefined;
  }
  void context;
  return detail.state === 'OPEN' ? { didNotHappen: true } : undefined;
}

export const githubMergeBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    return createGate(
      {
        method: asString(inputs['method']) ?? 'merge',
        timeoutMinutes: reported(inputs['timeoutMinutes'], 360),
        pollSeconds: reported(inputs['pollSeconds'], 30),
      },
      deps,
    );
  },
  async reconcile(_inputs, operationId, context, deps) {
    const agent = deps.agent;
    if (agent === undefined) return undefined;
    const prOutcome = await reconcilePullRequestEffect(operationId, context, {
      root: deps.root,
      recipe: deps.recipe,
      agent,
      store: deps.store,
    });
    if (prOutcome.handled) return prOutcome.answer;
    return await reconcilePriorEffects(operationId, context, deps);
  },
};
