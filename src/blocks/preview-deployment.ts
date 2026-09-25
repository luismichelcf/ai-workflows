import type { Gate, GateResult } from '../contract.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import { asString, checkDeploymentUrl, isSpanish, judgedSha, requireAgent } from './final.js';
import type { BlockManifest } from './manifest.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R4 §3.4: the newest successful deployment of the judged commit in the named
// environment. Nothing of a project lives here: the environment and the optional creator and
// URL pattern arrive through `with:`. A read that fails is technical, never a refusal.

export const manifest: BlockManifest = {
  name: 'preview-deployment',
  kind: 'module',
  natures: ['recompute'],
  validWhile: ['same-sha'],
  server: ['require-check'],
  inputs: {
    environment: { type: 'string', required: true },
    creator: { type: 'string' },
    'url-pattern': { type: 'string' },
  },
};

function createGate(
  inputs: { readonly environment: string; readonly creator?: string; readonly urlPattern?: string },
  deps: EngineBlockDeps,
): Gate {
  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'preview-deployment');
    const spanish = isSpanish(context.locale);
    const agent = requireAgent(deps, spanish);
    const sha = judgedSha(context);

    const found = await agent.github.deployments(sha, inputs.environment);
    const matching = found.filter(
      (item) =>
        item.sha === sha && (inputs.creator === undefined || item.creator === inputs.creator),
    );
    if (matching.length === 0) return notReady(spanish);

    const newest = matching.reduce((best, item) => (item.id > best.id ? item : best));
    const state = await agent.github.deploymentState(newest.id);
    if (state === undefined) return notReady(spanish);
    if (state.state === 'failure' || state.state === 'error') {
      return {
        ok: false,
        reason: spanish
          ? `La vista previa falló (${state.state}).`
          : `The preview failed (${state.state}).`,
      };
    }
    if (state.state !== 'success') return notReady(spanish);

    const urlProblem = checkDeploymentUrl(state.url, inputs.urlPattern, spanish);
    if (urlProblem !== undefined) return { ok: false, reason: urlProblem };

    return { ok: true, evidence: { deployment: newest.id, url: state.url, sha } };
  };
}

function notReady(spanish: boolean): GateResult {
  return {
    ok: false,
    reason: spanish
      ? 'La vista previa de esta versión aún no está lista.'
      : 'The preview of this version is not ready yet.',
  };
}

export const previewDeploymentBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const environment = asString(inputs['environment']) ?? '';
    const creator = asString(inputs['creator']);
    const urlPattern = asString(inputs['urlPattern']);
    return createGate(
      {
        environment,
        ...(creator === undefined ? {} : { creator }),
        ...(urlPattern === undefined ? {} : { urlPattern }),
      },
      deps,
    );
  },
};
