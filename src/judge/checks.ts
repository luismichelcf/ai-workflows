// PLAN-13-R3 §3.4 and §3.7: what the judge reads from GitHub about a SHA — the check of a stage,
// and the states and check-runs that imitate the judge's own name.

import {
  MergeQueueNotReady,
  type CheckRunSummary,
  type CommitStatus,
  type JudgeGitHub,
  type MergeQueueEntry,
} from './port.js';

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

/** PLAN-13-R6 §7: the engine's red test. Only a check-run tied to its official run counts. */
export const RED_TEST_CONTEXT = 'ai-workflows/red-test';

/** PLAN-13-R6 §7: the exact path of the official red-test workflow, taken from the workflow itself. */
const RED_TEST_WORKFLOW_PATH = '.github/workflows/ai-workflows-red-test.yml';

/**
 * PLAN-13-R6 §7: what the red test is judged against, so a check-run can be tied to the official
 * run of this pull request and its current base. `isAncestorOfBase` and `existsInBase` are the two
 * questions answered by git over the trusted tree (external edge); a failure there waits.
 */
export interface CheckOrigin {
  /** What the judged SHA is: the head of a pull request, or the SHA of a queue group. */
  readonly event: 'pull_request' | 'merge_group';
  /** The pull request being judged. */
  readonly pr: number;
  /** The branch the pull request is judged against. */
  readonly baseRef: string;
  /** The trusted tip of that branch. */
  readonly baseSha: string;
  /** Whether `sha` is the tip of the base or an ancestor of it. */
  isAncestorOfBase(sha: string): Promise<boolean>;
  /** Whether the file is in the trusted tree of the base. */
  existsInBase(path: string): Promise<boolean>;
}

export interface CheckOutcome {
  readonly outcome: 'passed' | 'waiting' | 'rejected' | 'technical';
  readonly reason?: string;
  /**
   * PLAN-13-R3 §3.4 (R13): an older check-run of the same name that the newest, green one replaced,
   * when that older attempt did not end in `success`. It changes no verdict: the judge only says it.
   */
  readonly note?: string;
}

/**
 * The pauses before each re-read of a queue that has not listed the group yet (PLAN-13-R3 §3.2).
 * They grow and then settle at one minute, so the whole wait reaches about five minutes (COLA-6:
 * with six pull requests armed at once, GitHub listed some groups more than a minute after their
 * event, and a shorter wait gave up and made GitHub take a piece out of the queue).
 */
export const MERGE_QUEUE_PAUSES_MS: readonly number[] = [
  2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
];

export type MergeQueueWait =
  | { readonly ok: true; readonly entries: readonly MergeQueueEntry[] }
  | { readonly ok: false; readonly readFailed: true; readonly reason: string }
  | { readonly ok: false; readonly readFailed: false };

/**
 * PLAN-13-R3 §3.2: a merge queue can list the group a moment after the event names it. The list is
 * read again, waiting, until the group appears — at most ten reads with growing pauses, up to about
 * five minutes — and only then is its absence treated as a failure. An entry the queue is still assembling (its commits are
 * not there yet) counts as the group not appearing yet, so it is read again. Any other read that
 * throws is never retried: it stays technical at once, because it says nothing about the group.
 */
export async function waitForMergeQueue(
  github: Pick<JudgeGitHub, 'mergeQueue'>,
  branch: string,
  sha: string,
  sleep: (ms: number) => Promise<void>,
): Promise<MergeQueueWait> {
  for (let attempt = 0; attempt <= MERGE_QUEUE_PAUSES_MS.length; attempt += 1) {
    if (attempt > 0) {
      const pause = MERGE_QUEUE_PAUSES_MS[attempt - 1];
      if (pause !== undefined) await sleep(pause);
    }
    let queue: readonly MergeQueueEntry[];
    try {
      queue = await github.mergeQueue(branch);
    } catch (error) {
      if (error instanceof MergeQueueNotReady) continue;
      return { ok: false, readFailed: true, reason: reasonOf(error) };
    }
    if (queue.some((entry) => entry.headSha === sha)) return { ok: true, entries: queue };
  }
  return { ok: false, readFailed: false };
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
 * PLAN-13-R3 §3.4 and PLAN-13-R6 §7: the exact check `name` over `sha`. For the engine's red test
 * (`ai-workflows/red-test`) a check-run counts only when that concrete check-run is tied to a job
 * of the official red-test workflow, run for this pull request and its current base; commit
 * statuses of that name never count. For any other (project) check the rule of R3 §3.4 stands: the
 * most recent check-run or status of that name, of any application. Anything still running waits;
 * anything finished that is not `success` rejects; unreadable is technical. The judge never runs a
 * suite.
 */
export async function requireCheck(
  github: JudgeGitHub,
  sha: string,
  name: string,
  locale: string,
  origin?: CheckOrigin,
): Promise<CheckOutcome> {
  const spanish = isSpanish(locale);
  let runs: CheckRunSummary[];
  try {
    runs = await github.checkRuns(sha, name);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }

  if (name === RED_TEST_CONTEXT) {
    return redTestOutcome(github, sha, runs, origin, spanish);
  }

  let statuses: CommitStatus[];
  try {
    statuses = (await github.statuses(sha)).filter((status) => status.context === name);
  } catch (error) {
    return { outcome: 'technical', reason: reasonOf(error) };
  }

  // Several runs of one name cannot be ordered when any of them lacks an id: GitHub always sends
  // it, so a list like that is refused rather than guessed (a single run without an id still stands).
  if (runs.length > 1 && runs.some((run) => run.id === undefined)) {
    return {
      outcome: 'technical',
      reason: spanish
        ? `Hay varios check-runs «${name}» y alguno no trae id: no se puede decidir cuál es el más reciente.`
        : `There are several check-runs "${name}" and one has no id: the most recent cannot be decided.`,
    };
  }

  // The most recent run is the one with the greatest id (GitHub numbers them in order); a run
  // without an id can only be the single run of that name, so it stands when it is alone.
  const latestRun = runs.reduce<CheckRunSummary | undefined>((latest, run) => {
    if (latest === undefined) return run;
    if (run.id === undefined) return latest;
    if (latest.id === undefined) return run;
    return run.id > latest.id ? run : latest;
  }, undefined);
  const latest = statuses[0];
  if (latestRun === undefined && latest === undefined) {
    return {
      outcome: 'waiting',
      reason: spanish ? `Falta el check «${name}».` : `The check "${name}" is missing.`,
    };
  }

  if (
    (latestRun !== undefined && latestRun.status !== 'completed') ||
    latest?.state === 'pending'
  ) {
    return {
      outcome: 'waiting',
      reason: spanish ? `El check «${name}» todavía no terminó.` : `The check "${name}" has not finished yet.`,
    };
  }

  // Name the check before its conclusion, so the report reads which one failed and how.
  if (latestRun !== undefined && latestRun.conclusion !== 'success') {
    return {
      outcome: 'rejected',
      reason: spanish
        ? `El check ${name} terminó en ${conclusionOf(latestRun)}.`
        : `The check ${name} ended ${conclusionOf(latestRun)}.`,
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

  // The newest run is green; if an older attempt of the same name ended otherwise, the judge says
  // which one it replaced. It is a trace (R13), never a change of the verdict.
  const note = replacedAttemptNote(runs, latestRun, name, spanish);
  // PLAN-13-R6 §7: the run log says where the check that counted came from (the application, or a
  // commit status). It is a trace, never a change of the verdict.
  const originNote = projectOriginNote(name, latestRun, latest, spanish);
  const combined = [note, originNote].filter((entry): entry is string => entry !== undefined);
  return combined.length === 0 ? { outcome: 'passed' } : { outcome: 'passed', note: combined.join(' ') };
}

/** PLAN-13-R6 §7: the note that says which application published the project check that counted. */
function projectOriginNote(
  name: string,
  latestRun: CheckRunSummary | undefined,
  latest: CommitStatus | undefined,
  spanish: boolean,
): string | undefined {
  if (latestRun !== undefined && (latest === undefined || latestRun.status === 'completed')) {
    return spanish
      ? `${name}: el check vino de la aplicación ${latestRun.app}`
      : `${name}: the check came from the application ${latestRun.app}`;
  }
  if (latest !== undefined) {
    return spanish
      ? `${name}: contó un estado de commit`
      : `${name}: a commit status counted`;
  }
  return undefined;
}

/** PLAN-13-R6 §7: one red-test check-run as it walked the chain, or why it could not be tied. */
type RedChainResult =
  | { readonly ok: true; readonly inProgress: boolean; readonly conclusion: string | null }
  | { readonly ok: false; readonly fork: boolean };

/**
 * PLAN-13-R6 §7: whether one red-test check-run is tied to a job of the official red-test
 * workflow, run for this pull request and its current base. A read that fails throws, so the
 * caller turns it into a wait; a check-run that simply does not pass the chain returns `ok: false`.
 */
async function redTestRunPasses(
  github: JudgeGitHub,
  run: CheckRunSummary,
  sha: string,
  origin: CheckOrigin,
): Promise<RedChainResult> {
  if (run.app !== 'github-actions') return { ok: false, fork: false };
  if (run.id === undefined || run.checkSuiteId === undefined) return { ok: false, fork: false };

  const suiteRuns = await github.checkSuiteRuns(run.checkSuiteId);
  if (suiteRuns.length !== 1) return { ok: false, fork: false };
  const actionsRun = suiteRuns[0] as (typeof suiteRuns)[number];
  if (actionsRun.headSha !== sha) return { ok: false, fork: false };

  const jobs = await github.workflowRunJobs(actionsRun.id);
  const wanted = `/check-runs/${String(run.id)}`;
  if (!jobs.some((job) => job.checkRunUrl.endsWith(wanted))) return { ok: false, fork: false };

  const workflow = await github.workflowById(actionsRun.workflowId);
  if (workflow.path !== RED_TEST_WORKFLOW_PATH) return { ok: false, fork: false };
  if (!(await origin.existsInBase(workflow.path))) return { ok: false, fork: false };

  if (actionsRun.event !== origin.event) return { ok: false, fork: false };
  if (origin.event === 'pull_request') {
    const pull = actionsRun.pullRequests.find(
      (entry) => entry.number === origin.pr && entry.baseRef === origin.baseRef,
    );
    if (pull === undefined) {
      return { ok: false, fork: actionsRun.pullRequests.length === 0 };
    }
    // The run's base is the current tip or an ancestor of it (the base only moved forward). The
    // question is always asked of git, so a base that cannot be read waits instead of passing.
    if (!(await origin.isAncestorOfBase(pull.baseSha))) {
      return { ok: false, fork: false };
    }
  }
  return { ok: true, inProgress: run.status !== 'completed', conclusion: run.conclusion };
}

/**
 * PLAN-13-R6 §7: the red test of `sha`, from the check-runs that pass the origin chain. The most
 * recent of those decides; the ones that do not pass are ignored and named in the note. A chain
 * that cannot be read waits, with the motive, and never turns green.
 */
async function redTestOutcome(
  github: JudgeGitHub,
  sha: string,
  runs: readonly CheckRunSummary[],
  origin: CheckOrigin | undefined,
  spanish: boolean,
): Promise<CheckOutcome> {
  if (origin === undefined) {
    return {
      outcome: 'waiting',
      reason: spanish
        ? 'La prueba roja no se puede comprobar sin el PR y su base.'
        : 'The red test cannot be checked without the pull request and its base.',
    };
  }

  const ignored: number[] = [];
  const passing: { run: CheckRunSummary; inProgress: boolean; conclusion: string | null }[] = [];
  let fork = false;
  for (const run of runs) {
    let result: RedChainResult;
    try {
      result = await redTestRunPasses(github, run, sha, origin);
    } catch (error) {
      return {
        outcome: 'waiting',
        reason: spanish
          ? `No se pudo leer la cadena de la prueba roja: ${reasonOf(error)}`
          : `The red test's chain could not be read: ${reasonOf(error)}`,
      };
    }
    if (result.ok) passing.push({ run, inProgress: result.inProgress, conclusion: result.conclusion });
    else {
      if (result.fork) fork = true;
      if (run.id !== undefined) ignored.push(run.id);
    }
  }

  const ignoredNote = ignored.length === 0
    ? undefined
    : spanish
      ? `${RED_TEST_CONTEXT}: se ignoran check-runs sin origen oficial (ids ${ignored.join(', ')})`
      : `${RED_TEST_CONTEXT}: check-runs without an official origin are ignored (ids ${ignored.join(', ')})`;

  if (passing.length === 0) {
    const reason = fork
      ? spanish
        ? 'no se puede atar la prueba roja a este PR'
        : 'the red test cannot be tied to this PR'
      : spanish
        ? `El check «${RED_TEST_CONTEXT}» no se pudo atar a su corrida oficial.`
        : `The check "${RED_TEST_CONTEXT}" could not be tied to its official run.`;
    return ignoredNote === undefined
      ? { outcome: 'waiting', reason }
      : { outcome: 'waiting', reason, note: ignoredNote };
  }

  const latest = passing.reduce((best, entry) =>
    (entry.run.id ?? -1) > (best.run.id ?? -1) ? entry : best,
  );
  const replaced = replacedAttemptNote(
    passing.map((entry) => entry.run),
    latest.run,
    RED_TEST_CONTEXT,
    spanish,
  );
  const note = [ignoredNote, replaced].filter((entry): entry is string => entry !== undefined);
  const withNote = (outcome: CheckOutcome): CheckOutcome =>
    note.length === 0 ? outcome : { ...outcome, note: note.join(' ') };

  if (latest.inProgress) {
    return withNote({
      outcome: 'waiting',
      reason: spanish ? `El check «${RED_TEST_CONTEXT}» todavía no terminó.` : `The check "${RED_TEST_CONTEXT}" has not finished yet.`,
    });
  }
  if (latest.conclusion !== 'success') {
    return withNote({
      outcome: 'rejected',
      reason: spanish
        ? `El check ${RED_TEST_CONTEXT} terminó en ${latest.conclusion ?? 'sin conclusión'}.`
        : `The check ${RED_TEST_CONTEXT} ended ${latest.conclusion ?? 'with no conclusion'}.`,
    });
  }
  return withNote({ outcome: 'passed' });
}

/**
 * PLAN-13-R3 §3.4 (R13): names the older, non-green check-run of the same name that a newer green
 * one replaced, or nothing when the newest run is not the single green attempt.
 */
function replacedAttemptNote(
  runs: readonly CheckRunSummary[],
  latest: CheckRunSummary | undefined,
  name: string,
  spanish: boolean,
): string | undefined {
  if (latest === undefined || latest.id === undefined) return undefined;
  if (latest.status !== 'completed' || latest.conclusion !== 'success') return undefined;
  const latestId = latest.id;
  let previous: CheckRunSummary | undefined;
  for (const run of runs) {
    if (run === latest || run.id === undefined || run.id >= latestId) continue;
    if (run.status !== 'completed' || run.conclusion === 'success') continue;
    if (previous === undefined || previous.id === undefined || run.id > previous.id) previous = run;
  }
  if (previous === undefined) return undefined;
  const conclusion = conclusionOf(previous);
  return spanish
    ? `${name}: un intento anterior terminó en ${conclusion} y lo reemplazó uno más reciente`
    : `${name}: an earlier attempt ended ${conclusion} and a more recent one replaced it`;
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
 * PLAN-13-R3 §3.7: whether a run of one of §3.2's events came from the main branch. A merge queue
 * run's head branch is `gh-readonly-queue/<principal>/…`; every other event runs from the
 * principal. `pull_request_target` is not required, because GitHub always runs that workflow from
 * the principal. A missing head branch cannot be checked, so it is trusted.
 */
function headBranchIsOfficial(
  event: string,
  headBranch: string | undefined,
  principal: string,
): boolean {
  if (headBranch === undefined) {
    // `pull_request_target` and `issue_comment` always run the workflow of the principal, so a run
    // without a head branch cannot be an imitation there. Every other event must name one: a copy
    // of the judge dispatched from another branch, or a run nobody can place, is not official.
    return event === 'pull_request_target' || event === 'issue_comment';
  }
  if (event === 'merge_group') return headBranch.startsWith(`gh-readonly-queue/${principal}/`);
  if (event === 'pull_request_target') return true;
  return headBranch === principal;
}

/**
 * One status is official if its `target_url` is this repository's run link (with or without a
 * job), that run exists, its path is the judge's workflow, its event is one of §3.2 and it came
 * from the main branch. The id of that run is returned so a caller can compare it with its own.
 */
export async function officialRunId(
  github: JudgeGitHub,
  status: CommitStatus,
  repository: string,
  judgePath: string,
  principal: string,
  serverUrl: string,
): Promise<number | undefined> {
  const url = status.targetUrl;
  if (url === null) return undefined;
  const pattern = new RegExp(
    `^${escapeRegExp(serverUrl)}/${escapeRegExp(repository)}/actions/runs/(\\d+)(?:/job/\\d+)?/?$`,
  );
  const match = pattern.exec(url);
  if (match?.[1] === undefined) return undefined;
  const id = Number.parseInt(match[1], 10);
  const run = await github.workflowRun(id);
  if (run === undefined || run.path !== judgePath || !JUDGE_EVENTS.includes(run.event)) {
    return undefined;
  }
  return headBranchIsOfficial(run.event, run.headBranch, principal) ? id : undefined;
}

export interface TraceCollection {
  readonly unofficial: Unofficial[];
  /** What could not be read while looking for the trace, with its motive. */
  readonly notes: string[];
}

/**
 * PLAN-13-R3 §3.7: the states and check-runs that did not come from the judge's own official run.
 * A failure to read the states, the check-runs or one run is reported in `notes` and never stops
 * the other states from being checked; it never changes the verdict either.
 */
export async function collectUnofficial(
  github: JudgeGitHub,
  sha: string,
  repository: string,
  judgePath: string,
  principal: string,
  serverUrl: string,
  contexts: readonly string[] = JUDGE_CONTEXTS,
  locale = 'es',
): Promise<TraceCollection> {
  const spanish = isSpanish(locale);
  const unofficial: Unofficial[] = [];
  const notes: string[] = [];

  let statuses: CommitStatus[];
  try {
    statuses = await github.statuses(sha);
  } catch (error) {
    notes.push(
      spanish
        ? `No se pudieron leer los estados de ${sha}: ${reasonOf(error)}`
        : `The statuses of ${sha} could not be read: ${reasonOf(error)}`,
    );
    return { unofficial, notes };
  }
  for (const status of statuses) {
    if (!contexts.includes(status.context)) continue;
    let official: number | undefined;
    try {
      official = await officialRunId(github, status, repository, judgePath, principal, serverUrl);
    } catch (error) {
      notes.push(
        spanish
          ? `No se pudo comprobar el estado ${status.context} de ${sha}: ${reasonOf(error)}`
          : `The status ${status.context} of ${sha} could not be checked: ${reasonOf(error)}`,
      );
      continue;
    }
    if (official !== undefined) continue;
    unofficial.push({ sha, context: status.context, kind: 'status', url: status.targetUrl });
  }

  for (const name of contexts) {
    let runs;
    try {
      runs = await github.checkRuns(sha, name);
    } catch (error) {
      notes.push(
        spanish
          ? `No se pudieron leer los check-runs «${name}» de ${sha}: ${reasonOf(error)}`
          : `The check-runs "${name}" of ${sha} could not be read: ${reasonOf(error)}`,
      );
      continue;
    }
    for (const run of runs) {
      unofficial.push({ sha, context: name, kind: 'check-run', url: run.url, app: run.app });
    }
  }

  return { unofficial, notes };
}
