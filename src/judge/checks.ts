// PLAN-13-R3 §3.4 and §3.7: what the judge reads from GitHub about a SHA — the check of a stage,
// and the states and check-runs that imitate the judge's own name.

import type { CheckRunSummary, CommitStatus, JudgeGitHub } from './port.js';

// The events of §3.2: only a run of one of these, of the judge's workflow, is an official status.
export const JUDGE_EVENTS: readonly string[] = [
  'pull_request_target',
  'merge_group',
  'issue_comment',
  'workflow_run',
  'workflow_dispatch',
];

/** The two names the judge publishes under, and the ones an imitator would copy. */
export const JUDGE_CONTEXTS: readonly string[] = ['ai-workflows', 'ai-workflows/advisory'];

export interface CheckOutcome {
  readonly outcome: 'passed' | 'waiting' | 'rejected' | 'technical';
  readonly reason?: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

/** The conclusion a finished check-run reported, or a word for one that never reported. */
function conclusionOf(run: CheckRunSummary): string {
  return run.conclusion ?? 'sin conclusión';
}

/**
 * PLAN-13-R3 §3.4: the exact check `name` over `sha`. Every check-run of that name counts, and
 * only the most recent commit status of that context. Anything still running waits; anything
 * finished that is not `success` rejects; unreadable is technical. The judge never runs a suite.
 */
export async function requireCheck(
  github: JudgeGitHub,
  sha: string,
  name: string,
  locale: string,
): Promise<CheckOutcome> {
  const spanish = isSpanish(locale);
  let runs: CheckRunSummary[];
  let statuses: CommitStatus[];
  try {
    runs = await github.checkRuns(sha, name);
    statuses = (await github.statuses(sha)).filter((status) => status.context === name);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }

  const latest = statuses[0];
  if (runs.length === 0 && latest === undefined) {
    return {
      outcome: 'waiting',
      reason: spanish ? `Falta el check «${name}».` : `The check "${name}" is missing.`,
    };
  }

  if (runs.some((run) => run.status !== 'completed') || latest?.state === 'pending') {
    return {
      outcome: 'waiting',
      reason: spanish ? `El check «${name}» todavía no terminó.` : `The check "${name}" has not finished yet.`,
    };
  }

  // Name the check before its conclusion, so the report reads which one failed and how.
  const failedRun = runs.find((run) => run.status === 'completed' && run.conclusion !== 'success');
  if (failedRun !== undefined) {
    return {
      outcome: 'rejected',
      reason: spanish
        ? `El check ${name} terminó en ${conclusionOf(failedRun)}.`
        : `The check ${name} ended ${conclusionOf(failedRun)}.`,
    };
  }
  if (latest !== undefined && latest.state !== 'success') {
    return {
      outcome: 'rejected',
      reason: spanish
        ? `El check ${name} terminó en ${latest.state}.`
        : `The check ${name} ended ${latest.state}.`,
    };
  }
  return { outcome: 'passed' };
}

/** PLAN-13-R3 §3.7: one state or check-run that is not the judge's own. */
export interface Unofficial {
  readonly sha: string;
  readonly context: string;
  readonly kind: 'status' | 'check-run';
  readonly url: string | null;
  readonly app?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One is official if its `target_url` is this repository's run link (with or without a job), that
 * run exists, its path is the judge's workflow and its event is one of §3.2. The judge itself
 * never creates a check-run under its own name, so every such check-run is reported.
 */
async function isOfficialStatus(
  github: JudgeGitHub,
  status: CommitStatus,
  repository: string,
  judgePath: string,
): Promise<boolean> {
  const url = status.targetUrl;
  if (url === null) return false;
  const pattern = new RegExp(
    `^https://github\\.com/${escapeRegExp(repository)}/actions/runs/(\\d+)(?:/job/\\d+)?/?$`,
  );
  const match = pattern.exec(url);
  if (match?.[1] === undefined) return false;
  const run = await github.workflowRun(Number.parseInt(match[1], 10));
  return run !== undefined && run.path === judgePath && JUDGE_EVENTS.includes(run.event);
}

/** The states and check-runs of §3.7 that did not come from the judge's own official run. */
export async function collectUnofficial(
  github: JudgeGitHub,
  sha: string,
  repository: string,
  judgePath: string,
): Promise<Unofficial[]> {
  const found: Unofficial[] = [];
  try {
    const statuses = await github.statuses(sha);
    for (const status of statuses) {
      if (!JUDGE_CONTEXTS.includes(status.context)) continue;
      if (await isOfficialStatus(github, status, repository, judgePath)) continue;
      found.push({ sha, context: status.context, kind: 'status', url: status.targetUrl });
    }
  } catch {
    // The trace is a side report: a state list that cannot be read adds nothing, and never
    // changes the verdict, which only depends on the checks the stages require.
  }
  for (const name of JUDGE_CONTEXTS) {
    try {
      const runs = await github.checkRuns(sha, name);
      for (const run of runs) {
        found.push({ sha, context: name, kind: 'check-run', url: run.url, app: run.app });
      }
    } catch {
      // Same as above: unreadable check-runs are not a verdict.
    }
  }
  return found;
}
