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
  waitForMergeQueue,
  type Unofficial,
} from './checks.js';
import { engineVersionFilesIn, isEngineProtectedPath, touchedEngineVersionFiles } from './own-files.js';
import { pieceOfBranch, readDeclaredKind } from './pieces.js';
import type { CommitStatus, JudgeGitHub, JudgePullRequest } from './port.js';
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
  /**
   * PLAN-13-R6 §1.2: the working branches the action declares (`branches` input). Absent or empty
   * means only the principal; it is compared with the `branches.into` of the principal's recipe.
   */
  readonly branches?: readonly string[];
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
  /** Waits between re-reads of a queue that has not listed the group yet. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Waits for real, unless the caller injects its own pause (the tests pass one that returns at once). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** Adds one note at most once: an identical note is never repeated in the report (§3.4). */
function addNote(notes: string[], text: string): void {
  if (!notes.includes(text)) notes[notes.length] = text;
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** The text of the recipe's language. Before a recipe is read, everything stays in Spanish. */
function pick(spanish: boolean, es: string, en: string): string {
  return spanish ? es : en;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** PLAN-13-R5 §2.6: the mark a builder or verdict event carries in a comment on the piece issue. */
const EVENT_MARK = 'ai-workflows:event';

/** PLAN-13-R5 §2.6: the path of the minimal workflow that signals a review of a pull request. */
const REVIEW_SIGNAL_PATH = '.github/workflows/ai-workflows-review-signal.yml';

/** PLAN-13-R6 §1.2: what the judge says when the action input and the recipe disagree. */
const MISMATCH = 'el workflow del juez y la receta no declaran las mismas ramas';

/** Whether two branch lists name the same branches, order and repeats aside (PLAN-13-R6 §1.2). */
function sameBranches(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------------------------------------
// Targets of §3.2

interface Target {
  readonly pr: number;
  /** The head this pull request is judged at. */
  readonly head: string;
  readonly headRef: string;
  /** The branch this pull request is understood to enter; its live tip is the trusted base. */
  readonly baseRef: string;
  readonly headRepo: string;
}

/** A pull request the event may put in front of the judge, before its live branch is read. */
interface Candidate {
  readonly pr: number;
  readonly head: string;
}

type Targets =
  | {
      readonly ok: true;
      readonly sha: string;
      readonly candidates: readonly Candidate[];
      /** The pull request the event is about, if any: `closed` and `edited` need to drop it. */
      readonly eventPr?: number;
      /** The destination the event payload names, so a retarget out of `into` is seen at once. */
      readonly eventBase?: string;
    }
  | { readonly ok: 'empty'; readonly note: string }
  | { readonly ok: 'technical'; readonly sha: string; readonly reason: string }
  /**
   * PLAN-13-R5 §2.6: a comment on an issue that is not a pull request. Nothing is looked up yet:
   * which pull requests belong to the piece can only be known after the recipe of the base is read,
   * so the judge carries just the piece (the issue number, R19) and resolves the rest later.
   */
  | { readonly ok: 'issue'; readonly piece: number };

/** The candidates named by the event, with the event's own pull request first when there is one. */
function candidatesWithHead(head: string, numbers: readonly number[]): Candidate[] {
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const pr of numbers) {
    if (seen.has(pr)) continue;
    seen.add(pr);
    candidates.push({ pr, head });
  }
  return candidates;
}

async function mergeGroupTargets(
  github: JudgeGitHub,
  principal: string,
  sha: string,
  sleep: (ms: number) => Promise<void>,
): Promise<Targets> {
  // §3.2: the queue may list the group a moment after the event names it; it is read again,
  // waiting, and only a list that never shows it is a failure. A read that throws is technical now.
  const read = await waitForMergeQueue(github, principal, sha, sleep);
  if (!read.ok) {
    return {
      ok: 'technical',
      sha,
      reason: read.readFailed ? read.reason : `el SHA ${sha} no aparece en la lista de la cola`,
    };
  }
  const queue = read.entries;
  const index = queue.findIndex((entry) => entry.headSha === sha);
  if (index < 0) {
    return { ok: 'technical', sha, reason: `el SHA ${sha} no aparece en la lista de la cola` };
  }
  const candidates: Candidate[] = [];
  for (const entry of queue.slice(0, index + 1)) {
    try {
      const pr = await github.pullRequest(entry.prNumber);
      candidates.push({ pr: entry.prNumber, head: pr.headSha });
    } catch (error) {
      return { ok: 'technical', sha, reason: reasonOf(error) };
    }
  }
  return { ok: true, sha, candidates };
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
  sleep: (ms: number) => Promise<void>,
): Promise<Targets> {
  const event = input.event;
  switch (input.eventName) {
    case 'pull_request_target': {
      const pull = field(event, 'pull_request');
      const number = num(pull, 'number');
      if (number === undefined) {
        return { ok: 'technical', sha: '', reason: 'el evento no nombra el pull request' };
      }
      const eventBase = text(field(pull, 'base'), 'ref');
      // The head is read live: the event may name a commit the branch already moved past, and the
      // re-read before publishing decides whether this run may still write a verdict. Every open
      // pull request with that head is put in front of the judge, so one verdict per SHA is the
      // worst of all of them (PLAN-13-R6 §1.2).
      try {
        const pr = await github.pullRequest(number);
        const open = await github.openPullRequestsWithHead(pr.headSha);
        const candidates = candidatesWithHead(pr.headSha, [number, ...open]);
        return {
          ok: true,
          sha: pr.headSha,
          candidates,
          eventPr: number,
          ...(eventBase === undefined ? {} : { eventBase }),
        };
      } catch (error) {
        return { ok: 'technical', sha: '', reason: reasonOf(error) };
      }
    }
    case 'issue_comment': {
      const issue = field(event, 'issue');
      if (field(issue, 'pull_request') !== undefined) {
        const number = num(issue, 'number');
        if (number === undefined) {
          return { ok: 'technical', sha: '', reason: 'el comentario no nombra el pull request' };
        }
        try {
          const pr = await github.pullRequest(number);
          const open = await github.openPullRequestsWithHead(pr.headSha);
          return {
            ok: true,
            sha: pr.headSha,
            candidates: candidatesWithHead(pr.headSha, [number, ...open]),
          };
        } catch (error) {
          return { ok: 'technical', sha: '', reason: reasonOf(error) };
        }
      }
      // PLAN-13-R5 §2.6: a comment on an issue that is not a pull request. The piece is the issue
      // number (R19), but the pull requests of the piece are only known once the base recipe is
      // read, so nothing is looked up here. A new comment only wakes the judge when it carries the
      // event mark; editing or deleting any comment always does, because that may have removed the
      // mark (or the verdict) that was there.
      const issueNumber = num(issue, 'number');
      if (issueNumber === undefined) {
        return { ok: 'empty', note: 'el comentario no nombra el issue' };
      }
      const action = text(event, 'action');
      const body = text(field(event, 'comment'), 'body') ?? '';
      if (action === 'created' && !body.includes(EVENT_MARK)) {
        return {
          ok: 'empty',
          note: 'el comentario nuevo del issue no lleva la marca ai-workflows:event',
        };
      }
      return { ok: 'issue', piece: issueNumber };
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
        const open = await github.openPullRequestsWithHead(pr.headSha);
        return {
          ok: true,
          sha: pr.headSha,
          candidates: candidatesWithHead(pr.headSha, [number, ...open]),
        };
      } catch (error) {
        return { ok: 'technical', sha: '', reason: reasonOf(error) };
      }
    }
    case 'workflow_run': {
      const run = field(event, 'workflow_run');
      const triggered = text(run, 'event');
      if (triggered === 'pull_request_review') {
        // PLAN-13-R5 §2.6: the signal only says that a review of some pull request moved; it is
        // never trusted. Its own repository, workflow path and event must match, and the pull
        // request number it carries is treated as a hint: the pull request is re-read and judged
        // on its live head. `head_sha` is the merge commit of the event, never the head to judge.
        const repo = text(field(run, 'repository'), 'full_name');
        const rawPath = text(run, 'path');
        // GitHub may report the path with a ref suffix; only the path is compared.
        const path = rawPath === undefined ? undefined : rawPath.split('@')[0];
        if (repo !== input.repository || path !== REVIEW_SIGNAL_PATH) {
          return {
            ok: 'empty',
            note: 'la señal de revisión no es de este repositorio o de este workflow',
          };
        }
        const pulls = field(run, 'pull_requests');
        const first = Array.isArray(pulls) ? pulls[0] : undefined;
        const number = num(first, 'number');
        if (number === undefined) {
          // A pull request from a fork leaves the list empty: nothing to judge, with the note.
          return { ok: 'empty', note: 'la señal de revisión no trae número de pull request' };
        }
        try {
          const pr = await github.pullRequest(number);
          const open = await github.openPullRequestsWithHead(pr.headSha);
          return {
            ok: true,
            sha: pr.headSha,
            candidates: candidatesWithHead(pr.headSha, [number, ...open]),
            eventPr: number,
          };
        } catch (error) {
          return { ok: 'technical', sha: '', reason: reasonOf(error) };
        }
      }
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
          return { ok: true, sha: head, candidates: candidatesWithHead(head, prs) };
        } catch (error) {
          return { ok: 'technical', sha: head, reason: reasonOf(error) };
        }
      }
      if (triggered === 'merge_group') {
        return mergeGroupTargets(github, principal, head, sleep);
      }
      return { ok: 'empty', note: `workflow_run de un evento no juzgado (${triggered ?? 'desconocido'})` };
    }
    case 'merge_group': {
      const head = text(field(event, 'merge_group'), 'head_sha');
      if (head === undefined) {
        return { ok: 'technical', sha: '', reason: 'merge_group sin head_sha' };
      }
      return mergeGroupTargets(github, principal, head, sleep);
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
  /** The run's notes: a stage may add a trace here (a check that replaced an earlier one). */
  readonly notes: string[];
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

/**
 * PLAN-13-R6 §1.2: across pull requests of one SHA the order is `failure > error > pending >
 * success`, unlike the order within one pull request, where a technical stage wins over a rejected
 * one. The description shown is the one of the worst pull request.
 */
const PIECE_RANK: Readonly<Record<JudgeVerdict, number>> = {
  passed: 0,
  waiting: 1,
  technical: 2,
  rejected: 3,
};

function worstPiece(a: JudgeVerdict, b: JudgeVerdict): JudgeVerdict {
  return PIECE_RANK[b] > PIECE_RANK[a] ? b : a;
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
    stage: stage.id,
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
      if (result.note !== undefined) addNote(work.notes, result.note);
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
            `el bloque «${uses ?? stage.id}» no tiene comprobación del servidor`,
            `the block "${uses ?? stage.id}" has no server check`,
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
  // §2.1: the engine's own list, the run's workflow and `also-protect` are all compared without
  // case, because a case-insensitive file system would let `.Claude/settings.json` overwrite the
  // real file. The workflow path is not in the list: it changes from project to project.
  const lower = file.toLowerCase();
  return (
    isEngineProtectedPath(file) ||
    lower === judgePath.toLowerCase() ||
    alsoProtect.some((entry) => entry.toLowerCase() === lower)
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
  const protectedTouched = work.facts.files.filter((file) =>
    isProtectedFile(file, judgePath, alsoProtect),
  );

  // §2.2: the engine version, compared against the merge base. It only runs when the pull request
  // touches one of those files; the others pay nothing. A git failure is technical, and anything
  // else — a file that cannot be read as its format, or that appears or disappears — is touched.
  let versionTouched: readonly string[] = [];
  if (engineVersionFilesIn(work.facts.files).length > 0) {
    try {
      versionTouched = await touchedEngineVersionFiles(
        work.root,
        work.facts.mergeBase,
        work.target.head,
        work.facts.files,
      );
    } catch (error) {
      return {
        error: pick(
          spanish,
          `No se pudo leer la versión del motor: ${reasonOf(error)}`,
          `The engine version could not be read: ${reasonOf(error)}`,
        ),
      };
    }
  }

  const touched = [...new Set([...protectedTouched, ...versionTouched])];
  if (touched.length === 0) return {};

  // §2.3: what was touched goes to the run log, never to the published description, which keeps
  // today's text (the limit of 140 characters preserves the order).
  addNote(
    work.notes,
    pick(
      spanish,
      `Archivos propios del motor tocados: ${touched.join(', ')}.`,
      `The engine's own files touched: ${touched.join(', ')}.`,
    ),
  );

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
      minCodeLength: 16,
      productOwners: owners,
      locale: work.recipe.locale,
    });
    return order.ok && work.target.head.toLowerCase().startsWith(order.code.toLowerCase());
  });
  if (valid) return {};

  const wanted = `/approve-judge-change ${work.target.head.slice(0, 16)}`;
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
// A promotion: a pass from one branch of `into` to another (PLAN-13-R6 §1.3)

/**
 * PLAN-13-R6 §1.3: a promotion (`staging` → `main`) is not a piece, and its stages were already
 * judged when the changes entered `from`. Only the judge's own files are judged here: touching
 * them without the owner's attestation for this head is a rejection, the same message as a piece.
 */
async function judgePromotion(
  recipe: Recipe,
  trusted: string,
  target: Target,
  work: Omit<StageWork, 'target' | 'piece' | 'facts' | 'trusted'>,
): Promise<JudgedPr> {
  try {
    // §3.1: the head's objects come before anything is read from it.
    await work.fetchObjects([target.head]);
  } catch (error) {
    return { pr: target.pr, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  let facts: ChangeFacts;
  try {
    facts = await describeChangeFromCommits({
      root: work.root,
      base: trusted,
      head: target.head,
      recipe,
      piece: String(target.pr),
    });
  } catch (error) {
    return { pr: target.pr, verdict: 'technical', stages: [], note: reasonOf(error) };
  }

  const stageWork: StageWork = { ...work, trusted, target, piece: String(target.pr), facts };
  const filesCheck = await judgeFilesNote(stageWork, work.judgePath, work.alsoProtect);
  let verdict: JudgeVerdict = 'passed';
  if (filesCheck.error !== undefined) verdict = 'technical';
  else if (filesCheck.note !== undefined) verdict = 'rejected';
  const note = filesCheck.error ?? filesCheck.note;
  return { pr: target.pr, verdict, stages: [], ...(note === undefined ? {} : { note }) };
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
  const verdict = pieces.reduce<JudgeVerdict>((acc, p) => worstPiece(acc, p.verdict), 'passed');
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
  const sleep = deps.sleep ?? realSleep;
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
    addNote(notes, `procedencia no comprobada: ${input.workflowRef}`);
    return finish();
  }

  const principal = await github.defaultBranch();
  const expectedRef =
    input.eventName === 'merge_group'
      ? ref.startsWith(`refs/heads/gh-readonly-queue/${principal}/`)
      : ref === `refs/heads/${principal}`;
  if (!expectedRef) {
    addNote(notes, `procedencia no comprobada: ${ref}`);
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

  const targets = await resolveTargets(input, github, principal, sleep);
  const judgedSha = targets.ok === 'empty' || targets.ok === 'issue' ? '' : targets.sha;
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
    for (const note of collected.notes) addNote(notes, note);
    if (collected.unofficial.length > 0) {
      const body = traceComment(collected.unofficial, locale);
      for (const target of targetList) {
        try {
          await github.upsertTraceComment(target.pr, body);
        } catch (error) {
          addNote(notes,
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

  /** The recipe at one branch tip, or why it could not be read (PLAN-13-R6 §1.2). */
  const readRecipeAt = async (
    sha: string,
    branch = 'la rama principal',
  ): Promise<{ ok: true; recipe: Recipe } | { ok: false; reason: string }> => {
    let content: string | undefined;
    try {
      content = await gitProjectFiles(input.root, sha).read('.ai-workflows/pipeline.yml');
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
    if (content === undefined) {
      return { ok: false, reason: `no existe .ai-workflows/pipeline.yml en ${branch}` };
    }
    const checked = await checkRecipe(content, '.ai-workflows/pipeline.yml', { root: input.root });
    if (!checked.ok) {
      const first = checked.errors[0];
      return { ok: false, reason: first === undefined ? 'la receta no es válida' : `${first.line}:${first.column} ${first.message}` };
    }
    return { ok: true, recipe: checked.recipe };
  };

  /**
   * PLAN-13-R5 §2.6: a builder or verdict event arrived as a comment on the piece's issue. The
   * recipe of the base names the pieces, so only here can the issue number be matched against the
   * branches: every open pull request into a working branch whose branch names that piece is judged
   * on its own live head and with the recipe of its own target branch. The failure of one never
   * touches the others.
   */
  const judgeIssuePiece = async (issueNumber: number): Promise<JudgeReport> => {
    const trusted = await github.branchHead(principal);
    await deps.fetchObjects([trusted]);
    await checkout(input.root, trusted);
    const base = await readRecipeAt(trusted, 'la rama principal');
    if (!base.ok) {
      throw new Error(`La receta de la rama principal no se pudo leer: ${base.reason}`);
    }
    const baseRecipe = base.recipe;
    const into = baseRecipe.branches?.into ?? [principal];
    const spanish = isSpanish(baseRecipe.locale);
    if (baseRecipe.pieces === undefined) {
      addNote(notes, pick(
        spanish,
        `La receta no declara piezas: el issue ${String(issueNumber)} no nombra ninguna`,
        `The recipe declares no pieces: issue ${String(issueNumber)} names none`,
      ));
      return finish();
    }
    const open = await github.openPullRequests();
    const matching = open.filter((pr) => {
      if (!into.includes(pr.baseRef)) return false;
      const piece = pieceOfBranch(baseRecipe, pr.headRef, pr.number);
      return 'piece' in piece && piece.piece === String(issueNumber);
    });
    if (matching.length === 0) {
      addNote(notes, pick(
        spanish,
        `La pieza ${String(issueNumber)} no tiene pull requests abiertos hacia una rama de trabajo`,
        `Piece ${String(issueNumber)} has no open pull requests into a working branch`,
      ));
      return finish();
    }

    // A publish that fails is said and never stops the other pull requests, but a run that could
    // not write a status ends as failed: the CLI exits 1 and the log keeps the motive.
    const failures: string[] = [];
    const safePublish = async (
      sha: string,
      state: string,
      description: string,
      locale: string,
    ): Promise<boolean> => {
      try {
        await publish(sha, targetContext, state, description);
        return true;
      } catch (error) {
        const reason = pick(
          isSpanish(locale),
          `No se pudo publicar el estado sobre ${sha}: ${reasonOf(error)}`,
          `The status could not be published on ${sha}: ${reasonOf(error)}`,
        );
        addNote(notes, reason);
        failures.push(reason);
        return false;
      }
    };

    const judgedAll: JudgedPr[] = [];
    const unofficialAll: Unofficial[] = [];
    for (const candidate of matching) {
      let live: JudgePullRequest;
      try {
        live = await github.pullRequest(candidate.number);
      } catch (error) {
        await safePublish(candidate.headSha, 'error', reasonOf(error), baseRecipe.locale);
        continue;
      }
      if (!into.includes(live.baseRef)) {
        addNote(notes, pick(
          isSpanish(baseRecipe.locale),
          `la rama destino del PR #${String(candidate.number)} es "${live.baseRef}", fuera de las ramas de trabajo: no se juzga`,
          `the target branch of pull request #${String(candidate.number)} is "${live.baseRef}", outside the working branches: nothing is judged`,
        ));
        continue;
      }

      // The trusted base of this pull request is the live tip of its own target branch, and the
      // recipe that decides its stages comes from there (PLAN-13-R6 §1.2).
      let currentTrusted = trusted;
      let currentRecipe = baseRecipe;
      const branchLabel = live.baseRef === principal ? 'la rama principal' : `la rama "${live.baseRef}"`;
      if (live.baseRef !== principal) {
        try {
          currentTrusted = await github.branchHead(live.baseRef);
          await deps.fetchObjects([currentTrusted]);
          await checkout(input.root, currentTrusted);
        } catch (error) {
          await safePublish(live.headSha, 'error', reasonOf(error), baseRecipe.locale);
          continue;
        }
        const branchRead = await readRecipeAt(currentTrusted, branchLabel);
        if (!branchRead.ok) {
          await safePublish(
            live.headSha,
            'error',
            `La receta de ${branchLabel} no se pudo leer: ${branchRead.reason}`,
            baseRecipe.locale,
          );
          continue;
        }
        currentRecipe = branchRead.recipe;
      }

      const promotion =
        (baseRecipe.branches?.promotions ?? []).some(
          (pair) => pair.from === live.headRef && pair.to === live.baseRef,
        ) && live.headRepo === input.repository;
      const target: Target = {
        pr: live.number,
        head: live.headSha,
        headRef: live.headRef,
        baseRef: live.baseRef,
        headRepo: live.headRepo,
      };
      const judgeLive = (recipe: Recipe, at: string): Promise<JudgedPr> =>
        promotion
          ? judgePromotion(recipe, at, target, {
              recipe,
              judgedSha: live.headSha,
              root: input.root,
              github,
              fetchObjects: deps.fetchObjects,
              judgePath,
              alsoProtect: input.alsoProtect,
              notes,
            })
          : judgeOne(
              recipe,
              at,
              target,
              { headRef: live.headRef, baseRef: live.baseRef },
              {
                recipe,
                judgedSha: live.headSha,
                root: input.root,
                github,
                fetchObjects: deps.fetchObjects,
                judgePath,
                alsoProtect: input.alsoProtect,
                notes,
              },
            );

      let judged: JudgedPr;
      try {
        judged = await judgeLive(currentRecipe, currentTrusted);
      } catch (error) {
        // An exception inside the engine is technical for this pull request only (SV-03c).
        await safePublish(live.headSha, 'error', reasonOf(error), currentRecipe.locale);
        continue;
      }

      let done = false;
      for (let attempt = 0; !done; attempt += 1) {
        // (a) the head and destination, one last time before writing.
        let before: JudgePullRequest;
        try {
          before = await github.pullRequest(candidate.number);
        } catch (error) {
          const reason = pick(
            isSpanish(currentRecipe.locale),
            `no se pudo releer el PR #${String(candidate.number)} antes de publicar: ${reasonOf(error)}`,
            `pull request #${String(candidate.number)} could not be re-read before publishing: ${reasonOf(error)}`,
          );
          addNote(notes, reason);
          failures.push(reason);
          break;
        }
        if (before.headSha !== live.headSha || !into.includes(before.baseRef)) {
          addNote(notes, pick(
            isSpanish(currentRecipe.locale),
            `la cabeza o la rama destino del PR #${String(candidate.number)} cambió antes de publicar; no se publica veredicto`,
            `the head or the target branch of pull request #${String(candidate.number)} moved before publishing; no verdict is published`,
          ));
          break;
        }

        // (b) a target branch that moved while judging is judged again from the new tip, once.
        const nowBase = await github.branchHead(live.baseRef);
        if (nowBase !== currentTrusted) {
          if (attempt >= 1) {
            await safePublish(live.headSha, 'error', pick(
              isSpanish(currentRecipe.locale),
              live.baseRef === principal ? 'la rama principal cambió mientras se juzgaba' : `la rama ${live.baseRef} cambió mientras se juzgaba`,
              live.baseRef === principal ? 'the main branch changed while the run was judging' : `the branch ${live.baseRef} changed while the run was judging`,
            ), currentRecipe.locale);
            break;
          }
          currentTrusted = nowBase;
          await deps.fetchObjects([currentTrusted]);
          await checkout(input.root, currentTrusted);
          const read = await readRecipeAt(currentTrusted, branchLabel);
          if (!read.ok) {
            throw new Error(pick(
              isSpanish(currentRecipe.locale),
              `La receta de ${branchLabel} no se pudo leer: ${read.reason}`,
              `The recipe of ${branchLabel} could not be read: ${read.reason}`,
            ));
          }
          currentRecipe = read.recipe;
          try {
            judged = await judgeLive(currentRecipe, currentTrusted);
          } catch (error) {
            await safePublish(live.headSha, 'error', reasonOf(error), currentRecipe.locale);
            break;
          }
          continue;
        }

        // (c) abstain only when the newest state of this context is an official run that started
        // after this one. An older one, or a foreign state, never silences the verdict.
        let statuses: readonly CommitStatus[] = [];
        try {
          statuses = await github.statuses(live.headSha);
        } catch (error) {
          addNote(notes, pick(
            isSpanish(currentRecipe.locale),
            `no se pudieron leer los estados de ${live.headSha}: ${reasonOf(error)}`,
            `the statuses of ${live.headSha} could not be read: ${reasonOf(error)}`,
          ));
          failures.push(reasonOf(error));
          await safePublish(live.headSha, 'error', reasonOf(error), currentRecipe.locale);
          break;
        }
        const newest = statuses.find((status) => status.context === targetContext);
        if (newest !== undefined) {
          let official: number | undefined;
          try {
            official = await officialRunId(github, newest, input.repository, judgePath, principal, input.serverUrl);
          } catch (error) {
            addNote(notes, pick(
              isSpanish(currentRecipe.locale),
              `no se pudo comprobar el estado más reciente de ${targetContext}: ${reasonOf(error)}`,
              `the newest status of ${targetContext} could not be checked: ${reasonOf(error)}`,
            ));
            official = undefined;
          }
          if (official !== undefined && official > input.runId) {
            addNote(notes, pick(
              isSpanish(currentRecipe.locale),
              `otra corrida oficial del juez publicó después (${official}); esta no publica`,
              `another official judge run published later (${official}); this one stays quiet`,
            ));
            break;
          }
        }

        const written = await safePublish(
          live.headSha,
          stateOf(judged.verdict),
          describeVerdict([judged], currentRecipe.locale),
          currentRecipe.locale,
        );
        if (!written) break;
        done = true;
      }
      if (!done) continue;

      const collected = await collectUnofficial(
        github,
        live.headSha,
        input.repository,
        judgePath,
        principal,
        input.serverUrl,
        traceContexts,
        currentRecipe.locale,
      );
      for (const note of collected.notes) addNote(notes, note);
      for (const entry of collected.unofficial) unofficialAll.push(entry);
      if (collected.unofficial.length > 0) {
        try {
          await github.upsertTraceComment(candidate.number, traceComment(collected.unofficial, currentRecipe.locale));
        } catch (error) {
          addNote(notes, pick(
            isSpanish(currentRecipe.locale),
            `No se pudo escribir el rastro en el PR #${String(candidate.number)}: ${reasonOf(error)}`,
            `The trace could not be written on pull request #${String(candidate.number)}: ${reasonOf(error)}`,
          ));
        }
      }
      judgedAll.push(judged);
    }

    const summaryPieces: SummaryPiece[] = judgedAll.map((piece) => ({
      pr: piece.pr,
      ...(piece.piece === undefined ? {} : { piece: piece.piece }),
      verdict: piece.verdict,
      stages: piece.stages,
      ...(piece.note === undefined ? {} : { note: piece.note }),
    }));
    const summary = buildSummary(summaryPieces, unofficialAll, baseRecipe.locale, notes);
    // The other pull requests were judged and each published its own status; but a run that could
    // not write a verdict or read a head's status is failed, and it says so instead of pretending.
    if (failures.length > 0) throw new Error(failures.join('; '));
    return finish(judgedAll, unofficialAll, summary);
  };

  if (targets.ok === 'empty') {
    addNote(notes, targets.note);
    return finish();
  }
  if (targets.ok === 'technical') {
    await publish(targets.sha, targetContext, 'error', targets.reason);
    return conclude([], 'es');
  }
  if (targets.ok === 'issue') {
    return judgeIssuePiece(targets.piece);
  }

  // The action already declares the working branches it was installed with; the recipe of the
  // principal is compared with them below. Filtering first means a pull request into any other
  // branch gets nothing even when the recipe cannot be read (PLAN-13-R6 §1.2, SV-DESTINO).
  const wanted = input.branches !== undefined && input.branches.length > 0 ? input.branches : [principal];
  const runEvent =
    input.eventName === 'workflow_run'
      ? text(field(input.event, 'workflow_run'), 'event') ?? ''
      : input.eventName;
  const isGroup = runEvent === 'merge_group';

  // Every candidate is re-read live: the head that sits in the event payload may already be gone,
  // and the destination decides whether it counts at all (PLAN-13-R6 §1.2). A pull request into a
  // branch outside the input gets no status; one that is no longer open (a `closed` event) stops
  // counting, so the others with its head are the ones judged.
  const seenPrs = new Set<number>();
  for (const candidate of targets.candidates) {
    if (seenPrs.has(candidate.pr)) continue;
    seenPrs.add(candidate.pr);
    let pr;
    try {
      pr = await github.pullRequest(candidate.pr);
    } catch (error) {
      await publish(targets.sha, targetContext, 'error', reasonOf(error));
      return conclude([], 'es');
    }
    if (pr.state !== 'open') continue;
    if (!wanted.includes(pr.baseRef)) {
      addNote(notes,
        pick(
          isSpanish('es'),
          `la rama destino del PR #${candidate.pr} es "${pr.baseRef}", fuera de las ramas de trabajo: no se juzga`,
          `the target branch of pull request #${candidate.pr} is "${pr.baseRef}", outside the working branches: nothing is judged`,
        ),
      );
      continue;
    }
    if (isGroup && pr.baseRef !== principal) continue;
    if (
      candidate.pr === targets.eventPr
      && targets.eventBase !== undefined
      && !wanted.includes(targets.eventBase)
    ) {
      continue;
    }
    infos.set(pr.number, { headRef: pr.headRef, baseRef: pr.baseRef });
    targetList.push({
      pr: pr.number,
      head: candidate.head,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      headRepo: pr.headRepo,
    });
  }
  if (targetList.length === 0) return finish();

  // The recipe of the principal names the working branches (`into`) and the promotions, always:
  // never the recipe of a target branch, or a branch could declare itself judged (PLAN-13-R6 §1.2).
  let trusted = await github.branchHead(principal);
  try {
    await deps.fetchObjects([trusted]);
  } catch (error) {
    await publish(targets.sha, targetContext, 'error', reasonOf(error));
    return conclude([], 'es');
  }
  await checkout(input.root, trusted);
  const read = await readRecipeAt(trusted, 'la rama principal');
  if (!read.ok) {
    await publish(targets.sha, targetContext, 'error', `La receta de la rama principal no se pudo leer: ${read.reason}`);
    return conclude([], 'es');
  }
  const principalRecipe = read.recipe;
  const into = principalRecipe.branches?.into ?? [principal];
  if (!sameBranches(wanted, into)) {
    await publish(targets.sha, targetContext, 'error', MISMATCH);
    return conclude([], principalRecipe.locale);
  }

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

  // §3.1 and §3.8(b): a group's trusted commit must be an ancestor of the group, and again every
  // time it moves while the run is judging.
  const groupAncestorProblem = async (current: string): Promise<string | undefined> => {
    let ancestor: boolean;
    try {
      ancestor = await gitIsAncestor(input.root, current, targets.sha);
    } catch (error) {
      return reasonOf(error);
    }
    return ancestor
      ? undefined
      : pick(isSpanish(principalRecipe.locale), 'la rama principal no es ancestro del grupo', 'the main branch is not an ancestor of the group');
  };
  if (isGroup) {
    const problem = await groupAncestorProblem(trusted);
    if (problem !== undefined) {
      await publish(targets.sha, targetContext, 'error', problem);
      return conclude([], principalRecipe.locale);
    }
  }

  interface Work {
    readonly target: Target;
    readonly promotion: boolean;
    trusted: string;
    recipe: Recipe;
    error?: string;
    piece?: JudgedPr;
  }

  /** The trusted tip and recipe of every target, read from its own target branch (PLAN-13-R6 §1.2). */
  const buildWorks = async (): Promise<Work[]> => {
    const works: Work[] = [];
    for (const target of targetList) {
      const promotion =
        (principalRecipe.branches?.promotions ?? []).some(
          (pair) => pair.from === target.headRef && pair.to === target.baseRef,
        ) && target.headRepo === input.repository;
      if (target.baseRef === principal) {
        works.push({ target, promotion, trusted, recipe: principalRecipe });
        continue;
      }
      let tip: string;
      try {
        tip = await github.branchHead(target.baseRef);
      } catch (error) {
        works.push({ target, promotion, trusted: '', recipe: principalRecipe, error: reasonOf(error) });
        continue;
      }
      try {
        await deps.fetchObjects([tip]);
        await checkout(input.root, tip);
      } catch (error) {
        works.push({ target, promotion, trusted: tip, recipe: principalRecipe, error: reasonOf(error) });
        continue;
      }
      const branchRead = await readRecipeAt(tip, `la rama "${target.baseRef}"`);
      if (!branchRead.ok) {
        works.push({
          target,
          promotion,
          trusted: tip,
          recipe: principalRecipe,
          error: `La receta de la rama "${target.baseRef}" no se pudo leer: ${branchRead.reason}`,
        });
        continue;
      }
      works.push({ target, promotion, trusted: tip, recipe: branchRead.recipe });
    }
    return works;
  };

  let worksRef: Work[] = [];
  const judgedShaFor = (): JudgedPr[] => worksRef.map((work) => work.piece as JudgedPr);
  const judgeWork = async (work: Work): Promise<JudgedPr> => {
    if (work.error !== undefined) {
      return { pr: work.target.pr, verdict: 'technical', stages: [], note: work.error };
    }
    const info = infos.get(work.target.pr) ?? { headRef: work.target.headRef, baseRef: work.target.baseRef };
    const workLike = {
      recipe: work.recipe,
      judgedSha: targets.sha,
      root: input.root,
      github,
      fetchObjects: deps.fetchObjects,
      judgePath,
      alsoProtect: input.alsoProtect,
      notes,
    };
    return work.promotion
      ? judgePromotion(work.recipe, work.trusted, work.target, workLike)
      : judgeOne(work.recipe, work.trusted, work.target, info, workLike);
  };

  worksRef = await buildWorks();
  for (const work of worksRef) work.piece = await judgeWork(work);

  // §3.8 corridas que se cruzan: (a) head and destination, (b) the tip of every target branch,
  // (c) another official run.
  for (let attempt = 0; ; attempt += 1) {
    let moved = false;
    for (const work of worksRef) {
      const target = work.target;
      let live;
      try {
        live = await github.pullRequest(target.pr);
      } catch (error) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `no se pudo releer el PR #${target.pr}: ${reasonOf(error)}`,
            `pull request #${target.pr} could not be re-read: ${reasonOf(error)}`,
          ),
        );
        return conclude(judgedShaFor(), principalRecipe.locale);
      }
      if (live.headSha !== target.head) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `la cabeza del PR #${target.pr} cambió antes de publicar (${live.headSha}); no se publica veredicto`,
            `the head of pull request #${target.pr} moved before publishing (${live.headSha}); no verdict is published`,
          ),
        );
        moved = true;
      }
      if (!into.includes(live.baseRef)) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `la rama destino del PR #${target.pr} pasó a ser "${live.baseRef}"; no se publica`,
            `the target branch of pull request #${target.pr} became "${live.baseRef}"; nothing is published`,
          ),
        );
        moved = true;
      }
    }
    if (moved) return conclude(judgedShaFor(), principalRecipe.locale);

    // The tip of every target branch is read again before publishing: a verdict computed with a
    // tip that already changed is never written. Changed once, the branch is judged again with the
    // new tip; changed twice, it is an error that names the branch (PLAN-13-R6 §1.2).
    let changedWork: Work | undefined;
    for (const work of worksRef) {
      if (work.error !== undefined) continue;
      let tip: string;
      try {
        tip = await github.branchHead(work.target.baseRef);
      } catch (error) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `no se pudo releer la rama ${work.target.baseRef}: ${reasonOf(error)}`,
            `the branch ${work.target.baseRef} could not be re-read: ${reasonOf(error)}`,
          ),
        );
        return conclude(judgedShaFor(), principalRecipe.locale);
      }
      if (tip !== work.trusted) {
        changedWork = work;
        work.trusted = tip;
        break;
      }
    }
    if (changedWork !== undefined) {
      const target = changedWork.target;
      const label = target.baseRef === principal ? 'la rama principal' : `la rama "${target.baseRef}"`;
      if (attempt >= 1) {
        await publish(
          targets.sha,
          targetContext,
          'error',
          pick(
            isSpanish(principalRecipe.locale),
            target.baseRef === principal ? 'la rama principal cambió mientras se juzgaba' : `la rama ${target.baseRef} cambió mientras se juzgaba`,
            target.baseRef === principal ? 'the main branch changed while the run was judging' : `the branch ${target.baseRef} changed while the run was judging`,
          ),
        );
        return conclude(judgedShaFor(), principalRecipe.locale);
      }
      try {
        await deps.fetchObjects([changedWork.trusted]);
        await checkout(input.root, changedWork.trusted);
      } catch (error) {
        changedWork.error = reasonOf(error);
        changedWork.piece = { pr: target.pr, verdict: 'technical', stages: [], note: reasonOf(error) };
        continue;
      }
      const branchRead = await readRecipeAt(changedWork.trusted, label);
      if (!branchRead.ok) {
        changedWork.error = `La receta de ${label} no se pudo leer: ${branchRead.reason}`;
        changedWork.piece = { pr: target.pr, verdict: 'technical', stages: [], note: changedWork.error };
        continue;
      }
      changedWork.recipe = branchRead.recipe;
      changedWork.piece = await judgeWork(changedWork);
      if (isGroup) {
        const problem = await groupAncestorProblem(changedWork.trusted);
        if (problem !== undefined) {
          await publish(targets.sha, targetContext, 'error', problem);
          return conclude(judgedShaFor(), principalRecipe.locale);
        }
      }
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
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `no se pudo comprobar el estado más reciente de ${targetContext}: ${reasonOf(error)}`,
            `the newest status of ${targetContext} could not be checked: ${reasonOf(error)}`,
          ),
        );
        official = undefined;
      }
      if (official !== undefined && official > input.runId) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `otra corrida oficial del juez publicó después (${official}); esta no publica`,
            `another official judge run published later (${official}); this one stays quiet`,
          ),
        );
        return conclude(judgedShaFor(), principalRecipe.locale);
      }
    }

    // §3.1: the live target branch, one last time before writing the verdict. A pull request
    // retargeted during the run receives nothing, not even an earlier verdict.
    let retargeted = false;
    for (const work of worksRef) {
      const target = work.target;
      let live;
      try {
        live = await github.pullRequest(target.pr);
      } catch (error) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `no se pudo releer el PR #${target.pr} antes de publicar: ${reasonOf(error)}`,
            `pull request #${target.pr} could not be re-read before publishing: ${reasonOf(error)}`,
          ),
        );
        return conclude(judgedShaFor(), principalRecipe.locale);
      }
      if (!into.includes(live.baseRef)) {
        addNote(notes,
          pick(
            isSpanish(principalRecipe.locale),
            `la rama destino del PR #${target.pr} es "${live.baseRef}"; no se publica`,
            `the target branch of pull request #${target.pr} is "${live.baseRef}"; nothing is published`,
          ),
        );
        retargeted = true;
      }
    }
    if (retargeted) return conclude(judgedShaFor(), principalRecipe.locale);

    const pieces = judgedShaFor();
    const verdict = pieces.reduce<JudgeVerdict>((acc, piece) => worstPiece(acc, piece.verdict), 'passed');
    await publish(targets.sha, targetContext, stateOf(verdict), describeVerdict(pieces, principalRecipe.locale));
    break;
  }

  return conclude(judgedShaFor(), principalRecipe.locale);
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
