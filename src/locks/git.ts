// Git hooks: layer 2 of the locks (see ../locks.ts).

import type { LockContext, LockDecision } from './editor.js';
import { canonicalize, isUnder } from './paths.js';

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
