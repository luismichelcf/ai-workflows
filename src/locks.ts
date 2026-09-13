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

export function decidePreCommit(input: PreCommitInput): LockDecision {
  // An empty commit is not this lock's business: nothing is being added to the tree.
  if (input.stagedPaths.length === 0) return { allow: true };

  // A folder with work in flight, or one opened as /libre, may commit. Same rule as the
  // editor hook, because both locks answer the same question at different moments.
  if (input.context.activePiece || input.context.libre) return { allow: true };

  // Staged paths are relative to the repository root, so the root is the base for
  // canonicalization. Reusing the editor lock's normalization makes `docs/../src/a.ts`
  // resolve to `src/a.ts` and stop posing as a paper — one implementation, one answer.
  const papers = input.context.paperPaths.map((paper) => canonicalize(paper, '.'));
  const staged = input.stagedPaths.map((stagedPath) => canonicalize(stagedPath, '.'));

  // With no piece, only papers may enter. One stray code file is enough to refuse, because
  // the commit would carry it.
  const offenders = staged.filter((stagedPath) => !papers.some((paper) => isUnder(stagedPath, paper)));
  if (offenders.length === 0) return { allow: true };

  return {
    allow: false,
    reason:
      `Estas rutas no son papeles: ${offenders.join(', ')}. ` +
      'El código entra por una pieza: abre una o usa /libre para prototipos.',
  };
}

export interface PrePushInput {
  /** The remote refs being updated, as git passes them on stdin. */
  readonly remoteRefs: readonly string[];
  readonly defaultBranch: string;
}

/** Nothing is pushed straight to the default branch: everything goes through a PR. */
export function decidePrePush(input: PrePushInput): LockDecision {
  // Compare the whole ref, not its tail: `refs/heads/fix/main` is a branch of its own and
  // must never be mistaken for the default `refs/heads/main`.
  const defaultRef = `refs/heads/${input.defaultBranch}`;
  if (!input.remoteRefs.includes(defaultRef)) return { allow: true };

  return {
    allow: false,
    reason:
      `No se empuja directo a ${defaultRef}: la rama por defecto solo recibe merges vía PR. ` +
      'Sube tu rama y abre un pull request.',
  };
}

export type GitHookKind = 'pre-commit' | 'pre-push';

/** The script git runs. POSIX sh, LF only: a CR in the first line breaks it. */
export function renderGitHook(kind: GitHookKind, command: string): string {
  // The body is assembled from LF-joined lines so no `\r` can slip in; a CR at the end of
  // the shebang makes the kernel look for an interpreter named `/bin/sh\r` and fail with a
  // message that never points at the cause.
  //
  // `exec` replaces the shell with the lock command, which keeps stdin intact: git feeds the
  // pre-push refs on stdin and the command must still see them. The hook kind travels as an
  // argument, and `"$@"` forwards git's own arguments untouched.
  return ['#!/bin/sh', `exec ${command} ${kind} "$@"`, ''].join('\n');
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

/**
 * Our hook entry for one client. Claude Code and Codex share the file shape; only the tool
 * names differ. The CLI anchors the matcher as a whole-name regex, so an alternation of
 * exact names keeps the hook off every other tool — reading included.
 */
export function buildHooksConfig(client: HookClient, command: string): HooksFile {
  const matcher = client === 'claude' ? 'Write|Edit|MultiEdit|NotebookEdit' : 'apply_patch';

  return {
    hooks: {
      PreToolUse: [
        {
          matcher,
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  };
}

/** True for a plain JSON object: the caller may hand us anything, including an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The command that identifies our entry, so reinstalling can recognize it. */
function firstCommand(file: HooksFile): string | undefined {
  return file.hooks.PreToolUse[0]?.hooks[0]?.command;
}

/**
 * Adds our entry to an existing settings or hooks file without touching anything else in
 * it. Installing twice changes nothing the second time.
 */
export function mergeHooksConfig(existing: unknown, ours: HooksFile): Record<string, unknown> {
  // Everything is rebuilt into fresh objects and arrays. The caller may still be holding
  // and using `existing`, so mutating it in place would corrupt their file behind their back.
  const base = isRecord(existing) ? existing : {};
  const baseHooks = isRecord(base.hooks) ? base.hooks : {};
  const currentPre = baseHooks.PreToolUse;
  const groups = Array.isArray(currentPre) ? [...currentPre] : [];

  // Idempotency: recognize our own entry by its command. Without this, every install would
  // append another group and the hook would run once per run.
  const ourCommand = firstCommand(ours);
  const alreadyInstalled = groups.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((handler) => isRecord(handler) && handler.command === ourCommand);
  });

  if (!alreadyInstalled) {
    groups.push(...ours.hooks.PreToolUse);
  }

  // Spread the base first so every untouched key (permissions and other hook events) rides
  // along verbatim; only PreToolUse is replaced with the combined list.
  return {
    ...base,
    hooks: {
      ...baseHooks,
      PreToolUse: groups,
    },
  };
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

/** One `required_status_checks` entry, reduced to what this check cares about. */
interface RequiredCheckEntry {
  readonly context: string;
  /** `undefined` means any app or workflow may report this context and satisfy it. */
  readonly integrationId: number | undefined;
}

/** A branch ruleset only counts if GitHub is told to truly enforce it on the default branch. */
function appliesToDefaultBranch(ruleset: Record<string, unknown>): boolean {
  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined;
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined;
  const include = refName && Array.isArray(refName.include) ? refName.include : [];
  // GitHub spells the default branch as the `~DEFAULT_BRANCH` token; a literal
  // `refs/heads/main` is accepted too, because both mean the same branch.
  return include.some((entry) => entry === '~DEFAULT_BRANCH' || entry === 'refs/heads/main');
}

/**
 * Reads GitHub's rulesets for the repository and says whether they actually enforce what
 * the pipeline relies on. Installing a check is worthless if nothing requires it.
 *
 * Several rulesets are combined: it is enough that between all of them they cover what the
 * pipeline needs. Only branch rulesets that GitHub is actively enforcing on the default
 * branch count — a disabled or evaluation-only ruleset blocks nothing.
 */
export function verifyProtections(
  rulesets: unknown,
  requirement: ProtectionRequirement,
): ProtectionReport {
  // The residual risk is always declared, even when the rules cannot be read: a green
  // report must never be read as more than it is.
  const limits: readonly string[] = [
    'Nada de esto puede impedir que un administrador del repositorio cambie o desactive las reglas: el sistema acepta ese riesgo y lo declara aquí.',
  ];

  // Input that is not a list of rulesets (for example an HTML error page) is an answer,
  // never an exception. The caller gets a report that says it could not read the rules.
  if (!Array.isArray(rulesets)) {
    return {
      ok: false,
      problems: [
        'No se pudieron leer las reglas del repositorio: GitHub no devolvió una lista de reglas.',
      ],
      limits,
    };
  }

  let hasActiveApplicable = false;
  let hasDeletion = false;
  let hasNonFastForward = false;
  let hasStrictPolicy = false;
  const checkEntries: RequiredCheckEntry[] = [];
  const bypassActorTypes: string[] = [];

  for (const rawRuleset of rulesets) {
    if (!isRecord(rawRuleset)) continue;
    // Only branch rulesets that are actively enforced on the default branch can block a
    // merge; `evaluate` and `disabled` rulesets are recorded but never relied upon.
    if (rawRuleset.target !== 'branch' || rawRuleset.enforcement !== 'active') continue;
    if (!appliesToDefaultBranch(rawRuleset)) continue;
    hasActiveApplicable = true;

    // Anyone in `bypass_actors` can merge without meeting the rules, so their mere
    // presence weakens the protection. Names are collected to say who.
    const actors = Array.isArray(rawRuleset.bypass_actors) ? rawRuleset.bypass_actors : [];
    for (const rawActor of actors) {
      if (isRecord(rawActor) && typeof rawActor.actor_type === 'string') {
        bypassActorTypes.push(rawActor.actor_type);
      }
    }

    const rules = Array.isArray(rawRuleset.rules) ? rawRuleset.rules : [];
    for (const rawRule of rules) {
      if (!isRecord(rawRule)) continue;
      if (rawRule.type === 'deletion') hasDeletion = true;
      if (rawRule.type === 'non_fast_forward') hasNonFastForward = true;
      if (rawRule.type !== 'required_status_checks') continue;

      const parameters = isRecord(rawRule.parameters) ? rawRule.parameters : undefined;
      if (!parameters) continue;
      if (parameters.strict_required_status_checks_policy === true) hasStrictPolicy = true;

      const checks = Array.isArray(parameters.required_status_checks)
        ? parameters.required_status_checks
        : [];
      for (const rawCheck of checks) {
        if (!isRecord(rawCheck) || typeof rawCheck.context !== 'string') continue;
        checkEntries.push({
          context: rawCheck.context,
          integrationId: typeof rawCheck.integration_id === 'number' ? rawCheck.integration_id : undefined,
        });
      }
    }
  }

  const problems: string[] = [];

  // 1. No ruleset is both enforced and aimed at the default branch, so nothing stops
  //    changes there and every rule below is effectively absent.
  if (!hasActiveApplicable) {
    problems.push(
      'No hay ninguna regla activa que aplique a la rama por defecto: hoy GitHub no bloquea cambios directos en ella.',
    );
  }

  const requiredContexts = new Set(checkEntries.map((entry) => entry.context));

  // 2. Every check the pipeline relies on must be demanded by some enforced ruleset.
  for (const check of requirement.requiredChecks) {
    if (!requiredContexts.has(check)) {
      problems.push(`El check "${check}" no está exigido para poder mergear a la rama por defecto.`);
    }
  }

  // 3. When the pipeline needs a branch that is up to date, the strict policy must be on.
  if (requirement.requireUpToDate && !hasStrictPolicy) {
    problems.push(
      'No se exige que la rama esté al día con la rama por defecto antes de mergear.',
    );
  }

  // 4. Without this rule, history on the default branch can be rewritten with a force push.
  if (!hasNonFastForward) {
    problems.push(
      'Se puede reescribir la historia de la rama por defecto con un force push: ninguna regla lo impide.',
    );
  }

  // 5. Without this rule, the default branch itself can be deleted.
  if (!hasDeletion) {
    problems.push('Se puede borrar la rama por defecto: ninguna regla lo impide.');
  }

  // 6. A bypass actor can merge without meeting the rules; the report names the kind.
  for (const actorType of bypassActorTypes) {
    problems.push(
      `Hay quien puede saltarse estas reglas sin cumplirlas: un actor de tipo "${actorType}".`,
    );
  }

  // 7. A required check without an integration id can be reported by any app or workflow,
  //    including one written to always pass. Reported once per distinct check name.
  const seenContexts = new Set<string>();
  for (const entry of checkEntries) {
    if (seenContexts.has(entry.context)) continue;
    seenContexts.add(entry.context);
    const anyWithoutIntegration = checkEntries.some(
      (other) => other.context === entry.context && other.integrationId === undefined,
    );
    if (anyWithoutIntegration) {
      problems.push(
        `El check "${entry.context}" no está atado a una aplicación concreta: cualquier app o workflow puede reportarlo y darlo por bueno.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, limits };
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
