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
  // Bash, PowerShell and Monitor ride along so the sign-off rule can see shell commands; the hook
  // lets them through itself when they carry no sign-off (see editor.ts). Monitor runs a shell
  // command like Bash, so it carries the same `command` text.
  const matcher =
    client === 'claude' ? 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor' : 'apply_patch|Bash';

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

/**
 * Deep copy of a JSON-shaped value. The caller keeps using the file it handed us, so every array
 * and object we hand back — the user's groups, keys we never looked at, our own groups — must be
 * its own object. Sharing one nested value would let a later edit through our result silently
 * change the file behind the caller's back (Rule 3).
 */
function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepCopy(entry)) as unknown as T;
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = deepCopy(entry);
    }
    return copy as unknown as T;
  }
  return value;
}

/** Reads the groups, refusing any entry that is not an object so we never rebuild over a shape we did not understand. */
function readGroups(pre: readonly unknown[]): Array<Record<string, unknown>> {
  return pre.map((group) => {
    if (!isRecord(group)) {
      throw new Error('Un grupo de "PreToolUse" no es un objeto JSON: no se reconstruye para no perder lo que tiene.');
    }
    return group;
  });
}

/**
 * A fresh copy of our own groups. Command and type always come from buildHooksConfig, so a
 * rewritten command cannot steer a reinstall. The only thing the user owns on our entry is the
 * `timeout` they may have added by hand, and it rides along when they set a numeric one (Rule 1).
 */
function copyOurGroups(groups: readonly HookGroup[], timeout: number | undefined): HookGroup[] {
  return groups.map((group) => ({
    matcher: group.matcher,
    hooks: group.hooks.map((handler) =>
      timeout === undefined
        ? { type: handler.type, command: handler.command }
        : { type: handler.type, command: handler.command, timeout },
    ),
  }));
}

/**
 * Adds our entry to an existing settings or hooks file without touching anything else in
 * it. Installing twice changes nothing the second time, and reinstalling repairs an earlier
 * install in place: an outdated matcher is refreshed and duplicate copies collapse to one.
 */
export function mergeHooksConfig(existing: unknown, ours: HooksFile): Record<string, unknown> {
  // `undefined` and `null` mean the file does not exist yet, not that it has a strange shape.
  // A brand-new file is simply ours, deep-copied so the caller cannot mutate us through it.
  if (existing === undefined || existing === null) {
    return deepCopy(ours) as unknown as Record<string, unknown>;
  }

  // Rule 1: a file that is not a plain object (a list, text, a number) is one we do not
  // understand. Rebuilding it would silently drop whatever the user had, so we refuse and
  // name the file as the place we could not read.
  // The copy is made here, once: everything the result carries comes from `base`, so nothing
  // it returns shares a nested object with the caller's file (Rule 3).
  if (!isRecord(existing)) {
    throw new Error(
      'El archivo de configuración no es un objeto JSON (es una lista, un texto o un número): no se reconstruye para no perder lo que tiene.',
    );
  }
  const base = deepCopy(existing);

  // `hooks` may be absent, but if it is present it must be a plain object. A list or text here
  // is a shape we cannot merge into without destroying data, so we refuse and name `hooks`.
  const hooksValue = base.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    throw new Error('La clave "hooks" no es un objeto JSON: no se reconstruye para no perder lo que tiene.');
  }
  const baseHooks: Record<string, unknown> = isRecord(hooksValue) ? hooksValue : {};

  // `PreToolUse` may be absent, but if present it must be a list whose every entry is a group
  // object. Guessing at any other shape would lose the user's groups, so we refuse and name it.
  const preValue = baseHooks.PreToolUse;
  if (preValue !== undefined && !Array.isArray(preValue)) {
    throw new Error('La clave "PreToolUse" no es una lista de grupos de ganchos: no se reconstruye para no perder lo que tiene.');
  }
  const currentGroups = readGroups(Array.isArray(preValue) ? preValue : []);

  const ourCommand = normalizeCommand(firstCommand(ours));
  const ourGroups = ours.hooks.PreToolUse;

  // Rule 1: look for a usable timeout the user set on one of our handlers before we rebuild
  // anything, so the single copy keeps it even when the first copy did not carry one. Only a
  // positive whole number is kept: `'30'`, 0, -5, a fraction or NaN would be copied into the
  // file as a timeout the CLI cannot honor, so they are dropped like an absent one.
  let ourTimeout: number | undefined;
  for (const group of currentGroups) {
    const handlers = Array.isArray(group.hooks) ? group.hooks : undefined;
    if (handlers === undefined) continue;
    for (const handler of handlers) {
      if (!isOurHandler(handler, ourCommand) || !isRecord(handler)) continue;
      if (typeof handler.timeout === 'number' && Number.isInteger(handler.timeout) && handler.timeout > 0) {
        ourTimeout = handler.timeout;
        break;
      }
    }
    if (ourTimeout !== undefined) break;
  }

  const groups: unknown[] = [];
  let placed = false;

  for (const group of currentGroups) {
    const handlers: readonly unknown[] | undefined = Array.isArray(group.hooks) ? group.hooks : undefined;
    const holdsOurs = handlers !== undefined && handlers.some((handler) => isOurHandler(handler, ourCommand));

    // Rule 2: not ours (checked across every group, not just the first) stays exactly as it was.
    // `group` is already a deep copy, so pushing it shares nothing with the file we were given.
    if (!holdsOurs) {
      groups.push(group);
      continue;
    }

    // Rule 2: pull our handler out of this group. Foreign handlers keep the group's own
    // matcher — we never widen it to ours — and an empty group disappears entirely.
    const foreigners = handlers.filter((handler) => !isOurHandler(handler, ourCommand));

    // Rule 2: every copy of ours collapses into this one, placed where the first copy was.
    // Placing it at the first occurrence, rather than appending, keeps a correct file in order.
    if (!placed) {
      groups.push(...copyOurGroups(ourGroups, ourTimeout));
      placed = true;
    }

    if (foreigners.length > 0) {
      groups.push({ ...group, hooks: foreigners });
    }
  }

  // Rule 5: a foreign group already using our matcher never blocks us; if no group held our
  // handler, this is a first install and our entry goes at the end.
  if (!placed) {
    groups.push(...copyOurGroups(ourGroups, ourTimeout));
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
