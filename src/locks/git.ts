// Git hooks: layer 2 of the locks (see ../locks.ts).

import type { LockContext, LockDecision } from './editor.js';
import { isUnder, readAbsolute, readAgainst, readPapers } from './paths.js';
import { isValidBranchName } from './refname.js';

export interface PreCommitInput {
  /** Staged paths, relative to the repository root. */
  readonly stagedPaths: readonly string[];
  readonly context: LockContext;
}

export function decidePreCommit(input: PreCommitInput): LockDecision {
  // An empty commit is not this lock's business: nothing is being added to the tree.
  if (input.stagedPaths.length === 0) return { allow: true };

  // The guarded folder is the configured project root, never the folder git happens to run in.
  // A root the lock cannot read is refused, like in the editor hook.
  const root = readAbsolute(input.context.projectRoot);
  if (!root.ok) {
    return {
      allow: false,
      reason:
        `La raíz del proyecto (projectRoot) no es una ruta absoluta que el candado pueda leer ` +
        `(${root.problem}). No puedo vigilar una carpeta que no entiendo.`,
    };
  }

  // Paper entries are read the same way in both locks: an entry that would switch the lock off
  // is refused as a paperPaths problem, not silently accepted.
  const papers = readPapers(input.context.paperPaths, root.path);
  if (!papers.ok) {
    return {
      allow: false,
      reason:
        `El candado no puede usar paperPaths: ${papers.problem}. ` +
        'Corrige la configuración o el candado dejaría de proteger el código.',
    };
  }

  // A folder with work in flight, or one opened as /libre, may commit. Same rule as the
  // editor hook, because both locks answer the same question at different moments.
  if (input.context.activePiece || input.context.libre) return { allow: true };

  // Staged paths are relative to the repository root, so the root is the base that reads them.
  // Sharing the editor lock's normalization makes `docs/../src/a.ts` resolve to `src/a.ts` and
  // stop posing as a paper — one implementation, one answer.
  const offenders: string[] = [];
  for (const stagedPath of input.stagedPaths) {
    const reading = readAgainst(stagedPath, root.path.display);
    if (!reading.ok || !papers.paths.some((paper) => isUnder(reading.path, paper))) offenders.push(stagedPath);
  }

  // With no piece, only papers may enter. One stray code file is enough to refuse, because
  // the commit would carry it.
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
  // The setting is validated before any ref is looked at, and even when the push carries no
  // default ref: a defaultBranch the lock cannot name is broken configuration, not a pass, and
  // silently treating it as "nothing matched" would switch the lock off without saying so.
  // `refs/` and `origin/` are refused explicitly: they would build `refs/heads/refs/heads/main`
  // or `refs/heads/origin/main`, a ref that never matches and so never refuses.
  const { defaultBranch } = input;
  const validDefaultBranch =
    isValidBranchName(defaultBranch) &&
    !defaultBranch.startsWith('refs/') &&
    !defaultBranch.startsWith('origin/');
  if (!validDefaultBranch) {
    return {
      allow: false,
      reason:
        `La configuración defaultBranch no es un nombre de rama válido (${JSON.stringify(defaultBranch)}). ` +
        'Corrige defaultBranch: debe ser un nombre como "main" o "release/main", sin "refs/" ni "origin/". ' +
        'Sin eso no puedo saber qué rama es la protegida y prefiero negar antes que dejar pasar a ciegas.',
    };
  }

  // Compare the whole ref, not its tail: `refs/heads/fix/main` is a branch of its own and
  // must never be mistaken for the default `refs/heads/main`.
  const defaultRef = `refs/heads/${defaultBranch}`;
  if (!input.remoteRefs.includes(defaultRef)) return { allow: true };

  return {
    allow: false,
    reason:
      `No se empuja directo a ${defaultRef}: la rama por defecto solo recibe merges vía PR. ` +
      'Sube tu rama y abre un pull request.',
  };
}

/**
 * The arguments for `git` that list what is staged in a form `parseStagedPaths` reads: NUL
 * separated, so names are never quoted, and with renames split into both sides, so moving code
 * into a paper folder still shows the code it removes.
 */
export const STAGED_PATHS_GIT_ARGS: readonly string[] = ['diff', '--cached', '--name-only', '-z', '--no-renames'];

/** The staged paths from the output of `git` with `STAGED_PATHS_GIT_ARGS`. */
export function parseStagedPaths(output: string): readonly string[] {
  // `-z` ends every entry with NUL, including the last, so the split leaves one trailing empty
  // piece. Take it out here: the empty string is never a path. No trimming and no unquoting —
  // under `-z` git does not quote, so a quote or a space is part of the name and must survive.
  return output.split('\0').filter((path) => path.length > 0);
}

/**
 * The remote refs git is about to update, read from the lines it sends to pre-push on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. A line in any other shape is refused.
 */
export function parsePrePushStdin(
  stdin: string,
): { readonly ok: true; readonly remoteRefs: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const remoteRefs: string[] = [];

  for (const rawLine of stdin.split('\n')) {
    // Windows git and its sh hand the refs over with CRLF; a trailing CR is line ending, not
    // part of the field, so it is stripped before splitting. Other CRs stay and fail the count.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    const fields = line.split(' ');
    const remoteRef = fields[2];
    if (fields.length !== 4 || remoteRef === undefined) {
      // Refuse instead of guessing which field is the ref: a line the lock does not understand
      // must never turn into a silent pass that pushes the default branch.
      return {
        ok: false,
        reason:
          `Una línea de pre-push no tiene cuatro campos (ref local, sha local, ref remoto, sha remoto): ` +
          `"${line}". Me niego a adivinar qué ref se empuja.`,
      };
    }

    remoteRefs.push(remoteRef);
  }

  return { ok: true, remoteRefs };
}

export type GitHookKind = 'pre-commit' | 'pre-push';

/**
 * Quotes one argument for POSIX sh as a literal: single quotes make the shell take every byte
 * as-is, so `$(...)`, `;` and spaces inside the argument are never read again. A single quote in
 * the argument is closed, escaped and reopened (`'\''`), the one character single quotes cannot
 * hold.
 */
function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The script git runs. POSIX sh, LF only: a CR in the first line breaks it. */
export function renderGitHook(kind: GitHookKind, argv: readonly string[]): string {
  // An empty argv would render `exec '<kind>' "$@"`: git's hooks would run a command that is
  // just the hook name, which is never what the caller meant. Refuse it, like a broken argument.
  if (argv.length === 0) {
    throw new Error('renderGitHook: argv must name the command to run');
  }

  // A line break or a NUL inside an argument would end the single quoted string and let the rest
  // of the argument run as shell code; no escaping can make a newline safe in one line. Throw
  // instead of writing a hook whose meaning is not the one that was asked for.
  for (const arg of argv) {
    if (arg.includes('\r') || arg.includes('\n') || arg.includes('\0')) {
      throw new Error('renderGitHook: arguments cannot contain CR, LF or NUL');
    }
  }

  // The command is one line of fully quoted arguments, then the kind, then `"$@"` so git's own
  // hook arguments reach the lock untouched.
  const command = [...argv.map(quoteArg), quoteArg(kind)].join(' ');
  // The body is assembled from LF-joined lines so no `\r` can slip in; a CR at the end of
  // the shebang makes the kernel look for an interpreter named `/bin/sh\r` and fail with a
  // message that never points at the cause.
  //
  // `exec` replaces the shell with the lock command, which keeps stdin intact: git feeds the
  // pre-push refs on stdin and the command must still see them. The hook kind travels as an
  // argument, and `"$@"` forwards git's own arguments untouched.
  return ['#!/bin/sh', `exec ${command} "$@"`, ''].join('\n');
}
