// Editor hook: may this tool call write here? Layer 1 of the locks (see ../locks.ts).

import { canonicalize, isUnder } from './paths.js';
import { pathsFromApplyPatch } from './patch.js';

export interface HookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** The session's working folder, as the CLI reports it. */
  readonly cwd: string;
}

export interface LockContext {
  /**
   * Absolute path of the project the lock guards: the git root of the folder it is installed
   * in. Configured, never taken from the hook's `cwd`, which moves with every `cd`.
   */
  readonly projectRoot: string;
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
