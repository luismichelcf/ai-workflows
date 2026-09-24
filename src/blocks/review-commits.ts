import { execFile } from 'node:child_process';

import { gitEnvironment } from '../git-env.js';
import { describeChangeFromCommits } from '../recipe/facts.js';
import type { PieceEvent } from '../agent/events.js';
import type { Recipe } from '../recipe/types.js';
import type { ServerAttestContext } from './definition.js';
import type { ValidWhile } from './manifest.js';

// PLAN-13-R4 §2.2: the version relation a verdict must satisfy, computed from commit objects.
// Next to the agent, `same-fingerprint-or-clean-update` also accepts a recorded clean update; on
// the server the judge never reads the store, so there only the head is accepted.

const GIT_TIMEOUT_MS = 60_000;

export function treeOfCommit(root: string, sha: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['rev-parse', `${sha}^{tree}`],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) resolve(stdout.trim());
        else reject(new Error(`git could not read the tree of ${sha}`));
      },
    );
  });
}

export async function commitFingerprint(
  root: string,
  base: string,
  sha: string,
  recipe: Recipe,
  piece: string,
  declaredKind?: string,
): Promise<string> {
  const facts = await describeChangeFromCommits({
    root,
    base,
    head: sha,
    recipe,
    piece,
    ...(declaredKind === undefined ? {} : { declaredKind }),
  });
  return facts.fingerprint;
}

/**
 * The version rule as the judge reads it: `same-fingerprint` compares each commit's fingerprint
 * against its own merge base with the principal; `…-or-clean-update` only accepts the head.
 */
export async function serverAccepts(
  root: string,
  trusted: string,
  head: string,
  sha: string,
  validWhile: ValidWhile,
  recipe: Recipe,
  piece: string,
): Promise<boolean> {
  if (validWhile === 'forever') return true;
  if (sha === head) return true;
  if (validWhile !== 'same-fingerprint') return false;
  const [headFingerprint, candidateFingerprint] = await Promise.all([
    commitFingerprint(root, trusted, head, recipe, piece),
    commitFingerprint(root, trusted, sha, recipe, piece),
  ]);
  return headFingerprint.length > 0 && headFingerprint === candidateFingerprint;
}

/**
 * PLAN-13-R4 §2.2 and §7: the events the judge can decide with, and the commits the remote no
 * longer has. The head is fetched strictly elsewhere; here each event's own commit is brought in
 * on its own. Every builder event counts, whatever its commit: it still excludes its session and
 * family, and the commit only says whether that builder changed something. A commit the remote
 * is missing (a `not our ref`, an unadvertised object, a ref that does not exist) is marked
 * `unavailable`; a verdict about it cannot decide, but a builder still excludes. Any other fetch
 * failure — the network, a 5xx, permissions — is technical and is rethrown, never swallowed into
 * an ignored event.
 */
export interface FetchableEvents {
  readonly events: readonly PieceEvent[];
  /** The shas the remote no longer has, so their events cannot be read as evidence. */
  readonly unavailable: ReadonlySet<string>;
}

const MISSING_OBJECT = /not our ref|unadvertised object|couldn't find remote ref|no such remote ref/i;

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && MISSING_OBJECT.test(error.message);
}

export async function fetchableEvents(
  context: Pick<ServerAttestContext, 'fetchObjects' | 'head'>,
  events: readonly PieceEvent[],
): Promise<FetchableEvents> {
  const unavailable = new Set<string>();
  const checked = new Set<string>([context.head]);
  for (const event of events) {
    if (checked.has(event.sha)) continue;
    checked.add(event.sha);
    try {
      await context.fetchObjects([event.sha]);
    } catch (error) {
      if (!isMissingObject(error)) throw error;
      unavailable.add(event.sha);
    }
  }
  return { events, unavailable };
}
