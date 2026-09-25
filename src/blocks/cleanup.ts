import type { Gate, GateResult, JsonValue } from '../contract.js';
import type { BlockDefinition, EngineBlockDeps, ReconcileAnswer } from './definition.js';
import {
  asString,
  evidenceString,
  isSpanish,
  lastPassed,
  requireAgent,
} from './final.js';
import type { BlockManifest } from './manifest.js';
import { currentBranch } from './pull-request.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.8: the last stage of the process. It deletes the remote branch only when its tip
// is the merged head, and it records what `finish` needs to remove the folder and the local
// branch. It never closes the issue (that belongs to a project block) and never removes the
// folder itself: the engine is running inside it.

export const manifest: BlockManifest = {
  name: 'cleanup',
  kind: 'module',
  natures: ['recompute'],
  server: [],
  inputs: {
    'merge-stage': { type: 'string', required: true },
    'delete-branch': { type: 'boolean', default: true },
    'remove-folder': { type: 'boolean', default: true },
  },
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function splitDelete(operationId: string): { readonly branch: string; readonly sha: string } | undefined {
  const first = operationId.indexOf(':');
  const last = operationId.lastIndexOf(':');
  if (first < 0 || last <= first) return undefined;
  return { branch: operationId.slice(first + 1, last), sha: operationId.slice(last + 1) };
}

function createGate(
  inputs: { readonly mergeStage: string; readonly deleteBranch: boolean; readonly removeFolder: boolean },
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'cleanup');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);

    const mergeEntry = lastPassed(context, inputs.mergeStage);
    const headSha = evidenceString(mergeEntry, 'headSha');
    const mergeSha = evidenceString(mergeEntry, 'mergeSha');
    if (headSha === undefined || mergeSha === undefined) {
      return {
        ok: false,
        reason: spanish
          ? 'Todavía no hay una fusión registrada que limpiar.'
          : 'There is no recorded merge to clean up yet.',
      };
    }

    const branch = await currentBranch(deps.root, spanish);

    if (inputs.deleteBranch) {
      const head = await agent.remote.branchHead(branch);
      if (head === undefined) {
        // Already gone: nothing to delete.
      } else if (head !== headSha) {
        return {
          ok: false,
          reason: spanish
            ? `La rama ${branch} apunta a otra versión (${head}), no a la fusionada: no se borra.`
            : `The branch ${branch} points at another version (${head}), not the merged one: it is not deleted.`,
        };
      } else {
        await context.runEffect(`delete-branch:${branch}:${headSha}`, async () => {
          await agent.remote.deleteBranch(branch, headSha);
          return null;
        });
      }
    }

    const evidence: Record<string, JsonValue> = {
      branch,
      headSha,
      mergeSha,
      folder: deps.root,
      removeFolder: inputs.removeFolder,
    };
    return { ok: true, evidence };
  };
}

/** The branch activity that proves a deletion of exactly this attempt, or `undefined`. */
async function reconcileDelete(
  operationId: string,
  deps: EngineBlockDeps,
): Promise<ReconcileAnswer> {
  const parts = splitDelete(operationId);
  if (parts === undefined) return undefined;
  const agent = deps.agent;
  if (agent === undefined) return undefined;
  const activity = await agent.github.branchActivity(parts.branch);
  const happened = activity.some(
    (item) =>
      item.type === 'branch_deletion'
      && item.before === parts.sha
      && deps.recipe.agentAccount !== undefined
      && item.actor === deps.recipe.agentAccount,
  );
  if (happened) return { confirmed: null };
  const head = await agent.remote.branchHead(parts.branch);
  if (head === parts.sha) return { didNotHappen: true };
  return undefined;
}

export const cleanupBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    return createGate(
      {
        mergeStage: asString(inputs['mergeStage']) ?? '',
        deleteBranch: asBoolean(inputs['deleteBranch'], true),
        removeFolder: asBoolean(inputs['removeFolder'], true),
      },
      deps,
    );
  },
  async reconcile(_inputs, operationId, _context, deps) {
    if (!operationId.startsWith('delete-branch:')) return undefined;
    return await reconcileDelete(operationId, deps);
  },
};
