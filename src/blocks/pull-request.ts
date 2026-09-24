import { execFile } from 'node:child_process';

import type { GateContext, JsonValue } from '../contract.js';
import type { AgentPullRequest, PullRequestHistoryItem } from '../agent/github.js';
import { gitEnvironment } from '../git-env.js';
import { pieceOfBranch } from '../judge/pieces.js';
import type { Recipe } from '../recipe/types.js';
import type { AgentDeps, ReconcileAnswer } from './definition.js';

// PLAN-13-R4 §3.0 and §3.0.1: the pull request of a piece, and how each of its effects is
// reconciled. The branch is the piece's own branch; the judged SHA is pushed without force; a
// draft pull request is opened once, marked by the operation that created it, and every later
// block finds it. A person's pull request is never reused (the owner cannot approve their own),
// and a pull request of the app without a mark is never assumed to be the engine's own.

const GIT_TIMEOUT_MS = 60_000;
const OP_MARKER = '<!-- ai-workflows:op ';
const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface PullRequestDeps {
  readonly root: string;
  readonly recipe: Recipe;
  readonly agent: AgentDeps;
}

/** The pull request of the piece, ready to be used, with the detail that confirmed it. */
export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
  readonly detail: AgentPullRequest;
}

/**
 * A pull request the engine refuses to use, with the motive a person reads. It is a rejection,
 * not a technical failure; anything else `pullRequestOf` throws stays technical.
 */
export class PullRequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestRefused';
  }
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** The current branch of the piece's tree; a detached head is technical, never guessed. */
export async function currentBranch(root: string, spanish: boolean): Promise<string> {
  const branch = await new Promise<string | undefined>((resolve) => {
    execFile(
      'git',
      ['symbolic-ref', '--short', 'HEAD'],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error, stdout) => resolve(error === null ? stdout.trim() : undefined),
    );
  });
  if (branch === undefined || branch.length === 0) {
    throw new Error(
      spanish
        ? 'El árbol está en una cabeza suelta: no se puede saber de qué rama es esta pieza.'
        : 'The tree is on a detached head: the branch of this piece cannot be known.',
    );
  }
  return branch;
}

/** Whether a pull request was opened by the agents, from the same repository, into the principal. */
function hasProvenance(
  pr: AgentPullRequest,
  agentAccount: string | undefined,
  repository: string,
  principal: string,
): boolean {
  if (agentAccount !== undefined && pr.author !== agentAccount) return false;
  if (pr.headRepo !== repository) return false;
  return pr.baseRef === principal;
}

/** The mark a pull request carries for one operation, or whether it carries any mark at all. */
function hasMark(body: string, operationId: string): boolean {
  return body.includes(`${OP_MARKER}${operationId} -->`);
}

function hasAnyMark(body: string): boolean {
  return body.includes(OP_MARKER);
}

export interface PullRequestOptions {
  readonly create: boolean;
  readonly context: GateContext;
  readonly deps: PullRequestDeps;
}

/**
 * PLAN-13-R4 §3.0. Returns the piece's pull request, pushing the judged SHA and opening a draft
 * one when `create` is set. A rejection is a `PullRequestRefused`; a broken or ambiguous state
 * throws, so the block stays technical.
 */
export async function pullRequestOf(
  piece: string,
  sha: string,
  options: PullRequestOptions,
): Promise<PullRequestRef> {
  const { context, deps } = options;
  const agent = deps.agent;
  const spanish = isSpanish(context.locale);

  const branch = await currentBranch(deps.root, spanish);
  const named = pieceOfBranch(deps.recipe, branch, 0);
  if ('none' in named) throw new Error(named.none);
  if (named.piece !== piece) {
    throw new Error(
      spanish
        ? `La rama "${branch}" es de la pieza ${named.piece}, no de la ${piece}.`
        : `The branch "${branch}" names piece ${named.piece}, not ${piece}.`,
    );
  }

  const principal = await agent.github.defaultBranch();
  const agentAccount = deps.recipe.agentAccount;
  const prs = await agent.github.pullRequestsOfBranch(branch);

  // A merge that already happened while the engine was down: exactly one merged pull request on
  // the judged commit, with provenance, is the piece's own.
  const merged = prs.filter(
    (pr) =>
      pr.state === 'MERGED'
      && pr.headSha === sha
      && hasProvenance(pr, agentAccount, agent.repository, principal),
  );
  if (merged.length > 1) {
    throw new Error(
      spanish
        ? 'Hay más de un PR fusionado de esta versión: no se puede saber cuál es el de la pieza.'
        : 'More than one merged pull request names this version: the piece\'s own cannot be told apart.',
    );
  }
  const already = merged[0];
  if (already !== undefined) return { number: already.number, url: already.url, detail: already };

  // Push the judged SHA without force. A remote branch with commits that are not here is refused
  // and sent to `sync`; an unknown remote head is refused the same way, never overwritten.
  const remoteHead = await agent.remote.branchHead(branch);
  if (remoteHead !== undefined && remoteHead !== sha) {
    let ancestor = false;
    try {
      ancestor = await isAncestor(deps.root, remoteHead, sha);
    } catch {
      // An unknown remote head is never assumed to be behind: it is refused, not overwritten.
      ancestor = false;
    }
    if (!ancestor) {
      throw new PullRequestRefused(
        spanish
          ? `La rama en GitHub tiene cambios que no están aquí (${remoteHead}). Resuélvelo con «sync».`
          : `The branch on GitHub has changes that are not here (${remoteHead}). Resolve it with "sync".`,
      );
    }
  }

  await context.runEffect(`push:${branch}:${sha}`, async () => {
    await agent.remote.push(branch, sha);
    return null;
  });
  const pushedHead = await agent.remote.branchHead(branch);
  if (pushedHead !== sha) {
    throw new PullRequestRefused(
      spanish
        ? 'La rama cambió en GitHub después de subirla: no se vuelve a subir, revísala a mano.'
        : 'The branch changed on GitHub after it was pushed: it is not pushed again, review it by hand.',
    );
  }

  const open = prs.filter((pr) => pr.state === 'OPEN');
  if (open.length > 1) {
    throw new Error(
      spanish
        ? 'Hay más de un PR abierto en esta rama: no se puede saber cuál es el de la pieza.'
        : 'More than one pull request is open on this branch: the piece\'s own cannot be told apart.',
    );
  }

  const openOne = open[0];
  if (openOne !== undefined) {
    if (!hasProvenance(openOne, agentAccount, agent.repository, principal)) {
      throw new PullRequestRefused(
        spanish
          ? `Este PR lo abrió ${openOne.author} (o apunta a otra base u otro repositorio); ciérralo para que el motor abra uno propio (el dueño no puede aprobar lo suyo).`
          : `This pull request was opened by ${openOne.author} (or targets another base or another repository); close it so the engine can open its own (the owner cannot approve their own).`,
      );
    }
    if (!hasAnyMark(openOne.body)) {
      throw new Error(
        spanish
          ? `No se sabe si este PR es del motor (PR #${openOne.number}): no se abre otro.`
          : `It is unknown whether this pull request is the engine's own (#${openOne.number}): no other is opened.`,
      );
    }
    return await confirmHead(openOne.number, sha, deps, spanish);
  }

  // No open pull request: a closed one of the app without any mark makes the state ambiguous.
  // A merged pull request is not one of the two states that rule names.
  const markless = prs.find(
    (pr) =>
      (pr.state === 'OPEN' || pr.state === 'CLOSED')
      && agentAccount !== undefined
      && pr.author === agentAccount
      && !hasAnyMark(pr.body),
  );
  if (markless !== undefined) {
    throw new Error(
      spanish
        ? `No se sabe si este PR es del motor (PR #${markless.number}): no se abre otro.`
        : `It is unknown whether this pull request is the engine's own (#${markless.number}): no other is opened.`,
    );
  }

  if (!options.create) {
    throw new Error(
      spanish
        ? 'No hay PR abierto de esta pieza y este bloque no puede abrirlo.'
        : 'There is no open pull request for this piece and this block cannot open one.',
    );
  }

  const created = await context.runEffect(`open-pr:${branch}:${sha}`, async () => {
    const title = await agent.github.issueTitle(Number(piece));
    const body = `Refs #${piece}\n${OP_MARKER}open-pr:${branch}:${sha} -->`;
    const number = await agent.github.createDraftPullRequest({
      branch,
      base: principal,
      title,
      body,
    });
    return { number } satisfies JsonValue;
  });
  const createdNumber = readCreatedNumber(created);
  const detail = await agent.github.pullRequestDetail(createdNumber);
  return await confirmHead(createdNumber, sha, deps, spanish, detail);
}

async function confirmHead(
  number: number,
  sha: string,
  deps: PullRequestDeps,
  spanish: boolean,
  known?: AgentPullRequest,
): Promise<PullRequestRef> {
  const detail = known ?? (await deps.agent.github.pullRequestDetail(number));
  // A merge that landed while the engine re-read is as good as one that was already there.
  const usable = detail.state === 'OPEN' || detail.state === 'MERGED';
  if (!usable || detail.headSha !== sha) {
    throw new Error(
      spanish
        ? `El PR #${number} no apunta a esta versión.`
        : `Pull request #${number} does not point at this version.`,
    );
  }
  return { number: detail.number, url: detail.url, detail };
}

function readCreatedNumber(value: JsonValue): number {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const number = (value as { readonly number?: unknown }).number;
    if (typeof number === 'number') return number;
  }
  throw new Error('the created pull request did not report its number');
}

/**
 * Whether `ancestor` is reachable from `descendant`. A clean "not an ancestor" is git exiting 1;
 * anything else (an unknown commit) is not an answer and throws.
 */
async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    execFile(
      'git',
      ['merge-base', '--is-ancestor', ancestor, descendant],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error) => {
        if (error === null) {
          resolve(true);
          return;
        }
        if ((error as { code?: unknown }).code === 1) {
          resolve(false);
          return;
        }
        reject(new Error(`git could not tell whether ${ancestor} is an ancestor of ${descendant}`));
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// §3.0.1: reconciling the pull request's own effects

export interface ReconcileOutcome {
  readonly handled: boolean;
  readonly answer?: ReconcileAnswer;
}

function splitOperation(operationId: string): { readonly prefix: string; readonly branch: string; readonly sha: string } | undefined {
  const first = operationId.indexOf(':');
  const last = operationId.lastIndexOf(':');
  if (first < 0 || last <= first) return undefined;
  const prefix = operationId.slice(0, first);
  const branch = operationId.slice(first + 1, last);
  const sha = operationId.slice(last + 1);
  if (!FULL_SHA.test(sha)) return undefined;
  return { prefix, branch, sha };
}

/** Whether `actor` is the agents' account, when one is declared. */
function isAgentActor(actor: string | null, agentAccount: string | undefined): boolean {
  return agentAccount !== undefined && actor === agentAccount;
}

/** The index of the last head change in a pull request's history, or -1. */
function lastHeadChange(history: readonly PullRequestHistoryItem[]): number {
  let index = -1;
  for (let at = 0; at < history.length; at += 1) {
    if (history[at]?.type === 'head-changed') index = at;
  }
  return index;
}

/**
 * Reconciles the effects `pullRequestOf` starts: `push` and `open-pr`. It answers `undefined`
 * when the operation is not one of them.
 */
export async function reconcilePullRequestEffect(
  operationId: string,
  context: GateContext,
  deps: PullRequestDeps,
): Promise<ReconcileOutcome> {
  const parts = splitOperation(operationId);
  if (parts === undefined) return { handled: false };
  if (parts.prefix === 'push') return { handled: true, answer: await reconcilePush(parts, context, deps) };
  if (parts.prefix === 'open-pr') return { handled: true, answer: await reconcileOpenPr(parts, context, deps) };
  return { handled: false };
}

async function reconcilePush(
  parts: { readonly branch: string; readonly sha: string },
  context: GateContext,
  deps: PullRequestDeps,
): Promise<ReconcileAnswer> {
  const activity = await deps.agent.github.branchActivity(parts.branch);
  const happened = activity.some(
    (item) => item.after === parts.sha && isAgentActor(item.actor, deps.recipe.agentAccount),
  );
  if (happened) return { confirmed: null };
  const head = await deps.agent.remote.branchHead(parts.branch);
  if (head === undefined || (await isAncestor(deps.root, head, parts.sha))) {
    return { didNotHappen: true };
  }
  void context;
  return undefined;
}

async function reconcileOpenPr(
  parts: { readonly branch: string; readonly sha: string },
  context: GateContext,
  deps: PullRequestDeps,
): Promise<ReconcileAnswer> {
  const prs = await deps.agent.github.pullRequestsOfBranch(parts.branch);
  const mine = prs.filter((pr) => hasMark(pr.body, `open-pr:${parts.branch}:${parts.sha}`));
  if (mine.length > 1) return undefined;
  const found = mine[0];
  if (found !== undefined) return { confirmed: { number: found.number, url: found.url } satisfies JsonValue };

  const markless = prs.find(
    (pr) =>
      (pr.state === 'OPEN' || pr.state === 'CLOSED')
      && deps.recipe.agentAccount !== undefined
      && pr.author === deps.recipe.agentAccount
      && !hasAnyMark(pr.body),
  );
  if (markless !== undefined) return undefined;
  void context;
  return { didNotHappen: true };
}
