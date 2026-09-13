// The locks: what stops an agent or a person from getting around the process.
//
// Three layers with different reach, and each one says what it covers (spec D07):
//
//   1. Editor hooks (Claude Code and Codex share one format). Help, not a guarantee: the
//      agent's CLI runs them, a folder that is not trusted skips them, and they only see
//      the tools they are wired to.
//   2. Git hooks. Also help: `git commit --no-verify` skips them. They see what is staged,
//      which the editor hook cannot.
//   3. The server check. The only mandatory layer: GitHub refuses the merge without it, and
//      it recomputes what it can instead of reading a file from the branch.
//
// Everything here is pure — decisions, file contents, readings of API responses — so every
// lock can be tested without installing anything on a real machine.

import * as path from 'node:path';

import type { CheckResult } from './gates.js';
import type { ExecutionIdentity, Verdict } from './identity.js';

// ---------------------------------------------------------------------------------------
// Editor hook: may this tool call write here?
// ---------------------------------------------------------------------------------------

export interface HookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** The session's working folder, as the CLI reports it. */
  readonly cwd: string;
}

export interface LockContext {
  /** The piece active in this folder. Absent means no piece. */
  readonly activePiece?: string;
  /** A folder opened with `/libre`: writing is allowed, merging never is. */
  readonly libre?: boolean;
  /** Folders, relative to `cwd`, where papers may be written without a piece. */
  readonly paperPaths: readonly string[];
}

export type LockDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** Reads the JSON a CLI sends on stdin. Malformed input is an answer, never an exception. */
export function parseHookInput(stdin: string): HookInput | { readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    // A parse failure is expected input, not a crash: return it as an answer the caller can
    // turn into a deny. Swallowing it silently would be the only mistake.
    return { error: 'stdin was not JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'stdin was not a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.tool_name !== 'string' || record.tool_name.length === 0) {
    return { error: 'tool_name is missing' };
  }

  return {
    toolName: record.tool_name,
    toolInput: record.tool_input,
    // The CLI always sends cwd; when it does not, an empty string keeps callers total.
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
  };
}

// Claude editing tools name their target in a different field each; NotebookEdit uses
// notebook_path. The list is closed on purpose: anything else is not this hook's surface.
const CLAUDE_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Backslashes are just the Windows spelling of a separator, so the rules see one form. */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** A POSIX path or a Windows drive path. `path.posix` alone would miss `C:/...`. */
function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(value);
}

/**
 * Turns any reported path into one canonical form: separators unified, relative paths read
 * against `cwd`, and `..` resolved. This is what stops `docs/../src/a.ts` from posing as
 * `docs`.
 */
function canonicalize(value: string, cwd: string): string {
  const forward = toPosix(value);
  const base = toPosix(cwd).replace(/\/+$/, '');
  const joined = isAbsoluteLike(forward) ? forward : `${base}/${forward}`;
  return path.posix.normalize(joined);
}

/**
 * Windows drive letters are case-insensitive; a lowercase `c:` and an uppercase `C:` are
 * the same folder. Only the drive letter is folded, so case-sensitive names below it keep
 * their meaning.
 */
function foldDrive(value: string): string {
  return value.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

/** True when `child` is `parent` itself or lives inside it. Prefix alone is not enough. */
function isUnder(child: string, parent: string): boolean {
  const c = foldDrive(child);
  const p = foldDrive(parent).replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
}

/** Every path a Codex `apply_patch` payload touches, including a rename's destination. */
function pathsFromApplyPatch(command: unknown): string[] | undefined {
  if (typeof command !== 'string') {
    // Not readable: the caller refuses rather than guessing at a changed format.
    return undefined;
  }

  const paths: string[] = [];
  const fileLine = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  const moveLine = /^\*\*\* Move to: (.+)$/gm;
  for (const match of command.matchAll(fileLine)) if (match[1]) paths.push(match[1].trim());
  for (const match of command.matchAll(moveLine)) if (match[1]) paths.push(match[1].trim());
  return paths;
}

/** The paths a covered tool will write, or `undefined` when the request cannot be read. */
function writeTargets(toolName: string, toolInput: unknown): string[] | undefined {
  if (toolName === 'apply_patch') {
    const record = asRecord(toolInput);
    if (!record) return undefined;
    return pathsFromApplyPatch(record.command);
  }

  const field = CLAUDE_FILE_TOOLS.has(toolName)
    ? 'file_path'
    : toolName === 'NotebookEdit'
      ? 'notebook_path'
      : undefined;
  if (!field) return undefined;

  const record = asRecord(toolInput);
  const value = record?.[field];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return [value];
}

/**
 * The covered surfaces are declared, not implied: Claude's Write, Edit, MultiEdit and
 * NotebookEdit, and Codex's apply_patch. Shell commands that write are NOT covered here —
 * the git pre-commit hook catches what they stage.
 */
export function decideToolUse(input: HookInput, context: LockContext): LockDecision {
  const isCovered =
    CLAUDE_FILE_TOOLS.has(input.toolName) || input.toolName === 'NotebookEdit' || input.toolName === 'apply_patch';
  // Rule 1: everything the hook is not wired to passes untouched.
  if (!isCovered) return { allow: true };

  // Rule 2: a request whose paths cannot be read is refused. A lock that lets through what
  // it does not understand has stopped working without saying so.
  const targets = writeTargets(input.toolName, input.toolInput);
  if (targets === undefined || targets.length === 0) {
    return {
      allow: false,
      reason:
        'No pude leer las rutas de esta herramienta: el candado se niega a adivinar. Revisa el formato de tool_input.',
    };
  }

  const projectRoot = canonicalize('.', input.cwd);
  const papers = context.paperPaths.map((paper) => canonicalize(paper, input.cwd));

  const inside = targets.map((target) => canonicalize(target, input.cwd)).filter((target) => isUnder(target, projectRoot));

  // Rule 4: paths outside the project are not this lock's business; agents keep scratch
  // files elsewhere and the lock guards the project, not the disk.
  if (inside.length === 0) return { allow: true };

  // Rule 5: a folder with work in flight, or one explicitly opened as /libre, may write.
  if (context.activePiece || context.libre) return { allow: true };

  // Rule 6: with no piece, only declared paper folders are writable.
  const allPapers = inside.every((target) => papers.some((paper) => isUnder(target, paper)));
  if (allPapers) return { allow: true };

  return {
    allow: false,
    reason:
      'Esta carpeta no tiene una pieza activa: el trabajo de código entra por una pieza. Abre una o usa /libre para prototipos.',
  };
}

export interface HookOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Allow is silence: exit 0 with no output lets the CLI's own permission flow continue.
 * Deny is one line of JSON in the shape both Claude Code and Codex accept.
 */
export function renderHookOutput(decision: LockDecision): HookOutput {
  // Allow is silence: exit 0 with no output lets the CLI's own permission flow continue.
  if (decision.allow) return { stdout: '', exitCode: 0 };

  // Both Claude Code and Codex accept this exact PreToolUse deny shape, printed as one line
  // so the CLIs parse it as a single JSON document.
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

/** The whole hook: read stdin, decide, answer. A request it cannot read is refused loudly. */
export function handleHook(stdin: string, context: LockContext): HookOutput {
  const parsed = parseHookInput(stdin);
  if ('error' in parsed) {
    return renderHookOutput({
      allow: false,
      reason: `No pude leer la solicitud del CLI (${parsed.error}); me niego en vez de dejar pasar a ciegas.`,
    });
  }
  return renderHookOutput(decideToolUse(parsed, context));
}

// ---------------------------------------------------------------------------------------
// Git hooks
// ---------------------------------------------------------------------------------------

export interface PreCommitInput {
  /** Staged paths, relative to the repository root. */
  readonly stagedPaths: readonly string[];
  readonly context: LockContext;
}

export function decidePreCommit(_input: PreCommitInput): LockDecision {
  throw new Error('decidePreCommit: not implemented');
}

export interface PrePushInput {
  /** The remote refs being updated, as git passes them on stdin. */
  readonly remoteRefs: readonly string[];
  readonly defaultBranch: string;
}

/** Nothing is pushed straight to the default branch: everything goes through a PR. */
export function decidePrePush(_input: PrePushInput): LockDecision {
  throw new Error('decidePrePush: not implemented');
}

export type GitHookKind = 'pre-commit' | 'pre-push';

/** The script git runs. POSIX sh, LF only: a CR in the first line breaks it. */
export function renderGitHook(_kind: GitHookKind, _command: string): string {
  throw new Error('renderGitHook: not implemented');
}

// ---------------------------------------------------------------------------------------
// Installing the editor hooks
// ---------------------------------------------------------------------------------------

export type HookClient = 'claude' | 'codex';

export interface HookHandler {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
}

export interface HookGroup {
  readonly matcher: string;
  readonly hooks: readonly HookHandler[];
}

export interface HooksFile {
  readonly hooks: { readonly PreToolUse: readonly HookGroup[] } & Record<string, unknown>;
}

/** Our hook entry for one client. */
export function buildHooksConfig(_client: HookClient, _command: string): HooksFile {
  throw new Error('buildHooksConfig: not implemented');
}

/**
 * Adds our entry to an existing settings or hooks file without touching anything else in
 * it. Installing twice changes nothing the second time.
 */
export function mergeHooksConfig(_existing: unknown, _ours: HooksFile): Record<string, unknown> {
  throw new Error('mergeHooksConfig: not implemented');
}

// ---------------------------------------------------------------------------------------
// Server-side protections
// ---------------------------------------------------------------------------------------

export interface ProtectionRequirement {
  /** Status checks that must be required to merge into the default branch. */
  readonly requiredChecks: readonly string[];
  /** Require branches to be up to date before merging. */
  readonly requireUpToDate?: boolean;
}

export interface ProtectionReport {
  readonly ok: boolean;
  /** What is missing or weaker than required, one sentence each. */
  readonly problems: readonly string[];
  /** What these protections cannot do even when everything is in place. */
  readonly limits: readonly string[];
}

/**
 * Reads GitHub's rulesets for the repository and says whether they actually enforce what
 * the pipeline relies on. Installing a check is worthless if nothing requires it.
 */
export function verifyProtections(
  _rulesets: unknown,
  _requirement: ProtectionRequirement,
): ProtectionReport {
  throw new Error('verifyProtections: not implemented');
}

// ---------------------------------------------------------------------------------------
// The owner's sign-off and the merge check
// ---------------------------------------------------------------------------------------

export interface PullRequestComment {
  readonly body: string;
  readonly author: string;
}

export interface SignOffRules {
  /** GitHub logins allowed to sign off. */
  readonly productOwners: readonly string[];
  /** The head of the pull request right now. */
  readonly headSha: string;
}

/**
 * `/visto-bueno <sha>` on its own line, from a product owner, naming the current head.
 * The SHA matters: a sign-off of an older version does not cover a newer one.
 */
export function parseSignOff(
  _comment: PullRequestComment,
  _rules: SignOffRules,
): { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string } {
  throw new Error('parseSignOff: not implemented');
}

export interface MergeCheckInput {
  readonly headSha: string;
  readonly builder: ExecutionIdentity;
  readonly verdicts: readonly Verdict[];
  readonly requiredAngles?: readonly string[];
  readonly differentProvider?: boolean;
  /** Whether this piece has something visible, and so needs the owner's sign-off. */
  readonly needsSignOff: boolean;
  readonly comments: readonly PullRequestComment[];
  readonly productOwners: readonly string[];
}

export interface MergeCheckResult {
  readonly conclusion: 'success' | 'failure';
  /** Every reason it failed, not just the first. */
  readonly summary: string;
}

/** What the server check concludes, composed from the identity and sign-off rules. */
export function concludeMergeCheck(_input: MergeCheckInput): MergeCheckResult {
  throw new Error('concludeMergeCheck: not implemented');
}

export type { CheckResult };
