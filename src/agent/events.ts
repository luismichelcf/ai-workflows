// PLAN-13-R4 §2 and §2.2: the events the agents publish on the piece's issue. A comment IS an
// event only when the agents' own identity wrote it, it was never edited, and its JSON carries
// exactly the fields of its type. §2.2 decides which version each event covers, with one rule
// for the engine and the judge.

import type { ExecutionIdentity } from '../identity.js';
import type { AgentGitHub } from './github.js';

/** The identity an event carries: what the CLI reported, plus the effort it was asked for. */
export interface EventIdentity {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly session: string;
}

/** One comment, as the agents' port reads it: the fields the event rules depend on. */
export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly authorType: 'User' | 'Bot';
  /** The slug of the app the comment was posted through, or null when it was not. */
  readonly viaApp: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BuilderEvent {
  readonly type: 'builder';
  readonly op: string;
  readonly piece: string;
  readonly sha: string;
  readonly identity: EventIdentity;
  /** The whole working tree the builder left, as a tree id. */
  readonly result: string;
  readonly at: string;
}

export interface VerdictEvent {
  readonly type: 'verdict';
  readonly op: string;
  readonly piece: string;
  readonly sha: string;
  readonly identity: EventIdentity;
  readonly angle: string;
  readonly approved: boolean;
  readonly workspace: { readonly before: string; readonly after: string };
  /** The stage id, only in the verdicts a `sandboxed-review` publishes. */
  readonly stage?: string;
  readonly at: string;
}

export type PieceEvent = BuilderEvent | VerdictEvent;

export interface EventRules {
  /** The identity the agents publish with, `<slug>[bot]`. */
  readonly agentAccount: string;
  /** The piece this issue stands for. */
  readonly piece: string;
}

const MARKER = '<!-- ai-workflows:event';
/**
 * The exact shape `renderEventComment` writes: one readable line, a blank line, then the marker
 * and nothing else. A marker buried in a sentence, a second marker, or any text after it means
 * the comment is not the engine's own published event, so it is refused rather than read.
 */
const EVENT_SHAPE = /^([^\n]+)\n+<!-- ai-workflows:event ([^\n]*) -->$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const BUILDER_KEYS = ['version', 'type', 'op', 'piece', 'sha', 'identity', 'result', 'source'] as const;
const VERDICT_KEYS = [
  'version', 'type', 'op', 'piece', 'sha', 'identity', 'angle', 'approved', 'workspace', 'source',
] as const;
const IDENTITY_KEYS = ['provider', 'model', 'effort', 'session'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
}

/** Every required key present, and no key outside `required` and `optional`. */
function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key))) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

function readIdentity(value: unknown): EventIdentity | undefined {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) return undefined;
  const provider = textField(value, 'provider');
  const model = textField(value, 'model');
  const effort = textField(value, 'effort');
  const session = textField(value, 'session');
  if (provider === undefined || model === undefined || effort === undefined || session === undefined) {
    return undefined;
  }
  return { provider, model, effort, session };
}

/** The slug behind a `<slug>[bot]` account, so the comment's app can be compared with it. */
export function slugOf(agentAccount: string): string {
  return agentAccount.replace(/\[bot\]$/, '');
}

function invalidEvent(rules: EventRules, comment: IssueComment): { invalid: string } | undefined {
  if (comment.authorType !== 'Bot') {
    return { invalid: `the comment was not written by a bot account ("${comment.authorType}")` };
  }
  if (comment.author !== rules.agentAccount) {
    return { invalid: `the comment is from "${comment.author}", not ${rules.agentAccount}` };
  }
  if (comment.viaApp !== slugOf(rules.agentAccount)) {
    return { invalid: `the comment was not posted through the declared app` };
  }
  if (comment.updatedAt !== comment.createdAt) {
    return { invalid: 'the comment was edited after it was posted' };
  }
  return undefined;
}

/**
 * Reads one comment: the event it carries, `undefined` when it carries no marker, or an
 * `invalid` reason when it carries the marker but is not a valid event.
 */
export function parseEventComment(
  comment: IssueComment,
  rules: EventRules,
): PieceEvent | { invalid: string } | undefined {
  if (!comment.body.includes(MARKER)) return undefined;

  const match = EVENT_SHAPE.exec(comment.body);
  if (match === null) {
    return { invalid: 'the event marker is not the exact shape the engine writes' };
  }
  const raw = (match[2] ?? '').trim();
  if (raw.length === 0) return { invalid: 'the event marker does not carry valid JSON' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalid: 'the event marker does not carry valid JSON' };
  }
  if (!isRecord(parsed)) return { invalid: 'the event is not a JSON object' };

  const bad = invalidEvent(rules, comment);
  if (bad !== undefined) return bad;

  if (parsed['version'] !== 1) return { invalid: `unknown event version ${String(parsed['version'])}` };
  const type = parsed['type'];
  if (type !== 'builder' && type !== 'verdict') return { invalid: `unknown event type ${String(type)}` };

  const op = textField(parsed, 'op');
  const piece = textField(parsed, 'piece');
  const sha = textField(parsed, 'sha');
  const identity = readIdentity(parsed['identity']);
  if (op === undefined || piece === undefined || sha === undefined || identity === undefined) {
    return { invalid: 'the event is missing its op, piece, sha or identity' };
  }
  if (piece !== rules.piece) return { invalid: `the event is of piece ${piece}, not ${rules.piece}` };
  if (!FULL_SHA.test(sha)) return { invalid: `"${sha}" is not a full hexadecimal SHA` };

  const source = parsed['source'];
  if (source !== 'provider-cli') return { invalid: 'the event does not name a known source' };

  if (type === 'builder') {
    if (!hasExactKeys(parsed, BUILDER_KEYS)) return { invalid: 'the builder event carries the wrong fields' };
    const result = textField(parsed, 'result');
    if (result === undefined || !FULL_SHA.test(result)) {
      return { invalid: 'the builder event does not carry a tree id' };
    }
    return { type: 'builder', op, piece, sha, identity, result, at: comment.createdAt };
  }

  if (!hasExactKeys(parsed, VERDICT_KEYS, ['stage'])) {
    return { invalid: 'the verdict event carries the wrong fields' };
  }
  const angle = textField(parsed, 'angle');
  if (angle === undefined) return { invalid: 'the verdict event does not name its angle' };
  const approved = parsed['approved'];
  if (typeof approved !== 'boolean') return { invalid: 'the verdict event does not approve or reject' };
  const workspace = parsed['workspace'];
  if (
    !isRecord(workspace)
    || !hasExactKeys(workspace, ['before', 'after'])
    || textField(workspace, 'before') === undefined
    || textField(workspace, 'after') === undefined
  ) {
    return { invalid: 'the verdict event does not carry its workspace fingerprints' };
  }
  if (workspace['before'] !== workspace['after']) {
    return { invalid: 'the review changed the workspace it was given' };
  }
  const stage = textField(parsed, 'stage');
  return {
    type: 'verdict',
    op,
    piece,
    sha,
    identity,
    angle,
    approved,
    workspace: { before: workspace['before'] as string, after: workspace['after'] as string },
    ...(stage === undefined ? {} : { stage }),
    at: comment.createdAt,
  };
}

/** The JSON an event is published as, without the reading-only `at`. */
function serialize(event: PieceEvent, source: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: 1,
    type: event.type,
    op: event.op,
    piece: event.piece,
    sha: event.sha,
    identity: event.identity,
  };
  if (event.type === 'builder') {
    return { ...base, result: event.result, source };
  }
  return {
    ...base,
    angle: event.angle,
    approved: event.approved,
    workspace: event.workspace,
    ...(event.stage === undefined ? {} : { stage: event.stage }),
    source,
  };
}

/** Renders the comment: one readable line for people, then the marker the parser reads back. */
export function renderEventComment(event: PieceEvent, locale: string): string {
  const spanish = locale.toLowerCase().startsWith('es');
  const source = (event as { readonly source?: string }).source ?? 'provider-cli';
  const line = spanish
    ? `El agente publicó un evento de tipo ${event.type}.`
    : `An agent published an event of type ${event.type}.`;
  return `${line}\n\n<!-- ai-workflows:event ${JSON.stringify(serialize(event, source))} -->`;
}

/** Every valid event on the piece's issue, in the order the comments were read. */
export async function readPieceEvents(
  github: Pick<AgentGitHub, 'issueComments'>,
  piece: number,
  rules: { readonly agentAccount: string },
): Promise<PieceEvent[]> {
  const comments = await github.issueComments(piece);
  const events: PieceEvent[] = [];
  for (const comment of comments) {
    const result = parseEventComment(comment, { agentAccount: rules.agentAccount, piece: String(piece) });
    if (result !== undefined && !('invalid' in result)) events.push(result);
  }
  return events;
}

export interface SelectVerdictsOptions {
  readonly events: readonly PieceEvent[];
  /** The angles the stage asked for; a verdict of any other angle never decides. */
  readonly angles: readonly string[];
  /** The stage's validity: whether a verdict of `sha` counts for the head. */
  accepts(sha: string): Promise<boolean>;
  /** The tree of a commit, to tell whether a builder changed something. */
  treeOf(sha: string): Promise<string>;
  /**
   * The shas whose commit cannot be read. A builder still excludes its session and family, but
   * its commit cannot say whether it changed something; a verdict cannot decide, however.
   */
  readonly unavailable?: ReadonlySet<string>;
}

export interface SelectVerdictsResult {
  /** Every builder event of the issue, whatever its version (PLAN-13-R4 §2.2). */
  readonly builders: readonly ExecutionIdentity[];
  /** Whether at least one builder left a tree different from the one it found. */
  readonly knownBuilder: boolean;
  /** Per requested angle, the newest verdict whose version the stage accepts. */
  readonly deciding: ReadonlyMap<string, VerdictEvent>;
}

/**
 * Blends every event of the issue into what a stage decides with: all builders (a reviewer
 * must differ from each), whether some builder changed something, and per angle the newest
 * verdict whose version the stage accepts.
 */
export async function selectVerdicts(options: SelectVerdictsOptions): Promise<SelectVerdictsResult> {
  const builders: ExecutionIdentity[] = [];
  let knownBuilder = false;
  for (const event of options.events) {
    if (event.type !== 'builder') continue;
    builders.push(event.identity);
    // A builder whose commit the remote no longer has still excludes its session and family;
    // not being able to read its tree only means it cannot be shown to have changed something.
    if (options.unavailable?.has(event.sha) === true) continue;
    const tree = await options.treeOf(event.sha);
    if (tree !== event.result) knownBuilder = true;
  }

  const deciding = new Map<string, VerdictEvent>();
  for (const event of options.events) {
    if (event.type !== 'verdict') continue;
    if (!options.angles.includes(event.angle)) continue;
    // A verdict about a commit nobody can read cannot decide: it is handled by the caller, which
    // refuses to approve while a newer, unreadable verdict of the same angle could say REVISE.
    if (options.unavailable?.has(event.sha) === true) continue;
    if (!(await options.accepts(event.sha))) continue;
    const current = deciding.get(event.angle);
    if (current === undefined || event.at >= current.at) deciding.set(event.angle, event);
  }

  return { builders, knownBuilder, deciding };
}
