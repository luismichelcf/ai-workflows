// PLAN-13-R3 §6: the `judge` and `red-test-check` commands of the binary. They read GitHub's
// environment, build the judge's input, bring the pull request's commit objects without checking
// them out, write the summary to `GITHUB_STEP_SUMMARY` and turn the verdict into an exit code.
//
// The judge is honest even when it cannot publish: the verdict lives in the status, so a rejection
// still exits 0 and only an internal failure exits 1. The token reaches exactly one git command as
// a header (`http.extraheader`), never written to disk and never part of a remote URL.

import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

import { gitEnvironment } from '../git-env.js';
import { createGhRunner } from '../gh-runner.js';
import { runJudge, type JudgeInput } from './judge.js';
import { createJudgeGitHub } from './port.js';
import { runRedTestCheck } from './red-test-check.js';

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function env(name: string): string {
  return process.env[name] ?? '';
}

/** The `also-protect` input: a list split by commas or newlines, with the empty entries dropped. */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** GitHub's annotation escaping: a newline inside a command must not start a second one. */
function escapeAnnotation(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * PLAN-13-R4 §7: a trace note is a `::warning::`, never an `::error::` — a note that a state
 * imitates the judge's name is not a failure of this run. Escaping keeps a note from starting
 * a second command.
 */
export function annotationFor(note: string): string {
  return `::warning::${escapeAnnotation(note)}`;
}

async function appendSummary(summary: string): Promise<void> {
  const file = env('GITHUB_STEP_SUMMARY');
  if (summary.length === 0 || file.length === 0) return;
  await appendFile(file, summary.endsWith('\n') ? summary : `${summary}\n`, 'utf8');
}

/** §6: the summary also goes to the run log, so the motive of a failure is seen there too. */
function printSummary(summary: string): void {
  if (summary.length === 0) return;
  process.stdout.write(summary.endsWith('\n') ? summary : `${summary}\n`);
}

async function readEvent(): Promise<unknown> {
  const path = env('GITHUB_EVENT_PATH');
  if (path.length === 0) throw new Error('GITHUB_EVENT_PATH is not set');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Brings the objects of the given commits, with the token of one single `git` command. */
function fetcher(root: string, token: string): (shas: string[]) => Promise<void> {
  return async (shas: string[]): Promise<void> => {
    if (shas.length === 0) return;
    const header =
      token.length === 0
        ? []
        : [
            '-c',
            `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
          ];
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        [...header, 'fetch', '--no-tags', '--quiet', 'origin', ...shas],
        {
          cwd: root,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
          env: gitEnvironment(),
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
            return;
          }
          // Never `error.message`: Node builds it from the whole command line, token header
          // included. The exit code or the signal, plus stderr, say what happened without it.
          const status =
            error.signal !== null && error.signal !== undefined
              ? `signal ${error.signal}`
              : `exit ${String(error.code ?? 'unknown')}`;
          reject(new Error(`git fetch failed (${status}): ${stderr.trim()}`));
        },
      );
    });
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function judgeCommand(): Promise<number> {
  const root = process.cwd();
  const repository = env('GITHUB_REPOSITORY');
  let event: unknown;
  try {
    event = await readEvent();
  } catch (error) {
    process.stderr.write(`${reasonOf(error)}\n`);
    return 1;
  }

  const runIdRaw = env('GITHUB_RUN_ID');
  const runId = Number.parseInt(runIdRaw, 10);
  const input: JudgeInput = {
    eventName: env('GITHUB_EVENT_NAME'),
    event,
    mode: env('AI_WORKFLOWS_MODE'),
    context: env('AI_WORKFLOWS_CONTEXT'),
    repository,
    workflowRef: env('GITHUB_WORKFLOW_REF'),
    actionRef: env('AI_WORKFLOWS_ACTION_REF'),
    runId: Number.isInteger(runId) ? runId : 0,
    serverUrl: env('GITHUB_SERVER_URL'),
    alsoProtect: splitList(env('AI_WORKFLOWS_ALSO_PROTECT')),
    root,
  };

  const github = createJudgeGitHub({ repository, runner: createGhRunner() });
  try {
    const report = await runJudge(input, { github, fetchObjects: fetcher(root, env('GH_TOKEN')) });
    await appendSummary(report.summary);
    printSummary(report.summary);
    for (const note of report.notes) {
      process.stdout.write(`${annotationFor(note)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`el juez no pudo terminar: ${reasonOf(error)}\n`);
    return 1;
  }
}

async function redTestCommand(): Promise<number> {
  const root = process.cwd();
  const repository = env('GITHUB_REPOSITORY');
  let event: unknown;
  try {
    event = await readEvent();
  } catch (error) {
    process.stderr.write(`${reasonOf(error)}\n`);
    return 1;
  }

  const github = createJudgeGitHub({ repository, runner: createGhRunner() });
  try {
    const result = await runRedTestCheck(
      { eventName: env('GITHUB_EVENT_NAME'), event, root, repository },
      { github, fetchObjects: fetcher(root, env('GH_TOKEN')) },
    );
    await appendSummary(result.summary);
    printSummary(result.summary);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`la prueba roja no pudo terminar: ${reasonOf(error)}\n`);
    return 1;
  }
}

/** Runs `judge` or `red-test-check` and returns the process exit code. */
export async function judgeCli(command: string): Promise<number> {
  return command === 'red-test-check' ? redTestCommand() : judgeCommand();
}
