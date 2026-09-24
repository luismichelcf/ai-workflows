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
 * PLAN-13-R4 §7: the events whose commit the judge can actually read. The head is fetched
 * strictly elsewhere; here each event's own commit is brought in on its own, and one that cannot
 * be fetched is dropped — never a permanent technical block. If dropping it leaves a builder
 * that changed something or an angle uncovered, the normal decision says so.
 */
export async function fetchableEvents(
  context: Pick<ServerAttestContext, 'fetchObjects' | 'head'>,
  events: readonly PieceEvent[],
): Promise<PieceEvent[]> {
  const usable: PieceEvent[] = [];
  for (const event of events) {
    if (event.sha === context.head) {
      usable.push(event);
      continue;
    }
    try {
      await context.fetchObjects([event.sha]);
      usable.push(event);
    } catch {
      // GitHub no longer delivers that commit: the event simply does not count.
    }
  }
  return usable;
}
