import { execFile } from 'node:child_process';
import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Gate, GateResult, JournalEntry } from '../contract.js';
import { isGreenRun, isRedEvidence, parseTestRun } from '../commands.js';
import { requireSameFiles } from '../gates.js';
import { gitEnvironment } from '../git-env.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import type { BlockManifest } from './manifest.js';
import {
  filesMatching,
  hashFiles,
  matchesGlobs,
  refuseDryRun,
  runTests,
  type TestGroupResult,
} from './test-run.js';

// PLAN-13-R2 §3.5 (CN-11): `build-verify@1` is the check that the implementation was built to
// pass the red test that was seen, and no other. In order: the last `passed` red entry with
// non-empty evidence; the test files still hash to what was recorded; no commit touched them
// after the red test was judged; the suite is green now; and, retiring only the implementation
// from a throwaway worktree of the exact green snapshot, the original failure and assertion
// come back. Everything git runs through `execFile`, never a console, and the temporary
// worktree is always removed.

const MINUTES_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const manifest: BlockManifest = {
  name: 'build-verify',
  kind: 'module',
  natures: ['recompute', 'execution-record'],
  validWhile: ['same-sha'],
  inputs: {
    command: { type: 'command', required: true, requireTests: true },
    tests: { type: 'glob-list', default: ['**/*.test.ts', '**/*.test.tsx'] },
    'red-stage': { type: 'string', required: true },
    'implementation-exclude': { type: 'glob-list', default: ['docs/**'] },
    'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
  },
};

interface RedEvidence {
  readonly files: Record<string, string>;
  readonly failures: readonly string[];
  readonly assertions: readonly string[];
  readonly judgedSha: string;
}

interface GitResult {
  readonly stdout: string;
  readonly ok: boolean;
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function changeOf(context: { readonly change: unknown }): Record<string, unknown> {
  return readObject(context.change) ?? {};
}

/** The recorded red evidence, only when it carries files, failures and assertions. */
function readRedEvidence(entry: JournalEntry | undefined): RedEvidence | undefined {
  if (entry === undefined) return undefined;
  const block = readObject(fieldOf(entry.evidence, 'block'));
  const judged = readObject(fieldOf(entry.evidence, 'judged'));
  if (block === undefined || judged === undefined) return undefined;

  const rawFiles = readObject(block['files']);
  if (rawFiles === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(rawFiles)) {
    if (typeof hash === 'string') files[name] = hash;
  }

  const failures = asStringList(block['failures']);
  const assertions = asStringList(block['assertions']);
  const judgedSha = asString(judged['sha']);
  if (
    Object.keys(files).length === 0 ||
    failures.length === 0 ||
    assertions.length === 0 ||
    judgedSha === undefined
  ) {
    return undefined;
  }
  return { files, failures, assertions, judgedSha };
}

/** Runs `git <args>` with a time limit and no console, returning its trimmed output. */
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
      resolve({ stdout: (stdout ?? '').trim(), ok: error === null });
    });
  });
}

function noRedReason(redStage: string, spanish: boolean): string {
  return spanish
    ? `No hay una prueba roja registrada en «${redStage}».`
    : `There is no red test recorded at "${redStage}".`;
}

function greenExpectedReason(failures: readonly string[], spanish: boolean): string {
  const named = failures.length > 0 ? failures.join(', ') : spanish ? 'ninguno' : 'none';
  return spanish
    ? `Se esperaba la suite en verde: ${named}.`
    : `The suite was expected to be green: ${named}.`;
}

function noImplementationReason(spanish: boolean): string {
  return spanish
    ? 'No hay archivos de implementación que retirar.'
    : 'There are no implementation files to retire.';
}

function notReproducedReason(spanish: boolean): string {
  return spanish
    ? 'La retirada no reprodujo la misma prueba y aserción de la roja original.'
    : 'The retirement did not reproduce the same failure and assertion as the original red test.';
}

function changedTestsReason(commits: readonly string[], spanish: boolean): string {
  const named = commits.map((commit) => commit.slice(0, 7)).join(', ');
  return spanish
    ? `Las pruebas cambiaron en commits posteriores a la prueba roja: ${named}.`
    : `The tests changed in commits after the red test: ${named}.`;
}

interface RetireOptions {
  readonly root: string;
  readonly snapshot: string;
  readonly mergeBase: string;
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
  readonly command: string;
  readonly timeoutMs: number;
  readonly piece: string;
  readonly signal: AbortSignal;
  readonly failures: readonly string[];
  readonly assertions: readonly string[];
  readonly spanish: boolean;
}

/**
 * Retires the implementation from a throwaway worktree of the exact green snapshot: a commit
 * built from that tree, a detached worktree of it, each implementation file restored from the
 * merge base or deleted when the base never had it, `node_modules` linked, and the same run
 * reproduced. The worktree is always removed.
 */
async function retireFromSnapshot(
  options: RetireOptions,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const { root, snapshot, mergeBase, implementation, tests, spanish } = options;

  const created = await runGit(root, [
    'commit-tree',
    snapshot,
    '-p',
    'HEAD',
    '-m',
    'ai-workflows-retire',
  ]);
  if (!created.ok || created.stdout.length === 0) {
    throw new Error('the temporary commit of the green snapshot could not be created');
  }
  const commit = created.stdout.split('\n')[0] ?? '';

  const parent = await mkdtemp(join(tmpdir(), 'aiw-retire-'));
  const worktree = join(parent, 'tree');
  // The linked `node_modules` is remembered so it can be removed as a LINK, never followed.
  let modulesLink: string | undefined;
  try {
    const added = await runGit(root, ['worktree', 'add', '--detach', worktree, commit]);
    if (!added.ok) throw new Error('the temporary worktree could not be created');

    for (const file of implementation) {
      const inBase = await runGit(root, ['cat-file', '-e', `${mergeBase}:${file}`]);
      if (inBase.ok) {
        const restored = await runGit(worktree, ['checkout', mergeBase, '--', file]);
        if (!restored.ok) throw new Error(`could not restore "${file}" from the merge base`);
      } else {
        await rm(join(worktree, file), { force: true });
      }
    }

    const modules = join(root, 'node_modules');
    if (existsSync(modules)) {
      const link = join(worktree, 'node_modules');
      if (!existsSync(link)) {
        symlinkSync(modules, link, process.platform === 'win32' ? 'junction' : 'dir');
        modulesLink = link;
      }
    }

    const run: TestGroupResult = await runTests({
      command: options.command,
      root: worktree,
      tests,
      timeoutMs: options.timeoutMs,
      piece: options.piece,
      signal: options.signal,
    });
    if (run.kind === 'technical') throw new Error(run.reason);

    const summary = parseTestRun({
      output: run.output,
      exitCode: run.code,
      ...(run.truncated ? { truncated: true } : {}),
    });
    const sameFailure = summary.failures.some((name) => options.failures.includes(name));
    const sameAssertion = summary.assertions.some((text) => options.assertions.includes(text));
    if (!isRedEvidence(summary) || !sameFailure || !sameAssertion) {
      return { ok: false, reason: notReproducedReason(spanish) };
    }
    return { ok: true };
  } finally {
    // On Windows `git worktree remove --force` follows the `node_modules` junction and deletes
    // the project's real dependencies. The link is removed first, by its own name only.
    if (modulesLink !== undefined) removeLink(modulesLink);
    await runGit(root, ['worktree', 'remove', '--force', worktree]);
    await runGit(root, ['worktree', 'prune']);
    await rm(parent, { recursive: true, force: true });
  }
}

/** Removes the link itself — never the folder it points at, and never its contents. */
function removeLink(link: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    return;
  }
  if (!isLink) return;
  try {
    rmSync(link, { force: true });
  } catch {
    // Best effort: the worktree removal follows, and the link cannot be left in the project.
  }
}

function createGate(
  command: string,
  tests: readonly string[],
  redStage: string,
  implementationExclude: readonly string[],
  timeoutMinutes: number,
  deps: EngineBlockDeps,
): Gate {
  const timeoutMs = timeoutMinutes * MINUTES_MS;

  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'build-verify');
    const spanish = isSpanish(context.locale);

    const redEntry = [...context.journal]
      .reverse()
      .find((entry) => entry.stage === redStage && entry.outcome === 'passed');
    const red = readRedEvidence(redEntry);
    if (red === undefined) return { ok: false, reason: noRedReason(redStage, spanish) };

    const recorded = Object.keys(red.files);
    const current = await hashFiles(deps.root, recorded);
    const sameFiles = requireSameFiles(red.files, current);
    if (!sameFiles.ok) return { ok: false, reason: sameFiles.reason };

    const history = await runGit(deps.root, [
      'log',
      '--format=%H',
      `${red.judgedSha}..HEAD`,
      '--',
      ...recorded,
    ]);
    if (!history.ok) throw new Error('the history of the test files could not be read');
    const commits = history.stdout.split('\n').filter((line) => line.length > 0);
    if (commits.length > 0) return { ok: false, reason: changedTestsReason(commits, spanish) };

    const change = changeOf(context);
    const changeFiles = asStringList(change['files']);
    const testFiles = filesMatching(tests, changeFiles);
    const greenTests = testFiles.length > 0 ? testFiles : recorded;

    const green = await runTests({
      command,
      root: deps.root,
      tests: greenTests,
      timeoutMs,
      piece: context.piece,
      signal: context.signal,
    });
    if (green.kind === 'technical') throw new Error(green.reason);
    const greenSummary = parseTestRun({
      output: green.output,
      exitCode: green.code,
      ...(green.truncated ? { truncated: true } : {}),
    });
    if (!isGreenRun(greenSummary)) {
      return { ok: false, reason: greenExpectedReason(greenSummary.failures, spanish) };
    }

    const implementation = changeFiles.filter(
      (file) => !testFiles.includes(file) && !matchesGlobs(implementationExclude, file),
    );
    if (implementation.length === 0) {
      return { ok: false, reason: noImplementationReason(spanish) };
    }

    const snapshot = asString(change['snapshot']);
    const mergeBase = asString(change['mergeBase']);
    if (snapshot === undefined || mergeBase === undefined) {
      throw new Error('the change has no snapshot to retire the implementation from');
    }

    const retired = await retireFromSnapshot({
      root: deps.root,
      snapshot,
      mergeBase,
      implementation,
      tests: recorded,
      command,
      timeoutMs,
      piece: context.piece,
      signal: context.signal,
      failures: red.failures,
      assertions: red.assertions,
      spanish,
    });
    if (!retired.ok) return { ok: false, reason: retired.reason };
    return { ok: true, evidence: { retired: [...implementation] } };
  };
}

export const buildVerifyBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const command = asString(inputs['command']) ?? '';
    const tests = asStringList(inputs['tests']);
    const redStage = asString(inputs['redStage']) ?? '';
    const implementationExclude = asStringList(inputs['implementationExclude']);
    const timeoutMinutes =
      typeof inputs['timeoutMinutes'] === 'number' ? inputs['timeoutMinutes'] : 30;
    return createGate(command, tests, redStage, implementationExclude, timeoutMinutes, deps);
  },
};
