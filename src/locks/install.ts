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
  // Bash and PowerShell ride along so the sign-off rule can see shell commands; the hook lets
  // them through itself when they carry no sign-off (see editor.ts).
  const matcher = client === 'claude' ? 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell' : 'apply_patch|Bash';

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
 * Whitespace carries no meaning in a shell command, so a formatter or a hand edit can change
 * the spacing without changing what runs. Normalizing lets a reinstall recognize our own
 * entry anyway, instead of treating the reworded command as a stranger and duplicating it.
 */
function normalizeCommand(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  return command.trim().replace(/\s+/g, ' ');
}

/** True when a handler is one of ours, matched by its command's normalized form. */
function isOurHandler(handler: unknown, ourCommand: string | undefined): boolean {
  if (!isRecord(handler)) return false;
  return normalizeCommand(handler.command) === ourCommand;
}

/** A fresh copy of our own groups: no reference is shared with `ours` or with the caller. */
function copyGroups(groups: readonly HookGroup[]): HookGroup[] {
  return groups.map((group) => ({
    matcher: group.matcher,
    hooks: group.hooks.map((handler) => ({ ...handler })),
  }));
}

/**
 * Adds our entry to an existing settings or hooks file without touching anything else in
 * it. Installing twice changes nothing the second time, and reinstalling repairs an earlier
 * install in place: an outdated matcher is refreshed and duplicate copies collapse to one.
 */
export function mergeHooksConfig(existing: unknown, ours: HooksFile): Record<string, unknown> {
  // `undefined` and `null` mean the file does not exist yet, not that it has a strange shape.
  // A brand-new file is simply ours, copied so the caller cannot mutate us through it.
  if (existing === undefined || existing === null) {
    return {
      ...ours,
      hooks: {
        ...ours.hooks,
        PreToolUse: copyGroups(ours.hooks.PreToolUse),
      },
    };
  }

  // Rule 1: a file that is not a plain object (a list, text, a number) is one we do not
  // understand. Rebuilding it would silently drop whatever the user had, so we refuse and
  // name the file as the place we could not read.
  if (!isRecord(existing)) {
    throw new Error(
      'El archivo de configuración no es un objeto JSON (es una lista, un texto o un número): no se reconstruye para no perder lo que tiene.',
    );
  }

  // `hooks` may be absent, but if it is present it must be a plain object. A list or text here
  // is a shape we cannot merge into without destroying data, so we refuse and name `hooks`.
  const hooksValue = existing.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new Error('La clave "hooks" no es un objeto JSON: no se reconstruye para no perder lo que tiene.');
  }
  const baseHooks = isRecord(hooksValue) ? hooksValue : {};

  // `PreToolUse` may be absent, but if present it must be a list whose every entry is a group
  // object. Guessing at any other shape would lose the user's groups, so we refuse and name it.
  const preValue = baseHooks.PreToolUse;
  if (preValue !== undefined && !Array.isArray(preValue)) {
    throw new Error('La clave "PreToolUse" no es una lista de grupos de ganchos: no se reconstruye para no perder lo que tiene.');
  }
  const currentPre = Array.isArray(preValue) ? preValue : [];

  const ourCommand = normalizeCommand(firstCommand(ours));
  const ourGroups = ours.hooks.PreToolUse;

  // Everything is rebuilt into fresh objects and arrays. The caller may still be holding and
  // using `existing`, so mutating it in place would corrupt their file behind their back.
  const groups: unknown[] = [];
  let placed = false;

  for (const group of currentPre) {
    // Rule 1 again: any group that is not an object is unreadable; name `PreToolUse`.
    if (!isRecord(group)) {
      throw new Error('Un grupo de "PreToolUse" no es un objeto JSON: no se reconstruye para no perder lo que tiene.');
    }

    const handlers: readonly unknown[] | undefined = Array.isArray(group.hooks) ? group.hooks : undefined;
    const holdsOurs = handlers !== undefined && handlers.some((handler) => isOurHandler(handler, ourCommand));

    // Rule 2: not ours (checked across every group, not just the first) stays exactly as it was.
    if (!holdsOurs) {
      groups.push(group);
      continue;
    }

    // Rule 3: pull our handler out of this group. Foreign handlers keep the group's own
    // matcher — we never widen it to ours — and an empty group disappears entirely.
    const foreigners = handlers.filter((handler) => !isOurHandler(handler, ourCommand));

    // Repair in place: put our single, current entry where the stale one was. Placing it at the
    // first occurrence, rather than appending, keeps an already-correct file in the same order.
    if (!placed) {
      groups.push(...copyGroups(ourGroups));
      placed = true;
    }

    if (foreigners.length > 0) {
      groups.push({ ...group, hooks: foreigners });
    }
  }

  // Rule 5: a foreign group already using our matcher never blocks us; if no group held our
  // handler, this is a first install and our entry goes at the end.
  if (!placed) {
    groups.push(...copyGroups(ourGroups));
  }

  // Spread the base first so every untouched key (permissions and other hook events) rides
  // along verbatim; only PreToolUse is replaced with the combined list.
  return {
    ...existing,
    hooks: {
      ...baseHooks,
      PreToolUse: groups,
    },
  };
}
