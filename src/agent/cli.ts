import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  EffectRefusedBecauseParked,
  type JournalEntry,
  type JsonValue,
  type PipelineConfig,
  type PieceStatus,
  type RunOutcome,
  type StageConfig,
  type Store,
} from '../contract.js';
import { renderStatus, runCommand, type CommandOutput } from '../cli.js';
import { createEngine } from '../engine.js';
import { safeTerminalText } from '../safe-text.js';
import { DEFAULT_BANNED_TERMS, readOwnerSummary, renderOwnerMessage, type OwnerMessageKind } from '../messages.js';
import { agentCredentialsFromEnv, createAppTokenSource, APP_ID_ENV, APP_KEY_FILE_ENV } from './identity.js';
import { createAgentGitHub, type AgentGitHub, type RemoteGit } from './github.js';
import { readPieceEvents, renderEventComment, slugOf, type IssueComment, type PieceEvent } from './events.js';
import { createRemoteGit, gitCurrentBranch, gitHead, gitIsClean, gitMainRoot, gitOk, gitText, gitTopLevel, snapshotTree, runGit } from './git.js';
import { finishPiece } from './finish.js';
import { createGhRunner, type GhRunnerWithEnv } from '../gh-runner.js';
import { createGitHubStatePort } from '../store-github.js';
import { createGitStore, type StatePort } from '../store-git.js';
import { checkRecipe } from '../recipe/blocks.js';
import { compileRecipe, runProviderInGroup } from '../recipe/compile.js';
import { recordCleanUpdate, verifyCleanUpdate } from '../recipe/validity.js';
import { diskProjectFiles, type ChangeDeclared } from '../recipe/facts.js';
import { pieceOfBranch, readDeclaredKind } from '../judge/pieces.js';
import type { Recipe } from '../recipe/types.js';
import type { ProviderRunner } from '../blocks/definition.js';
import {
  buildInvocation,
  parseRun,
  type Invocation,
  type ProviderName,
  type RawRun,
  type RunRequest,
} from '../providers.js';

// PLAN-13-R4 §4, §6, §8 and §3.8: the binary connected to the recipe, next to the agent. `run`,
// `build`, `review` and `sync` read and check the recipe before touching the store; the control
// commands never depend on it, so a broken recipe can still be stopped. Two sessions on one piece
// never both work; owner messages go out once and only while they still apply; `finish` retires
// the folder and the branch after `done`; `sync` records a clean update before moving the head.

const RECIPE_FILE = '.ai-workflows/pipeline.yml';
const LEASE_MS = 15 * 60_000;

/** The agents' installation token, asked for again on every call (PLAN-13-R4 §1.2, §6). */
export interface AgentTokenSource {
  token(): Promise<string>;
  /** The account GitHub reports for the app, as `<slug>[bot]`. */
  account(): Promise<string>;
}

export interface CreateAgentEdgesOptions {
  /** `owner/name`, as GitHub reports it. */
  readonly repository: string;
  /** The runner of `gh` the edges talk through; a test hands its own. */
  readonly runner: GhRunnerWithEnv;
  /** The app token source; without it the calls run as the account `gh` is logged in as. */
  readonly tokenSource?: AgentTokenSource;
  /** The repository the git side pushes in; defaults to the current folder. */
  readonly root?: string;
}

export interface AgentEdges {
  readonly github: AgentGitHub;
  readonly remote: RemoteGit;
}

/**
 * The two halves of the GitHub edge next to the agent, over one `gh` runner. A token source is
 * asked for a live token on EVERY call: an installation token lives an hour, and a merge can be
 * observed for hours, so caching one would send a dead token. Without a source the calls go out
 * as the account `gh` is logged in as, with no token in the environment.
 */
export function createAgentEdges(options: CreateAgentEdgesOptions): AgentEdges {
  const token =
    options.tokenSource === undefined
      ? undefined
      : (): Promise<string> => options.tokenSource!.token();
  const github = createAgentGitHub({
    repository: options.repository,
    runner: options.runner,
    ...(token === undefined ? {} : { token }),
  });
  const remote = createRemoteGit({
    root: options.root ?? process.cwd(),
    repository: options.repository,
    ...(token === undefined ? {} : { token }),
  });
  return { github, remote };
}

export interface AgentCliDeps {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly github?: AgentGitHub;
  readonly remote?: RemoteGit;
  readonly statePort?: StatePort;
  readonly repository?: string;
  readonly providers?: ProviderRunner;
  /** The `gh` runner the edges use when the recipe has no agent identity; a test hands its own. */
  readonly ghRunner?: GhRunnerWithEnv;
  /** The app token source, so a test can hand one instead of the environment variables. */
  readonly tokenSource?: AgentTokenSource;
  ghAccounts?(): Promise<string[]>;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Only for tests: runs right after the engine returns and before any read. */
  afterRun?(): Promise<void>;
  /** Only for tests: runs between the engine's verdict and the owner messages. */
  beforeMessages?(): Promise<void>;
  /** Only for tests: runs just before `sync` moves the head. */
  beforeFastForward?(): Promise<void>;
  /** Only for tests: runs just before renewing and writing each clean-update record of `sync`. */
  beforeCleanUpdateRecord?(index: number): Promise<void>;
}

function spanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What to say when a reservation could not be dropped: silence would hide a stuck lease. */
function releaseFailureText(locale: string, error: unknown): string {
  return spanish(locale)
    ? `La reserva de la pieza no se pudo soltar: ${safeTerminalText(reasonOf(error))}`
    : `The piece's reservation could not be released: ${safeTerminalText(reasonOf(error))}`;
}

/** Joins a note with whatever the run already had to say, never dropping either. */
function appendNote(note: string, extra: string): string {
  return note.length === 0 ? extra : `${note}\n${extra}`;
}

function refusal(locale: string, es: string, en: string): CommandOutput {
  return { ok: false, text: spanish(locale) ? es : en };
}

// ---------------------------------------------------------------------------------------------
// Reading the recipe and the edges

interface LoadedRecipe {
  readonly ok: true;
  readonly recipe: Recipe;
}

interface BrokenRecipe {
  readonly ok: false;
  readonly errors: readonly string[];
  readonly warning: string;
}

async function readRecipeAt(root: string): Promise<LoadedRecipe | BrokenRecipe> {
  const path = join(root, RECIPE_FILE);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return {
      ok: false,
      errors: [`${RECIPE_FILE}: not found`],
      warning: `The recipe ${RECIPE_FILE} could not be read (speaking English).`,
    };
  }
  const checked = await checkRecipe(content, RECIPE_FILE, { root });
  if (!checked.ok) {
    const errors = checked.errors.map(
      (error) => `${error.file}:${error.line}:${error.column}: ${error.message}`,
    );
    return {
      ok: false,
      errors,
      warning: `The recipe is not valid (speaking English): ${safeTerminalText(errors[0] ?? '')}`,
    };
  }
  return { ok: true, recipe: checked.recipe };
}

/** `owner/name` of the `origin` remote, or a reason it cannot be told. */
async function repositoryOf(root: string, provided: string | undefined): Promise<string | undefined> {
  if (provided !== undefined) return provided;
  try {
    const url = await gitText(root, ['remote', 'get-url', 'origin']);
    return parseRepositoryUrl(url);
  } catch {
    return undefined;
  }
}

function parseRepositoryUrl(url: string): string | undefined {
  const https = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (https === null) return undefined;
  const owner = https[1];
  const name = https[2];
  return owner === undefined || name === undefined ? undefined : `${owner}/${name}`;
}

/** The GitHub edge of the agents, or the reason it cannot be built. */
type Edges =
  | { readonly ok: true; readonly github?: AgentGitHub; readonly remote?: RemoteGit; readonly repository: string }
  | { readonly ok: false; readonly text: string };

async function resolveEdges(deps: AgentCliDeps, root: string, recipe: Recipe): Promise<Edges> {
  const repository = await repositoryOf(root, deps.repository);
  if (repository === undefined) {
    return {
      ok: false,
      text: spanish(recipe.locale)
        ? 'No se pudo saber el repositorio de GitHub a partir de "origin".'
        : 'The GitHub repository could not be told from "origin".',
    };
  }
  // Two fakes handed in are the whole edge: no identity is checked, no `gh` is built.
  if (deps.github !== undefined && deps.remote !== undefined) {
    return { ok: true, github: deps.github, remote: deps.remote, repository };
  }

  const runner = deps.ghRunner ?? createGhRunner();

  if (recipe.agentAccount !== undefined) {
    let tokenSource = deps.tokenSource;
    if (tokenSource === undefined) {
      const credentials = agentCredentialsFromEnv(deps.env, root);
      if ('missing' in credentials) {
        return {
          ok: false,
          text: spanish(recipe.locale)
            ? `La receta declara una identidad de agente y falta ${credentials.missing} (${APP_ID_ENV} y ${APP_KEY_FILE_ENV}).`
            : `The recipe declares an agent identity and ${credentials.missing} is missing (${APP_ID_ENV} and ${APP_KEY_FILE_ENV}).`,
        };
      }
      if ('refused' in credentials) {
        return {
          ok: false,
          text: spanish(recipe.locale)
            ? `Las credenciales del agente no sirven: ${credentials.refused}`
            : `The agent credentials are unusable: ${credentials.refused}`,
        };
      }
      tokenSource = createAppTokenSource({ credentials, repository });
    }
    // Before touching anything: the key must belong to the declared identity. A key of another
    // app would publish under an account the recipe never named.
    const account = await tokenSource.account();
    if (account !== recipe.agentAccount) {
      return {
        ok: false,
        text: spanish(recipe.locale)
          ? `La llave no es de la identidad declarada: GitHub la reporta como "${account}", no como "${recipe.agentAccount}".`
          : `The key is not of the declared identity: GitHub reports it as "${account}", not "${recipe.agentAccount}".`,
      };
    }
    const edges = createAgentEdges({ repository, runner, tokenSource, root });
    return {
      ok: true,
      github: deps.github ?? edges.github,
      remote: deps.remote ?? edges.remote,
      repository,
    };
  }

  // A recipe without an agent identity still reaches GitHub, as the account `gh` is logged in
  // as (the path of `approval-comment` and of every project without its own app).
  const edges = createAgentEdges({ repository, runner, root });
  return {
    ok: true,
    github: deps.github ?? edges.github,
    remote: deps.remote ?? edges.remote,
    repository,
  };
}

async function resolveStore(deps: AgentCliDeps, root: string): Promise<Store> {
  if (deps.statePort !== undefined) return createGitStore({ port: deps.statePort });
  const repository = (await repositoryOf(root, deps.repository)) ?? 'unknown/unknown';
  const [owner, repo] = repository.split('/');
  const credentials = agentCredentialsFromEnv(deps.env, root);
  const runner = createGhRunner();
  let run = runner;
  if (!('missing' in credentials) && !('refused' in credentials)) {
    const source = createAppTokenSource({ credentials, repository });
    run = async (args, input) => runner(args, input, { GH_TOKEN: await source.token() });
  }
  const port = createGitHubStatePort({
    owner: owner ?? 'unknown',
    repo: repo ?? 'unknown',
    run,
  });
  return createGitStore({ port });
}

async function gitTop(root: string): Promise<string | undefined> {
  try {
    return await gitTopLevel(root);
  } catch {
    return undefined;
  }
}

async function resolveBaseRef(root: string, principal: string): Promise<string> {
  const remote = `origin/${principal}`;
  return (await gitOk(root, ['rev-parse', '--verify', `${remote}^{commit}`])) ? remote : principal;
}

/** The principal branch of the repository; `main` when GitHub is not there to say. */
async function principalOf(
  github: AgentGitHub | undefined,
): Promise<{ readonly ok: true; readonly branch: string } | { readonly ok: false; readonly text: string }> {
  if (github === undefined) return { ok: true, branch: 'main' };
  try {
    return { ok: true, branch: await github.defaultBranch() };
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }
}

// ---------------------------------------------------------------------------------------------
// run

function busyText(locale: string): string {
  return spanish(locale)
    ? 'La pieza la tiene otra sesión ahora mismo; esta corrida no escribió nada.'
    : 'Another session holds the piece right now; this run wrote nothing.';
}

function renderOutcome(outcome: RunOutcome, locale: string): CommandOutput {
  if (outcome.outcome === 'busy') return { ok: false, text: busyText(locale) };
  // The terminal keeps the whole motive (PLAN-13-R4 §6): the owner runs this by hand and needs
  // to read what stopped the piece, not a reason trimmed to fit a line.
  const text = renderStatus([outcome.status], { locale, verbose: true });
  if (outcome.outcome === 'parked') return { ok: false, text };
  return { ok: outcome.status.state === 'done', text };
}

function closedText(piece: string, locale: string): string {
  return spanish(locale)
    ? `La pieza ${safeTerminalText(piece)} ya está cerrada; su carpeta se retiró. No hay nada que ejecutar.`
    : `Piece ${safeTerminalText(piece)} is already closed; its folder was retired. There is nothing to run.`;
}

interface Facts {
  readonly state: string | null;
  readonly stage: string | null;
  readonly reason: string | null;
  readonly at: number | null;
  readonly runId: string | null;
  readonly sha: string;
}

async function captureFacts(piece: string, store: Store, root: string): Promise<Facts> {
  const current = await store.loadStatus(piece);
  const journal = await store.journal(piece);
  const stage = current?.status.stage;
  const last: JournalEntry | undefined =
    stage === undefined ? undefined : [...journal].reverse().find((entry) => entry.stage === stage);
  return {
    state: current?.status.state ?? null,
    stage: stage ?? null,
    reason: current?.status.reason ?? null,
    at: last?.at ?? null,
    runId: last?.runId ?? null,
    sha: await gitHead(root),
  };
}

function messageKind(status: PieceStatus, recipe: Recipe): OwnerMessageKind | undefined {
  if (status.state === 'waiting:decision') {
    const uses = recipe.stages.find((stage) => stage.id === status.stage)?.gate.uses ?? '';
    return uses.includes('approval-review') || uses.includes('approval-comment') ? 'approval' : 'question';
  }
  if (status.state === 'blocked:rejected' || status.state === 'blocked:technical') return 'blocked';
  if (status.state === 'done') return 'close';
  return undefined;
}

function messageKey(
  kind: OwnerMessageKind,
  piece: string,
  status: PieceStatus,
  facts: Facts,
): string {
  if (kind === 'start' || kind === 'close') return piece;
  if (kind === 'blocked') {
    const digest = createHash('sha256').update(status.reason ?? '').digest('hex').slice(0, 12);
    return `${status.stage ?? ''}:${facts.sha}:${digest}`;
  }
  return `${status.stage ?? ''}:${facts.sha}`;
}

function summaryLines(recipe: Recipe, root: string, piece: string): readonly string[] | undefined {
  const spec = recipe.messages?.summary;
  if (spec === undefined) return undefined;
  try {
    const document = readFileSync(join(root, spec.file.replaceAll('{piece}', piece)), 'utf8');
    return readOwnerSummary(document, spec.section);
  } catch {
    return undefined;
  }
}

function markerOf(op: string): string {
  return `<!-- ai-workflows:message {"op":"${op}"} -->`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * PLAN-13-R4 §6: the exact order the owner has to write, for an approval by comment. It is built
 * from the stage's own `command` and `code-length` and the head, so the message and the stage's
 * refusal name the very same order. `undefined` when the stage approves with the GitHub button.
 */
function approvalOrder(status: PieceStatus, recipe: Recipe, facts: Facts): string | undefined {
  const stage = recipe.stages.find((item) => item.id === status.stage);
  const uses = stage?.gate.uses ?? '';
  if (!uses.includes('approval-comment')) return undefined;
  const withValue = asRecord(stage?.gate.with);
  const command =
    typeof withValue?.['command'] === 'string' && withValue['command'].length > 0
      ? withValue['command']
      : '/approve';
  const rawLength = withValue?.['code-length'];
  const codeLength = typeof rawLength === 'number' && Number.isInteger(rawLength) ? rawLength : 7;
  return `${command} ${facts.sha.slice(0, codeLength)}`;
}

/** PLAN-13-R4 §6: the stage's own summary for a stop, never the raw technical reason. */
function blockedDetail(status: PieceStatus, recipe: Recipe, es: boolean): string | undefined {
  const stage = recipe.stages.find((item) => item.id === status.stage);
  if (stage === undefined) return undefined;
  const how =
    status.state === 'blocked:technical'
      ? es
        ? 'fallo técnico'
        : 'technical failure'
      : es
        ? 'rechazo'
        : 'refusal';
  return `${stage.summary} (${how})`;
}

/**
 * Runs one owner-message effect. A message left in doubt — a crash before or after the comment,
 * or a store that failed while recording it — is settled by reading the issue: a comment carrying
 * this operation's mark AND written by the agents through their app means it already went out;
 * anything else means it never did. A comment of another account quoting the mark never counts.
 */
async function messageEffect(
  store: Store,
  piece: string,
  op: string,
  github: AgentGitHub,
  body: string,
  agentAccount: string | undefined,
): Promise<void> {
  const send = async (): Promise<JsonValue> => {
    const id = await github.commentOnIssue(Number(piece), body);
    return { id };
  };
  const isOurs = (comment: IssueComment): boolean => {
    if (!comment.body.includes(`"op":"${op}"`)) return false;
    if (comment.authorType !== 'Bot') return false;
    if (agentAccount === undefined) return true;
    return comment.author === agentAccount && comment.viaApp === slugOf(agentAccount);
  };
  try {
    await store.runEffect(piece, op, send);
  } catch (error) {
    if (error instanceof EffectRefusedBecauseParked) throw error;
    // The effect may have landed before the failure: read the issue and settle it, then either
    // return its recorded result or run it once more. A read that also fails propagates.
    const comments = await github.issueComments(Number(piece));
    const sent = comments.some(isOurs);
    await store.reconcileEffect(piece, op, sent ? { confirmed: null } : { didNotHappen: true });
    await store.runEffect(piece, op, send);
  }
}

async function deliverMessage(
  kind: OwnerMessageKind,
  piece: string,
  status: PieceStatus,
  recipe: Recipe,
  store: Store,
  github: AgentGitHub,
  root: string,
  facts: Facts,
): Promise<string> {
  const messages = recipe.messages;
  if (messages === undefined) return '';
  const key = messageKey(kind, piece, status, facts);
  const op = `owner-message:${kind}:${key}`;
  const summary = summaryLines(recipe, root, piece);
  const link = status.reason === undefined ? undefined : /https?:\/\/\S+/.exec(status.reason)?.[0];
  const detail =
    kind === 'question'
      ? status.reason
      : kind === 'blocked'
        ? blockedDetail(status, recipe, spanish(recipe.locale))
        : undefined;
  const order = kind === 'approval' ? approvalOrder(status, recipe, facts) : undefined;
  const rendered = renderOwnerMessage(kind, {
    locale: recipe.locale,
    ...(summary === undefined ? {} : { summary }),
    ...(detail === undefined ? {} : { detail }),
    ...(link === undefined ? {} : { link }),
    ...(order === undefined ? {} : { order }),
    maxLength: messages.maxLength,
    banned: [...DEFAULT_BANNED_TERMS, ...messages.bannedWords],
  });
  if ('refused' in rendered) return rendered.refused;
  const body = `${rendered.text}\n\n${markerOf(op)}`;
  await messageEffect(store, piece, op, github, body, recipe.agentAccount);
  return '';
}

/** Whether the store still shows exactly what made the engine return this outcome. */
function matchesOutcome(status: PieceStatus, facts: Facts, runId: string): boolean {
  if (facts.state !== status.state) return false;
  if ((facts.stage ?? null) !== (status.stage ?? null)) return false;
  if ((facts.reason ?? null) !== (status.reason ?? null)) return false;
  // The last entry of the stage must be from THIS run; a waiting stage records none.
  if (facts.at !== null && facts.runId !== runId) return false;
  return true;
}

/**
 * PLAN-13-R4 §6: the `start` message, sent once per piece, inside the run and before its first
 * stage, only when the store has never seen the piece. It is keyed by the piece, so a crash on
 * either side of the comment never sends it twice.
 */
async function deliverStart(
  piece: string,
  recipe: Recipe,
  store: Store,
  github: AgentGitHub,
  root: string,
): Promise<string> {
  const messages = recipe.messages;
  if (messages === undefined) return '';
  const runId = `start-${randomUUID()}`;
  const held = await store.reserve(piece, runId, LEASE_MS);
  if (!held.ok) return '';
  let note = '';
  try {
    if ((await store.loadStatus(piece)) === undefined) {
      const op = `owner-message:start:${piece}`;
      const summary = summaryLines(recipe, root, piece);
      const rendered = renderOwnerMessage('start', {
        locale: recipe.locale,
        ...(summary === undefined ? {} : { summary }),
        maxLength: messages.maxLength,
        banned: [...DEFAULT_BANNED_TERMS, ...messages.bannedWords],
      });
      if ('refused' in rendered) note = rendered.refused;
      else await messageEffect(store, piece, op, github, `${rendered.text}

${markerOf(op)}`, recipe.agentAccount);
    }
  } finally {
    try {
      await store.release(piece, runId);
    } catch (error) {
      note = appendNote(note, releaseFailureText(recipe.locale, error));
    }
  }
  return note;
}

async function deliverOutcomeMessages(
  piece: string,
  outcome: RunOutcome,
  recipe: Recipe,
  store: Store,
  github: AgentGitHub | undefined,
  root: string,
  runId: string,
): Promise<string> {
  if (outcome.outcome !== 'ran' || recipe.messages === undefined) return '';
  const kind = messageKind(outcome.status, recipe);
  if (kind === undefined || github === undefined) return '';

  // The reservation is the same one the run held: with it in hand the state cannot move under
  // this message, and another session that took the piece meanwhile wins.
  const held = await store.reserve(piece, runId, LEASE_MS);
  if (!held.ok) {
    return spanish(recipe.locale)
      ? 'Otra sesión tiene la pieza en este momento; no se envió ningún aviso.'
      : 'Another session holds the piece right now; no message was sent.';
  }
  let note = '';
  try {
    const now = await captureFacts(piece, store, root);
    if (!matchesOutcome(outcome.status, now, runId)) {
      note = spanish(recipe.locale)
        ? 'El aviso al dueño ya no corresponde: la pieza avanzó mientras tanto.'
        : 'The owner message no longer applies: the piece moved on meanwhile.';
    } else {
      note = await deliverMessage(kind, piece, outcome.status, recipe, store, github, root, now);
    }
  } finally {
    try {
      await store.release(piece, runId);
    } catch (error) {
      note = appendNote(note, releaseFailureText(recipe.locale, error));
    }
  }
  return note;
}

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly bools: ReadonlySet<string>;
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--dry-run', '--verbose']);

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(arg)) {
        bools.add(arg);
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values[arg] = next;
        index += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, values, bools };
}

async function commandRun(args: readonly string[], deps: AgentCliDeps): Promise<CommandOutput> {
  const parsed = parseArgs(args);
  const piece = parsed.positionals[0];
  if (piece === undefined || piece.length === 0) {
    return { ok: false, text: 'Usage: run <piece>' };
  }
  const root = await gitTop(deps.cwd);
  if (root === undefined) return { ok: false, text: 'This folder is not a git repository.' };
  const loaded = await readRecipeAt(root);
  if (!loaded.ok) return { ok: false, text: loaded.errors.join('\n') };
  const recipe = loaded.recipe;

  const branch = await gitCurrentBranch(root);
  if (branch === undefined) {
    return refusal(recipe.locale, 'El árbol está en una cabeza suelta.', 'The tree is on a detached head.');
  }
  const named = pieceOfBranch(recipe, branch, 0);
  if ('none' in named) return { ok: false, text: named.none };
  if (recipe.pieces !== undefined && named.piece !== piece) {
    return {
      ok: false,
      text: spanish(recipe.locale)
        ? `La rama "${branch}" es de la pieza ${named.piece}, no de la ${piece}.`
        : `The branch "${branch}" names piece ${named.piece}, not ${piece}.`,
    };
  }

  const edges = await resolveEdges(deps, root, recipe);
  if (!edges.ok) return { ok: false, text: edges.text };
  const store = await resolveStore(deps, root);

  const existing = await store.loadStatus(piece);
  if (existing !== undefined && existing.status.state === 'done') {
    return { ok: false, text: closedText(piece, recipe.locale) };
  }

  let declared: ChangeDeclared = {};
  if (recipe.pieces?.declaredKind !== undefined) {
    const read = await readDeclaredKind(recipe, piece, diskProjectFiles(root));
    if ('rejected' in read) return { ok: false, text: read.rejected };
    declared = read.kind === undefined ? {} : { kind: read.kind };
  }

  // PLAN-13-R4 §2.2: the builders of the piece are every builder event on its issue. Without the
  // list the sandboxed review cannot judge independence, so an issue that cannot be read stops
  // the run as a technical failure — never a run with no builder in silence.
  if (recipe.agentAccount !== undefined && edges.github !== undefined) {
    try {
      const events = await readPieceEvents(edges.github, Number(piece), {
        agentAccount: recipe.agentAccount,
      });
      const builders = events
        .filter((event) => event.type === 'builder')
        .map((event) => ({
          provider: event.identity.provider,
          model: event.identity.model,
          session: event.identity.session,
        }));
      declared = { ...declared, builders };
    } catch (error) {
      // The issue cannot be read, so the run stops here — but nothing is written. A blind
      // `saveStatus` would overwrite a park, a quarantine or another session's live run, and
      // would leave a trace in a dry run and create a piece the store never saw. The failure is
      // only said in the terminal; the state is left exactly as it was.
      const text = spanish(recipe.locale)
        ? `La corrida se detuvo por un fallo técnico al leer el issue de la pieza: ${safeTerminalText(reasonOf(error))}`
        : `The run stopped on a technical failure while reading the piece's issue: ${safeTerminalText(reasonOf(error))}`;
      return { ok: false, text };
    }
  }

  const principal = await principalOf(edges.github);
  if (!principal.ok) return { ok: false, text: principal.text };
  const baseRef = await resolveBaseRef(root, principal.branch);
  const runId = randomUUID();

  let compiled;
  try {
    compiled = await compileRecipe(recipe, {
      root,
      baseRef,
      declared: () => declared,
      store,
      ...(deps.providers === undefined ? {} : { providers: deps.providers }),
      ...(edges.github !== undefined && edges.remote !== undefined
        ? {
            agent: {
              github: edges.github,
              remote: edges.remote,
              repository: edges.repository,
              sleep: deps.sleep ?? realSleep,
              now: deps.now ?? Date.now,
            },
          }
        : {}),
    });
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }

  const engine = createEngine({
    config: compiled.config,
    store,
    describeChange: compiled.describeChange,
    confirmFacts: compiled.confirmFacts,
    confirmQuarantine: compiled.confirmQuarantine,
    leaseMs: LEASE_MS,
    runId,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });

  const dryRun = parsed.bools.has('--dry-run');
  const notes: string[] = [];
  if (!dryRun && recipe.messages !== undefined && edges.github !== undefined && existing === undefined) {
    const note = await deliverStart(piece, recipe, store, edges.github, root);
    if (note.length > 0) notes.push(note);
  }

  let outcome: RunOutcome;
  try {
    outcome = await engine.run(piece, dryRun ? { mode: 'dry-run' } : undefined);
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }

  // PLAN-13-R4 §6: the window between the engine's verdict and the owner message is the one
  // another session can use. The test hook and any `beforeMessages` run here, before any read,
  // so the message is judged against the outcome that motivated it and against this run.
  if (deps.afterRun !== undefined) await deps.afterRun();
  if (deps.beforeMessages !== undefined) await deps.beforeMessages();

  if (!dryRun && edges.github !== undefined) {
    const note = await deliverOutcomeMessages(piece, outcome, recipe, store, edges.github, root, runId);
    if (note.length > 0) notes.push(note);
  }

  if (outcome.outcome === 'ran' && outcome.status.state === 'done') {
    const mainRoot = await gitMainRoot(root);
    const finished = await finishPiece({ mainRoot, piece, store, locale: recipe.locale, runId });
    notes.push(finished.text);
    return { ok: finished.ok, text: [renderOutcome(outcome, recipe.locale).text, ...notes].join('\n') };
  }

  const rendered = renderOutcome(outcome, recipe.locale);
  return { ok: rendered.ok, text: [rendered.text, ...notes].join('\n') };
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });

// ---------------------------------------------------------------------------------------------
// control commands

/** A one-stage config for the control commands, which only ever touch the store. */
function controlConfig(locale: string): PipelineConfig {
  const stage: StageConfig = {
    name: '__control',
    nature: 'recompute',
    gate: () => ({ ok: 'skipped', reason: 'control command' }),
  };
  return { locale, stages: [stage] };
}

async function commandControl(
  argv: readonly string[],
  deps: AgentCliDeps,
  root: string,
): Promise<CommandOutput> {
  const loaded = await readRecipeAt(root);
  const locale = loaded.ok ? loaded.recipe.locale : 'en';
  const store = await resolveStore(deps, root);
  let output: CommandOutput;
  try {
    output = await runCommand(argv, { config: controlConfig(locale), store });
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }
  if (!loaded.ok) {
    return { ok: output.ok, text: `${loaded.warning}\n${output.text}` };
  }
  return output;
}

// ---------------------------------------------------------------------------------------------
// finish

async function commandFinish(args: readonly string[], deps: AgentCliDeps): Promise<CommandOutput> {
  const piece = args.find((arg) => !arg.startsWith('--'));
  if (piece === undefined || piece.length === 0) return { ok: false, text: 'Usage: finish <piece>' };
  const root = await gitTop(deps.cwd);
  if (root === undefined) return { ok: false, text: 'This folder is not a git repository.' };
  const loaded = await readRecipeAt(root);
  const locale = loaded.ok ? loaded.recipe.locale : 'en';
  const store = await resolveStore(deps, root);
  const mainRoot = await gitMainRoot(deps.cwd);
  const result = await finishPiece({ mainRoot, piece, store, locale });
  const text = loaded.ok ? result.text : `${loaded.warning}\n${result.text}`;
  return { ok: result.ok, text };
}

// ---------------------------------------------------------------------------------------------
// sync

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.ok;
}

async function commandSync(args: readonly string[], deps: AgentCliDeps): Promise<CommandOutput> {
  const piece = args.find((arg) => !arg.startsWith('--'));
  if (piece === undefined || piece.length === 0) return { ok: false, text: 'Usage: sync <piece>' };
  const root = await gitTop(deps.cwd);
  if (root === undefined) return { ok: false, text: 'This folder is not a git repository.' };
  const loaded = await readRecipeAt(root);
  if (!loaded.ok) return { ok: false, text: loaded.errors.join('\n') };
  const recipe = loaded.recipe;

  const branch = await gitCurrentBranch(root);
  if (branch === undefined) {
    return refusal(recipe.locale, 'El árbol está en una cabeza suelta.', 'The tree is on a detached head.');
  }
  const named = pieceOfBranch(recipe, branch, 0);
  if ('none' in named) return { ok: false, text: named.none };
  if (recipe.pieces !== undefined && named.piece !== piece) {
    return {
      ok: false,
      text: spanish(recipe.locale)
        ? `La rama "${branch}" es de la pieza ${named.piece}, no de la ${piece}.`
        : `The branch "${branch}" names piece ${named.piece}, not ${piece}.`,
    };
  }

  const edges = await resolveEdges(deps, root, recipe);
  if (!edges.ok) return { ok: false, text: edges.text };
  const store = await resolveStore(deps, root);

  if (!(await gitIsClean(root))) {
    return refusal(
      recipe.locale,
      'Hay cambios sin guardar: guárdalos o descártalos antes de sincronizar.',
      'There are unsaved changes: save or discard them before syncing.',
    );
  }

  const runId = `sync-${randomUUID()}`;
  const held = await store.reserve(piece, runId, LEASE_MS);
  if (!held.ok) {
    return { ok: false, text: busyText(recipe.locale) };
  }

  const perform = async (): Promise<CommandOutput> => {
    const principal = await principalOf(edges.github);
    if (!principal.ok) return { ok: false, text: principal.text };
    try {
      await gitText(root, ['fetch', 'origin', branch]);
      await gitText(root, ['fetch', 'origin', principal.branch]);
    } catch (error) {
      return { ok: false, text: safeTerminalText(reasonOf(error)) };
    }
    const baseRef = `origin/${principal.branch}`;
    const remoteTip = await gitText(root, ['rev-parse', `origin/${branch}`]);
    const localHead = await gitText(root, ['rev-parse', 'HEAD']);
    if (remoteTip === localHead) {
      return { ok: true, text: spanish(recipe.locale) ? 'Ya está al día: nada que hacer.' : 'Already up to date: nothing to do.' };
    }
    if (!(await isAncestor(root, localHead, remoteTip))) {
      return refusal(
        recipe.locale,
        'En GitHub hay cambios que no son una actualización limpia: no se tocó nada.',
        'GitHub has changes that are not a clean update: nothing was touched.',
      );
    }

    const commits = (await gitText(root, ['rev-list', '--reverse', '--first-parent', remoteTip, '--not', localHead]))
      .split('\n')
      .filter((line) => line.length > 0);

    const steps: { readonly from: string; readonly to: string }[] = [];
    let from = localHead;
    for (const to of commits) {
      try {
        await verifyCleanUpdate(root, baseRef, from, to);
      } catch {
        return refusal(
          recipe.locale,
          'En GitHub hay cambios que no son una actualización limpia: no se tocó nada.',
          'GitHub has changes that are not a clean update: nothing was touched.',
        );
      }
      steps.push({ from, to });
      from = to;
    }

    for (const [index, step] of steps.entries()) {
      // The hook runs before the renewal, so a piece taken in this window is seen: the record is
      // not written and the head is not moved. `index` is only there for the tests.
      if (deps.beforeCleanUpdateRecord !== undefined) await deps.beforeCleanUpdateRecord(index);
      const renewed = await store.renew(piece, runId, LEASE_MS);
      if (!renewed.ok) {
        return { ok: false, text: busyText(recipe.locale) };
      }
      await recordCleanUpdate({ store, root, baseRef, piece, from: step.from, to: step.to, runId });
    }

    // PLAN-13-R4 §8: the reservation is renewed right before the head moves, after the test
    // hook and any re-read, so another session that took the piece in this window is seen and
    // the head is left where it was.
    if (deps.beforeFastForward !== undefined) await deps.beforeFastForward();
    const renewed = await store.renew(piece, runId, LEASE_MS);
    if (!renewed.ok) return { ok: false, text: busyText(recipe.locale) };
    await gitText(root, ['merge', '--ff-only', remoteTip]);
    return { ok: true, text: spanish(recipe.locale) ? 'La pieza se actualizó con la base y quedó registrado.' : 'The piece was updated with the base and it was recorded.' };
  };

  let result: CommandOutput;
  try {
    result = await perform();
  } catch (error) {
    result = { ok: false, text: safeTerminalText(reasonOf(error)) };
  }
  // Dropping the reservation is reported too: a lease that will not go carries on until it
  // lapses, and a silent failure would leave the piece looking held by a session that is gone.
  try {
    await store.release(piece, runId);
  } catch (error) {
    result = { ok: result.ok, text: appendNote(result.text, releaseFailureText(recipe.locale, error)) };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// build and review

async function commandProvider(
  kind: 'build' | 'review',
  args: readonly string[],
  deps: AgentCliDeps,
): Promise<CommandOutput> {
  const parsed = parseArgs(args);
  const piece = parsed.positionals[0];
  if (piece === undefined || piece.length === 0) {
    return { ok: false, text: `Usage: ${kind} <piece> --provider <p> --model <m> --prompt <file>` };
  }
  const root = await gitTop(deps.cwd);
  if (root === undefined) return { ok: false, text: 'This folder is not a git repository.' };
  const loaded = await readRecipeAt(root);
  if (!loaded.ok) return { ok: false, text: loaded.errors.join('\n') };
  const recipe = loaded.recipe;

  const branch = await gitCurrentBranch(root);
  if (branch === undefined) {
    return refusal(recipe.locale, 'El árbol está en una cabeza suelta.', 'The tree is on a detached head.');
  }
  const named = pieceOfBranch(recipe, branch, 0);
  if ('none' in named) return { ok: false, text: named.none };
  if (recipe.pieces !== undefined && named.piece !== piece) {
    return {
      ok: false,
      text: spanish(recipe.locale)
        ? `La rama "${branch}" es de la pieza ${named.piece}, no de la ${piece}.`
        : `The branch "${branch}" names piece ${named.piece}, not ${piece}.`,
    };
  }

  const edges = await resolveEdges(deps, root, recipe);
  if (!edges.ok) return { ok: false, text: edges.text };
  if (edges.github === undefined) {
    return refusal(
      recipe.locale,
      'Esta orden necesita la identidad de GitHub de los agentes y no la tiene.',
      "This command needs the agents' GitHub identity and does not have it.",
    );
  }

  if (!(await gitIsClean(root))) {
    return refusal(
      recipe.locale,
      'Hay cambios sin guardar: guárdalos o descártalos antes de continuar.',
      'There are unsaved changes: save or discard them before continuing.',
    );
  }

  const provider = parsed.values['--provider'];
  const model = parsed.values['--model'];
  const promptFile = parsed.values['--prompt'];
  const effort = parsed.values['--effort'];
  const angle = parsed.values['--angle'];
  if (provider === undefined || model === undefined || promptFile === undefined || (kind === 'review' && angle === undefined)) {
    return { ok: false, text: `Usage: ${kind} <piece> --provider <p> --model <m> --prompt <file>${kind === 'review' ? ' --angle <a>' : ''}` };
  }

  let prompt: string;
  try {
    prompt = readFileSync(join(root, promptFile), 'utf8');
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }

  const request: RunRequest = {
    provider: provider as ProviderName,
    model,
    ...(effort === undefined ? {} : { effort }),
    cwd: root,
    prompt,
    mode: kind === 'build' ? 'build' : 'review',
  };

  let invocation: Invocation;
  try {
    invocation = buildInvocation(request);
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }

  const before = await snapshotTree(root);
  const startHead = await gitHead(root);

  let raw: RawRun;
  try {
    raw = deps.providers !== undefined
      ? await deps.providers.run(invocation)
      : await runProviderInGroup(invocation);
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }

  const report = parseRun(request, raw);
  if (report.status !== 'success' || report.identity === undefined) {
    return {
      ok: false,
      text: report.reason ?? `The ${kind} run did not finish successfully; nothing was published.`,
    };
  }

  const after = await snapshotTree(root);
  const head = await gitHead(root);
  const identity = {
    provider: report.identity.provider,
    model: report.identity.model,
    effort: effort ?? '',
    session: report.identity.session,
  };

  let event: PieceEvent;
  if (kind === 'build') {
    event = {
      type: 'builder',
      op: randomUUID(),
      piece,
      sha: startHead,
      identity,
      result: after,
      at: new Date().toISOString(),
    };
  } else {
    const approved = verdictApproved(report.text) && before === after;
    event = {
      type: 'verdict',
      op: randomUUID(),
      piece,
      sha: head,
      identity,
      angle: angle ?? '',
      approved,
      workspace: { before, after },
      at: new Date().toISOString(),
    };
  }

  try {
    await edges.github.commentOnIssue(Number(piece), renderEventComment(event, recipe.locale));
  } catch (error) {
    return { ok: false, text: safeTerminalText(reasonOf(error)) };
  }
  return { ok: true, text: spanish(recipe.locale) ? `El evento de ${kind} se publicó.` : `The ${kind} event was published.` };
}

function verdictApproved(text: string | undefined): boolean {
  if (text === undefined) return false;
  const match = /^VERDICT:\s*(\S+)/m.exec(text);
  return match?.[1] === 'APPROVED';
}

// ---------------------------------------------------------------------------------------------
// doctor

async function commandDoctor(deps: AgentCliDeps): Promise<CommandOutput> {
  const root = await gitTop(deps.cwd);
  if (root === undefined) return { ok: false, text: 'This folder is not a git repository.' };
  const loaded = await readRecipeAt(root);
  const es = loaded.ok ? spanish(loaded.recipe.locale) : false;
  const lines: string[] = [];

  const version = await runGit(root, ['--version']);
  const parsedVersion = /(\d+)\.(\d+)/.exec(version.stdout);
  const major = Number.parseInt(parsedVersion?.[1] ?? '0', 10);
  const minor = Number.parseInt(parsedVersion?.[2] ?? '0', 10);
  const gitOkVersion = major > 2 || (major === 2 && minor >= 38);
  lines.push(
    gitOkVersion
      ? es ? `git ${version.stdout.trim()}: correcto.` : `git ${version.stdout.trim()}: fine.`
      : es ? 'git es antiguo: hace falta 2.38 o más.' : 'git is too old: 2.38 or newer is needed.',
  );

  if (!loaded.ok) {
    lines.push(es ? 'La receta no es válida:' : 'The recipe is not valid:');
    lines.push(...loaded.errors);
  } else {
    if (loaded.recipe.agentAccount !== undefined) {
      const credentials = agentCredentialsFromEnv(deps.env, root);
      if ('missing' in credentials) {
        lines.push(es ? `Identidad del agente: falta ${credentials.missing}.` : `Agent identity: ${credentials.missing} is missing.`);
      } else if ('refused' in credentials) {
        lines.push(es ? `Identidad del agente: ${credentials.refused}.` : `Agent identity: ${credentials.refused}.`);
      } else {
        lines.push(
          es
            ? 'Identidad del agente: la llave está fuera del proyecto.'
            : 'Agent identity: the key lives outside the project.',
        );
      }
    }
    if (loaded.recipe.owner !== undefined && deps.ghAccounts !== undefined) {
      const owner = loaded.recipe.owner;
      try {
        const accounts = await deps.ghAccounts();
        const loggedIn = accounts.some((account) => account.toLowerCase() === owner.toLowerCase());
        if (loggedIn) {
          lines.push(
            es
              ? `Aviso: la cuenta que aprueba (${owner}) está abierta en esta máquina; un agente podría aprobar por ti.`
              : `Warning: the account that approves (${owner}) is signed in on this machine; an agent could approve for you.`,
          );
        }
      } catch (error) {
        // A list that could not be read is said: silence could hide that the owner is signed in.
        lines.push(
          es
            ? `No se pudieron leer las cuentas abiertas de GitHub: ${safeTerminalText(reasonOf(error))}.`
            : `The GitHub accounts signed in could not be read: ${safeTerminalText(reasonOf(error))}.`,
        );
      }
    }
  }

  // `doctor` answers `ok: false` for what it checks and can fail: an unreadable recipe or a git
  // too old. A warning (the owner signed in here) never blocks.
  return { ok: loaded.ok && gitOkVersion, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------------------------
// entry

export async function runAgentCli(argv: readonly string[], deps: AgentCliDeps): Promise<CommandOutput> {
  const [command, ...args] = argv;
  let result: CommandOutput;
  switch (command) {
    case 'run':
      result = await commandRun(args, deps);
      break;
    case 'build':
      result = await commandProvider('build', args, deps);
      break;
    case 'review':
      result = await commandProvider('review', args, deps);
      break;
    case 'sync':
      result = await commandSync(args, deps);
      break;
    case 'finish':
      result = await commandFinish(args, deps);
      break;
    case 'doctor':
      result = await commandDoctor(deps);
      break;
    case 'status':
    case 'stop':
    case 'pause':
    case 'resume': {
      const root = await gitTop(deps.cwd);
      result = root === undefined
        ? { ok: false, text: 'This folder is not a git repository.' }
        : await commandControl(argv, deps, root);
      break;
    }
    default:
      result = {
        ok: false,
        text: 'Usage: ai-workflows <run|status|stop|pause|resume|doctor|build|review|sync|finish>',
      };
  }
  // Every line the owner reads goes through the same terminal sanitiser, whatever command wrote it.
  return { ok: result.ok, text: safeTerminalText(result.text) };
}

/** The accounts `gh` is signed in as, best effort: an unreadable answer is an empty list. */
export async function ghAccounts(): Promise<string[]> {
  try {
    const result = await createGhRunner()(['api', 'user', '-q', '.login']);
    const login = result.stdout.trim();
    return result.exitCode === 0 && login.length > 0 ? [login] : [];
  } catch {
    return [];
  }
}

