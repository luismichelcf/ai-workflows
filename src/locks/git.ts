// Git hooks: layer 2 of the locks (see ../locks.ts).

import type { LockContext, LockDecision } from './editor.js';
import { isUnder, readAbsolute, readAgainst, readPapers } from './paths.js';

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

/**
 * The arguments for `git` that list what is staged in a form `parseStagedPaths` reads: NUL
 * separated, so names are never quoted, and with renames split into both sides, so moving code
 * into a paper folder still shows the code it removes.
 */
export const STAGED_PATHS_GIT_ARGS: readonly string[] = [];

/** The staged paths from the output of `git` with `STAGED_PATHS_GIT_ARGS`. */
export function parseStagedPaths(_output: string): readonly string[] {
  throw new Error('parseStagedPaths: not implemented');
}

/**
 * The remote refs git is about to update, read from the lines it sends to pre-push on stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`. A line in any other shape is refused.
 */
export function parsePrePushStdin(
  _stdin: string,
): { readonly ok: true; readonly remoteRefs: readonly string[] } | { readonly ok: false; readonly reason: string } {
  throw new Error('parsePrePushStdin: not implemented');
}

export type GitHookKind = 'pre-commit' | 'pre-push';

/** The script git runs. POSIX sh, LF only: a CR in the first line breaks it. */
export function renderGitHook(kind: GitHookKind, argv: readonly string[]): string {
  const command = argv.join(' ');
  // The body is assembled from LF-joined lines so no `\r` can slip in; a CR at the end of
  // the shebang makes the kernel look for an interpreter named `/bin/sh\r` and fail with a
  // message that never points at the cause.
  //
  // `exec` replaces the shell with the lock command, which keeps stdin intact: git feeds the
  // pre-push refs on stdin and the command must still see them. The hook kind travels as an
  // argument, and `"$@"` forwards git's own arguments untouched.
  return ['#!/bin/sh', `exec ${command} ${kind} "$@"`, ''].join('\n');
}
