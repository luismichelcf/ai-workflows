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

/**
 * The effort values each CLI documents. A value outside its own list is refused rather than
 * passed through: measured, `claude` prints "Unknown --effort value … using the default
 * effort" and runs anyway, so a typo would silently run at an effort nobody chose. OpenCode
 * has no closed list verified here, so it only gets the flag-looking-value guard.
 */
const KNOWN_EFFORTS: Record<ProviderName, readonly string[] | undefined> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  antigravity: ['low', 'medium', 'high'],
  opencode: undefined,
  muse: undefined,
};

/**
 * Refuses a value that starts with a dash. To the CLI's own argument parser such a value is
 * indistinguishable from a flag: a tampered `resumeSession` of `--dangerously-skip-permissions`
 * would otherwise switch on write access inside a review. The prompt never travels as a flag.
 */
function requireNotFlag(field: string, value: string): void {
  if (value.startsWith('-')) {
    throw new Error(`The ${field} '${value}' starts with a dash and looks like a flag; refusing it.`);
  }
}

/**
 * Absolute Windows (`C:\…`, `C:/…`) or POSIX (`/…`) path. A `cwd` that is relative is refused
 * because the CLI would resolve it against whatever folder the engine happened to be in, not
 * the piece's own folder, and a `--add-dir`-style value that looks like a flag is refused by
 * `requireNotFlag` because the CLI's parser cannot tell it apart from an option.
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;

/**
 * The folder a run may touch has to be an absolute path. An empty or relative value would let
 * a run work in the wrong tree, and a flag-looking value was landing right after `--add-dir`.
 */
function requireCwd(cwd: string): void {
  if (cwd === '') {
    throw new Error('The cwd is empty; an absolute folder is required so a run cannot work in the wrong tree.');
  }
  requireNotFlag('cwd', cwd);
  if (!ABSOLUTE_PATH.test(cwd)) {
    throw new Error(`The cwd '${cwd}' is not an absolute path; refusing it rather than letting the CLI resolve it.`);
  }
}

/**
 * A model name has to be present. An empty value would travel as `--model ''`, which the CLI
 * reads as a missing or default model rather than the one the owner authorised. A value made
 * only of spaces is just as empty: the CLI trims it to nothing and picks its own model, so it
 * is refused here rather than silently running on a model nobody chose.
 */
function requireModel(model: string): void {
  if (model.trim() === '') {
    throw new Error('The model is empty; a model name is required so the CLI cannot pick one.');
  }
  requireNotFlag('model', model);
}

/** A session id is one opaque token: no spaces and no shell metacharacters. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function requireSessionId(session: string): void {
  requireNotFlag('resumeSession', session);
  if (!SESSION_ID.test(session)) {
    throw new Error(
      `The resumeSession '${session}' is not a valid session id (letters, digits, dot, underscore, colon or dash only); refusing it.`,
    );
  }
}

function requireEffort(provider: ProviderName, effort: string): void {
  requireNotFlag('effort', effort);
  const known = KNOWN_EFFORTS[provider];
  if (known !== undefined && !known.includes(effort)) {
    throw new Error(
      `The effort '${effort}' is not one of ${known.join(', ')} for ${provider}; refusing it rather than running at an unrequested effort.`,
    );
  }
}

/** Builds the command for one run. Throws when the provider cannot do what was asked. */
export function buildInvocation(request: RunRequest): Invocation {
  const promptArg = { stdin: request.prompt } as const;

  // Every value that reaches the command line is checked before it is placed there. The prompt
  // is exempt: it travels on stdin and is never an argument unless it is the data itself.
  requireModel(request.model);
  requireCwd(request.cwd);
  if (request.effort !== undefined) requireEffort(request.provider, request.effort);
  if (request.resumeSession !== undefined) requireSessionId(request.resumeSession);

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
  // `--print-timeout` defaults to 5 minutes, which cut off every build longer than that; the
  // explicit value keeps a build alive, while a review is bounded tighter than a build.
  const printTimeout = request.mode === 'review' ? '10m' : '30m';
  const args: string[] = [
    '--model',
    request.model,
    '--add-dir',
    request.cwd,
    '--output-format',
    'json',
  ];
  // `agy --help` lists --effort (low|medium|high); dropping it silently ran at the default.
  if (request.effort !== undefined) args.push('--effort', request.effort);
  args.push('--print-timeout', printTimeout);
  if (request.mode === 'review') {
    // Plan mode reviews without permission to write; a build may skip permission prompts.
    args.push('--mode', 'plan');
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (request.resumeSession !== undefined) args.push('--conversation', request.resumeSession);
  // `-p` is the prompt flag and has to be last: a flag placed after it would be read as its
  // value. The prompt itself still travels on stdin, never as an argument.
  args.push('-p');
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

/** How long one probe may take before it counts as failed, when the caller says nothing. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * The largest deadline a caller may ask for. A timeout has to be a positive integer: with
 * `Infinity` the deadline never fires and every probe reads as "not installed"; 0, a negative,
 * a fractional or an out-of-range value is not a deadline at all. Such a value is refused
 * before any probe runs.
 */
const MAX_PROBE_TIMEOUT_MS = 2 ** 31 - 1;

function validTimeout(timeoutMs: number): boolean {
  return Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_PROBE_TIMEOUT_MS;
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

/** The outcome of one probe: what it answered, or why it could not be believed. */
type ProbeResult =
  | { readonly ok: true; readonly run: RawRun }
  | { readonly ok: false; readonly reason: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one probe under a deadline. A rejection (spawn EINVAL, a killed process) and a probe
 * that never answers both come back as a failed `ProbeResult`, never as a throw and never as
 * a wait that has no end. Surface the failure reason instead of swallowing it, so the caller
 * can put in `problem` what actually happened.
 */
async function probe(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const attempt = Promise.resolve()
      .then(() => run(command, args))
      .then((answered): ProbeResult => ({ ok: true, run: answered }))
      .catch((error: unknown): ProbeResult => ({ ok: false, reason: describeError(error) }));
    const raced = await Promise.race([attempt, deadline]);
    if (raced === 'timeout') {
      return { ok: false, reason: `did not answer within ${timeoutMs}ms` };
    }
    return raced;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A model line as OpenCode prints it: `provider/model`, or a longer chain such as
 * `openrouter/qwen/qwen3.7-max`. Only lines matching this shape are listed. A blacklist of
 * "error" and "at" prefixes still let a deprecation warning, a `TypeError:` line or a `WARN`
 * line through and listed it as a model the engine would then try to run. Anchored at both
 * ends, and a single group repeated one-or-more times: the old pattern accepted exactly one
 * slash and dropped the 4410 of 7784 cached models that name a vendor between the provider and
 * the model. A space can never appear inside, so a prose line that merely contains a slash is
 * ignored.
 */
const MODEL_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._:@+-]+)+$/;

/**
 * An `Error` at the start of any line, case-insensitively, means the probe failed even when it
 * exited 0. The review found that checking only the very start of the whole output let an
 * `Error:` on a later line be read as a signed-in session. The `m` flag checks every line.
 * The word boundary keeps `Errorless` from counting as an error.
 */
const ERROR_LINE = /^error\b/im;

/**
 * An ANSI escape sequence (CSI: ESC `[`, parameters, final byte). Stripped from `auth list`
 * output before any marker is read, because opencode colours its own failures
 * (`ESC[91mESC[1mError: `) and an anchored match would otherwise never reach the word. The
 * pattern consumes a run of parameter characters in one pass, so it stays linear: a nested
 * quantifier would backtrack catastrophically on the long unbroken streams a CLI can print.
 */
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The box-drawing characters and spaces opencode wraps `auth list` in, at the start of every
 * line (`│  Error: …`). Removed per line before anchoring, or an error hidden inside the box
 * would read as a signed-in session.
 */
const BOX_PREFIX = /^[\s│┌└├─]+/;

/**
 * The `auth list` output with its presentation removed: ANSI escapes and each line's box
 * prefix, so a marker is matched against the start of what the CLI meant to print rather than
 * against decoration the CLI added.
 */
function stripAuthFormatting(output: string): string {
  return output
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.replace(BOX_PREFIX, ''))
    .join('\n');
}

/** Finds out what is installed and signed in. Never throws: a missing CLI is an answer. */
export async function detectProvider(
  provider: ProviderName,
  run: CommandRunner,
  options: DetectOptions = {},
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

  const requestedTimeout = options.timeoutMs;
  if (requestedTimeout !== undefined && !validTimeout(requestedTimeout)) {
    // The limit is refused before the first probe: a bad `timeoutMs` is the caller's mistake,
    // not a reason to spend a spawn on every provider.
    return {
      name: provider,
      installed: false,
      authenticated: false,
      models: [],
      problem: `The probe timeout (timeoutMs ${requestedTimeout}) must be a positive integer no larger than ${MAX_PROBE_TIMEOUT_MS}ms; refusing to probe.`,
    };
  }
  const timeoutMs = requestedTimeout ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Installed means `--version` actually succeeded (exit code 0). A non-zero exit, a command
  // that could not be spawned, or a probe that timed out all count as not installed; no
  // string like "not found" is consulted, because a mere warning can contain that phrase.
  const version = await probe(run, command, ['--version'], timeoutMs);
  if (!version.ok) {
    return {
      name: provider,
      installed: false,
      authenticated: false,
      models: [],
      problem: `The '${command}' command could not be verified (--version ${version.reason}); treating it as not installed.`,
    };
  }
  if (version.run.exitCode !== 0) return notInstalled(provider, command);

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

  // Models are only read from a probe that exited 0. A failed probe, or one that exited 0
  // while printing an error, contributes no model at all.
  const modelsProbe = await probe(run, command, ['models'], timeoutMs);
  if (modelsProbe.ok && modelsProbe.run.exitCode === 0) {
    for (const line of modelsProbe.run.output.split(/\r?\n/)) {
      const model = line.trim();
      // Only a `provider/model` line is a model; warnings and stack lines fall through.
      if (MODEL_LINE.test(model)) models.push(model);
    }
  }

  // Signed in means the `auth list` probe exited 0 and showed a credential. A non-zero exit,
  // an `Error:` line, an empty output or the explicit "0 credentials" all mean it did not.
  let authProblem: string | undefined;
  const authProbe = await probe(run, command, ['auth', 'list'], timeoutMs);
  if (!authProbe.ok) {
    authProblem = `'${command}' is installed, but its sign-in could not be checked (auth list ${authProbe.reason}); run '${command} auth login' and verify.`;
  } else {
    // Colour codes and the box are presentation, not content: strip them once and read every
    // marker against the cleaned text, so an error the CLI dressed up is still caught.
    const authText = stripAuthFormatting(authProbe.run.output);
    if (
      authProbe.run.exitCode !== 0 ||
      authText.trim() === '' ||
      /(^|\D)0 credentials/i.test(authText) ||
      ERROR_LINE.test(authText)
    ) {
      authProblem = `'${command}' is installed but has no verified credentials; run '${command} auth login' to sign in.`;
    }
  }

  return {
    name: provider,
    installed: true,
    authenticated: authProblem === undefined,
    models,
    ...(authProblem !== undefined ? { problem: authProblem } : {}),
  };
}
