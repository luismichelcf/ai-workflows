import type { Gate, GateResult, JsonValue } from '../contract.js';
import type { CheckRunSummary, CommitStatus } from '../judge/port.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import {
  asObject,
  asString,
  asStringList,
  checkDeploymentUrl,
  evidenceString,
  isSpanish,
  lastPassed,
  requireAgent,
} from './final.js';
import type { BlockManifest } from './manifest.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.7: what has to be green over the merge commit before a piece is done. The names
// of the checks and the optional deployment arrive by `with:`; the merge commit is read from the
// last passed `github-merge` stage. A check still running waits (the recipe's `retry` waits too).

export const manifest: BlockManifest = {
  name: 'post-merge',
  kind: 'module',
  natures: ['recompute'],
  server: [],
  inputs: {
    'merge-stage': { type: 'string', required: true },
    checks: { type: 'string-list' },
    deployment: {
      type: 'object',
      fields: {
        environment: { type: 'string', required: true },
        creator: { type: 'string' },
      },
    },
  },
};

function latestRun(runs: readonly CheckRunSummary[], name: string, spanish: boolean): CheckRunSummary | 'ambiguous' | undefined {
  if (runs.length > 1 && runs.some((run) => run.id === undefined)) {
    return 'ambiguous';
  }
  const latest = runs.reduce<CheckRunSummary | undefined>((best, run) => {
    if (best === undefined) return run;
    if (run.id === undefined) return best;
    if (best.id === undefined) return run;
    return run.id > best.id ? run : best;
  }, undefined);
  void name;
  void spanish;
  return latest;
}

async function evaluateCheck(
  deps: EngineBlockDeps,
  sha: string,
  name: string,
  spanish: boolean,
): Promise<string | undefined> {
  const agent = deps.agent;
  if (agent === undefined) return undefined;
  const runs = await agent.github.checkRuns(sha, name);
  const statuses: CommitStatus[] = (await agent.github.statuses(sha)).filter(
    (status) => status.context === name,
  );

  const run = latestRun(runs, name, spanish);
  if (run === 'ambiguous') {
    return spanish
      ? `Hay varios check-runs «${name}» y alguno no trae id: no se puede decidir cuál es el más reciente.`
      : `There are several check-runs "${name}" and one has no id: the most recent cannot be decided.`;
  }
  const status = statuses[0];

  if (run === undefined && status === undefined) {
    return spanish ? `El check ${name} no existe.` : `The check ${name} does not exist.`;
  }
  if ((run !== undefined && run.status !== 'completed') || status?.state === 'pending') {
    return spanish ? `El check ${name} todavía corre.` : `The check ${name} is still running.`;
  }
  if (run !== undefined && run.conclusion !== 'success') {
    return spanish
      ? `El check ${name} terminó en ${run.conclusion ?? 'sin conclusión'}.`
      : `The check ${name} ended ${run.conclusion ?? 'with no conclusion'}.`;
  }
  if (status !== undefined && status.state !== 'success') {
    return spanish
      ? `El check ${name} terminó en ${status.state}.`
      : `The check ${name} ended ${status.state}.`;
  }
  return undefined;
}

async function evaluateDeployment(
  deps: EngineBlockDeps,
  sha: string,
  deployment: { readonly environment: string; readonly creator?: string },
  spanish: boolean,
): Promise<{ readonly reason?: string; readonly block?: JsonValue }> {
  const agent = deps.agent;
  if (agent === undefined) return { reason: 'no GitHub identity' };
  const found = await agent.github.deployments(sha, deployment.environment);
  const matching = found.filter(
    (item) => item.sha === sha && (deployment.creator === undefined || item.creator === deployment.creator),
  );
  if (matching.length === 0) {
    return {
      reason: spanish ? 'El despliegue de esta versión aún no está listo.' : 'The deployment of this version is not ready yet.',
    };
  }
  const newest = matching.reduce((best, item) => (item.id > best.id ? item : best));
  const state = await agent.github.deploymentState(newest.id);
  if (state === undefined || state.state !== 'success') {
    return {
      reason: spanish ? 'El despliegue de esta versión aún no está listo.' : 'The deployment of this version is not ready yet.',
    };
  }
  const urlProblem = checkDeploymentUrl(state.url, undefined, spanish);
  if (urlProblem !== undefined) return { reason: urlProblem };
  return { block: { deployment: newest.id, url: state.url, sha } };
}

function createGate(
  inputs: {
    readonly mergeStage: string;
    readonly checks: readonly string[];
    readonly deployment?: { readonly environment: string; readonly creator?: string };
  },
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'post-merge');
    const spanish = isSpanish(context.locale);
    requireAgent(deps, spanish);
    const mergeEntry = lastPassed(context, inputs.mergeStage);
    const mergeSha = evidenceString(mergeEntry, 'mergeSha');
    if (mergeSha === undefined) {
      return {
        ok: false,
        reason: spanish
          ? 'Todavía no hay una fusión registrada que comprobar.'
          : 'There is no recorded merge to check yet.',
      };
    }

    for (const name of inputs.checks) {
      const problem = await evaluateCheck(deps, mergeSha, name, spanish);
      if (problem !== undefined) return { ok: false, reason: problem };
    }

    const evidence: Record<string, JsonValue> = {
      mergeSha,
      checks: [...inputs.checks],
    };
    if (inputs.deployment !== undefined) {
      const deployment = await evaluateDeployment(deps, mergeSha, inputs.deployment, spanish);
      if (deployment.reason !== undefined) return { ok: false, reason: deployment.reason };
      evidence['deployment'] = deployment.block ?? null;
    }
    return { ok: true, evidence };
  };
}

export const postMergeBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const checks = asStringList(inputs['checks']) ?? [];
    const deploymentRaw = asObject(inputs['deployment']);
    const environment = deploymentRaw === undefined ? undefined : asString(deploymentRaw['environment']);
    const creator = deploymentRaw === undefined ? undefined : asString(deploymentRaw['creator']);
    return createGate(
      {
        mergeStage: asString(inputs['mergeStage']) ?? '',
        checks,
        ...(environment === undefined
          ? {}
          : { deployment: { environment, ...(creator === undefined ? {} : { creator }) } }),
      },
      deps,
    );
  },
};
