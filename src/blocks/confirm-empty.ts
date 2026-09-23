import { ProcessTreeSurvived } from '../contract.js';
import type { ProcessGroup, ProcessGroupControl } from '../process-group.js';

// PLAN-13-R2 §11 (review round 1): emptying a group is decided by whoever emptied it. A group
// that reports an explicit "not empty" is quarantined as it is; only a LOST answer (the
// Windows launcher died, left no file or did not answer in time) may be settled by asking the
// system again, and even then only an affirmative "empty" lifts the quarantine. This lives in
// one place so the command block, the project command, the test runner and the review executor
// cannot drift apart.

export async function confirmEmptyGroup(
  group: ProcessGroup,
  control: ProcessGroupControl,
  program: string,
  endedCleanly = false,
): Promise<void> {
  const result = await group.terminate();
  if (result.empty) return;
  // A terminator that reports more than there is is cross-checked against the system only when
  // the block's own command exited 0 (`endedCleanly`): after a clean success asking again is
  // safe and avoids quarantining a group the system can already confirm empty. Every other end
  // — a killed command, a non-zero exit, a cancellation, a lost answer — trusts the report
  // there and then, because a second opinion at that point is a race that could turn a live
  // process into a pass.
  if (result.lost !== true && !endedCleanly) {
    throw new ProcessTreeSurvived(
      group.quarantine,
      `the process group of "${program}" is not empty`,
    );
  }
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
