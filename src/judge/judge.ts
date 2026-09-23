// PLAN-13-R3 §3 and §4: the judge. It runs on GitHub, on the trusted commit of the main branch,
// and it never checks out the pull request or runs any of its code: it reads commit objects,
// asks the port about the pull request, and calls only the `server` part of an engine block.
//
// The whole flow of one run, in order: prove where the workflow came from; read the switch; read
// the recipe from the live head of main; find what to judge for the event; judge each pull request
// stage by stage; trace the states that imitate its name; and only then publish, after checking
// that neither the head nor main moved and that no newer official run went first.

import type { GateContext } from '../contract.js';
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
import { collectUnofficial, requireCheck, type Unofficial } from './checks.js';
import { pieceOfBranch, readDeclaredKind } from './pieces.js';
import type { JudgeGitHub } from './port.js';
import { buildSummary, type SummaryPiece } from './summary.js';

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

/** PLAN-13-R3 §3.2: the SHA to judge and the pull requests to judge for this event. */
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
      // The head is read live, not taken from the event: the event may name a commit the branch
      // already moved past, and only the live one is judged (and re-read before publishing).
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

function fromServer(stage: RecipeStage, result: ServerResult): JudgedStage {
  const outcome: StageOutcome = result.outcome;
  const reason = 'reason' in result ? result.reason : undefined;
  return {
    id: stage.id,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    required: stage.required,
  };
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
          : 'No aplica.';
      return { id: stage.id, outcome: 'skipped', reason, required: stage.required };
    }
  }

  const server = stage.server;
  const uses = stage.gate.uses;
  const definition: BlockDefinition | undefined = uses === undefined ? undefined : engineBlock(uses);

  try {
    if (server === 'local-only' || server === undefined) {
      return server === undefined && stage.required
        ? { id: stage.id, outcome: 'technical', reason: 'la etapa no dice cómo comprobarla en GitHub', required: true }
        : { id: stage.id, outcome: 'informative', reason: 'solo se comprueba junto al agente', required: stage.required };
    }

    if (typeof server === 'object') {
      const result = await requireCheck(work.github, work.judgedSha, server.requireCheck, work.recipe.locale);
      return {
        id: stage.id,
        outcome: result.outcome,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        required: stage.required,
      };
    }

    if (server === 'recompute') {
      const recompute = definition?.server?.recompute;
      if (definition === undefined || recompute === undefined) {
        return {
          id: stage.id,
          outcome: 'technical',
          reason: `el bloque «${uses ?? stage.id}» no se puede recomprobar en el servidor`,
          required: stage.required,
        };
      }
      const inputs = blockInputs(definition.manifest, stage.gate.with);
      return fromServer(stage, await recompute(inputs, serverContext(work)));
    }

    const attest = definition?.server?.attestation;
    if (definition === undefined || attest === undefined) {
      return {
        id: stage.id,
        outcome: 'technical',
        reason: 'la comprobación del servidor de este bloque llega en la rebanada 4',
        required: stage.required,
      };
    }
    const inputs = blockInputs(definition.manifest, stage.gate.with);
    return fromServer(stage, await attest(inputs, serverAttestContext(stage, work)));
  } catch (error) {
    return { id: stage.id, outcome: 'technical', reason: reasonOf(error), required: stage.required };
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

async function judgeFilesNote(
  work: StageWork,
  judgePath: string,
  alsoProtect: readonly string[],
): Promise<string | undefined> {
  const touched = work.facts.files.filter((file) => isProtectedFile(file, judgePath, alsoProtect));
  if (touched.length === 0) return undefined;

  const owners = work.recipe.owner === undefined ? [] : [work.recipe.owner];
  let comments;
  try {
    comments = await work.github.comments(work.target.pr);
  } catch (error) {
    return `No se pudieron leer los comentarios del PR para la atestación del juez: ${reasonOf(error)}`;
  }
  const valid = comments.some((comment) => {
    const order = evaluateOwnerOrder(comment, {
      order: '/approve-judge-change',
      minCodeLength: 7,
      productOwners: owners,
    });
    return order.ok && work.target.head.toLowerCase().startsWith(order.code.toLowerCase());
  });
  if (valid) return undefined;

  const wanted = `/approve-judge-change ${work.target.head.slice(0, 7)}`;
  return `El PR cambia archivos del juez; hace falta un comentario ${wanted} del dueño para esta versión.`;
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
  const piece = pieceOfBranch(recipe, info.headRef, target.pr);
  if ('none' in piece) {
    return {
      pr: target.pr,
      verdict: 'rejected',
      stages: [],
      note: `Sin pieza: la rama "${info.headRef}" no nombra ninguna pieza.`,
    };
  }
  const pieceId = piece.piece;
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
        note: `Tipo declarado inválido: ${declared.rejected}`,
      };
    }
    declaredKind = declared.kind;
  } catch (error) {
    return { pr: target.pr, piece: pieceId, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  try {
    await work.fetchObjects([target.head]);
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

  const note = await judgeFilesNote(stageWork, work.judgePath, work.alsoProtect);
  let verdict = verdictOf(stages);
  if (note !== undefined) verdict = worse(verdict, 'rejected');

  return {
    pr: target.pr,
    piece: pieceId,
    verdict,
    stages: stages.map((stage) => ({
      id: stage.id,
      outcome: stage.outcome,
      ...(stage.reason === undefined ? {} : { reason: stage.reason }),
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

  if (!FULL_SHA.test(input.actionRef)) {
    await publish(initialSha(input), targetContext, 'error', 'el juez no está fijado por SHA');
    return finish();
  }

  const targets = await resolveTargets(input, github, principal);
  if (targets.ok === 'empty') {
    notes.push(targets.note);
    return finish();
  }
  if (targets.ok === 'technical') {
    await publish(targets.sha, targetContext, 'error', targets.reason);
    return finish();
  }

  // §3.1 commit confiable: the live head of main, read once, checked out and read from.
  let trusted = await github.branchHead(principal);
  await deps.fetchObjects([trusted]);
  await checkout(input.root, trusted);

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
    return finish();
  }
  let recipe = read.recipe;

  // §3.1 rama destino: the event's base and the live one must both be the principal.
  const infos = new Map<number, PrInfo>();
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
      notes.push(`la rama destino del PR #${target.pr} es "${pr.baseRef}", no la principal: nada se publica`);
      return finish();
    }
    infos.set(target.pr, { headRef: pr.headRef, baseRef: pr.baseRef });
  }

  // §3.1: in a group, the trusted commit must be an ancestor of the group SHA.
  const isGroup = input.eventName === 'merge_group';
  if (isGroup) {
    let ancestor: boolean;
    try {
      ancestor = await gitIsAncestor(input.root, trusted, targets.sha);
    } catch (error) {
      ancestor = false;
      void error;
    }
    if (!ancestor) {
      await publish(targets.sha, targetContext, 'error', 'la rama principal no es ancestro del grupo');
      return finish();
    }
  }

  const judgeAll = async (currentRecipe: Recipe, currentTrusted: string): Promise<JudgedPr[]> => {
    const judged: JudgedPr[] = [];
    for (const target of targets.targets) {
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
    for (const target of targets.targets) {
      let live;
      try {
        live = await github.pullRequest(target.pr);
      } catch (error) {
        notes.push(`no se pudo releer el PR #${target.pr}: ${reasonOf(error)}`);
        return finish();
      }
      if (live.headSha !== target.head) {
        notes.push(`la cabeza del PR #${target.pr} cambió antes de publicar (${live.headSha}); no se publica veredicto`);
        moved = true;
      }
      if (live.baseRef !== principal) {
        notes.push(`la rama destino del PR #${target.pr} pasó a ser "${live.baseRef}"; no se publica`);
        moved = true;
      }
    }
    if (moved) return finish();

    const nowMain = await github.branchHead(principal);
    if (nowMain !== trusted) {
      if (attempt >= 1) {
        await publish(targets.sha, targetContext, 'error', 'la rama principal cambió mientras se juzgaba');
        return finish();
      }
      trusted = nowMain;
      await deps.fetchObjects([trusted]);
      await checkout(input.root, trusted);
      read = await readRecipeAt(trusted);
      if (!read.ok) {
        await publish(targets.sha, targetContext, 'error', `La receta de la rama principal no se pudo leer: ${read.reason}`);
        return finish();
      }
      recipe = read.recipe;
      pieces = await judgeAll(recipe, trusted);
      continue;
    }

    const statuses = await github.statuses(targets.sha);
    const ours = statuses.find((status) => status.context === targetContext);
    if (ours !== undefined && !belongsToThisRun(ours.targetUrl, input)) {
      notes.push(`otra corrida del juez publicó después ${ours.targetUrl ?? ''}; esta no publica`);
      return finish();
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

  // §3.7 rastro de estados imitados, después de publicar: lo propio ya es oficial.
  const unofficial = await collectUnofficial(github, targets.sha, input.repository, judgePath);
  if (unofficial.length > 0) {
    const body = [
      isSpanish(recipe.locale)
        ? 'Estados con el nombre del juez que no salieron de su corrida oficial:'
        : 'Statuses named like the judge that did not come from its official run:',
      ...unofficial.map((entry) => `- ${entry.context} [${entry.kind}]: ${entry.url ?? ''}`),
    ].join('\n');
    for (const target of targets.targets) {
      try {
        await github.upsertTraceComment(target.pr, body);
      } catch (error) {
        notes.push(`no se pudo escribir el rastro en el PR #${target.pr}: ${reasonOf(error)}`);
      }
    }
  }

  const summary: SummaryPiece[] = pieces.map((piece) => ({
    pr: piece.pr,
    ...(piece.piece === undefined ? {} : { piece: piece.piece }),
    verdict: piece.verdict,
    stages: piece.stages,
    ...(piece.note === undefined ? {} : { note: piece.note }),
  }));
  return finish(pieces, unofficial, buildSummary(summary, unofficial, recipe.locale));
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

/** Whether a status's link is one of this run (with or without a job), so nobody replaced it. */
function belongsToThisRun(targetUrl: string | null, input: JudgeInput): boolean {
  if (targetUrl === null) return false;
  const base = `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}`;
  return targetUrl === base || targetUrl.startsWith(`${base}/job/`);
}

/** Moves the checkout to the trusted commit only when it is somewhere else. */
async function checkout(root: string, sha: string): Promise<void> {
  const at = await gitHead(root);
  if (at !== sha) await gitCheckoutDetach(root, sha);
}
