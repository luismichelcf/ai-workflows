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

/**
 * The verified capability matrix. `false` is the default for anything the engine has not
 * actually seen a provider do, because relying on an unverified capability is how a review
 * ends up writing files or a run ends up on an unauthorised model.
 *
 * Every provider here can resume, recover changes and classify errors; those are read from
 * its structured output and have all been verified. `start` is false only for muse, which the
 * engine never spawns directly, and `readOnlyReview` is false for opencode, which has no
 * verified read-only mode.
 */
const CAPABILITIES: Record<ProviderName, Capabilities> = {
  claude: {
    start: true,
    identifyModel: true,
    resume: true,
    readOnlyReview: true,
    recoverChanges: true,
    classifyError: true,
  },
  codex: {
    start: true,
    identifyModel: false,
    resume: true,
    readOnlyReview: true,
    recoverChanges: true,
    classifyError: true,
  },
  opencode: {
    start: true,
    identifyModel: false,
    resume: true,
    readOnlyReview: false,
    recoverChanges: true,
    classifyError: true,
  },
  antigravity: {
    start: true,
    identifyModel: false,
    resume: true,
    readOnlyReview: true,
    recoverChanges: true,
    classifyError: true,
  },
  muse: {
    start: false,
    identifyModel: true,
    resume: true,
    readOnlyReview: false,
    recoverChanges: true,
    classifyError: true,
  },
};

export function capabilities(provider: ProviderName): Capabilities {
  return CAPABILITIES[provider];
}

/** Builds the command for one run. Throws when the provider cannot do what was asked. */
export function buildInvocation(request: RunRequest): Invocation {
  const promptArg = { stdin: request.prompt } as const;

  if (request.provider === 'muse') {
    // Muse is not spawned from here. It runs inside the project's own WSL jail, moved in as a
    // git bundle and back out as a patch; that launcher belongs to the project, not the engine.
    throw new Error(
      'Muse is not started by the engine: use the project launcher that runs it inside its WSL jail.',
    );
  }

  if (request.provider === 'opencode') {
    if (request.mode === 'review') {
      // No read-only mode has been verified for opencode. Improvising one would let a review
      // write files, so refusing is the only honest answer.
      throw new Error(
        'OpenCode has no verified read-only mode, so it cannot run a review.',
      );
    }
    return buildOpencodeInvocation(request, promptArg);
  }

  if (request.provider === 'claude') return buildClaudeInvocation(request, promptArg);
  if (request.provider === 'codex') return buildCodexInvocation(request, promptArg);
  return buildAntigravityInvocation(request, promptArg);
}

function buildClaudeInvocation(
  request: RunRequest,
  prompt: { readonly stdin: string },
): Invocation {
  const args: string[] = ['-p', '--model', request.model];
  if (request.effort !== undefined) args.push('--effort', request.effort);
  args.push('--output-format', 'json');
  // Plan mode cannot write; a build is allowed to edit.
  args.push('--permission-mode', request.mode === 'review' ? 'plan' : 'acceptEdits');
  if (request.resumeSession !== undefined) args.push('--resume', request.resumeSession);
  return { command: 'claude', args, cwd: request.cwd, ...prompt };
}

function buildCodexInvocation(
  request: RunRequest,
  prompt: { readonly stdin: string },
): Invocation {
  const args: string[] = ['exec'];
  if (request.resumeSession !== undefined) args.push('resume', request.resumeSession);
  args.push('-m', request.model);
  if (request.effort !== undefined) {
    // Codex takes the effort as a config override, not a dedicated flag.
    args.push('-c', `model_reasoning_effort="${request.effort}"`);
  }
  if (request.mode === 'review') {
    if (request.resumeSession !== undefined) {
      // `codex exec resume` rejects --sandbox, so on a resumed review the read-only rule has
      // to travel as configuration; using the flag would make the review able to write.
      args.push('-c', 'sandbox_mode="read-only"');
    } else {
      args.push('--sandbox', 'read-only');
    }
  }
  args.push('--json');
  // Codex reads stdin as the prompt when `-` is its final argument.
  args.push('-');
  return { command: 'codex', args, cwd: request.cwd, ...prompt };
}

function buildOpencodeInvocation(
  request: RunRequest,
  prompt: { readonly stdin: string },
): Invocation {
  const args: string[] = ['run', '-m', request.model, '--dir', request.cwd];
  if (request.effort !== undefined) args.push('--variant', request.effort);
  args.push('--format', 'json');
  if (request.mode === 'build') args.push('--auto');
  if (request.resumeSession !== undefined) args.push('-s', request.resumeSession);
  return { command: 'opencode', args, cwd: request.cwd, ...prompt };
}

function buildAntigravityInvocation(
  request: RunRequest,
  prompt: { readonly stdin: string },
): Invocation {
  // Antigravity reports the effort inside the model name, so there is no separate flag.
  const args: string[] = [
    '-p',
    '--model',
    request.model,
    '--add-dir',
    request.cwd,
    '--output-format',
    'json',
  ];
  if (request.mode === 'review') {
    // Plan mode reviews without permission to write; a build may skip permission prompts.
    args.push('--mode', 'plan');
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (request.resumeSession !== undefined) args.push('--conversation', request.resumeSession);
  return { command: 'agy', args, cwd: request.cwd, ...prompt };
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

// Every marker is anchored to the start of the message, and the message is trimmed first.
// That anchoring is the whole guard: the builder sees the output of the project's own tests,
// so a red test's text ends up inside the CLI's error. Matching a bare word anywhere in the
// text read "expected 200 to be 429", "should return 401 Unauthorized" or "memory usage limit
// exceeded" as an outage and quietly relayed the work to another model without the owner
// deciding it. Only the CLI's own phrasing, at the very start of its message, classifies.
const QUOTA_MARKERS = [
  // The two captured provider phrasings, which do not begin with a marker word.
  /^you've hit your usage limit/,
  /^claude ai usage limit reached/,
  // Phrasings that begin with the marker itself.
  /^usage limit/,
  /^rate limit/,
  /^rate-limit/,
  /^quota/,
  /^429\b/,
  /^too many requests/,
];
const AUTH_MARKERS = [
  /^invalid api key/,
  /^unauthorized/,
  /^401 unauthorized/,
  /^please run \/login/,
  /^not logged in/,
  /^not signed in/,
];

/**
 * Rule 2: a failure is only a quota when the CLI's own message says so at its start; anything
 * unrecognised is a plain failure. Guessing "quota" here would silently relay the work to
 * another model, which is exactly the incident this function exists to prevent.
 */
function classifyFailure(message: string): RunStatus {
  const text = message.trim().toLowerCase();
  if (QUOTA_MARKERS.some((marker) => marker.test(text))) return 'quota';
  if (AUTH_MARKERS.some((marker) => marker.test(text))) return 'auth';
  return 'failed';
}

/** Codex reports no model of its own, so its `identity.model` is the requested one. */
function parseCodex(request: RunRequest, output: string): RunReport {
  let session: string | undefined;
  let text: string | undefined;
  // A failure anywhere in the stream wins over a later completion. Codex can report a failed
  // turn and then a completed one; reading only the last event declared success over work
  // that did not happen. An empty `thread_id` is not an identity: accepting it would make two
  // different runs look like "the same execution" to the identity gates.
  let failed = false;
  let completed = false;
  let failureMessage = '';

  for (const event of parseJsonLines(output)) {
    const type = asString(event.type);
    if (type === 'thread.started') {
      const id = asString(event.thread_id);
      if (session === undefined && id !== undefined && id.trim() !== '') session = id;
    } else if (type === 'item.completed') {
      const item = asObject(event.item);
      if (item && asString(item.type) === 'agent_message') {
        // The final message is the last agent message, not the first.
        text = asString(item.text) ?? text;
      }
    } else if (type === 'turn.completed') {
      completed = true;
    } else if (type === 'turn.failed') {
      failed = true;
      const error = asObject(event.error);
      failureMessage = (error && asString(error.message)) ?? '';
    }
  }

  if (failed) {
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
  if (completed) {
    return buildReport(request, session, request.model, false, 'success', text);
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
  // The main session is the one named by the first event that carries a session id. Events
  // from other sessions mixed into the stream (a sub-agent, a resumed run) are ignored: a
  // stop there says nothing about this run.
  let mainSession: string | undefined;
  let text: string | undefined;
  // Only the LAST event of the main session decides. A stop followed by any further step or
  // text means the process died mid-turn, so the run never reached its end. Tracking "any
  // stop seen" reported success over a run that was cut off after the stop.
  let lastWasStop = false;
  let sawMainEvent = false;

  for (const event of parseJsonLines(output)) {
    const eventSession = asString(event.sessionID);
    if (mainSession === undefined && eventSession !== undefined) mainSession = eventSession;
    if (mainSession !== undefined && eventSession !== mainSession) continue;

    sawMainEvent = true;
    lastWasStop = false;

    const type = asString(event.type);
    if (type === 'text') {
      const part = asObject(event.part);
      if (part) text = asString(part.text) ?? text;
    } else if (type === 'step_finish') {
      const part = asObject(event.part);
      // `reason: 'tool-calls'` is a mid-turn step; only a stop finishes the run.
      if (part && asString(part.reason) === 'stop') lastWasStop = true;
    }
  }

  if (sawMainEvent && lastWasStop) {
    return buildReport(request, mainSession, request.model, false, 'success', text);
  }
  return buildReport(
    request,
    mainSession,
    request.model,
    false,
    'incomplete',
    text,
    'The last step did not finish with a stop; the run stopped mid-turn.',
  );
}

/**
 * The main model is the one that did the work: the entry with the most output tokens. The
 * requested model being present is not enough — Claude Code can run a small auxiliary model
 * for background chores, and if the chosen model only touched a few tokens the run the owner
 * authorised did not happen. A single entry is the main one by definition.
 */
function pickModel(usage: JsonObject): string | undefined {
  let main: string | undefined;
  let mostTokens = -1;
  for (const [name, entry] of Object.entries(usage)) {
    const tokens = asNumber(asObject(entry)?.outputTokens) ?? 0;
    if (tokens > mostTokens) {
      main = name;
      mostTokens = tokens;
    }
  }
  return main;
}

/**
 * Takes the last line that is a JSON object. The CLI sometimes prints a warning line before
 * its JSON result; reading the whole output as one document would then lose a run that did
 * finish. A stream with no JSON object at all still comes back undefined and is incomplete.
 */
function parseLastJsonRecord(output: string): JsonObject | undefined {
  const whole = asObject(parseJsonDocument(output));
  if (whole) return whole;

  let found: JsonObject | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = asObject(parseJsonDocument(trimmed));
    if (record) found = record;
  }
  return found;
}

function parseClaude(request: RunRequest, output: string): RunReport {
  const record = parseLastJsonRecord(output);
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
  const reportedModel = usage ? pickModel(usage) : undefined;

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
  // Any configured model other than the requested one fails the run. Keeping the first
  // configured model let a later switch to another model go unnoticed.
  let mismatchedModel: string | undefined;
  // The LAST terminal event decides. A completion followed by a frozen proposal is not a
  // finished run: muse stops on the proposal and never comes back in exec mode.
  let lastTerminal: 'completed' | 'proposed' | undefined;

  for (const event of parseJsonLines(output)) {
    const type = asString(event.type);

    if (type === 'stream') {
      if (asString(event.kind) === 'session') session ??= asString(event.session_id);
    } else if (type === 'run.model.configured') {
      const configured = asString(event.model);
      model ??= configured;
      if (configured !== undefined && configured !== request.model && mismatchedModel === undefined) {
        mismatchedModel = configured;
      }
    } else if (type === 'run.terminal.completed') {
      lastTerminal = 'completed';
    } else if (type === 'task.lifecycle.proposed') {
      lastTerminal = 'proposed';
    }
  }

  if (mismatchedModel !== undefined) {
    // Muse echoes the model it configured; a mismatch is a different run than the one asked
    // for, and it fails even if the turn later completed. The reason names the model that
    // actually ran, not the requested one.
    return buildReport(
      request,
      session,
      mismatchedModel,
      true,
      'failed',
      undefined,
      `Muse configured ${mismatchedModel} when ${request.model} was requested.`,
    );
  }

  const modelConfirmed = model !== undefined;

  if (lastTerminal === 'completed') {
    return buildReport(request, session, model ?? request.model, modelConfirmed, 'success');
  }

  if (lastTerminal === 'proposed') {
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

/** One assignment is the same as another when it names the same provider, model and effort. */
function sameAssignment(a: Assignment, b: Assignment): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/**
 * The company whose account an assignment spends from. A quota is shared by the company, not
 * by the model or the effort: every model under one company bills the same account, so
 * swapping an exhausted model for a sibling, or just raising the effort, cannot help.
 *
 * The company is usually the CLI provider, but OpenCode is the exception that makes this a
 * function instead of a string compare. OpenCode fronts models from several companies behind
 * separate accounts and names the company in the `company/model` prefix
 * (`deepseek/deepseek-flash` -> `deepseek`). Treating all of OpenCode as one company would
 * refuse a relay that is actually moving to a different account, which is a valid relay.
 */
function companyOf(provider: string, model: string): string {
  if (provider === 'opencode') {
    const slash = model.indexOf('/');
    if (slash > 0) return model.slice(0, slash);
    return model;
  }
  return provider;
}

/**
 * What happens after one run. The owner's rules, applied literally:
 *
 *   - Who failed is who the report says. `report.identity` names the provider and model that
 *     just failed, so the engine never relays back to it even when `tried` is empty, and the
 *     reason names that model rather than the first in the chain.
 *   - Only a quota or an auth failure may relay on its own, and only to the next assignment
 *     he named in the same answer. A quota is shared by the company, so no option from the
 *     failing model's company, and not the same model at another effort, is ever chosen.
 *   - The relay only ever moves forward in the owner's order, past the most advanced option
 *     already tried and past the failed model. An option the owner ranked earlier is never
 *     revisited.
 *   - A quality failure (`failed`) never relays: changing heads because the work was poor is
 *     his decision, not the engine's.
 *   - A timeout or a hang (`incomplete`) is inspected, because a cutoff is not a quota and
 *     must never be silently handed to another model.
 *   - Two rounds stuck on the same point means changing heads, which is his call — overrides
 *     everything except an outright success.
 *   - A counter the engine cannot trust (NaN, negative, fractional, infinite) is also his
 *     call, because a corrupted state must not drive an automatic relay.
 */
export function decideRelay(report: RunReport, state: RelayState): RelayDecision {
  // A success needs no decision at all; it is checked first so it survives both the stuck
  // rule and a corrupted counter.
  if (report.status === 'success') return { action: 'continue' };

  // A state the engine cannot parse cannot authorise a relay. NaN, a negative, a fractional
  // or an infinite round count is corruption, and only the owner can read it.
  if (!Number.isInteger(state.stuckRounds) || state.stuckRounds < 0) {
    return {
      action: 'ask-owner',
      reason: `The stuck-round counter (${state.stuckRounds}) is not a valid count; the owner must decide.`,
    };
  }

  // Two stuck rounds in the same place means the head has to change, and only the owner
  // chooses who runs next. This wins over quota/auth so a flapping relay cannot loop.
  if (state.stuckRounds >= 2) {
    return {
      action: 'ask-owner',
      reason: `Stuck for ${state.stuckRounds} rounds on the same point; the owner must choose who runs next.`,
    };
  }

  if (report.status === 'quota' || report.status === 'auth') {
    // Who failed: the report's own identity, when it has one. It is the only trustworthy
    // source, because `tried` can be empty (rule 1) or stale.
    const identity = report.identity;
    const failed =
      identity !== undefined && identity.provider !== '' && identity.model !== ''
        ? { provider: identity.provider, model: identity.model }
        : undefined;

    // The search starts after the furthest point the owner's order has already reached: the
    // most advanced assignment already tried, and the failed model itself. Moving only
    // forward is what stops the relay from stepping back onto an earlier-ranked option.
    let furthestTried = -1;
    for (const attempt of state.tried) {
      const index = state.chain.findIndex((candidate) => sameAssignment(candidate, attempt));
      if (index > furthestTried) furthestTried = index;
    }

    let failedIndex = -1;
    if (failed !== undefined) {
      // The identity carries no effort, so match provider and model only. Among several
      // efforts of the same model, take the last, so the search cannot land on an earlier one.
      state.chain.forEach((candidate, index) => {
        if (candidate.provider === failed.provider && candidate.model === failed.model) {
          failedIndex = index;
        }
      });
    }

    const startAt = Math.max(furthestTried, failedIndex);

    for (let index = startAt + 1; index < state.chain.length; index += 1) {
      const candidate = state.chain[index];
      if (candidate === undefined) continue;
      // An already-tried option is never picked, even if the owner listed it again.
      if (state.tried.some((attempt) => sameAssignment(attempt, candidate))) continue;
      // Rule 3: a quota/auth is shared by the company. `sameCompany` also covers the same
      // model at a different effort, since a model is always in its own company.
      if (
        failed !== undefined &&
        companyOf(candidate.provider, candidate.model) === companyOf(failed.provider, failed.model)
      ) {
        continue;
      }

      // The reason names the model that actually failed, not the first in the chain.
      const failedModel =
        failed?.model ?? state.chain[Math.max(furthestTried, 0)]?.model ?? 'current model';
      const cause = report.status === 'quota' ? 'ran out of quota' : 'is not signed in';
      const detail = report.reason !== undefined ? ` (${report.reason})` : '';
      return {
        action: 'relay',
        to: candidate,
        reason: `${report.status === 'quota' ? 'Quota' : 'Auth'}: ${failedModel} ${cause}${detail}; relaying to ${candidate.model}.`,
      };
    }

    return {
      action: 'ask-owner',
      reason: `The owner's chain is exhausted for this block; no valid assignment remains after ${failed?.model ?? 'the attempted options'}.`,
    };
  }

  if (report.status === 'incomplete') {
    // Nothing confirms whether this was a quota; a person looks at the process and the work.
    return {
      action: 'inspect',
      reason: 'The run never reached a terminal record (cut off, hung or awaiting approval); inspect it before relaying.',
    };
  }

  // `failed`: the work finished and went wrong. Automatic relay is never allowed for quality.
  return {
    action: 'ask-owner',
    reason:
      report.reason !== undefined
        ? `The run failed (${report.reason}); only the owner decides whether to change heads.`
        : 'The run failed; only the owner decides whether to change heads.',
  };
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

/**
 * The command each provider is detected through, matching `buildInvocation`. Antigravity's
 * binary is `agy`; muse is not spawned by the engine, so it has no probe here.
 */
const PROVIDER_COMMAND: Record<ProviderName, string | undefined> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
  muse: undefined,
};

/** Text emitted by a shell when the command does not exist. */
const NOT_FOUND_MARKERS = [
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /no such file or directory/i,
  /not found/i,
];

function looksNotInstalled(run: RawRun): boolean {
  if (run.exitCode === null) return true;
  return NOT_FOUND_MARKERS.some((marker) => marker.test(run.output));
}

function notInstalled(name: ProviderName, command: string | undefined): Detection {
  const label = command ?? name;
  return {
    name,
    installed: false,
    authenticated: false,
    models: [],
    problem: `The '${label}' command is not installed. Install it and sign in before retrying.`,
  };
}

export interface DetectOptions {
  /** How long one probe may take before it counts as failed. */
  readonly timeoutMs?: number;
}

/** Finds out what is installed and signed in. Never throws: a missing CLI is an answer. */
export async function detectProvider(
  provider: ProviderName,
  run: CommandRunner,
  _options: DetectOptions = {},
): Promise<Detection> {
  const command = PROVIDER_COMMAND[provider];
  if (command === undefined) {
    // Muse is moved in and out of its own WSL jail by the project launcher, never probed here.
    return {
      name: provider,
      installed: false,
      authenticated: false,
      models: [],
      problem: `'${provider}' is not started by the engine; use the project launcher that runs it in its WSL jail.`,
    };
  }

  let version: RawRun;
  try {
    version = await run(command, ['--version']);
  } catch {
    // The runner failing (spawn EINVAL, a killed process) is itself the answer: the CLI could
    // not be started, so it is reported as not installed instead of being thrown onward.
    return notInstalled(provider, command);
  }

  if (looksNotInstalled(version)) return notInstalled(provider, command);

  if (provider !== 'opencode') {
    // Installed is all that was verified for these CLIs. Claiming a session from an output we
    // cannot read safely would be a guess, so it is reported as not authenticated with a note.
    return {
      name: provider,
      installed: true,
      authenticated: false,
      models: [],
      problem: `'${command}' is installed, but its sign-in could not be verified safely; check it is logged in.`,
    };
  }

  // OpenCode is the provider whose output format is verified, so its models and session are read.
  const models: string[] = [];
  let authProblem: string | undefined;

  const modelsRun = await guard(run, command, ['models']);
  if (modelsRun !== undefined && !looksNotInstalled(modelsRun)) {
    for (const line of modelsRun.output.split(/\r?\n/)) {
      const model = line.trim();
      if (model !== '') models.push(model);
    }
  }

  const authRun = await guard(run, command, ['auth', 'list']);
  if (authRun === undefined || looksNotInstalled(authRun)) {
    authProblem = `'${command}' is installed, but its sign-in could not be checked; run '${command} auth login' and verify.`;
  } else if (/0 credentials/i.test(authRun.output) || authRun.output.trim() === '') {
    authProblem = `'${command}' is installed but has no credentials; run '${command} auth login' to sign in.`;
  }

  return {
    name: provider,
    installed: true,
    authenticated: authProblem === undefined,
    models,
    ...(authProblem !== undefined ? { problem: authProblem } : {}),
  };
}

/**
 * Runs one probe and never lets its failure escape: an unusable answer is reported as
 * `undefined` and the caller turns it into a problem, keeping detectProvider total.
 */
async function guard(
  run: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<RawRun | undefined> {
  try {
    return await run(command, args);
  } catch {
    return undefined;
  }
}
