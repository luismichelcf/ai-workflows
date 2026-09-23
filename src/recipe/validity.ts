import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GateContext, JournalEntry, Store } from '../contract.js';
import type { ValidWhile } from '../blocks/manifest.js';
import { gitEnvironment } from '../git-env.js';

// PLAN-13-R2 §6: the four validity rules, and the clean update that keeps one alive. A step
// `from -> to` is a real merge commit whose second parent is an ancestor of the base and whose
// tree is exactly what merging `from` with that parent again would produce; anything edited by
// hand during the merge is refused. Git is asked every time — on write and on read — so a
// record written straight into the store proves nothing on its own. Everything runs through
// `execFile`, never a console.

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitResult {
  readonly stdout: string;
  readonly ok: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `git <args>`, returning its trimmed output and whether it exited zero. */
function runGit(
  root: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  const options = {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8' as const,
    env: gitEnvironment(extraEnv),
  };
  return new Promise((resolve) => {
    execFile('git', [...args], options, (error, stdout) => {
      resolve({ stdout: stdout.trim(), ok: error === null });
    });
  });
}

async function gitText(
  root: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(root, args, extraEnv);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout;
}

/** The tree id of the whole working state, computed with a temporary index (never the real one). */
async function snapshotTree(root: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aiw-index-'));
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(directory, 'index') };
    await gitText(root, ['read-tree', 'HEAD'], env);
    await gitText(root, ['add', '-A'], env);
    return await gitText(root, ['write-tree'], env);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * What the engine seals into evidence before and after a stage: the commit it is judging and
 * the tree of the whole working state at that moment. Both must be equal to the facts of the
 * run, or the result is not sealed.
 */
export async function readJudged(root: string): Promise<{ sha: string; snapshot: string }> {
  return { sha: await gitText(root, ['rev-parse', 'HEAD']), snapshot: await snapshotTree(root) };
}

/** The tree of a three-way merge recomputed by git, or undefined when it conflicts. */
async function mergeTree(
  root: string,
  mergeBase: string,
  from: string,
  parent: string,
): Promise<string | undefined> {
  const result = await runGit(root, [
    'merge-tree',
    '--write-tree',
    `--merge-base=${mergeBase}`,
    from,
    parent,
  ]);
  if (!result.ok) return undefined;
  return result.stdout.split('\n')[0] ?? '';
}

/**
 * Verifies the shape of a clean update `from -> to` in git: `to` is a merge commit whose first
 * parent is `from` and whose second parent is an ancestor of `baseRef`, and merging `from` with
 * that parent again produces exactly the tree of `to`. Throws with the motive when it does not.
 */
export async function verifyCleanUpdate(
  root: string,
  baseRef: string,
  from: string,
  to: string,
): Promise<{ base: string }> {
  const parents = (await gitText(root, ['rev-list', '--parents', '-n', '1', to])).split(/\s+/);
  if (parents.length !== 3 || parents[0] !== to) {
    throw new Error('it is not a merge commit of exactly two parents');
  }
  if (parents[1] !== from) throw new Error(`its first parent is not ${from}`);
  const parent = parents[2] as string;

  const ancestor = await runGit(root, ['merge-base', '--is-ancestor', parent, baseRef]);
  if (!ancestor.ok) throw new Error(`${parent} is not an ancestor of ${baseRef}`);

  const mergeBase = await gitText(root, ['merge-base', from, parent]);
  const merged = await mergeTree(root, mergeBase, from, parent);
  if (merged === undefined) throw new Error('merging both parents conflicts');
  const tree = await gitText(root, ['rev-parse', `${to}^{tree}`]);
  if (merged !== tree) throw new Error('the merge commit is not exactly the result of merging both parents');
  return { base: parent };
}

export interface RecordCleanUpdateOptions {
  readonly store: Store;
  readonly root: string;
  readonly baseRef: string;
  readonly piece: string;
  readonly from: string;
  readonly to: string;
  readonly runId?: string;
  readonly now?: () => number;
}

/**
 * Writes the engine's `@clean-update` record for a verified `from -> to` step. It is only ever
 * called by engine code: a project block never receives it. The step is verified again on read,
 * so the record alone proves nothing.
 */
export async function recordCleanUpdate(options: RecordCleanUpdateOptions): Promise<void> {
  const { store, root, baseRef, piece, from, to } = options;
  let base: string;
  try {
    ({ base } = await verifyCleanUpdate(root, baseRef, from, to));
  } catch (error) {
    throw new Error(`${to} is not a clean update of ${from}: ${reasonOf(error)}`);
  }
  await store.append(piece, {
    stage: '@clean-update',
    outcome: 'passed',
    evidence: { from, to, base },
    at: (options.now ?? Date.now)(),
    runId: options.runId ?? 'engine',
    pipeline: '',
  });
}

interface Judged {
  readonly sha: string;
  readonly snapshot: string;
  readonly fingerprint: string;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldOf(value, key);
  return typeof field === 'string' ? field : undefined;
}

function judgedOf(entry: JournalEntry): Judged | undefined {
  const judged = fieldOf(entry.evidence, 'judged');
  const sha = stringField(judged, 'sha');
  const snapshot = stringField(judged, 'snapshot');
  const fingerprint = stringField(judged, 'fingerprint');
  if (sha === undefined || snapshot === undefined || fingerprint === undefined) return undefined;
  return { sha, snapshot, fingerprint };
}

export interface StillValidOptions {
  readonly root: string;
  readonly baseRef: string;
}

/**
 * Whether the evidence a stage recorded still holds for the change in front of it. A skipped
 * entry carries no evidence, so it survives only under `forever`; every other rule makes the
 * engine evaluate `applies-if` again, so an omission never outlives a change of facts.
 */
export async function stillValidFor(
  rule: ValidWhile,
  entry: JournalEntry,
  context: GateContext,
  options: StillValidOptions,
): Promise<boolean> {
  if (rule === 'forever') return true;

  const judged = judgedOf(entry);
  if (judged === undefined) return false;

  const change = context.change;
  const sha = stringField(change, 'sha');
  const snapshot = stringField(change, 'snapshot');

  if (rule === 'same-sha') {
    return sha !== undefined && snapshot !== undefined && judged.sha === sha && judged.snapshot === snapshot;
  }

  if (rule === 'same-fingerprint') {
    const fingerprint = stringField(change, 'fingerprint');
    return (
      fingerprint !== undefined &&
      fingerprint.length > 0 &&
      judged.fingerprint.length > 0 &&
      judged.fingerprint === fingerprint
    );
  }

  // same-fingerprint-or-clean-update
  if (sha !== undefined && snapshot !== undefined && judged.sha === sha && judged.snapshot === snapshot) {
    return true;
  }
  if (fieldOf(change, 'clean') !== true) return false;
  const judgedTree = await gitText(options.root, ['rev-parse', `${judged.sha}^{tree}`]);
  if (judged.snapshot !== judgedTree) return false;
  if (sha === undefined) return false;
  return chainHolds(options.root, options.baseRef, context.journal, judged.sha, sha);
}

/** A chain of recorded and re-verified clean update steps from `from` to `to`. */
async function chainHolds(
  root: string,
  baseRef: string,
  journal: readonly JournalEntry[],
  from: string,
  to: string,
): Promise<boolean> {
  const next = new Map<string, string>();
  for (const entry of journal) {
    if (entry.stage !== '@clean-update' || entry.outcome !== 'passed') continue;
    const stepFrom = stringField(entry.evidence, 'from');
    const stepTo = stringField(entry.evidence, 'to');
    if (stepFrom === undefined || stepTo === undefined) continue;
    if (!next.has(stepFrom)) next.set(stepFrom, stepTo);
  }

  const seen = new Set<string>();
  let cursor = from;
  while (cursor !== to) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const target = next.get(cursor);
    if (target === undefined) return false;
    try {
      await verifyCleanUpdate(root, baseRef, cursor, target);
    } catch {
      return false;
    }
    cursor = target;
  }
  return true;
}
