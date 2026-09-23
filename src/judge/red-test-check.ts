import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createWorktree, linkModules, removeWorktree } from '../blocks/build-verify.js';
import { redTestBlock } from '../blocks/red-test.js';
import { filesMatching, runTests } from '../blocks/test-run.js';
import { isGreenRun, isRedEvidence, parseTestRun, type TestRunSummary } from '../commands.js';
import type { GateContext } from '../contract.js';
import { gitEnvironment } from '../git-env.js';
import { appliesIfFor } from '../recipe/applies.js';
import { checkRecipe } from '../recipe/blocks.js';
import {
  describeChangeFromCommits,
  gitProjectFiles,
  type ChangeFacts,
} from '../recipe/facts.js';
import type { Recipe, RecipeStage } from '../recipe/types.js';
import { pieceOfBranch, readDeclaredKind } from './pieces.js';
import type { JudgeGitHub, MergeQueueEntry } from './port.js';

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
): Promise<CollectResult> {
  if (eventName === 'pull_request') {
    const pull = fieldOf(event, 'pull_request');
    const number = numberOf(fieldOf(pull, 'number'));
    const head = fieldOf(pull, 'head');
    const headSha = stringOf(fieldOf(head, 'sha'));
    const headRef = stringOf(fieldOf(head, 'ref'));
    const baseSha = stringOf(fieldOf(fieldOf(pull, 'base'), 'sha'));
    if (number === undefined || headSha === undefined || headRef === undefined || baseSha === undefined) {
      return { ok: false, reason: 'La carga del evento no trae el PR con su cabeza y su base.' };
    }
    return { ok: true, prs: [{ number, headSha, headRef, baseSha, runHead: headSha }] };
  }

  if (eventName === 'merge_group') {
    const groupSha = stringOf(fieldOf(fieldOf(event, 'merge_group'), 'head_sha'));
    if (groupSha === undefined) return { ok: false, reason: 'La carga del grupo no trae su SHA.' };
    let queue: MergeQueueEntry[];
    try {
      queue = await github.mergeQueue(branch);
    } catch (error) {
      return { ok: false, reason: `No se pudo leer la cola de fusión: ${reasonOf(error)}` };
    }
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
        baseSha: entry.baseSha,
        runHead: groupSha,
      });
    }
    return { ok: true, prs };
  }

  return { ok: false, reason: `Evento no soportado: ${eventName}.` };
}

// The motives of the `red-test` block (PLAN-13-R2 §3.4), in the recipe's locale.
function noTestsReason(): string {
  return 'La pieza no trae pruebas: sin una prueba que falle por su aserción no hay autorización para construir.';
}

function greenReason(): string {
  return 'La prueba pasó: no está roja.';
}

function brokenReason(): string {
  return 'La prueba falló por importación o entorno, no por su aserción.';
}

function headFailedReason(): string {
  return 'La prueba no pasó contra la cabeza.';
}

interface StageOutcome {
  readonly id: string;
  readonly outcome: 'passed' | 'skipped' | 'failed';
  readonly reason: string;
}

interface PrOutcome {
  readonly number: number;
  readonly piece?: string;
  readonly failure?: string;
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
    return { id: stage.id, outcome: 'failed', reason: 'La etapa no trae un comando que correr.' };
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
  if (testFiles.length === 0) return { id: stage.id, outcome: 'failed', reason: noTestsReason() };

  const timeoutMs = timeoutMinutes * MINUTES_MS;

  let redSummary: TestRunSummary;
  try {
    redSummary = await runOnce(context, pr.baseSha, pr.runHead, testFiles, command, timeoutMs, piece);
  } catch (error) {
    return { id: stage.id, outcome: 'failed', reason: `No se pudo correr la prueba: ${reasonOf(error)}` };
  }
  if (!isRedEvidence(redSummary)) {
    return {
      id: stage.id,
      outcome: 'failed',
      reason: isGreenRun(redSummary) ? greenReason() : brokenReason(),
    };
  }

  let greenSummary: TestRunSummary;
  try {
    greenSummary = await runOnce(context, pr.runHead, pr.runHead, testFiles, command, timeoutMs, piece);
  } catch (error) {
    return { id: stage.id, outcome: 'failed', reason: `No se pudo correr la prueba: ${reasonOf(error)}` };
  }
  if (!isGreenRun(greenSummary)) return { id: stage.id, outcome: 'failed', reason: headFailedReason() };

  return { id: stage.id, outcome: 'passed', reason: 'La prueba falla contra la base y pasa contra la cabeza.' };
}

async function checkPullRequest(
  context: RunContext,
  pr: CheckPr,
  trusted: string,
): Promise<PrOutcome> {
  const base: { number: number; piece?: string; failure?: string; stages: StageOutcome[] } = {
    number: pr.number,
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
  anyStage: boolean,
  detail: string | undefined,
): string {
  const lines: string[] = ['# Prueba roja en GitHub', ''];
  if (detail !== undefined) {
    lines.push(detail, '');
    return lines.join('\n');
  }
  if (!anyStage) lines.push('Ninguna etapa `red-test` aplicó a esta corrida.', '');
  for (const pr of prs) {
    lines.push(`## #${pr.number}`);
    if (pr.piece !== undefined) lines.push(`Pieza: ${pr.piece}.`);
    if (pr.stages.length === 0 && pr.failure !== undefined) {
      lines.push(`- No se pudo juzgar: ${pr.failure}`);
    }
    for (const stage of pr.stages) {
      if (stage.outcome === 'passed') lines.push(`- ${stage.id}: pasó.`);
      else lines.push(`- ${stage.id}: ${stage.reason}`);
    }
    if (pr.stages.length > 0 && pr.failure !== undefined) {
      lines.push(`- Resultado: rechazado.`);
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
  },
): Promise<{ ok: boolean; summary: string }> {
  const { eventName, event, root } = input;

  let branch: string;
  try {
    branch = await deps.github.defaultBranch();
  } catch (error) {
    return { ok: false, summary: renderSummary([], false, `No se pudo leer la rama principal: ${reasonOf(error)}`) };
  }

  let trusted: string;
  try {
    trusted = await deps.github.branchHead(branch);
  } catch (error) {
    return {
      ok: false,
      summary: renderSummary([], false, `No se pudo leer la punta de ${branch}: ${reasonOf(error)}`),
    };
  }

  const collected = await collectPullRequests(eventName, event, deps.github, branch);
  if (!collected.ok) return { ok: false, summary: renderSummary([], false, collected.reason) };

  const shas = new Set<string>([trusted]);
  for (const pr of collected.prs) {
    shas.add(pr.headSha);
    shas.add(pr.runHead);
    shas.add(pr.baseSha);
  }
  try {
    await deps.fetchObjects([...shas]);
  } catch (error) {
    return { ok: false, summary: renderSummary([], false, `No se pudieron traer los commits a juzgar: ${reasonOf(error)}`) };
  }

  const recipeText = await showFile(root, trusted, RECIPE_PATH);
  if (recipeText === undefined) {
    return { ok: false, summary: renderSummary([], false, `No hay receta legible en ${trusted}:${RECIPE_PATH}.`) };
  }
  const checked = await checkRecipe(recipeText, RECIPE_PATH, { root });
  if (!checked.ok) {
    const first = checked.errors[0];
    return { ok: false, summary: renderSummary([], false, `La receta de ${trusted} no es válida: ${first?.message ?? 'error desconocido'}`) };
  }

  const context: RunContext = {
    root,
    recipe: checked.recipe,
    signal: new AbortController().signal,
    environment: filteredEnvironment(),
  };

  const outcomes: PrOutcome[] = [];
  let anyStage = false;
  let allOk = true;
  for (const pr of collected.prs) {
    const outcome = await checkPullRequest(context, pr, trusted);
    outcomes.push(outcome);
    if (outcome.stages.length > 0) anyStage = true;
    if (outcome.failure !== undefined) allOk = false;
  }

  return { ok: allOk, summary: renderSummary(outcomes, anyStage, undefined) };
}
