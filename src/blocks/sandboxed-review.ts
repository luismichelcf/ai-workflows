import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Gate, GateContext, GateResult, JsonValue } from '../contract.js';
import { familyOf, requireDifferentBuilder } from '../identity.js';
import type { ExecutionIdentity } from '../identity.js';
import { parseEventComment, renderEventComment, type PieceEvent } from '../agent/events.js';
import { decideIndependentReview } from './reviews.js';
import { fetchableEvents, serverAccepts, treeOfCommit } from './review-commits.js';
import type { ServerAttestContext, ServerResult } from './definition.js';
import {
  buildInvocation,
  parseRun,
  type ProviderName,
  type RunRequest,
} from '../providers.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { refuseDryRun } from './test-run.js';

// PLAN-13-R2 §3.3 (CN-02, CN-03): `sandboxed-review@1` produces the verdict itself instead of
// receiving it. It runs the reviewer in read-only mode, observes the reviewer's real identity
// from the CLI's own output, takes a fingerprint of the working tree before and after, and
// reads a single exact `VERDICT:` line. A review that modified the tree never passes, even
// saying it approves, and the reviewer's own text claiming to be someone else proves nothing.

const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export const manifest: BlockManifest = {
  name: 'sandboxed-review',
  kind: 'module',
  natures: ['recompute', 'attest'],
  validWhile: ['same-sha', 'same-fingerprint-or-clean-update'],
  server: ['attestation', 'require-check'],
  inputs: {
    reviewer: {
      type: 'object',
      required: true,
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
};

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readIdentity(value: unknown): ExecutionIdentity | undefined {
  const record = readObject(value);
  if (record === undefined) return undefined;
  const provider = asString(record['provider']);
  const model = asString(record['model']);
  const session = asString(record['session']);
  if (provider === undefined || model === undefined || session === undefined) return undefined;
  return { provider, model, session };
}

/** Every declared builder of the change; `undefined` when one of them is not a real identity. */
function readBuilders(value: unknown): ExecutionIdentity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const builders: ExecutionIdentity[] = [];
  for (const item of value) {
    const identity = readIdentity(item);
    if (identity === undefined) return undefined;
    builders.push(identity);
  }
  return builders;
}

/** Every file under `root`, as paths relative to it with `/`, excluding `.git` and `node_modules`. */
async function listFiles(root: string, prefix: string): Promise<string[]> {
  const here = prefix === '' ? root : join(root, prefix);
  const entries = await readdir(here, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * sha256 over the ordered list of (relative path with `/`, content) of the whole working tree.
 * Taken by the block itself before and after the review: a tree that changed, changed.
 */
async function workspaceFingerprint(root: string): Promise<string> {
  const files = (await listFiles(root, '')).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function cleanReason(spanish: boolean): string {
  return spanish
    ? 'La revisión se hace sobre versiones guardadas: hay cambios sin guardar.'
    : 'A review is done on saved versions: there are unsaved changes.';
}

function noBuilderReason(spanish: boolean): string {
  return spanish
    ? 'No se sabe quién construyó la pieza, así que no se puede juzgar la independencia de la revisión.'
    : 'Nobody knows who built the piece, so the independence of the review cannot be judged.';
}

function missingPromptReason(path: string, spanish: boolean): string {
  return spanish
    ? `No existe el archivo de la revisión «${path}».`
    : `The review prompt file "${path}" does not exist.`;
}

function treeChangedReason(spanish: boolean): string {
  return spanish
    ? 'La revisión modificó el árbol de trabajo.'
    : 'The review changed the working tree.';
}

function sameFamilyReason(family: string, spanish: boolean): string {
  return spanish
    ? `El revisor y el constructor son de la misma familia (${family}).`
    : `The reviewer and the builder are from the same family (${family}).`;
}

function reviseWithoutTextReason(spanish: boolean): string {
  return spanish
    ? 'El revisor pidió cambios sin explicar por qué.'
    : 'The reviewer asked for changes without saying why.';
}

function runNotSuccessfulReason(status: string, reason: string | undefined): string {
  const detail = reason === undefined ? '' : `: ${reason}`;
  return `the review did not finish successfully (${status}${detail})`;
}

/** The exact verdict lines of the reviewer's text, trimmed line by line. */
function verdictOf(text: string): { readonly approved: boolean } | undefined {
  let approved = false;
  let revise = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'VERDICT:APPROVED') approved = true;
    else if (trimmed === 'VERDICT:REVISE') revise = true;
  }
  if (approved === revise) return undefined;
  return { approved };
}

/** The reviewer's text without its verdict line, which is the reason it is refusing. */
function textWithoutVerdict(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== 'VERDICT:APPROVED' && line !== 'VERDICT:REVISE')
    .join('\n')
    .trim();
}

interface ReviewInputs {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
  readonly prompt: string;
  readonly angle: string;
  readonly forbidSameFamily: boolean;
  readonly timeoutMinutes: number;
}

function createGate(inputs: ReviewInputs, deps: EngineBlockDeps): Gate {
  return async (context: GateContext): Promise<GateResult> => {
    await refuseDryRun(context, 'sandboxed-review');
    const spanish = isSpanish(context.locale);

    const change = readObject(context.change) ?? {};
    if (change['clean'] !== true) return { ok: false, reason: cleanReason(spanish) };

    const builders = readBuilders(change['builders']);
    if (builders === undefined || builders.length === 0) {
      return { ok: false, reason: noBuilderReason(spanish) };
    }

    const path = inputs.prompt.replaceAll('{piece}', context.piece);
    let promptText: string;
    try {
      promptText = await readFile(join(deps.root, path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, reason: missingPromptReason(path, spanish) };
      }
      throw error;
    }

    const before = await workspaceFingerprint(deps.root);

    const request: RunRequest = {
      provider: inputs.provider as ProviderName,
      model: inputs.model,
      ...(inputs.effort === undefined ? {} : { effort: inputs.effort }),
      cwd: deps.root,
      prompt: promptText,
      mode: 'review',
    };
    const raw = await deps.providers.run(buildInvocation(request), {
      signal: context.signal,
      timeoutMs: inputs.timeoutMinutes * 60_000,
    });
    const report = parseRun(request, raw);
    if (report.status !== 'success' || report.identity === undefined) {
      throw new Error(runNotSuccessfulReason(report.status, report.reason));
    }

    const after = await workspaceFingerprint(deps.root);
    if (after !== before) return { ok: false, reason: treeChangedReason(spanish) };

    const verdict = verdictOf(report.text ?? '');
    if (verdict === undefined) throw new Error('the reviewer gave no single VERDICT line');

    const sha = asString(change['sha']) ?? '';
    for (const builder of builders) {
      const independence = requireDifferentBuilder(
        [{ by: report.identity, sha, approved: verdict.approved }],
        builder,
        { differentProvider: false },
      );
      if (!independence.ok) return { ok: false, reason: independence.reason };

      if (inputs.forbidSameFamily) {
        const reviewerFamily = familyOf(report.identity);
        if (reviewerFamily === familyOf(builder)) {
          return { ok: false, reason: sameFamilyReason(reviewerFamily, spanish) };
        }
      }
    }

    if (!verdict.approved) {
      const text = textWithoutVerdict(report.text ?? '');
      return { ok: false, reason: text.length > 0 ? text : reviseWithoutTextReason(spanish) };
    }

    // PLAN-13-R4 §2: its own approved verdict is published as an event, so its server
    // attestation has something to read. Without the agents' identity there is nothing to
    // publish, and a stage that only runs next to the agent needs none.
    if (deps.agent !== undefined && deps.recipe.agentAccount !== undefined) {
      const event: PieceEvent = {
        type: 'verdict',
        op: `verdict:${context.stage}:${sha}`,
        piece: context.piece,
        sha,
        identity: {
          provider: report.identity.provider,
          model: report.identity.model,
          effort: inputs.effort ?? '',
          session: report.identity.session,
        },
        angle: inputs.angle,
        approved: true,
        workspace: { before, after: before },
        stage: context.stage,
        at: '',
      };
      await context.runEffect(`verdict:${context.stage}:${sha}`, async () => {
        await deps.agent?.github.commentOnIssue(
          Number(context.piece),
          renderEventComment(event, context.locale),
        );
        return null;
      });
    }

    return {
      ok: true,
      evidence: {
        reviewer: {
          provider: report.identity.provider,
          model: report.identity.model,
          session: report.identity.session,
        },
        sha,
        angle: inputs.angle,
        approved: true,
        workspace: before,
      } satisfies JsonValue,
    };
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PLAN-13-R4 §3.1 and §7: the verdict this block published for its stage and head, decided with
 * the same function as the independent review. A verdict of another stage never counts.
 */
async function attestation(
  inputs: Record<string, unknown>,
  context: ServerAttestContext,
): Promise<ServerResult> {
  const spanish = isSpanish(context.locale);
  const agentAccount = context.recipe.agentAccount;
  if (agentAccount === undefined) {
    return {
      outcome: 'technical',
      reason: spanish
        ? 'La receta no declara la identidad con la que publican los agentes.'
        : 'The recipe does not declare the identity the agents publish with.',
    };
  }

  let comments;
  try {
    comments = await context.github.issueComments(Number(context.piece));
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
  const events: PieceEvent[] = [];
  for (const comment of comments) {
    const parsed = parseEventComment(comment, { agentAccount, piece: context.piece });
    if (parsed === undefined || 'invalid' in parsed) continue;
    if (parsed.type === 'builder' || parsed.stage === context.stage) events.push(parsed);
  }

  const angle = asString(inputs['angle']) ?? '';
  // PLAN-13-R4 §7: the head must be readable — without it nothing can be judged. Each event's
  // commit is brought in on its own; an event whose commit cannot be fetched is ignored (no
  // count, no permanent block), so the decision below names whatever it leaves missing.
  try {
    await context.fetchObjects([context.head]);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }
  const usable = await fetchableEvents(context, events);
  try {
    const decision = await decideIndependentReview({
      events: usable,
      angles: angle.length === 0 ? [] : [angle],
      forbidSameFamily: inputs['forbidSameFamily'] !== false,
      stage: context.stage,
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

function splitVerdict(operationId: string): { readonly stage: string; readonly sha: string } | undefined {
  if (!operationId.startsWith('verdict:')) return undefined;
  const rest = operationId.slice('verdict:'.length);
  const last = rest.lastIndexOf(':');
  if (last < 0) return undefined;
  return { stage: rest.slice(0, last), sha: rest.slice(last + 1) };
}

export const sandboxedReviewBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const reviewer = readObject(inputs['reviewer']) ?? {};
    const effort = asString(reviewer['effort']);
    return createGate(
      {
        provider: asString(reviewer['provider']) ?? '',
        model: asString(reviewer['model']) ?? '',
        ...(effort === undefined ? {} : { effort }),
        prompt: asString(inputs['prompt']) ?? '',
        angle: asString(inputs['angle']) ?? '',
        forbidSameFamily: inputs['forbidSameFamily'] !== false,
        timeoutMinutes:
          typeof inputs['timeoutMinutes'] === 'number' ? inputs['timeoutMinutes'] : 30,
      },
      deps,
    );
  },
  server: { attestation },
  async reconcile(_inputs, operationId, context, deps) {
    const parts = splitVerdict(operationId);
    const agent = deps.agent;
    if (parts === undefined || agent === undefined || deps.recipe.agentAccount === undefined) {
      return undefined;
    }
    const comments = await agent.github.issueComments(Number(context.piece));
    const found = comments.some((comment) => {
      const parsed = parseEventComment(comment, {
        agentAccount: deps.recipe.agentAccount as string,
        piece: context.piece,
      });
      return parsed !== undefined && !('invalid' in parsed) && parsed.op === operationId;
    });
    return found ? { confirmed: null } : { didNotHappen: true };
  },
};
