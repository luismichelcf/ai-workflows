import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { JsonValue, Store } from '../contract.js';
import { safeTerminalText } from '../safe-text.js';
import { gitHead, gitIsClean, runGit } from './git.js';

// PLAN-13-R4 §3.8: `finish` retires what `cleanup` recorded once the piece is `done`. The gate
// never removes the folder (the engine runs inside it) or the local branch; this command does,
// from the main copy, repeatably, and repairing only the registry entry of THIS piece.

export interface FinishOptions {
  readonly mainRoot: string;
  readonly piece: string;
  readonly store: Store;
  readonly locale: string;
  readonly runId?: string;
  readonly leaseMs?: number;
  readonly now?: () => number;
}

export interface FinishResult {
  readonly ok: boolean;
  readonly text: string;
}

const DEFAULT_LEASE_MS = 15 * 60_000;

function spanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface CleanupEvidence {
  readonly branch: string;
  readonly headSha: string;
  readonly folder: string;
}

/** The last passed `cleanup` entry's evidence, the only schema `finish` reads. */
function cleanupEvidence(
  journal: readonly { stage: string; outcome: string; evidence?: JsonValue }[],
): CleanupEvidence | undefined {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry === undefined || entry.stage !== 'cleanup' || entry.outcome !== 'passed') continue;
    const block = asObject(asObject(entry.evidence)?.['block']);
    const branch = block === undefined ? undefined : asString(block['branch']);
    const headSha = block === undefined ? undefined : asString(block['headSha']);
    const folder = block === undefined ? undefined : asString(block['folder']);
    if (branch !== undefined && headSha !== undefined && folder !== undefined) {
      return { branch, headSha, folder };
    }
  }
  return undefined;
}

/** Whether the running process is inside `folder`, so removing it would lock the folder. */
function cwdInside(folder: string): boolean {
  const cwd = resolve(process.cwd());
  const target = resolve(folder);
  const normalized = process.platform === 'win32' ? target.toLowerCase() : target;
  const here = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return (
    here === normalized
    || here.startsWith(`${normalized}\\`)
    || here.startsWith(`${normalized}/`)
  );
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** A plain directory check that never follows a broken link into a throw. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repairs ONLY the registry entry of `folder`: it finds the `worktrees/<name>` directory whose
 * `gitdir` file points exactly at `folder/.git` and removes that one directory. Never
 * `git worktree prune`, which would deregister other pieces whose folder is on a disconnected
 * drive.
 */
async function repairRegistry(mainRoot: string, folder: string): Promise<boolean> {
  const common = await runGit(mainRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return false;
  const worktrees = join(common.stdout.trim(), 'worktrees');
  if (!existsSync(worktrees)) return false;

  const wanted = join(folder, '.git');
  for (const name of readdirSync(worktrees)) {
    const gitdirFile = join(worktrees, name, 'gitdir');
    let target: string;
    try {
      target = readFileSync(gitdirFile, 'utf8').trim();
    } catch {
      continue;
    }
    if (samePath(target, wanted)) {
      rmSync(join(worktrees, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return true;
    }
  }
  return false;
}

export async function finishPiece(options: FinishOptions): Promise<FinishResult> {
  const { mainRoot, piece, store, locale } = options;
  const es = spanish(locale);
  const runId = options.runId ?? `finish-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const held = await store.reserve(piece, runId, leaseMs);
  if (!held.ok) {
    return {
      ok: false,
      text: es
        ? `La pieza la tiene otra sesión (${safeTerminalText(held.heldBy)}); no se tocó nada.`
        : `Another session holds the piece (${safeTerminalText(held.heldBy)}); nothing was touched.`,
    };
  }

  try {
    const current = await store.loadStatus(piece);
    if (current === undefined || current.status.state !== 'done') {
      return {
        ok: false,
        text: es
          ? 'La pieza no está terminada; no se retira nada.'
          : 'The piece is not done; nothing is retired.',
      };
    }

    const journal = await store.journal(piece);
    const evidence = cleanupEvidence(journal);
    if (evidence === undefined) {
      return {
        ok: false,
        text: es
          ? 'La pieza no tiene la limpieza registrada; no se retira nada.'
          : 'The piece has no recorded cleanup; nothing is retired.',
      };
    }

    const notes: string[] = [];
    if (isDirectory(evidence.folder)) {
      if (samePath(evidence.folder, mainRoot)) {
        return {
          ok: false,
          text: es
            ? 'La carpeta de la pieza es la copia principal; nunca se retira.'
            : 'The piece folder is the main copy; it is never retired.',
        };
      }
      if (!(await gitIsClean(evidence.folder))) {
        return {
          ok: false,
          text: es
            ? 'La carpeta tiene cambios sin guardar: guárdalos o descártalos y vuelve a ejecutar finish.'
            : 'The folder has unsaved changes: save or discard them and run finish again.',
        };
      }
      const head = await gitHead(evidence.folder);
      if (head !== evidence.headSha) {
        return {
          ok: false,
          text: es
            ? `La carpeta no está en la cabeza fusionada (${head}); no se retira.`
            : `The folder is not at the merged head (${head}); it is not retired.`,
        };
      }
      if (cwdInside(evidence.folder)) process.chdir(mainRoot);
      const removed = await runGit(mainRoot, ['worktree', 'remove', evidence.folder]);
      if (!removed.ok) {
        return {
          ok: false,
          text: es
            ? `No se pudo retirar la carpeta: ${safeTerminalText(removed.stderr.trim())}`
            : `The folder could not be retired: ${safeTerminalText(removed.stderr.trim())}`,
        };
      }
      notes.push(es ? 'carpeta retirada' : 'folder retired');
    } else if (await repairRegistry(mainRoot, evidence.folder)) {
      notes.push(es ? 'registro de la carpeta reparado' : 'folder registry repaired');
    }

    const branchExists = await runGit(mainRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${evidence.branch}`,
    ]);
    if (branchExists.ok) {
      const tip = branchExists.stdout.trim();
      if (tip === evidence.headSha) {
        const deleted = await runGit(mainRoot, ['branch', '-D', evidence.branch]);
        if (!deleted.ok) {
          return {
            ok: false,
            text: es
              ? `No se pudo borrar la rama local: ${safeTerminalText(deleted.stderr.trim())}`
              : `The local branch could not be deleted: ${safeTerminalText(deleted.stderr.trim())}`,
          };
        }
        notes.push(es ? 'rama local borrada' : 'local branch deleted');
      } else {
        notes.push(
          es
            ? `la rama local apunta a otra versión (${tip}); no se tocó`
            : `the local branch points at another version (${tip}); it was left alone`,
        );
      }
    }

    const detail = notes.length === 0 ? (es ? 'nada pendiente' : 'nothing left') : notes.join(', ');
    return {
      ok: true,
      text: es ? `Pieza ${piece}: ${detail}.` : `Piece ${piece}: ${detail}.`,
    };
  } catch (error) {
    return {
      ok: false,
      text: es
        ? `No se pudo terminar de retirar la pieza: ${safeTerminalText(reasonOf(error))}`
        : `The piece could not be fully retired: ${safeTerminalText(reasonOf(error))}`,
    };
  } finally {
    await store.release(piece, runId).catch(() => undefined);
  }
}
