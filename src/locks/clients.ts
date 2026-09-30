// PLAN-13-R6 §3.2: one lock, three translators.
//
// The decision itself (decideToolUse, the folder rules, runEditor) does not change. What changes
// is the shape each client speaks: Claude Code and Codex share the same envelope, OpenCode hands
// its plugin call a different one, and each reads a refusal in its own way (§3.1, measured on the
// owner's PC). A translator turns a client's request into the `HookInput` the lock already knows
// and turns the lock's decision into the answer that client actually obeys.

import { parseHookInput, renderHookOutput, type HookInput, type LockDecision } from './editor.js';
import type { HookClient } from './install.js';

export interface ClientOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * §3.2: a tool the translator does not know but whose input carries one of these names is refused.
 * The lock cannot read what it would write, so it never lets it pass by doubt.
 */
const PATH_LIKE_KEYS: readonly string[] = ['path', 'filePath', 'file_path', 'paths', 'patchText'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function carriesPath(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return PATH_LIKE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

type ParsedObject =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

function parseJsonObject(stdin: string): ParsedObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return { ok: false, error: 'stdin was not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'stdin was not a JSON object' };
  return { ok: true, value: parsed };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Codex sends the Claude envelope: `tool_name`, `tool_input` and `cwd`. Its editing tool is
 * `apply_patch` (aliases `Edit` and `Write`) with the whole patch in `tool_input.command`, and its
 * console is `Bash` with the same `command` field as text.
 */
function parseCodex(stdin: string): HookInput | { readonly error: string } {
  const read = parseJsonObject(stdin);
  if (!read.ok) return { error: read.error };
  const parsed = read.value;

  const tool = parsed.tool_name;
  if (typeof tool !== 'string' || tool.length === 0) return { error: 'tool_name is missing' };
  const cwd = stringField(parsed.cwd);
  const toolInput = parsed.tool_input;

  if (tool === 'Bash') {
    const record = isRecord(toolInput) ? toolInput : undefined;
    return { toolName: 'Bash', toolInput: { command: record?.command }, cwd };
  }
  if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
    const record = isRecord(toolInput) ? toolInput : undefined;
    return { toolName: 'apply_patch', toolInput: { command: record?.command }, cwd };
  }
  if (carriesPath(toolInput)) {
    return { error: `la herramienta desconocida "${tool}" trae una ruta y el candado no sabe qué escribiría` };
  }
  return { toolName: tool, toolInput, cwd };
}

/**
 * OpenCode hands its plugin `(input, output)`; the plugin forwards one call as
 * `{tool, sessionID, callID, args, cwd}`. `write` and `edit` carry `filePath`, `apply_patch`
 * carries `patchText` and `bash` carries `command`. The reading tools are known, so a path in
 * them is not a refusal.
 */
function parseOpencode(stdin: string): HookInput | { readonly error: string } {
  const read = parseJsonObject(stdin);
  if (!read.ok) return { error: read.error };
  const parsed = read.value;

  const tool = parsed.tool;
  if (typeof tool !== 'string' || tool.length === 0) return { error: 'tool is missing' };
  const cwd = stringField(parsed.cwd);
  const args = parsed.args;
  const record = isRecord(args) ? args : undefined;

  switch (tool) {
    case 'write':
      return { toolName: 'Write', toolInput: { file_path: record?.filePath, content: record?.content }, cwd };
    case 'edit':
      return {
        toolName: 'Edit',
        toolInput: { file_path: record?.filePath, old_string: record?.oldString, new_string: record?.newString },
        cwd,
      };
    case 'apply_patch':
      return { toolName: 'apply_patch', toolInput: { command: record?.patchText }, cwd };
    case 'bash':
      return { toolName: 'Bash', toolInput: { command: record?.command }, cwd };
    case 'read':
      return { toolName: 'Read', toolInput: args, cwd };
    case 'glob':
      return { toolName: 'Glob', toolInput: args, cwd };
    case 'grep':
      return { toolName: 'Grep', toolInput: args, cwd };
    default:
      if (carriesPath(args)) {
        return { error: `la herramienta desconocida "${tool}" trae una ruta y el candado no sabe qué escribiría` };
      }
      return { toolName: tool, toolInput: args, cwd };
  }
}

/** §3.2: the request of one client, translated to the `HookInput` the lock already knows. */
export function parseClientInput(client: HookClient, stdin: string): HookInput | { readonly error: string } {
  if (client === 'codex') return parseCodex(stdin);
  if (client === 'opencode') return parseOpencode(stdin);
  return parseHookInput(stdin);
}

/**
 * §3.1 and §3.2: the refusal in the only shape each client obeys. Claude and Codex read the JSON
 * deny on stdout with exit 0 (Codex ignores an exit 2). OpenCode reads a non-zero exit as a block,
 * so its refusal is the reason on stderr and exit 2; the plugin turns that into a thrown error.
 */
export function renderClientOutput(client: HookClient, decision: LockDecision): ClientOutput {
  if (client === 'opencode') {
    if (decision.allow) return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: decision.reason, exitCode: 2 };
  }
  const output = renderHookOutput(decision);
  return { stdout: output.stdout, stderr: '', exitCode: output.exitCode };
}
