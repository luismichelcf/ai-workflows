// Installing the editor hooks into a CLI settings file without losing what is there.

import { isRecord } from './shared.js';

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
