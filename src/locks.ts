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
export function parseHookInput(_stdin: string): HookInput | { readonly error: string } {
  throw new Error('parseHookInput: not implemented');
}

/**
 * The covered surfaces are declared, not implied: Claude's Write, Edit, MultiEdit and
 * NotebookEdit, and Codex's apply_patch. Shell commands that write are NOT covered here —
 * the git pre-commit hook catches what they stage.
 */
export function decideToolUse(_input: HookInput, _context: LockContext): LockDecision {
  throw new Error('decideToolUse: not implemented');
}

export interface HookOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Allow is silence: exit 0 with no output lets the CLI's own permission flow continue.
 * Deny is one line of JSON in the shape both Claude Code and Codex accept.
 */
export function renderHookOutput(_decision: LockDecision): HookOutput {
  throw new Error('renderHookOutput: not implemented');
}

/** The whole hook: read stdin, decide, answer. A request it cannot read is refused loudly. */
export function handleHook(_stdin: string, _context: LockContext): HookOutput {
  throw new Error('handleHook: not implemented');
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
