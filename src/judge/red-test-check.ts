import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createWorktree, linkModules, removeWorktree } from '../blocks/build-verify.js';
import { redTestBlock } from '../blocks/red-test.js';
import { filesMatching, runTests } from '../blocks/test-run.js';
import { isGreenRun, isRedEvidence, parseTestRun, type TestRunSummary } from '../commands.js';
import type { GateContext } from '../contract.js';
import { gitEnvironment } from '../git-env.js';
import { appliesIfFor, languageOf } from '../recipe/applies.js';
import { checkRecipe } from '../recipe/blocks.js';
import {
  describeChangeFromCommits,
  gitProjectFiles,
  type ChangeFacts,
} from '../recipe/facts.js';
import type { Recipe, RecipeStage } from '../recipe/types.js';
import { waitForMergeQueue } from './checks.js';
import { pieceOfBranch, readDeclaredKind } from './pieces.js';
import type { JudgeGitHub } from './port.js';
import { escapeReportText } from './summary.js';

// PLAN-13-R3 §5: the unprivileged job `ai-workflows/red-test`. For every piece the `red-test`
// stage applies to, the new or changed tests are copied from the head into a throwaway worktree
// of the base and must fail there by their own assertion; the same run in a worktree of the head
// must be green. The recipe always comes from the trusted commit (the live head of the main
// branch), never from the base of the event or the disk, so a PR that removes the stage is still
// judged with it. Every git command runs through `execFile` (never a console), test processes run
// with an environment stripped of tokens and secrets, and every temporary worktree is removed.

const MINUTES_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const RECIPE_PATH = '.ai-workflows/pipeline.yml';

const RED_TEST_USES = 'ai-workflows/red-test@1';

/** §5: the environment of a test process carries none of these, in any spelling. */
const FORBIDDEN_ENV = /TOKEN|SECRET|PASSWORD|KEY|^ACTIONS_|^GH_/i;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Waits for real, unless the caller injects its own pause (the tests pass one that returns at once). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * PLAN-13-R3 §5: everything that came from the pull request (branches, paths, declared values,
 * motives) is sanitised and escaped before it reaches the summary: no raw controls, HTML, table
 * separators or link brackets.
 */
function escapeText(text: string): string {
  return escapeReportText(text).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fieldOf(value: unknown, key: string): unknown {
  return recordOf(value)?.[key];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** §5: the process's own environment, minus every token, secret, password and key. */
function filteredEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (FORBIDDEN_ENV.test(name)) continue;
    environment[name] = value;
  }
  return environment;
}

interface GitRun {
  readonly ok: boolean;
  readonly stdout: string;
}

function runGit(root: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnvironment(),
      },
      (error, stdout) => resolve({ ok: error === null, stdout: stdout ?? '' }),
    );
  });
}

/** The whole content of one file at one commit, or `undefined` when that commit lacks it. */
async function showFile(root: string, sha: string, path: string): Promise<string | undefined> {
  const result = await runGit(root, ['show', `${sha}:${path}`]);
  return result.ok ? result.stdout : undefined;
}

async function existsAt(root: string, sha: string, path: string): Promise<boolean> {
  return (await runGit(root, ['cat-file', '-e', `${sha}:${path}`])).ok;
}

function stageTests(): readonly string[] {
  const spec = redTestBlock.manifest.inputs['tests'];
  return spec !== undefined && spec.type === 'glob-list' && spec.default !== undefined
    ? spec.default
    : [];
}

function stageTimeout(): number {
  const spec = redTestBlock.manifest.inputs['timeout-minutes'];
  return spec !== undefined && spec.type === 'integer' && spec.default !== undefined
    ? spec.default
    : 30;
}

function withField(stage: RecipeStage, key: string): unknown {
  return recordOf(stage.gate.with)?.[key];
}

interface CheckPr {
  readonly number: number;
  /** The head of the pull request itself; the change and its declared kind are read from it. */
  readonly headSha: string;
  readonly headRef: string;
  /** The branch the pull request targets; one that does not target the main branch is not judged. */
  readonly baseRef: string;
  /** The commit the tests run against. */
  readonly baseSha: string;
  /** The commit the tests are copied from and must pass against. */
  readonly runHead: string;
}

type CollectResult = { readonly ok: true; readonly prs: readonly CheckPr[] } | { readonly ok: false; readonly reason: string };

type PullRequests = Pick<JudgeGitHub, 'defaultBranch' | 'branchHead' | 'mergeQueue' | 'pullRequest'>;

async function collectPullRequests(
  eventName: string,
  event: unknown,
  github: PullRequests,
  branch: string,
  sleep: (ms: number) => Promise<void>,
): Promise<CollectResult> {
  if (eventName === 'pull_request') {
    const pull = fieldOf(event, 'pull_request');
    const number = numberOf(fieldOf(pull, 'number'));
    const head = fieldOf(pull, 'head');
    const headSha = stringOf(fieldOf(head, 'sha'));
    const headRef = stringOf(fieldOf(head, 'ref'));
    const base = fieldOf(pull, 'base');
    const baseSha = stringOf(fieldOf(base, 'sha'));
    const baseRef = stringOf(fieldOf(base, 'ref'));
    if (
      number === undefined ||
      headSha === undefined ||
      headRef === undefined ||
      baseSha === undefined ||
      baseRef === undefined
    ) {
      return { ok: false, reason: 'La carga del evento no trae el PR con su cabeza y su base.' };
    }
    return { ok: true, prs: [{ number, headSha, headRef, baseRef, baseSha, runHead: headSha }] };
  }

  if (eventName === 'merge_group') {
    const groupSha = stringOf(fieldOf(fieldOf(event, 'merge_group'), 'head_sha'));
    if (groupSha === undefined) return { ok: false, reason: 'La carga del grupo no trae su SHA.' };
    // §5, §3.2: the queue may list the group a moment after the event names it. The list is read
    // again, waiting, until it shows the group; a read that throws fails at once.
    const read = await waitForMergeQueue(github, branch, groupSha, sleep);
    if (!read.ok) {
      return {
        ok: false,
        reason: read.readFailed
          ? `No se pudo leer la cola de fusión: ${read.reason}`
          : `La cola de fusión no lista el grupo ${groupSha}.`,
      };
    }
    const queue = read.entries;
    const index = queue.findIndex((entry) => entry.headSha === groupSha);
    if (index === -1) {
      return { ok: false, reason: `La cola de fusión no lista el grupo ${groupSha}.` };
    }
    const prs: CheckPr[] = [];
    for (const entry of queue.slice(0, index + 1)) {
      let pr;
      try {
        pr = await github.pullRequest(entry.prNumber);
      } catch (error) {
        return {
          ok: false,
          reason: `No se pudo leer el PR ${entry.prNumber} de la cola: ${reasonOf(error)}`,
        };
      }
      prs.push({
        number: entry.prNumber,
        headSha: pr.headSha,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        baseSha: entry.baseSha,
        runHead: groupSha,
      });
    }
    return { ok: true, prs };
  }

  return { ok: false, reason: `Evento no soportado: ${eventName}.` };
}

// The motives of the `red-test` block (PLAN-13-R2 §3.4), in the recipe's locale.
function noTestsReason(spanish: boolean): string {
  return spanish
    ? 'La pieza no trae pruebas: sin una prueba que falle por su aserción no hay autorización para construir.'
    : 'The piece brings no tests: without a test that fails by its own assertion there is no authorisation to build.';
}

function greenReason(spanish: boolean): string {
  return spanish ? 'La prueba pasó: no está roja.' : 'The test passed: it is not red.';
}

function brokenReason(spanish: boolean): string {
  return spanish
    ? 'La prueba falló por importación o entorno, no por su aserción.'
    : 'The test failed by import or environment, not by its assertion.';
}

function headFailedReason(spanish: boolean): string {
  return spanish ? 'La prueba no pasó contra la cabeza.' : 'The test did not pass against the head.';
}

function noCommandReason(spanish: boolean): string {
  return spanish ? 'La etapa no trae un comando que correr.' : 'The stage brings no command to run.';
}

function passedReason(spanish: boolean): string {
  return spanish
    ? 'La prueba falla contra la base y pasa contra la cabeza.'
    : 'The test fails against the base and passes against the head.';
}

function couldNotRunReason(spanish: boolean, detail: string): string {
  return spanish ? `No se pudo correr la prueba: ${detail}` : `The test could not be run: ${detail}`;
}

interface StageOutcome {
  readonly id: string;
  readonly outcome: 'passed' | 'skipped' | 'failed';
  readonly reason: string;
}

interface PrOutcome {
  readonly number: number;
  readonly headRef?: string;
  readonly piece?: string;
  readonly failure?: string;
  /** Something to say about a PR that was not judged (a target branch other than the main one). */
  readonly note?: string;
  readonly stages: readonly StageOutcome[];
}

interface RunContext {
  readonly root: string;
  readonly recipe: Recipe;
  readonly signal: AbortSignal;
  readonly environment: NodeJS.ProcessEnv;
}

/** Runs one command over the copied tests at `baseCommit`, reading the test contents from `contentCommit`. */
async function runOnce(
  context: RunContext,
  baseCommit: string,
  contentCommit: string,
  testFiles: readonly string[],
  command: string,
  timeoutMs: number,
  piece: string,
): Promise<TestRunSummary> {
  const { root } = context;
  const { parent, tree } = await createWorktree(root, baseCommit, 'aiw-redtest-');
  let modulesLink: string | undefined;
  try {
    modulesLink = await linkModules(root, tree);
    for (const file of testFiles) {
      const content = await showFile(root, contentCommit, file);
      if (content === undefined) {
        throw new Error(`the test file "${file}" is not in the commit being run`);
      }
      const target = join(tree, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const run = await runTests({
      command,
      root: tree,
      tests: testFiles,
      timeoutMs,
      piece,
      signal: context.signal,
      environment: context.environment,
    });
    if (run.kind === 'technical') throw new Error(run.reason);
    return parseTestRun({
      output: run.output,
      exitCode: run.code,
      ...(run.truncated ? { truncated: true } : {}),
    });
  } finally {
    await removeWorktree(root, tree, parent, modulesLink);
  }
}

async function checkStage(
  context: RunContext,
  stage: RecipeStage,
  facts: ChangeFacts,
  pr: CheckPr,
  piece: string,
): Promise<StageOutcome> {
  const spanish = languageOf(context.recipe.locale) === 'es';
  const applies = appliesIfFor(context.recipe, stage.id);
  const gateContext: GateContext = {
    piece,
    stage: stage.id,
    change: facts,
    journal: [],
    locale: context.recipe.locale,
    mode: 'run',
    signal: context.signal,
    runEffect: async () => {
      throw new Error('the red-test check never runs an effect');
    },
  };
  if (applies !== undefined) {
    const applicability = applies(gateContext);
    if (applicability !== true) {
      const reason = typeof applicability === 'object' ? applicability.skip : 'No aplica.';
      return { id: stage.id, outcome: 'skipped', reason };
    }
  }

  const command = asString(withField(stage, 'command'));
  if (command === undefined || command.length === 0) {
    return { id: stage.id, outcome: 'failed', reason: noCommandReason(spanish) };
  }
  const providedTests = asStringList(withField(stage, 'tests'));
  const testsGlobs = providedTests.length > 0 ? providedTests : stageTests();
  const timeoutValue = withField(stage, 'timeout-minutes');
  const timeoutMinutes = typeof timeoutValue === 'number' && Number.isInteger(timeoutValue)
    ? timeoutValue
    : stageTimeout();

  const candidates = filesMatching(testsGlobs, facts.files);
  const testFiles: string[] = [];
  for (const file of candidates) {
    if (await existsAt(context.root, pr.headSha, file)) testFiles.push(file);
  }
  if (testFiles.length === 0) return { id: stage.id, outcome: 'failed', reason: noTestsReason(spanish) };

  const timeoutMs = timeoutMinutes * MINUTES_MS;

  let redSummary: TestRunSummary;
  try {
    redSummary = await runOnce(context, pr.baseSha, pr.runHead, testFiles, command, timeoutMs, piece);
  } catch (error) {
    return { id: stage.id, outcome: 'failed', reason: couldNotRunReason(spanish, reasonOf(error)) };
  }
  if (!isRedEvidence(redSummary)) {
    return {
      id: stage.id,
      outcome: 'failed',
      reason: isGreenRun(redSummary) ? greenReason(spanish) : brokenReason(spanish),
    };
  }

  let greenSummary: TestRunSummary;
  try {
    greenSummary = await runOnce(context, pr.runHead, pr.runHead, testFiles, command, timeoutMs, piece);
  } catch (error) {
    return { id: stage.id, outcome: 'failed', reason: couldNotRunReason(spanish, reasonOf(error)) };
  }
  if (!isGreenRun(greenSummary)) return { id: stage.id, outcome: 'failed', reason: headFailedReason(spanish) };

  return { id: stage.id, outcome: 'passed', reason: passedReason(spanish) };
}

async function checkPullRequest(
  context: RunContext,
  pr: CheckPr,
  trusted: string,
): Promise<PrOutcome> {
  const base: {
    number: number;
    headRef?: string;
    piece?: string;
    failure?: string;
    note?: string;
    stages: StageOutcome[];
  } = {
    number: pr.number,
    headRef: pr.headRef,
    stages: [],
  };

  const pieceResult = pieceOfBranch(context.recipe, pr.headRef, pr.number);
  if ('none' in pieceResult) {
    base.failure = pieceResult.none;
    return base;
  }
  const piece = pieceResult.piece;
  base.piece = piece;

  try {
    const declared = await readDeclaredKind(
      context.recipe,
      piece,
      gitProjectFiles(context.root, pr.headSha),
    );
    if ('rejected' in declared) {
      base.failure = declared.rejected;
      return base;
    }
    const facts = await describeChangeFromCommits({
      root: context.root,
      base: trusted,
      head: pr.headSha,
      recipe: context.recipe,
      piece,
      ...(declared.kind === undefined ? {} : { declaredKind: declared.kind }),
    });

    const stages = context.recipe.stages.filter(
      (stage) => stage.phase === 'pre-merge' && stage.gate.uses === RED_TEST_USES,
    );
    for (const stage of stages) {
      const outcome = await checkStage(context, stage, facts, pr, piece);
      base.stages.push(outcome);
      if (outcome.outcome === 'failed') base.failure = outcome.reason;
    }
  } catch (error) {
    base.failure = reasonOf(error);
  }
  return base;
}

function renderSummary(
  prs: readonly PrOutcome[],
  locale: string,
  detail: string | undefined,
): string {
  const spanish = languageOf(locale) === 'es';
  const lines: string[] = [
    spanish ? '# Prueba roja en GitHub' : '# Red test on GitHub',
    '',
  ];
  if (detail !== undefined) {
    lines.push(escapeText(detail), '');
    return lines.join('\n');
  }
  const applied = prs.some((pr) => pr.stages.some((stage) => stage.outcome !== 'skipped'));
  if (!applied) {
    lines.push(
      spanish
        ? 'Ninguna etapa `red-test` aplicó a esta corrida.'
        : 'No `red-test` stage applied to this run.',
      '',
    );
  }
  for (const pr of prs) {
    lines.push(`## #${pr.number}`);
    if (pr.headRef !== undefined) {
      lines.push(`${spanish ? 'Rama' : 'Branch'}: ${escapeText(pr.headRef)}.`);
    }
    if (pr.piece !== undefined) {
      lines.push(`${spanish ? 'Pieza' : 'Piece'}: ${escapeText(pr.piece)}.`);
    }
    if (pr.note !== undefined) lines.push(`- ${escapeText(pr.note)}`);
    if (pr.stages.length === 0 && pr.failure !== undefined) {
      lines.push(
        `- ${spanish ? 'No se pudo juzgar' : 'Could not be judged'}: ${escapeText(pr.failure)}`,
      );
    }
    for (const stage of pr.stages) {
      if (stage.outcome === 'passed') {
        lines.push(`- ${escapeText(stage.id)}: ${spanish ? 'pasó' : 'passed'}.`);
      } else {
        lines.push(`- ${escapeText(stage.id)}: ${escapeText(stage.reason)}`);
      }
    }
    if (pr.stages.length > 0 && pr.failure !== undefined) {
      lines.push(`- ${spanish ? 'Resultado: rechazado.' : 'Result: rejected.'}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * PLAN-13-R3 §5: judges whether the red test of every pull request really is red against its own
 * base and green against its own head, with the recipe of the trusted commit and the test
 * processes stripped of tokens and secrets. Never throws for an expected failure: it returns the
 * verdict and a Markdown summary in the recipe's locale.
 */
export async function runRedTestCheck(
  input: { eventName: string; event: unknown; root: string; repository: string },
  deps: {
    github: Pick<JudgeGitHub, 'defaultBranch' | 'branchHead' | 'mergeQueue' | 'pullRequest'>;
    fetchObjects(shas: string[]): Promise<void>;
    /** Waits between re-reads of a queue that has not listed the group yet. Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ ok: boolean; summary: string }> {
  const { eventName, event, root } = input;
  const sleep = deps.sleep ?? realSleep;

  let branch: string;
  try {
    branch = await deps.github.defaultBranch();
  } catch (error) {
    return { ok: false, summary: renderSummary([], 'es', `No se pudo leer la rama principal: ${reasonOf(error)}`) };
  }

  let trusted: string;
  try {
    trusted = await deps.github.branchHead(branch);
  } catch (error) {
    return {
      ok: false,
      summary: renderSummary([], 'es', `No se pudo leer la punta de ${branch}: ${reasonOf(error)}`),
    };
  }

  const collected = await collectPullRequests(eventName, event, deps.github, branch, sleep);
  if (!collected.ok) return { ok: false, summary: renderSummary([], 'es', collected.reason) };

  const shas = new Set<string>([trusted]);
  for (const pr of collected.prs) {
    shas.add(pr.headSha);
    shas.add(pr.runHead);
    shas.add(pr.baseSha);
  }
  try {
    await deps.fetchObjects([...shas]);
  } catch (error) {
    return { ok: false, summary: renderSummary([], 'es', `No se pudieron traer los commits a juzgar: ${reasonOf(error)}`) };
  }

  const recipeText = await showFile(root, trusted, RECIPE_PATH);
  if (recipeText === undefined) {
    return { ok: false, summary: renderSummary([], 'es', `No hay receta legible en ${trusted}:${RECIPE_PATH}.`) };
  }
  const checked = await checkRecipe(recipeText, RECIPE_PATH, { root });
  if (!checked.ok) {
    const first = checked.errors[0];
    return { ok: false, summary: renderSummary([], 'es', `La receta de ${trusted} no es válida: ${first?.message ?? 'error desconocido'}`) };
  }

  const spanish = languageOf(checked.recipe.locale) === 'es';

  // §5: the recipe comes from the live head of the main branch, which in a merge group must be an
  // ancestor of the group's SHA. Bringing the objects first is what makes this checkable.
  if (eventName === 'merge_group') {
    const groupSha = stringOf(fieldOf(fieldOf(event, 'merge_group'), 'head_sha'));
    if (groupSha !== undefined) {
      const ancestor = await runGit(root, ['merge-base', '--is-ancestor', trusted, groupSha]);
      if (!ancestor.ok) {
        return {
          ok: false,
          summary: renderSummary([], checked.recipe.locale, spanish
            ? `La punta de ${branch} (${trusted}) no es ancestro del grupo ${groupSha}.`
            : `The head of ${branch} (${trusted}) is not an ancestor of the group ${groupSha}.`),
        };
      }
    }
  }

  const context: RunContext = {
    root,
    recipe: checked.recipe,
    signal: new AbortController().signal,
    environment: filteredEnvironment(),
  };

  const outcomes: PrOutcome[] = [];
  let allOk = true;
  for (const pr of collected.prs) {
    if (pr.baseRef !== branch) {
      // §3.1: a pull request into another branch is not tested, and the check never passes on
      // that: it names the target branch and leaves the run red, so a retargeted PR cannot keep a
      // green that was never tested.
      outcomes.push({
        number: pr.number,
        headRef: pr.headRef,
        note: spanish
          ? `No se prueba: la rama destino es «${pr.baseRef}», no ${branch}.`
          : `Not tested: the target branch is "${pr.baseRef}", not ${branch}.`,
        stages: [],
      });
      allOk = false;
      continue;
    }
    const outcome = await checkPullRequest(context, pr, trusted);
    outcomes.push(outcome);
    if (outcome.failure !== undefined) allOk = false;
  }

  return { ok: allOk, summary: renderSummary(outcomes, checked.recipe.locale, undefined) };
}
