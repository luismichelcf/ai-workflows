import { ProcessTreeSurvived } from '../contract.js';
import type { ProcessGroup, ProcessGroupControl } from '../process-group.js';

// PLAN-13-R2 §11 (review round 1): emptying a group is decided by whoever emptied it. A group
// that reports an explicit "not empty" is quarantined as it is, whatever the command's own
// exit code was; only a LOST answer (the Windows launcher died, left no file or did not answer
// in time) may be settled by asking the system again, and even then only an affirmative
// "empty" lifts the quarantine. This lives in one place so the command block, the project
// command, the test runner and the review executor cannot drift apart.

export async function confirmEmptyGroup(
  group: ProcessGroup,
  control: ProcessGroupControl,
  program: string,
): Promise<void> {
  const result = await group.terminate();
  if (result.empty) return;
  // An explicit "not empty" is a fact the launcher (or the POSIX kill) observed: it is final
  // and never overruled by a second opinion, which could turn a live process into a pass.
  if (result.lost !== true) {
    throw new ProcessTreeSurvived(
      group.quarantine,
      `the process group of "${program}" is not empty`,
    );
  }
  // The answer was lost, so the system is asked again; only an affirmative "empty" lifts it.
  let confirmed = false;
  try {
    confirmed = (await control.check(group.quarantine)).empty;
  } catch {
    confirmed = false;
  }
  if (confirmed) return;
  throw new ProcessTreeSurvived(
    group.quarantine,
    `the process group of "${program}" is not confirmed empty`,
  );
}
