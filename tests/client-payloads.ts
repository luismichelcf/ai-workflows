import { join } from 'node:path';

// PLAN-13-R6 §3.1: the requests Codex 0.159.0 and OpenCode 1.18.30 really send, captured on the
// owner's PC on 29-sep and sanitized by hand. Ids are placeholders and every path is built from the
// temporary project of the test, so nothing of the machine that captured them is kept here.
//
// Codex sends the same envelope as Claude Code (tool_name, tool_input, cwd, hook_event_name,
// session_id, turn_id, tool_use_id, permission_mode, model). Its editing tool is `apply_patch`
// (aliases `Edit` and `Write`) with the WHOLE patch in `tool_input.command` and relative paths;
// the console is `Bash` with `tool_input.command` as text.
//
// OpenCode hands its plugin `(input, output)`: `input.tool`, `input.sessionID`, `input.callID` and
// `output.args`. `write` carries `{filePath, content}`, `edit` `{filePath, oldString, newString}`,
// `bash` `{command}`; `filePath` arrives absolute (with backslashes on Windows). `apply_patch`
// (`{patchText}`) was not offered by the model used in the capture: its shape comes from OpenCode's
// source. The plugin forwards one call to the engine on stdin as
// `{tool, sessionID, callID, args, cwd}`, where `cwd` is the plugin's `directory`.

export const SHA = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

/** An absolute path inside the project, spelled with the separator of the running system. */
export const inProject = (project: string, rel: string): string => join(project, ...rel.split('/'));

const CODEX_ENVELOPE = {
  session_id: '00000000-0000-7000-8000-00000000c0de',
  turn_id: '00000000-0000-7000-8000-00000000ab1e',
  hook_event_name: 'PreToolUse',
  model: 'gpt-6-sol',
  permission_mode: 'bypassPermissions',
  tool_use_id: 'exec-00000000-0000-4000-8000-000000000001',
} as const;

/** The patch Codex wrote in the capture: one added file, relative path. */
export const addFilePatch = (rel: string, content = 'd'): string =>
  ['*** Begin Patch', `*** Add File: ${rel}`, ...content.split('\n').map((line) => `+${line}`), '*** End Patch'].join('\n');

/** Codex, editing through `apply_patch` (or one of its aliases). */
export function codexPatch(cwd: string, patch: string, toolName: 'apply_patch' | 'Edit' | 'Write' = 'apply_patch'): Record<string, unknown> {
  return { ...CODEX_ENVELOPE, cwd, tool_name: toolName, tool_input: { command: patch } };
}

/** Codex, running a console order (PowerShell text on Windows, still `Bash`). */
export function codexBash(cwd: string, command: string): Record<string, unknown> {
  return { ...CODEX_ENVELOPE, cwd, tool_name: 'Bash', tool_input: { command } };
}

/** Codex, any other tool with any input (MCP tools send their whole argument object). */
export function codexTool(cwd: string, toolName: string, toolInput: unknown): Record<string, unknown> {
  return { ...CODEX_ENVELOPE, cwd, tool_name: toolName, tool_input: toolInput };
}

export const OPENCODE_INPUT = { sessionID: 'ses_placeholder0000000000000001', callID: 'call_00_placeholder000000000001' } as const;

/** What the OpenCode plugin sends to the engine for one call (the wire format defined in §3.2). */
export function opencodeCall(cwd: string, tool: string, args: unknown): Record<string, unknown> {
  return { tool, sessionID: OPENCODE_INPUT.sessionID, callID: OPENCODE_INPUT.callID, args, cwd };
}

export const opencodeWrite = (project: string, rel: string, content = 's') =>
  opencodeCall(project, 'write', { filePath: inProject(project, rel), content });

export const opencodeEdit = (project: string, rel: string, newString = 'nuevo') =>
  opencodeCall(project, 'edit', { filePath: inProject(project, rel), oldString: 'viejo', newString });

export const opencodePatch = (project: string, patch: string) => opencodeCall(project, 'apply_patch', { patchText: patch });

export const opencodeBash = (project: string, command: string) => opencodeCall(project, 'bash', { command });

/** Claude Code, for the equivalent case. */
export function claudeWrite(project: string, rel: string, content = 'x\n'): Record<string, unknown> {
  return { tool_name: 'Write', tool_input: { file_path: inProject(project, rel), content }, cwd: project, hook_event_name: 'PreToolUse' };
}

export function claudeBash(project: string, command: string): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command }, cwd: project, hook_event_name: 'PreToolUse' };
}
