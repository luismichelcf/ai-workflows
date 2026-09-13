// How the engine talks to the coding CLIs: Claude Code, Codex, OpenCode, Antigravity, Muse.
//
// Three rules shape everything here, each one learned from a real incident:
//
//   1. Exit code 0 is not success. A CLI can exit cleanly having done nothing, having hit a
//      quota, or having been cut off mid-stream. Success is read from its own structured
//      output: a terminal event, a result record, a status field.
//   2. A timeout is not a quota. Treating an unrecognised failure as "out of quota" would
//      silently hand the work to another model. Anything not clearly identified is `failed`
//      or `incomplete`, and a person looks at it.
//   3. The prompt is data, never shell. It travels on stdin or as one argument, and no
//      command line is ever built by concatenating strings.
//
// Everything in this file is pure: building an invocation and reading an output. Actually
// spawning the process belongs to the runner, so these rules can be tested without calling
// a paid model.

import type { ExecutionIdentity } from './identity.js';

export type ProviderName = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'muse';

export interface RunRequest {
  readonly provider: ProviderName;
  readonly model: string;
  readonly effort?: string;
  /** Absolute path of the piece's own folder. */
  readonly cwd: string;
  readonly prompt: string;
  /** A review must run read-only. A build may write inside `cwd`. */
  readonly mode: 'build' | 'review';
  /** Continue exactly this session instead of opening a new one — never "the last one". */
  readonly resumeSession?: string;
}

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** When set, the prompt travels here. */
  readonly stdin?: string;
}

export type RunStatus =
  /** Finished, with its terminal record, and did what was asked. */
  | 'success'
  /** Explicitly out of quota or rate-limited. The only failure that may trigger a relay. */
  | 'quota'
  /** Explicitly not signed in. Also relayable, since no retry will fix it. */
  | 'auth'
  /** Finished and failed, or failed in a way nobody recognised. */
  | 'failed'
  /** Never reached its terminal record: cut off, hung, or waiting on an approval. */
  | 'incomplete';

export interface RawRun {
  readonly output: string;
  /** `null` when the process could not be started or was killed. */
  readonly exitCode: number | null;
}

export interface RunReport {
  readonly status: RunStatus;
  /** Who did the work, for the identity gates. Present whenever the session is known. */
  readonly identity?: ExecutionIdentity;
  /**
   * Whether the model in `identity` was reported by the CLI itself. When false it is the
   * model that was requested, and the identity gates should know that.
   */
  readonly modelConfirmed: boolean;
  /** The final message, when there is one. */
  readonly text?: string;
  readonly reason?: string;
}

/**
 * What each provider has been verified to do. `false` means not verified, not "impossible":
 * the engine must not rely on a capability nobody checked.
 */
export interface Capabilities {
  readonly start: boolean;
  readonly identifyModel: boolean;
  readonly resume: boolean;
  /** Can run a review without being able to write. */
  readonly readOnlyReview: boolean;
  readonly recoverChanges: boolean;
  readonly classifyError: boolean;
}

export function capabilities(_provider: ProviderName): Capabilities {
  throw new Error('capabilities: not implemented');
}

/** Builds the command for one run. Throws when the provider cannot do what was asked. */
export function buildInvocation(_request: RunRequest): Invocation {
  throw new Error('buildInvocation: not implemented');
}

/** Reads what a run actually did, from the CLI's own structured output. */
export function parseRun(request: RunRequest, run: RawRun): RunReport {
  // Rule 1: the exit code says nothing. A clean exit with no output is a run that did
  // nothing, and every provider has to report that as incomplete rather than success.
  if (run.output.trim() === '') {
    return { status: 'incomplete', modelConfirmed: false, reason: 'The run produced no output.' };
  }

  if (request.provider === 'codex') return parseCodex(request, run.output);
  if (request.provider === 'opencode') return parseOpencode(request, run.output);
  if (request.provider === 'claude') return parseClaude(request, run.output);
  if (request.provider === 'antigravity') return parseAntigravity(request, run.output);
  return parseMuse(request, run.output);
}

// ---------------------------------------------------------------------------------------
// Reading the CLIs' structured output
// ---------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parses one JSON document, or undefined when the CLI emitted prose, HTML or a broken body. */
function parseJsonDocument(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    // Not JSON at all. The caller reports it as incomplete; parseRun never throws on bad input.
    return undefined;
  }
}

/**
 * JSONL is read line by line and non-JSON lines are skipped: a CLI may interleave plain-text
 * progress or warnings with its events. A stream that is all noise ends up with no terminal
 * event, which the provider parsers already read as incomplete.
 */
function parseJsonLines(output: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const event = asObject(parseJsonDocument(trimmed));
    if (event) events.push(event);
  }
  return events;
}

function buildReport(
  request: RunRequest,
  session: string | undefined,
  model: string,
  modelConfirmed: boolean,
  status: RunStatus,
  text?: string,
  reason?: string,
): RunReport {
  return {
    status,
    modelConfirmed,
    ...(session !== undefined ? { identity: { provider: request.provider, model, session } } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

const QUOTA_MARKERS = [/usage limit/, /rate limit/, /rate-limit/, /quota/, /\b429\b/, /too many requests/];
const AUTH_MARKERS = [
  /invalid api key/,
  /unauthorized/,
  /\b401\b/,
  /please run \/login/,
  /not logged in/,
  /not signed in/,
  /\blogin\b/,
  /authentication/,
];

/**
 * Rule 2: a failure is only a quota when the text says so; anything unrecognised is a plain
 * failure. Guessing "quota" here would silently relay the work to another model, which is
 * exactly the incident this function exists to prevent.
 */
function classifyFailure(message: string): RunStatus {
  const text = message.toLowerCase();
  if (QUOTA_MARKERS.some((marker) => marker.test(text))) return 'quota';
  if (AUTH_MARKERS.some((marker) => marker.test(text))) return 'auth';
  return 'failed';
}

/** Codex reports no model of its own, so its `identity.model` is the requested one. */
function parseCodex(request: RunRequest, output: string): RunReport {
  let session: string | undefined;
  let text: string | undefined;
  let terminal: 'completed' | 'failed' | undefined;
  let failureMessage = '';

  for (const event of parseJsonLines(output)) {
    const type = asString(event.type);
    if (type === 'thread.started') {
      session ??= asString(event.thread_id);
    } else if (type === 'item.completed') {
      const item = asObject(event.item);
      if (item && asString(item.type) === 'agent_message') {
        // The final message is the last agent message, not the first.
        text = asString(item.text) ?? text;
      }
    } else if (type === 'turn.completed') {
      terminal = 'completed';
    } else if (type === 'turn.failed') {
      terminal = 'failed';
      const error = asObject(event.error);
      failureMessage = (error && asString(error.message)) ?? '';
    }
  }

  if (terminal === 'completed') {
    return buildReport(request, session, request.model, false, 'success', text);
  }
  if (terminal === 'failed') {
    return buildReport(
      request,
      session,
      request.model,
      false,
      classifyFailure(failureMessage),
      text,
      failureMessage,
    );
  }
  return buildReport(
    request,
    session,
    request.model,
    false,
    'incomplete',
    text,
    'The codex stream ended without a terminal turn event.',
  );
}

/** OpenCode reports its session but not the model it ran, so the model stays unconfirmed. */
function parseOpencode(request: RunRequest, output: string): RunReport {
  let session: string | undefined;
  let text: string | undefined;
  let stopped = false;

  for (const event of parseJsonLines(output)) {
    const type = asString(event.type);
    session ??= asString(event.sessionID);

    if (type === 'text') {
      const part = asObject(event.part);
      if (part) text = asString(part.text) ?? text;
    } else if (type === 'step_finish') {
      const part = asObject(event.part);
      // `reason: 'tool-calls'` is a mid-turn step; only a stop finishes the run.
      if (part && asString(part.reason) === 'stop') stopped = true;
    }
  }

  if (stopped) {
    return buildReport(request, session, request.model, false, 'success', text);
  }
  return buildReport(
    request,
    session,
    request.model,
    false,
    'incomplete',
    text,
    'The last step did not finish with a stop; the run stopped mid-turn.',
  );
}

/** Prefers the requested model when it is among those used; otherwise the first reported one. */
function pickModel(usage: JsonObject, requested: string): string | undefined {
  const models = Object.keys(usage);
  if (models.includes(requested)) return requested;
  return models[0];
}

function parseClaude(request: RunRequest, output: string): RunReport {
  const record = asObject(parseJsonDocument(output));
  if (!record) {
    return buildReport(
      request,
      undefined,
      request.model,
      false,
      'incomplete',
      undefined,
      'Claude returned something that is not a single JSON result.',
    );
  }

  const session = asString(record.session_id);
  const resultText = asString(record.result);
  const subtype = asString(record.subtype);
  const succeeded = subtype === 'success' && record.is_error !== true;

  // `modelUsage` names the model that actually ran; that is the only model Claude confirms.
  const usage = asObject(record.modelUsage);
  const reportedModel = usage ? pickModel(usage, request.model) : undefined;

  if (!succeeded) {
    const detail = resultText ?? subtype ?? '';
    return buildReport(
      request,
      session,
      reportedModel ?? request.model,
      reportedModel !== undefined,
      classifyFailure(detail),
      resultText,
      detail,
    );
  }

  if (reportedModel !== undefined && reportedModel !== request.model) {
    // Never let an alias switch pass silently: a run on another model is not the run the
    // owner authorised, so it fails and the reason names both models.
    return buildReport(
      request,
      session,
      reportedModel,
      true,
      'failed',
      resultText,
      `Claude used ${reportedModel} when ${request.model} was requested.`,
    );
  }

  return buildReport(
    request,
    session,
    reportedModel ?? request.model,
    reportedModel !== undefined,
    'success',
    resultText,
  );
}

function parseAntigravity(request: RunRequest, output: string): RunReport {
  const record = asObject(parseJsonDocument(output));
  if (!record) {
    return buildReport(
      request,
      undefined,
      request.model,
      false,
      'incomplete',
      undefined,
      'Antigravity returned something that is not a single JSON result.',
    );
  }

  const status = asString(record.status);
  const session = asString(record.conversation_id);
  const response = asString(record.response);

  if (status === 'SUCCESS' && response !== undefined && response.trim() !== '') {
    return buildReport(request, session, request.model, false, 'success', response);
  }
  if (status === 'SUCCESS') {
    // Measured in this house: SUCCESS with an empty response means it did nothing at all.
    return buildReport(
      request,
      session,
      request.model,
      false,
      'incomplete',
      undefined,
      'Antigravity reported SUCCESS with an empty response, so it did no work.',
    );
  }

  const detail = response ?? status ?? '';
  return buildReport(
    request,
    session,
    request.model,
    false,
    classifyFailure(detail),
    response,
    detail,
  );
}

function parseMuse(request: RunRequest, output: string): RunReport {
  let session: string | undefined;
  let model: string | undefined;
  let completed = false;
  let lastType: string | undefined;

  for (const event of parseJsonLines(output)) {
    const type = asString(event.type);
    lastType = type ?? lastType;

    if (type === 'stream') {
      if (asString(event.kind) === 'session') session ??= asString(event.session_id);
    } else if (type === 'run.model.configured') {
      model ??= asString(event.model);
    } else if (type === 'run.terminal.completed') {
      completed = true;
    }
  }

  if (model !== undefined && model !== request.model) {
    // Muse echoes the model it configured; a mismatch is a different run than the one asked
    // for, and it fails even if the turn later completed.
    return buildReport(
      request,
      session,
      model,
      true,
      'failed',
      undefined,
      `Muse configured ${model} when ${request.model} was requested.`,
    );
  }

  const modelConfirmed = model !== undefined;

  if (completed) {
    return buildReport(request, session, model ?? request.model, modelConfirmed, 'success');
  }

  if (lastType === 'task.lifecycle.proposed') {
    // Documented: with a compound shell command muse waits for a human approval that never
    // arrives in exec mode; the stream simply stops on the proposal.
    return buildReport(
      request,
      session,
      model ?? request.model,
      modelConfirmed,
      'incomplete',
      undefined,
      'Muse stopped on a proposed action, waiting for an approval that never arrived.',
    );
  }

  return buildReport(
    request,
    session,
    model ?? request.model,
    modelConfirmed,
    'incomplete',
    undefined,
    'The muse stream ended without a terminal event.',
  );
}

// ---------------------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------------------

export interface Assignment {
  readonly provider: ProviderName;
  readonly model: string;
  readonly effort?: string;
}

export interface RelayState {
  /**
   * The owner's choice for this piece, in order: the builder first, then the relay he named
   * in the same answer. Nothing outside this list is ever picked.
   */
  readonly chain: readonly Assignment[];
  /** Assignments already tried for this same block. */
  readonly tried: readonly Assignment[];
  /** Consecutive rounds stuck on the same point. */
  readonly stuckRounds: number;
}

export type RelayDecision =
  | { readonly action: 'continue' }
  /** Hand the same work to the next assignment in the owner's chain. */
  | { readonly action: 'relay'; readonly to: Assignment; readonly reason: string }
  /** A person has to look before anything else happens. */
  | { readonly action: 'inspect'; readonly reason: string }
  /** Only the owner can decide this one. */
  | { readonly action: 'ask-owner'; readonly reason: string };

export function decideRelay(_report: RunReport, _state: RelayState): RelayDecision {
  throw new Error('decideRelay: not implemented');
}

// ---------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------

export type CommandRunner = (command: string, args: readonly string[]) => Promise<RawRun>;

export interface Detection {
  readonly name: ProviderName;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly models: readonly string[];
  /** What is missing and what to do about it, in words. */
  readonly problem?: string;
}

/** Finds out what is installed and signed in. Never throws: a missing CLI is an answer. */
export function detectProvider(_provider: ProviderName, _run: CommandRunner): Promise<Detection> {
  throw new Error('detectProvider: not implemented');
}
