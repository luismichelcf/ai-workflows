// Editor hook: may this tool call write here? Layer 1 of the locks (see ../locks.ts).

import { isUnder, readAbsolute, readAgainst, readPapers } from './paths.js';
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
  /**
   * PLAN-13-R5 §1.3: the orders only the owner writes, read from the recipe's approval stages.
   * Absent means the v0.3.0 behaviour: only `/visto-bueno` is known.
   */
  readonly ownerOrders?: readonly string[];
  /** PLAN-13-R5 §1.3: refuse the terminal forms that approve a pull request. */
  readonly forbidPullRequestApproval?: boolean;
  /**
   * PLAN-13-R5 §1.4: the recipe of this working copy could not be read or validated, with the
   * problem at file:line:column. Only `.ai-workflows/` stays writable, and rule 0 is stricter.
   */
  readonly brokenRecipe?: string;
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

// The owner's sign-off is a comment only he may write: `/visto-bueno <sha>` names the exact
// version he looked at (see signoff.ts). When an agent writes it with the owner's account, the
// server cannot tell it apart from him, so no agent may put the order itself into a command or a
// file. This must be judged before any other rule, and the two surfaces are read differently:
//
//   - Shell tools (Bash, PowerShell, and Claude Code's Monitor, which runs a shell command or a
//     WebSocket) carry their text in `command` when they run one. Any `/visto-bueno` there is
//     refused, placeholder or not: the shell can fill a `<placeholder>` in before GitHub sees it
//     (`"/visto-bueno <sha>" -replace '<sha>', (git rev-parse HEAD)`, `sed`, string concatenation,
//     a variable). A Monitor with no `command` but a `ws` object runs no shell at all, so it is
//     allowed rather than refused as unreadable.
//   - Writing tools (Write, Edit, MultiEdit, NotebookEdit, Codex's apply_patch) carry the file's
//     text. Only a line the server itself would read as the order is refused: `/visto-bueno` at
//     the start of the trimmed line, then whitespace, then a value that is not a `<placeholder>`.
//     Everything else — the project's own sign-off regex, a sentence that names the order, a
//     document explaining it — is a mention, not the order, and stays writable.
//
// This is help, not a guarantee: an agent can still write a template holding `<sha>` in one step
// and fill it in with the shell in another, never naming the order where this hook can read it.
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
/** Without a recipe the lock knows only the v0.3.0 order, so old callers keep working. */
const DEFAULT_OWNER_ORDERS: readonly string[] = ['/visto-bueno'];
/**
 * The `gh` binary as a whole word, plain or `.exe`, reached directly or through a quoted path. `\b`
 * also sees it glued to a shell separator (`;gh`, `&&gh`, `|gh`, `(gh`, `$(gh`, a backquote), while
 * a word that merely ends in `gh` (`high`) has no boundary before it and is not the binary
 * (PLAN-13-R5 §1.3).
 */
const GH_BIN = String.raw`\bgh(?:\.exe)?["']?`;
/** The general options gh accepts between the binary and its command (`-R`, `--repo`, `--hostname`). */
const GH_GLOBAL =
  String.raw`(?:\s+(?:-R|--repo|--hostname)(?:\s+|=)\S+|\s+--[A-Za-z][A-Za-z-]*(?:=\S+)?|\s+-[A-Za-z])*`;
/** The binary plus its general options, ready to be followed by the command itself. */
const GH_CMD = `${GH_BIN}${GH_GLOBAL}`;
/** The terminal forms a person uses to approve a pull request (PLAN-13-R5 §1.3). */
const PULL_REQUEST_REVIEW = new RegExp(`${GH_CMD}\\s+pr\\s+review\\b`, 'i');
const REVIEW_APPROVE_FLAG = /(^|\s)(--approve|-a)(?=\W|$)/;
const API_PULL_REVIEWS = /pulls\/\d+\/reviews/;
/** A body sent to the reviews endpoint: its content cannot be read here, so it is refused. */
const API_REVIEWS_INPUT = /(^|\s)--input(=|\s|$)/;
const API_REVIEWS_APPROVE = /approve/i;
/** The GraphQL mutations that add or submit a pull request review. */
const GRAPHQL_ADD_REVIEW = /(?:add|submit)PullRequestReview\b/i;
/** Publishing to GitHub from the shell, the strict rule of a broken recipe (§1.4). */
const GH_PR_COMMENT = new RegExp(`${GH_CMD}\\s+pr\\s+comment\\b`, 'i');
const GH_ISSUE_COMMENT = new RegExp(`${GH_CMD}\\s+issue\\s+comment\\b`, 'i');
const GH_API = new RegExp(`${GH_CMD}\\s+api\\b`, 'i');
/** Any spelling of a field flag, attached or not: `-f body=`, `-fbody=`, `-F=body=`, `--raw-field`. */
const API_SENDS_FIELDS = /(^|\s)(-f|-F)(\S*)(?=\s|$)|(^|\s)(--field|--raw-field|--input)(=|\s|$)/i;
/** The method of a `gh api` call, as gh reads it: the LAST `-X`/`--method` of the command. */
function lastApiMethod(command: string): string | undefined {
  const found = [...command.matchAll(/(?:-x|--method)\s*=?\s*(\S+)/gi)];
  return found.length === 0 ? undefined : found[found.length - 1]?.[1];
}
/** A line the server reads as any order: `/word value`, the shape of every approval. */
const ORDER_SHAPED_LINE = /^\/(\S+)\s+(\S.*)$/;

interface SignOffText {
  readonly text: string;
  /** A Codex patch line carries a leading `+` when it adds; strip one before judging the line. */
  readonly stripPlus: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when one line, trimmed, is a line the server would read as one of the owner's orders. */
function isOwnerOrderLine(rawLine: string, stripPlus: boolean, orders: readonly string[]): boolean {
  let line = rawLine.trim();
  if (stripPlus) line = line.replace(/^\+/, '').trim();

  for (const order of orders) {
    const value = new RegExp(`^${escapeRegExp(order)}\\s+(\\S.*)$`, 'i').exec(line)?.[1];
    if (value !== undefined && !value.startsWith('<')) return true;
  }
  return false;
}

/** True when any line of the text the tool is about to write would be read as an order. */
function writesOwnerOrderLine(text: string, stripPlus: boolean, orders: readonly string[]): boolean {
  return text.split(/\r?\n/).some((line) => isOwnerOrderLine(line, stripPlus, orders));
}

/** True when any line has the shape of an order, whatever its word is (broken-recipe mode). */
function writesOrderShapedLine(text: string, stripPlus: boolean): boolean {
  return text.split(/\r?\n/).some((rawLine) => {
    let line = rawLine.trim();
    if (stripPlus) line = line.replace(/^\+/, '').trim();
    const value = ORDER_SHAPED_LINE.exec(line)?.[2];
    return value !== undefined && !value.startsWith('<');
  });
}

/** True when a shell command asks GitHub to approve a pull request. */
function approvesPullRequest(command: string): boolean {
  if (PULL_REQUEST_REVIEW.test(command) && REVIEW_APPROVE_FLAG.test(command)) return true;
  if (!GH_API.test(command)) return false;
  if (API_PULL_REVIEWS.test(command) && (API_REVIEWS_INPUT.test(command) || API_REVIEWS_APPROVE.test(command))) {
    return true;
  }
  return GRAPHQL_ADD_REVIEW.test(command) && API_REVIEWS_APPROVE.test(command);
}

/** True when a shell command publishes something on GitHub (broken-recipe mode). */
function publishesToGitHub(command: string): boolean {
  if (GH_PR_COMMENT.test(command) || GH_ISSUE_COMMENT.test(command) || PULL_REQUEST_REVIEW.test(command)) {
    return true;
  }
  if (!GH_API.test(command)) return false;
  const method = lastApiMethod(command);
  if (method !== undefined && method.toUpperCase() !== 'GET') return true;
  return API_SENDS_FIELDS.test(command);
}

/**
 * The text each writing tool is about to write, with whether its lines carry a leading `+`.
 * `undefined` means the request could not be read and must be refused: an `apply_patch` whose
 * `command` is not text cannot be inspected. An empty list means there is nothing to judge here.
 */
function fileSignOffTexts(toolName: string, toolInput: unknown): SignOffText[] | undefined {
  const record = asRecord(toolInput);

  if (toolName === 'Write') {
    const content = record?.content;
    return typeof content === 'string' ? [{ text: content, stripPlus: false }] : [];
  }

  if (toolName === 'Edit') {
    const changed = record?.new_string;
    return typeof changed === 'string' ? [{ text: changed, stripPlus: false }] : [];
  }

  if (toolName === 'MultiEdit') {
    const edits = record?.edits;
    if (!Array.isArray(edits)) return [];

    const texts: SignOffText[] = [];
    for (const edit of edits) {
      const changed = asRecord(edit)?.new_string;
      if (typeof changed === 'string') texts.push({ text: changed, stripPlus: false });
    }
    return texts;
  }

  if (toolName === 'NotebookEdit') {
    const source = record?.new_source;
    return typeof source === 'string' ? [{ text: source, stripPlus: false }] : [];
  }

  if (toolName === 'apply_patch') {
    const command = record?.command;
    // Not text: the patch cannot be read, so it cannot be cleared. Refused even with a piece.
    if (typeof command !== 'string') return undefined;
    return [{ text: command, stripPlus: true }];
  }

  return [];
}

/**
 * Rule 0 of the editor hook: no tool call writes one of the owner's approval orders itself, and no
 * shell approves a pull request. The orders come from the recipe (`context.ownerOrders`); without
 * them the v0.3.0 behaviour is kept exactly. Returns `undefined` when the call may continue.
 */
function ownerRuleRefusal(toolName: string, toolInput: unknown, context: LockContext): LockDecision | undefined {
  const orders = context.ownerOrders ?? DEFAULT_OWNER_ORDERS;
  const order: LockDecision = {
    allow: false,
    reason:
      'La aprobación del dueño solo la da él. No escribas tú la orden de aprobación con su cuenta: ' +
      'pídeselo al dueño y que sea él quien la escriba.',
  };

  if (SHELL_TOOLS.has(toolName)) {
    const record = asRecord(toolInput);
    const command = record?.command;
    // Claude Code's Monitor runs either a shell `command` or a WebSocket `ws`, never both (its
    // own documentation, 13-sep-2026). A `ws` monitor carries no shell text, so there is nothing
    // that could smuggle the order in: it may pass. Only Monitor gets this exit; a shell tool
    // with an unreadable command stays refused, because that command might be anything.
    if (typeof command !== 'string' && toolName === 'Monitor' && asRecord(record?.ws)) {
      return undefined;
    }
    // A shell command the hook cannot read might be anything, including the order. Refuse.
    if (typeof command !== 'string') {
      return {
        allow: false,
        reason:
          'No pude leer el comando de esta herramienta: el candado se niega a adivinar si iba a escribir una orden del dueño. Revisa el formato de tool_input.',
      };
    }
    // Shell text can fill a placeholder in before GitHub sees it, so any appearance is refused.
    const lower = command.toLowerCase();
    if (orders.some((entry) => lower.includes(entry.toLowerCase()))) return order;
    if (context.forbidPullRequestApproval === true && approvesPullRequest(command)) {
      return {
        allow: false,
        reason:
          'Aprobar un pull request solo lo hace el dueño. Un agente no puede publicar la aprobación ' +
          'del dueño con su cuenta: pídeselo a él.',
      };
    }
    return undefined;
  }

  const texts = fileSignOffTexts(toolName, toolInput);
  // An unreadable patch might carry the order; refuse rather than guess.
  if (texts === undefined) {
    return {
      allow: false,
      reason:
        'No pude leer lo que esta herramienta iba a escribir: el candado se niega a adivinar si era ' +
        'una orden del dueño. Revisa el formato de tool_input.',
    };
  }

  return texts.some(({ text, stripPlus }) => writesOwnerOrderLine(text, stripPlus, orders))
    ? order
    : undefined;
}

/**
 * PLAN-13-R5 §1.2: a path inside the git area of a working copy. Git refuses to call that a work
 * tree, so the path rules cannot read it; the copy's own context decides. A broken recipe refuses
 * it, a piece or `/libre` allows it, and without a piece it is refused like code would be.
 */
export function decideGitFolder(context: LockContext): LockDecision {
  if (context.brokenRecipe !== undefined) return { allow: false, reason: brokenRecipeReason(context) };
  if (context.activePiece || context.libre) return { allow: true };
  return {
    allow: false,
    reason:
      'La carpeta interna de git no se escribe sin una pieza activa: abre una o usa /libre para prototipos.',
  };
}

/** What to say in broken-recipe mode: the problem, and the only door that stays open. */
function brokenRecipeReason(context: LockContext): string {
  return (
    `La receta no es válida (${context.brokenRecipe}). Hasta repararla solo se puede escribir dentro ` +
    'de .ai-workflows/: el candado no deja pasar nada más por si acaso.'
  );
}

/** Rule 0 in broken-recipe mode: publishing to GitHub and any order-shaped line are refused. */
function brokenOrderRefusal(input: HookInput, context: LockContext): LockDecision | undefined {
  if (SHELL_TOOLS.has(input.toolName)) {
    const record = asRecord(input.toolInput);
    const command = record?.command;
    if (typeof command !== 'string' && input.toolName === 'Monitor' && asRecord(record?.ws)) {
      return undefined;
    }
    if (typeof command !== 'string') {
      return { allow: false, reason: brokenRecipeReason(context) };
    }
    return publishesToGitHub(command) ? { allow: false, reason: brokenRecipeReason(context) } : undefined;
  }

  if (!isCoveredWriteTool(input.toolName)) return undefined;
  const texts = fileSignOffTexts(input.toolName, input.toolInput);
  if (texts === undefined) return { allow: false, reason: brokenRecipeReason(context) };
  return texts.some(({ text, stripPlus }) => writesOrderShapedLine(text, stripPlus))
    ? { allow: false, reason: brokenRecipeReason(context) }
    : undefined;
}

/**
 * The owner rule alone, without the folder rules. `runHook` calls it once on the whole request so
 * that writing an order is refused wherever the target folder lives, and `decideToolUse` uses it
 * as the first rule of a whole decision.
 */
export function orderRefusal(input: HookInput, context: LockContext): LockDecision | undefined {
  if (context.brokenRecipe !== undefined) return brokenOrderRefusal(input, context);
  return ownerRuleRefusal(input.toolName, input.toolInput, context);
}

/** The whole decision under a broken recipe: repair folder only, and the stricter rule 0. */
function decideBrokenToolUse(input: HookInput, context: LockContext): LockDecision {
  const order = brokenOrderRefusal(input, context);
  if (order !== undefined) return order;
  if (SHELL_TOOLS.has(input.toolName)) return { allow: true };
  if (!isCoveredWriteTool(input.toolName)) return { allow: true };

  const root = readAbsolute(context.projectRoot);
  if (!root.ok) {
    return { allow: false, reason: brokenRecipeReason(context) };
  }
  const repair = readAbsolute(`${root.path.display}/.ai-workflows`);
  if (!repair.ok) return { allow: false, reason: brokenRecipeReason(context) };

  const targets = writeTargets(input.toolName, input.toolInput);
  if (targets === undefined || targets.length === 0) {
    // Under a broken recipe an unreadable write is refused, never passed by doubt.
    return { allow: false, reason: brokenRecipeReason(context) };
  }

  const projectDrive = root.path.windows ? /^([A-Za-z]):/.exec(root.path.display)?.[1] : undefined;
  const readings = targets.map((target) => readAgainst(target, input.cwd, projectDrive));
  for (const reading of readings) {
    if (!reading.ok) return { allow: false, reason: brokenRecipeReason(context) };
  }

  const inside = readings
    .flatMap((reading) => (reading.ok ? [reading.path] : []))
    .filter((target) => isUnder(target, root.path));
  // Paths outside the project are not this lock's business, broken recipe or not.
  if (inside.length === 0) return { allow: true };
  if (inside.every((target) => isUnder(target, repair.path))) return { allow: true };
  return { allow: false, reason: brokenRecipeReason(context) };
}

/** True when the tool is one of the writing surfaces this lock judges by its path. */
export function isCoveredWriteTool(toolName: string): boolean {
  return CLAUDE_FILE_TOOLS.has(toolName) || toolName === 'NotebookEdit' || toolName === 'apply_patch';
}

/** The paths a covered tool will write, or `undefined` when the request cannot be read. */
export function writeTargets(toolName: string, toolInput: unknown): string[] | undefined {
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
 * The covered surfaces are declared, not implied. For the folder rules (below): Claude's Write,
 * Edit, MultiEdit and NotebookEdit, and Codex's apply_patch. Shell commands that write are not
 * judged by their path — the git pre-commit hook catches what they stage. For the owner's
 * sign-off rule only, Bash, PowerShell and Monitor are covered too, since the order travels in
 * their `command` text. In Codex, `write_stdin` does not pass through this hook again (its own
 * documentation, read 13-sep-2026), so a command typed into a running session is not re-judged
 * here; there is no `tool_input` to read for it on this seam. It is help, not a guarantee: the
 * hook never sees MCP tools, and an agent can write a `<sha>` template in one step and fill it in
 * with the shell in another, never naming the order where this hook can read it.
 */
export function decideToolUse(input: HookInput, context: LockContext): LockDecision {
  // A broken recipe replaces every rule: only the recipe can be repaired, and rule 0 is stricter.
  if (context.brokenRecipe !== undefined) return decideBrokenToolUse(input, context);

  // Rule 0: no agent writes the owner's sign-off for him. Checked before every other rule, and
  // unaffected by a piece or a /libre folder, because those open writing, never the sign-off.
  const signOff = ownerRuleRefusal(input.toolName, input.toolInput, context);
  if (signOff) return signOff;

  // Shell tools are covered only by the sign-off rule above: their command is not a path this
  // lock can judge, and without the order they always pass. The pre-commit hook guards what they
  // stage, not what they run.
  if (SHELL_TOOLS.has(input.toolName)) return { allow: true };

  // Rule 1: everything the hook is not wired to passes untouched.
  if (!isCoveredWriteTool(input.toolName)) return { allow: true };

  // Rule 2: the guarded folder is the configured project root, never the hook's cwd, which moves
  // with every `cd`. A root the lock cannot read as an absolute path cannot be guarded at all:
  // refuse everything and name the setting that is wrong.
  const root = readAbsolute(context.projectRoot);
  if (!root.ok) {
    return {
      allow: false,
      reason:
        `La raíz del proyecto (projectRoot) no es una ruta absoluta que el candado pueda leer ` +
        `(${root.problem}). No puedo vigilar una carpeta que no entiendo.`,
    };
  }

  // Rule 3: a paper entry that is absolute, empty or climbs out would silently switch the lock
  // off. Read it here and in pre-commit alike, and refuse it as a paperPaths problem.
  const papers = readPapers(context.paperPaths, root.path);
  if (!papers.ok) {
    return {
      allow: false,
      reason:
        `El candado no puede usar paperPaths: ${papers.problem}. ` +
        'Corrige la configuración o el candado dejaría de proteger el código.',
    };
  }

  // Rule 4: a folder with work in flight, or one explicitly opened as /libre, may write
  // anywhere. Checked before reading the targets, because with a piece writing is allowed
  // everywhere: a path or a patch the lock cannot read no longer changes the answer.
  if (context.activePiece || context.libre) return { allow: true };

  // Rule 5: a request whose paths cannot be read is refused. A lock that lets through what it
  // does not understand has stopped working without saying so. Reached only without a piece,
  // where the targets themselves decide.
  const targets = writeTargets(input.toolName, input.toolInput);
  if (targets === undefined || targets.length === 0) {
    return {
      allow: false,
      reason:
        'No pude leer las rutas de esta herramienta: el candado se niega a adivinar. Revisa el formato de tool_input.',
    };
  }

  // Targets are read against the cwd (that is what a relative path needs); the project root is
  // not. A path the lock cannot reduce is refused, never guessed into a decision.
  const projectDrive = root.path.windows ? /^([A-Za-z]):/.exec(root.path.display)?.[1] : undefined;
  const readings = targets.map((target) => readAgainst(target, input.cwd, projectDrive));
  for (const reading of readings) {
    if (!reading.ok) {
      return {
        allow: false,
        reason: `No pude reducir una de las rutas sin adivinar (${reading.problem}). Me niego en vez de dejar pasar a ciegas.`,
      };
    }
  }

  const inside = readings
    .flatMap((reading) => (reading.ok ? [reading.path] : []))
    .filter((target) => isUnder(target, root.path));

  // Rule 6: paths outside the project are not this lock's business; agents keep scratch
  // files elsewhere and the lock guards the project, not the disk.
  if (inside.length === 0) return { allow: true };

  // Rule 7: with no piece, only declared paper folders are writable.
  const allPapers = inside.every((target) => papers.paths.some((paper) => isUnder(target, paper)));
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
