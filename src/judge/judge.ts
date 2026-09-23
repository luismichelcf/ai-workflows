// PLAN-13-R3 §3 and §4: the judge. It runs on GitHub, on the trusted commit of the main branch,
// and it never checks out the pull request or runs any of its code: it reads commit objects,
// asks the port about the pull request, and calls only the `server` part of an engine block.
//
// The whole flow of one run, in order: prove where the workflow came from; read the switch; read
// the recipe from the live head of main; find what to judge for the event; judge each pull request
// stage by stage; trace the states that imitate its name; and only then publish, after checking
// that neither the head nor main moved and that no newer official run went first.

import type { GateContext, JsonValue } from '../contract.js';
import type {
  BlockDefinition,
  ServerAttestContext,
  ServerContext,
  ServerResult,
} from '../blocks/definition.js';
import { engineBlock } from '../blocks/registry.js';
import { evaluateOwnerOrder } from '../locks/signoff.js';
import { appliesIfFor } from '../recipe/applies.js';
import { checkRecipe } from '../recipe/blocks.js';
import {
  describeChangeFromCommits,
  gitCheckoutDetach,
  gitHead,
  gitIsAncestor,
  gitProjectFiles,
  type ChangeFacts,
} from '../recipe/facts.js';
import { blockInputs } from '../recipe/inputs.js';
import type { Recipe, RecipeStage } from '../recipe/types.js';
import {
  collectUnofficial,
  officialRunId,
  requireCheck,
  type Unofficial,
} from './checks.js';
import { pieceOfBranch, readDeclaredKind } from './pieces.js';
import type { JudgeGitHub } from './port.js';
import { buildSummary, escapeReportText, type SummaryPiece } from './summary.js';

// ---------------------------------------------------------------------------------------------
// The signatures the tests fix (PLAN-13-R3 §6.1).

export interface JudgeInput {
  readonly eventName: string;
  /** The payload of `GITHUB_EVENT_PATH`. */
  readonly event: unknown;
  readonly mode: string;
  readonly context: string;
  readonly repository: string;
  readonly workflowRef: string;
  readonly actionRef: string;
  readonly runId: number;
  readonly serverUrl: string;
  readonly alsoProtect: readonly string[];
  /** The checkout of the trusted commit. */
  readonly root: string;
}

export type StageOutcome =
  | 'passed'
  | 'skipped'
  | 'rejected'
  | 'waiting'
  | 'technical'
  | 'informative';

export type JudgeVerdict = 'passed' | 'rejected' | 'waiting' | 'technical';

export interface JudgeStageReport {
  readonly id: string;
  readonly outcome: StageOutcome;
  readonly reason?: string;
  /** What a `recompute` proved, when the server part left any. */
  readonly evidence?: JsonValue;
}

export interface JudgePieceReport {
  readonly pr: number;
  readonly piece?: string;
  readonly verdict: JudgeVerdict;
  readonly stages: readonly JudgeStageReport[];
}

export interface JudgePublished {
  readonly sha: string;
  readonly context: string;
  readonly state: string;
  readonly description: string;
}

export interface JudgeReport {
  readonly published: readonly JudgePublished[];
  readonly pieces: readonly JudgePieceReport[];
  readonly unofficial: readonly Unofficial[];
  /** Markdown for `GITHUB_STEP_SUMMARY`. */
  readonly summary: string;
  /** What was not published, and why. */
  readonly notes: readonly string[];
}

export interface JudgeDeps {
  readonly github: JudgeGitHub;
  /** Brings commit objects the judge did not check out, with the token of one single command. */
  fetchObjects(shas: string[]): Promise<void>;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------------------------
// Small readers for the event payload: JSON is unknown until it is checked.

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === 'string' ? found : undefined;
}

function num(value: unknown, key: string): number | undefined {
  const found = field(value, key);
  return typeof found === 'number' && Number.isInteger(found) ? found : undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** The text of the recipe's language. Before a recipe is read, everything stays in Spanish. */
function pick(spanish: boolean, es: string, en: string): string {
  return spanish ? es : en;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------------------------
// Targets of §3.2

interface Target {
  readonly pr: number;
  /** The head this pull request is judged at. */
  readonly head: string;
}

type Targets =
  | { readonly ok: true; readonly sha: string; readonly targets: readonly Target[] }
  | { readonly ok: 'empty'; readonly note: string }
  | { readonly ok: 'technical'; readonly sha: string; readonly reason: string };

async function mergeGroupTargets(
  github: JudgeGitHub,
  principal: string,
  sha: string,
): Promise<Targets> {
  let queue;
  try {
    queue = await github.mergeQueue(principal);
  } catch (error) {
    return { ok: 'technical', sha, reason: reasonOf(error) };
  }
  const index = queue.findIndex((entry) => entry.headSha === sha);
  if (index < 0) {
    return { ok: 'technical', sha, reason: `el SHA ${sha} no aparece en la lista de la cola` };
  }
  const targets: Target[] = [];
  for (const entry of queue.slice(0, index + 1)) {
    try {
      const pr = await github.pullRequest(entry.prNumber);
      targets.push({ pr: entry.prNumber, head: pr.headSha });
    } catch (error) {
      return { ok: 'technical', sha, reason: reasonOf(error) };
    }
  }
  return { ok: true, sha, targets };
}

/**
 * PLAN-13-R3 §3.2: the SHA to judge and the pull requests to judge for this event. The live head
 * of the pull request is read, and only the re-read before publishing decides whether a verdict
 * may still be written for it (a head the event named but the branch moved past is not judged).
 */
async function resolveTargets(
  input: JudgeInput,
  github: JudgeGitHub,
  principal: string,
): Promise<Targets> {
  const event = input.event;
  switch (input.eventName) {
    case 'pull_request_target': {
      const pull = field(event, 'pull_request');
      const number = num(pull, 'number');
      if (number === undefined) {
        return { ok: 'technical', sha: '', reason: 'el evento no nombra el pull request' };
      }
      // The head is read live: the event may name a commit the branch already moved past, and the
      // re-read before publishing decides whether this run may still write a verdict.
      try {
        const pr = await github.pullRequest(number);
        return { ok: true, sha: pr.headSha, targets: [{ pr: number, head: pr.headSha }] };
      } catch (error) {
        return { ok: 'technical', sha: '', reason: reasonOf(error) };
      }
    }
    case 'issue_comment': {
      const issue = field(event, 'issue');
      if (field(issue, 'pull_request') === undefined) {
        return { ok: 'empty', note: 'el comentario no es de un pull request' };
      }
      const number = num(issue, 'number');
      if (number === undefined) {
        return { ok: 'technical', sha: '', reason: 'el comentario no nombra el pull request' };
      }
      try {
        const pr = await github.pullRequest(number);
        return { ok: true, sha: pr.headSha, targets: [{ pr: number, head: pr.headSha }] };
      } catch (error) {
        return { ok: 'technical', sha: '', reason: reasonOf(error) };
      }
    }
    case 'workflow_dispatch': {
      const raw = field(field(event, 'inputs'), 'pr');
      const number =
        typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN;
      if (!Number.isInteger(number)) {
        return { ok: 'technical', sha: '', reason: 'workflow_dispatch sin número de pull request' };
      }
      try {
        const pr = await github.pullRequest(number);
        return { ok: true, sha: pr.headSha, targets: [{ pr: number, head: pr.headSha }] };
      } catch (error) {
        return { ok: 'technical', sha: '', reason: reasonOf(error) };
      }
    }
    case 'workflow_run': {
      const run = field(event, 'workflow_run');
      const triggered = text(run, 'event');
      const head = text(run, 'head_sha');
      if (head === undefined) {
        return { ok: 'technical', sha: '', reason: 'workflow_run sin head_sha' };
      }
      if (triggered === 'pull_request') {
        try {
          const prs = await github.openPullRequestsWithHead(head);
          if (prs.length === 0) {
            return { ok: 'empty', note: `ningún pull request abierto tiene la cabeza ${head}` };
          }
          return { ok: true, sha: head, targets: prs.map((pr) => ({ pr, head })) };
        } catch (error) {
          return { ok: 'technical', sha: head, reason: reasonOf(error) };
        }
      }
      if (triggered === 'merge_group') {
        return mergeGroupTargets(github, principal, head);
      }
      return { ok: 'empty', note: `workflow_run de un evento no juzgado (${triggered ?? 'desconocido'})` };
    }
    case 'merge_group': {
      const head = text(field(event, 'merge_group'), 'head_sha');
      if (head === undefined) {
        return { ok: 'technical', sha: '', reason: 'merge_group sin head_sha' };
      }
      return mergeGroupTargets(github, principal, head);
    }
    default:
      return { ok: 'empty', note: `evento no juzgado: ${input.eventName}` };
  }
}

interface PrInfo {
  readonly headRef: string;
  readonly baseRef: string;
}

// ---------------------------------------------------------------------------------------------
// One stage of one pull request (§3.3, §3.4).

interface StageWork {
  readonly recipe: Recipe;
  readonly trusted: string;
  readonly judgedSha: string;
  readonly target: Target;
  readonly piece: string;
  readonly facts: ChangeFacts;
  readonly root: string;
  readonly github: JudgeGitHub;
  readonly judgePath: string;
  readonly alsoProtect: readonly string[];
  fetchObjects(shas: string[]): Promise<void>;
}

interface JudgedStage extends JudgeStageReport {
  readonly required: boolean;
}

const RANK: Readonly<Record<JudgeVerdict, number>> = {
  passed: 0,
  waiting: 1,
  rejected: 2,
  technical: 3,
};

function worse(a: JudgeVerdict, b: JudgeVerdict): JudgeVerdict {
  return RANK[b] > RANK[a] ? b : a;
}

function verdictOf(stages: readonly JudgedStage[]): JudgeVerdict {
  let verdict: JudgeVerdict = 'passed';
  for (const stage of stages) {
    if (!stage.required) continue;
    if (stage.outcome === 'technical') verdict = worse(verdict, 'technical');
    else if (stage.outcome === 'rejected') verdict = worse(verdict, 'rejected');
    else if (stage.outcome === 'waiting') verdict = worse(verdict, 'waiting');
  }
  return verdict;
}

/**
 * A stage as it appears in the report. A `required: false` stage that would fail is informative
 * and never blocks (§3.3.4): it still says why, but it does not count against the pull request.
 */
function present(
  stage: RecipeStage,
  outcome: StageOutcome,
  reason: string | undefined,
  evidence: JsonValue | undefined = undefined,
): JudgedStage {
  const failing = outcome === 'rejected' || outcome === 'waiting' || outcome === 'technical';
  const shown: StageOutcome = !stage.required && failing ? 'informative' : outcome;
  return {
    id: stage.id,
    outcome: shown,
    ...(reason === undefined ? {} : { reason }),
    ...(evidence === undefined ? {} : { evidence }),
    required: stage.required,
  };
}

function fromServer(stage: RecipeStage, result: ServerResult): JudgedStage {
  const reason = 'reason' in result ? result.reason : undefined;
  const evidence = 'evidence' in result ? result.evidence : undefined;
  return present(stage, result.outcome, reason, evidence);
}

function serverContext(work: StageWork): ServerContext {
  return {
    facts: work.facts,
    files: gitProjectFiles(work.root, work.target.head),
    locale: work.recipe.locale,
    piece: work.piece,
    recipe: work.recipe,
  };
}

function serverAttestContext(stage: RecipeStage, work: StageWork): ServerAttestContext {
  return {
    ...serverContext(work),
    root: work.root,
    head: work.target.head,
    trusted: work.trusted,
    needsHuman: stage.needsHuman,
    validWhile: stage.validWhile,
    ...(work.recipe.owner === undefined ? {} : { owner: work.recipe.owner }),
    pullRequest: work.target.pr,
    github: work.github,
    fetchObjects: work.fetchObjects,
  };
}

async function judgeStage(stage: RecipeStage, work: StageWork): Promise<JudgedStage> {
  const spanish = isSpanish(work.recipe.locale);
  try {
    // Deciding whether a stage applies, and running its server part, are one unit: a failure in
    // either leaves only this stage technical, and the rest are still judged (§3.3).
    const applies = appliesIfFor(work.recipe, stage.id);
    if (applies !== undefined) {
      const context = {
        change: { files: work.facts.files, kind: work.facts.kind, lane: work.facts.lane },
      } as unknown as GateContext;
      const applicability = applies(context);
      if (applicability !== true) {
        const reason =
          typeof applicability === 'object' && applicability !== null && 'skip' in applicability
            ? applicability.skip
            : pick(spanish, 'No aplica.', 'Does not apply.');
        return present(stage, 'skipped', reason);
      }
    }

    const server = stage.server;
    const uses = stage.gate.uses;
    const definition: BlockDefinition | undefined = uses === undefined ? undefined : engineBlock(uses);

    if (server === 'local-only' || server === undefined) {
      return server === undefined && stage.required
        ? present(
            stage,
            'technical',
            pick(
              spanish,
              'la etapa no dice cómo comprobarla en GitHub',
              'the stage does not say how to check it on GitHub',
            ),
          )
        : present(
            stage,
            'informative',
            pick(spanish, 'solo se comprueba junto al agente', 'it is only checked next to the agent'),
          );
    }

    if (typeof server === 'object') {
      const result = await requireCheck(work.github, work.judgedSha, server.requireCheck, work.recipe.locale);
      return present(stage, result.outcome, result.reason);
    }

    if (server === 'recompute') {
      const recompute = definition?.server?.recompute;
      if (definition === undefined || recompute === undefined) {
        return present(
          stage,
          'technical',
          pick(
            spanish,
            `el bloque «${uses ?? stage.id}» no se puede recomprobar en el servidor`,
            `the block "${uses ?? stage.id}" cannot be recomputed on the server`,
          ),
        );
      }
      const inputs = blockInputs(definition.manifest, stage.gate.with);
      return fromServer(stage, await recompute(inputs, serverContext(work)));
    }

    const attest = definition?.server?.attestation;
    if (definition === undefined || attest === undefined) {
      return present(
        stage,
        'technical',
        pick(
          spanish,
          'la comprobación del servidor de este bloque llega en la rebanada 4',
          'the server check of this block arrives in slice 4',
        ),
      );
    }
    const inputs = blockInputs(definition.manifest, stage.gate.with);
    return fromServer(stage, await attest(inputs, serverAttestContext(stage, work)));
  } catch (error) {
    return present(stage, 'technical', reasonOf(error));
  }
}

// ---------------------------------------------------------------------------------------------
// The judge's own files (§3.5)

function isProtectedFile(file: string, judgePath: string, alsoProtect: readonly string[]): boolean {
  return (
    file === '.ai-workflows' ||
    file.startsWith('.ai-workflows/') ||
    file === judgePath ||
    alsoProtect.includes(file)
  );
}

interface FilesNote {
  /** The rejection motive: the pull request changes the judge and lacks the owner's order. */
  readonly note?: string;
  /** The pull request is technical: the comments could not be read to decide the attestation. */
  readonly error?: string;
}

async function judgeFilesNote(
  work: StageWork,
  judgePath: string,
  alsoProtect: readonly string[],
): Promise<FilesNote> {
  const spanish = isSpanish(work.recipe.locale);
  const touched = work.facts.files.filter((file) => isProtectedFile(file, judgePath, alsoProtect));
  if (touched.length === 0) return {};

  const owners = work.recipe.owner === undefined ? [] : [work.recipe.owner];
  let comments;
  try {
    comments = await work.github.comments(work.target.pr);
  } catch (error) {
    return {
      error: pick(
        spanish,
        `No se pudieron leer los comentarios del PR para la atestación del juez: ${reasonOf(error)}`,
        `The pull request comments could not be read for the judge's attestation: ${reasonOf(error)}`,
      ),
    };
  }
  const valid = comments.some((comment) => {
    const order = evaluateOwnerOrder(comment, {
      order: '/approve-judge-change',
      minCodeLength: 7,
      productOwners: owners,
      locale: work.recipe.locale,
    });
    return order.ok && work.target.head.toLowerCase().startsWith(order.code.toLowerCase());
  });
  if (valid) return {};

  const wanted = `/approve-judge-change ${work.target.head.slice(0, 7)}`;
  return {
    note: pick(
      spanish,
      `El PR cambia archivos del juez; hace falta un comentario ${wanted} del dueño para esta versión.`,
      `The pull request changes the judge's files; a comment ${wanted} by the owner is needed for this version.`,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// One pull request (§3.3)

interface JudgedPr extends JudgePieceReport {
  /** The reason that is not any single stage: missing piece, invalid kind, judge files. */
  readonly note?: string;
}

async function judgeOne(
  recipe: Recipe,
  trusted: string,
  target: Target,
  info: PrInfo,
  work: Omit<StageWork, 'target' | 'piece' | 'facts' | 'trusted'>,
): Promise<JudgedPr> {
  const spanish = isSpanish(recipe.locale);
  const piece = pieceOfBranch(recipe, info.headRef, target.pr);
  if ('none' in piece) {
    return {
      pr: target.pr,
      verdict: 'rejected',
      stages: [],
      note: pick(spanish, `Sin pieza: ${piece.none}.`, `No piece: ${piece.none}.`),
    };
  }
  const pieceId = piece.piece;

  // §3.1: the head's objects come before anything is read from it — a declared kind, a project
  // file, an ancestor. An un-fetchable head makes the pull request technical, never rejected.
  try {
    await work.fetchObjects([target.head]);
  } catch (error) {
    return { pr: target.pr, piece: pieceId, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  const files = gitProjectFiles(work.root, target.head);

  let declaredKind: string | undefined;
  try {
    const declared = await readDeclaredKind(recipe, pieceId, files);
    if ('rejected' in declared) {
      return {
        pr: target.pr,
        piece: pieceId,
        verdict: 'rejected',
        stages: [],
        note: pick(
          spanish,
          `Tipo declarado inválido: ${declared.rejected}.`,
          `Invalid declared kind: ${declared.rejected}.`,
        ),
      };
    }
    declaredKind = declared.kind;
  } catch (error) {
    return { pr: target.pr, piece: pieceId, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  let facts: ChangeFacts;
  try {
    facts = await describeChangeFromCommits({
      root: work.root,
      base: trusted,
      head: target.head,
      recipe,
      piece: pieceId,
      ...(declaredKind === undefined ? {} : { declaredKind }),
    });
  } catch (error) {
    return { pr: target.pr, piece: pieceId, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  const stageWork: StageWork = {
    ...work,
    trusted,
    target,
    piece: pieceId,
    facts,
  };

  const stages: JudgedStage[] = [];
  for (const stage of recipe.stages) {
    if (stage.phase !== 'pre-merge') continue;
    stages.push(await judgeStage(stage, stageWork));
  }

  const filesCheck = await judgeFilesNote(stageWork, work.judgePath, work.alsoProtect);
  let verdict = verdictOf(stages);
  if (filesCheck.error !== undefined) verdict = worse(verdict, 'technical');
  else if (filesCheck.note !== undefined) verdict = worse(verdict, 'rejected');

  const note = filesCheck.error ?? filesCheck.note;
  return {
    pr: target.pr,
    piece: pieceId,
    verdict,
    stages: stages.map((stage) => ({
      id: stage.id,
      outcome: stage.outcome,
      ...(stage.reason === undefined ? {} : { reason: stage.reason }),
      ...(stage.evidence === undefined ? {} : { evidence: stage.evidence }),
    })),
    ...(note === undefined ? {} : { note }),
  };
}

// ---------------------------------------------------------------------------------------------
// The verdict, the name it publishes under and the description it shows (§3.8)

function stateOf(verdict: JudgeVerdict): string {
  return verdict === 'passed' ? 'success' : verdict === 'rejected' ? 'failure' : verdict === 'waiting' ? 'pending' : 'error';
}

function truncateDescription(value: string): string {
  const points = [...value];
  return points.length <= 140 ? value : points.slice(0, 140).join('');
}

function stateLabel(verdict: JudgeVerdict, spanish: boolean): string {
  if (verdict === 'rejected') return spanish ? 'Rechazado en' : 'Rejected in';
  if (verdict === 'technical') return spanish ? 'Error en' : 'Error in';
  return spanish ? 'Pendiente en' : 'Waiting in';
}

function describeVerdict(pieces: readonly JudgedPr[], locale: string): string {
  const spanish = isSpanish(locale);
  const verdict = pieces.reduce<JudgeVerdict>((acc, p) => worse(acc, p.verdict), 'passed');
  if (verdict === 'passed') return spanish ? 'Todo en verde.' : 'All green.';

  const chosen = pieces.find((piece) => piece.verdict === verdict) ?? pieces[0];
  if (chosen?.note !== undefined) return truncateDescription(chosen.note);

  const wanted: StageOutcome = verdict === 'rejected' ? 'rejected' : verdict === 'technical' ? 'technical' : 'waiting';
  const stage = chosen?.stages.find((entry) => entry.outcome === wanted);
  if (stage === undefined) return spanish ? 'Sin veredicto.' : 'No verdict.';
  return truncateDescription(`${stateLabel(verdict, spanish)} ${stage.id}: ${stage.reason ?? ''}`);
}

// ---------------------------------------------------------------------------------------------
// The run

export async function runJudge(input: JudgeInput, deps: JudgeDeps): Promise<JudgeReport> {
  const { github } = deps;
  const notes: string[] = [];
  const published: JudgePublished[] = [];
  const finish = (
    pieces: readonly JudgedPr[] = [],
    unofficial: readonly Unofficial[] = [],
    summary = '',
  ): JudgeReport => ({
    published,
    pieces: pieces.map((piece) => ({
      pr: piece.pr,
      ...(piece.piece === undefined ? {} : { piece: piece.piece }),
      verdict: piece.verdict,
      stages: piece.stages,
    })),
    unofficial,
    summary,
    notes,
  });

  const publish = async (
    sha: string,
    context: string,
    state: string,
    description: string,
  ): Promise<void> => {
    const targetUrl = `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}`;
    const shown = truncateDescription(description);
    await github.publishStatus(sha, { context, state, description: shown, targetUrl });
    published.push({ sha, context, state, description: shown });
  };

  // §3.1 procedencia: where the workflow's YAML comes from, proven in every run.
  const at = input.workflowRef.lastIndexOf('@');
  const prefix = `${input.repository}/`;
  const judgePath = at < 0 || !input.workflowRef.startsWith(prefix)
    ? undefined
    : input.workflowRef.slice(prefix.length, at);
  const ref = at < 0 ? undefined : input.workflowRef.slice(at + 1);
  if (judgePath === undefined || judgePath.length === 0 || ref === undefined || ref.length === 0) {
    notes.push(`procedencia no comprobada: ${input.workflowRef}`);
    return finish();
  }

  const principal = await github.defaultBranch();
  const expectedRef =
    input.eventName === 'merge_group'
      ? ref.startsWith(`refs/heads/gh-readonly-queue/${principal}/`)
      : ref === `refs/heads/${principal}`;
  if (!expectedRef) {
    notes.push(`procedencia no comprobada: ${ref}`);
    return finish();
  }

  // §4 el interruptor: the trimmed, case-insensitive value.
  const mode = input.mode.trim().toLowerCase();
  if (!['', 'off', 'advisory', 'on'].includes(mode)) {
    await publish(
      initialSha(input),
      input.context,
      'error',
      'AI_WORKFLOWS_MODE inválido: use off, advisory u on',
    );
    return finish();
  }
  if (mode === '' || mode === 'off') {
    await publish(initialSha(input), input.context, 'success', 'motor apagado');
    return finish();
  }
  const targetContext = mode === 'advisory' ? 'ai-workflows/advisory' : input.context;
  const traceContexts = [input.context, 'ai-workflows/advisory'];

  if (!FULL_SHA.test(input.actionRef)) {
    await publish(initialSha(input), targetContext, 'error', 'el juez no está fijado por SHA');
    return finish();
  }

  const targets = await resolveTargets(input, github, principal);
  const judgedSha = targets.ok === 'empty' ? '' : targets.sha;
  const infos = new Map<number, PrInfo>();
  const targetList: Target[] = [];

  // §3.7 rastro de estados imitados: collected on every path that does not publish a verdict, and
  // after publishing, when the judge's own status is already official. A read failure is a note.
  const traceComment = (unofficial: readonly Unofficial[], locale: string): string => {
    const spanish = isSpanish(locale);
    const heading = pick(
      spanish,
      'Estados con el nombre del juez que no salieron de su corrida oficial:',
      'Statuses named like the judge that did not come from its official run:',
    );
    const lines = unofficial.map((entry) => {
      const detail = entry.app === undefined ? '' : ` (${escapeReportText(entry.app)})`;
      return `- ${escapeReportText(entry.context)} [${entry.kind}]${detail}: ${escapeReportText(entry.url ?? '')}`;
    });
    return [heading, ...lines].join('\n');
  };
  const conclude = async (judged: readonly JudgedPr[], locale: string): Promise<JudgeReport> => {
    const collected = await collectUnofficial(
      github,
      judgedSha,
      input.repository,
      judgePath,
      principal,
      input.serverUrl,
      traceContexts,
      locale,
    );
    notes.push(...collected.notes);
    if (collected.unofficial.length > 0) {
      const body = traceComment(collected.unofficial, locale);
      for (const target of targetList) {
        try {
          await github.upsertTraceComment(target.pr, body);
        } catch (error) {
          notes.push(
            pick(
              isSpanish(locale),
              `No se pudo escribir el rastro en el PR #${target.pr}: ${reasonOf(error)}`,
              `The trace could not be written on pull request #${target.pr}: ${reasonOf(error)}`,
            ),
          );
        }
      }
    }
    const summary: SummaryPiece[] = judged.map((piece) => ({
      pr: piece.pr,
      ...(piece.piece === undefined ? {} : { piece: piece.piece }),
      verdict: piece.verdict,
      stages: piece.stages,
      ...(piece.note === undefined ? {} : { note: piece.note }),
    }));
    return finish(judged, collected.unofficial, buildSummary(summary, collected.unofficial, locale, notes));
  };

  if (targets.ok === 'empty') {
    notes.push(targets.note);
    return finish();
  }
  if (targets.ok === 'technical') {
    await publish(targets.sha, targetContext, 'error', targets.reason);
    return conclude([], 'es');
  }

  // §3.1 rama destino: before publishing anything, not even an error. A pull request whose base
  // is not the principal receives nothing; among several, the ones into another branch are
  // dropped and the rest are judged.
  const eventBase = text(field(field(input.event, 'pull_request'), 'base'), 'ref');
  if (input.eventName === 'pull_request_target' && eventBase !== undefined && eventBase !== principal) {
    notes.push(`la rama destino del PR es "${eventBase}", no la principal: nada se publica`);
    return finish();
  }
  for (const target of targets.targets) {
    let pr;
    try {
      pr = await github.pullRequest(target.pr);
    } catch (error) {
      await publish(targets.sha, targetContext, 'error', reasonOf(error));
      return finish();
    }
    if (pr.baseRef !== principal) {
      notes.push(`la rama destino del PR #${target.pr} es "${pr.baseRef}", no la principal: no se juzga`);
      continue;
    }
    infos.set(target.pr, { headRef: pr.headRef, baseRef: pr.baseRef });
    targetList.push(target);
  }
  if (targetList.length === 0) return finish();

  // §3.1 commit confiable: the live head of main, read once, checked out and read from.
  let trusted = await github.branchHead(principal);
  await deps.fetchObjects([trusted]);
  await checkout(input.root, trusted);

  // §3.1: bring every object the run will read — the group's SHA and each judged head — before
  // reading a declared kind, a file or an ancestor. An un-fetchable object is technical.
  const toFetch = new Set<string>([trusted, targets.sha]);
  for (const target of targetList) toFetch.add(target.head);
  try {
    await deps.fetchObjects([...toFetch]);
  } catch (error) {
    await publish(targets.sha, targetContext, 'error', reasonOf(error));
    return conclude([], 'es');
  }

  const readRecipeAt = async (sha: string): Promise<{ ok: true; recipe: Recipe } | { ok: false; reason: string }> => {
    let content: string | undefined;
    try {
      content = await gitProjectFiles(input.root, sha).read('.ai-workflows/pipeline.yml');
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
    if (content === undefined) {
      return { ok: false, reason: 'no existe .ai-workflows/pipeline.yml en la rama principal' };
    }
    const checked = await checkRecipe(content, '.ai-workflows/pipeline.yml', { root: input.root });
    if (!checked.ok) {
      const first = checked.errors[0];
      return { ok: false, reason: first === undefined ? 'la receta no es válida' : `${first.line}:${first.column} ${first.message}` };
    }
    return { ok: true, recipe: checked.recipe };
  };

  let read = await readRecipeAt(trusted);
  if (!read.ok) {
    await publish(targets.sha, targetContext, 'error', `La receta de la rama principal no se pudo leer: ${read.reason}`);
    return conclude([], 'es');
  }
  let recipe = read.recipe;

  // §3.1 and §3.8(b): a group's trusted commit must be an ancestor of the group, and again every
  // time the principal moves while the run is judging.
  const runEvent =
    input.eventName === 'workflow_run'
      ? text(field(input.event, 'workflow_run'), 'event') ?? ''
      : input.eventName;
  const isGroup = runEvent === 'merge_group';
  const ancestorProblem = async (current: string): Promise<string | undefined> => {
    let ancestor: boolean;
    try {
      ancestor = await gitIsAncestor(input.root, current, targets.sha);
    } catch (error) {
      return reasonOf(error);
    }
    return ancestor
      ? undefined
      : pick(isSpanish(recipe.locale), 'la rama principal no es ancestro del grupo', 'the main branch is not an ancestor of the group');
  };
  if (isGroup) {
    const problem = await ancestorProblem(trusted);
    if (problem !== undefined) {
      await publish(targets.sha, targetContext, 'error', problem);
      return conclude([], recipe.locale);
    }
  }

  const judgeAll = async (currentRecipe: Recipe, currentTrusted: string): Promise<JudgedPr[]> => {
    const judged: JudgedPr[] = [];
    for (const target of targetList) {
      const info = infos.get(target.pr);
      if (info === undefined) continue;
      judged.push(
        await judgeOne(currentRecipe, currentTrusted, target, info, {
          recipe: currentRecipe,
          judgedSha: targets.sha,
          root: input.root,
          github,
          fetchObjects: deps.fetchObjects,
          judgePath,
          alsoProtect: input.alsoProtect,
        }),
      );
    }
    return judged;
  };

  let pieces = await judgeAll(recipe, trusted);

  // §3.8 corridas que se cruzan: (a) head, (b) main, (c) another official run.
  for (let attempt = 0; ; attempt += 1) {
    let moved = false;
    for (const target of targetList) {
      const spanish = isSpanish(recipe.locale);
      let live;
      try {
        live = await github.pullRequest(target.pr);
      } catch (error) {
        notes.push(
          pick(
            spanish,
            `no se pudo releer el PR #${target.pr}: ${reasonOf(error)}`,
            `pull request #${target.pr} could not be re-read: ${reasonOf(error)}`,
          ),
        );
        return conclude(pieces, recipe.locale);
      }
      if (live.headSha !== target.head) {
        notes.push(
          pick(
            spanish,
            `la cabeza del PR #${target.pr} cambió antes de publicar (${live.headSha}); no se publica veredicto`,
            `the head of pull request #${target.pr} moved before publishing (${live.headSha}); no verdict is published`,
          ),
        );
        moved = true;
      }
      if (live.baseRef !== principal) {
        notes.push(
          pick(
            spanish,
            `la rama destino del PR #${target.pr} pasó a ser "${live.baseRef}"; no se publica`,
            `the target branch of pull request #${target.pr} became "${live.baseRef}"; nothing is published`,
          ),
        );
        moved = true;
      }
    }
    if (moved) return conclude(pieces, recipe.locale);

    const nowMain = await github.branchHead(principal);
    if (nowMain !== trusted) {
      if (attempt >= 1) {
        await publish(
          targets.sha,
          targetContext,
          'error',
          pick(isSpanish(recipe.locale), 'la rama principal cambió mientras se juzgaba', 'the main branch changed while the run was judging'),
        );
        return conclude(pieces, recipe.locale);
      }
      trusted = nowMain;
      await deps.fetchObjects([trusted]);
      await checkout(input.root, trusted);
      read = await readRecipeAt(trusted);
      if (!read.ok) {
        await publish(
          targets.sha,
          targetContext,
          'error',
          pick(
            isSpanish(recipe.locale),
            `La receta de la rama principal no se pudo leer: ${read.reason}`,
            `The recipe of the main branch could not be read: ${read.reason}`,
          ),
        );
        return conclude(pieces, recipe.locale);
      }
      recipe = read.recipe;
      if (isGroup) {
        const problem = await ancestorProblem(trusted);
        if (problem !== undefined) {
          await publish(targets.sha, targetContext, 'error', problem);
          return conclude(pieces, recipe.locale);
        }
      }
      pieces = await judgeAll(recipe, trusted);
      continue;
    }

    // §3.8(c): abstain only when the newest state of this context is an official run that started
    // after this one. A foreign state, or an older official one, never silences the verdict; the
    // trace of everything seen still goes to the report.
    const statuses = await github.statuses(targets.sha);
    const newest = statuses.find((status) => status.context === targetContext);
    if (newest !== undefined) {
      let official: number | undefined;
      try {
        official = await officialRunId(github, newest, input.repository, judgePath, principal, input.serverUrl);
      } catch (error) {
        notes.push(
          pick(
            isSpanish(recipe.locale),
            `no se pudo comprobar el estado más reciente de ${targetContext}: ${reasonOf(error)}`,
            `the newest status of ${targetContext} could not be checked: ${reasonOf(error)}`,
          ),
        );
        official = undefined;
      }
      if (official !== undefined && official > input.runId) {
        notes.push(
          pick(
            isSpanish(recipe.locale),
            `otra corrida oficial del juez publicó después (${official}); esta no publica`,
            `another official judge run published later (${official}); this one stays quiet`,
          ),
        );
        return conclude(pieces, recipe.locale);
      }
    }

    // §3.1: the live target branch, one last time before writing the verdict. A pull request
    // retargeted during the run receives nothing, not even an earlier verdict.
    for (const target of targetList) {
      const spanish = isSpanish(recipe.locale);
      let live;
      try {
        live = await github.pullRequest(target.pr);
      } catch (error) {
        notes.push(
          pick(
            spanish,
            `no se pudo releer el PR #${target.pr} antes de publicar: ${reasonOf(error)}`,
            `pull request #${target.pr} could not be re-read before publishing: ${reasonOf(error)}`,
          ),
        );
        return conclude(pieces, recipe.locale);
      }
      if (live.baseRef !== principal) {
        notes.push(
          pick(
            spanish,
            `la rama destino del PR #${target.pr} es "${live.baseRef}"; no se publica`,
            `the target branch of pull request #${target.pr} is "${live.baseRef}"; nothing is published`,
          ),
        );
        return conclude(pieces, recipe.locale);
      }
    }

    const verdict = pieces.reduce<JudgeVerdict>((acc, piece) => worse(acc, piece.verdict), 'passed');
    await publish(
      targets.sha,
      targetContext,
      stateOf(verdict),
      describeVerdict(pieces, recipe.locale),
    );
    break;
  }

  return conclude(pieces, recipe.locale);
}

/** The SHA a run about to be judged publishes on, before targets are resolved. */
function initialSha(input: JudgeInput): string {
  const event = input.event;
  const fromPr = text(field(field(event, 'pull_request'), 'head'), 'sha');
  if (fromPr !== undefined) return fromPr;
  const fromGroup = text(field(event, 'merge_group'), 'head_sha');
  if (fromGroup !== undefined) return fromGroup;
  return text(field(event, 'workflow_run'), 'head_sha') ?? '';
}

/** Moves the checkout to the trusted commit only when it is somewhere else. */
async function checkout(root: string, sha: string): Promise<void> {
  const at = await gitHead(root);
  if (at !== sha) await gitCheckoutDetach(root, sha);
}
