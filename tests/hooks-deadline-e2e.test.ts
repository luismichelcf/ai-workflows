import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HOOK_LOADER } from '../src/index.js';

import { buildEngine, type BuiltEngine } from './built-engine.js';
import { emptyFolder, git, removeRepositories, repository } from './git-fixtures.js';

// PLAN-13-R6 §4 test 3 and the lean entry: the Claude hook, run exactly as Claude Code runs it (the
// loader line and the COMPILED engine), must END before Claude Code's 30 s cut, with the refusal on
// stdout and exit 0, even when git hangs with a grandchild holding its pipes or when a disk read
// blocks the thread that decides.
//
// Interface these tests fix:
//  - `hook editor` answers through the git deadline (20 s) and, if the deciding thread is blocked,
//    through the watchdog of the main thread (25 s); then the process exits explicitly
//    (`process.exit`), whatever handle is still open.
//  - `bin.ts` loads only what `hook` uses: `hook editor` works with `dist/judge/cli.js`,
//    `dist/agent/cli.js` and `dist/recipe/command.js` absent from the package (dynamic imports).

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'hooks:',
  '  papers: ["docs"]',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

function project(branch = 'arreglo'): string {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'export const a = 1;\n', 'docs/nota.md': 'nota\n' });
  git(root, 'switch', '-q', '-C', branch);
  return root;
}

const writeRequest = (file: string, cwd: string) =>
  JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'x\n' }, cwd, hook_event_name: 'PreToolUse' });

interface Finished {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Runs the loader like Claude Code does; a run that passes `killAfterMs` is killed and reported. */
function runLoader(projectDir: string, stdin: string, env: NodeJS.ProcessEnv, killAfterMs = 40_000): Promise<Finished> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', HOOK_LOADER, projectDir, 'hook', 'editor'], { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', (status) => {
      clearTimeout(killer);
      done({ status, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

function denyReason(output: Finished): string {
  expect(output.status).toBe(0);
  const parsed = JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const strays: string[] = [];
afterEach(() => {
  for (const file of strays.splice(0)) {
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, 'utf8').match(/\d+/g) ?? []) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
});

let engine: BuiltEngine;
beforeAll(() => {
  engine = buildEngine();
  // What `hook` does not use is taken out of the package: a static import of it would fail to load.
  for (const unused of [['judge', 'cli.js'], ['agent', 'cli.js'], ['recipe', 'command.js']]) {
    const file = join(engine.packageDir, 'dist', ...unused);
    if (existsSync(file)) unlinkSync(file);
  }
}, 180_000);
afterAll(() => engine.remove());

describe('§4: the hook loads only what it uses', () => {
  it('hook editor answers with the judge, the agent CLI and the recipe command absent from the package', async () => {
    const root = project('arreglo');
    engine.install(root);
    const papers = await runLoader(root, writeRequest(join(root, 'docs', 'b.md'), root), process.env);
    expect(papers.stderr).toBe('');
    expect(papers.status).toBe(0);
    expect(papers.stdout).toBe('');
    const code = await runLoader(root, writeRequest(join(root, 'src', 'b.mjs'), root), process.env);
    expect(denyReason(code)).not.toMatch(/no se pudo cargar/);
  }, 60_000);
});

describe('§4 test 3: end to end, the process ends before 30 s with the refusal and exit 0', () => {
  it.runIf(process.platform !== 'win32')('git hangs and leaves a grandchild with its pipes open', async () => {
    const root = project('arreglo');
    engine.install(root);
    const bin = emptyFolder();
    const pids = join(bin, 'pids');
    strays.push(pids);
    writeFileSync(join(bin, 'git'), ['#!/usr/bin/env bash', `echo $$ >> '${pids}'`, `sleep 120 & echo $! >> '${pids}'`, 'sleep 120', ''].join('\n'));
    chmodSync(join(bin, 'git'), 0o755);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };

    const output = await runLoader(root, writeRequest(join(root, 'src', 'b.mjs'), root), env);
    expect(output.ms).toBeLessThan(30_000);
    expect(denyReason(output)).toMatch(/git no respondió a tiempo/i);
    // The hung git and its grandchild were killed with their tree.
    const started = (readFileSync(pids, 'utf8').match(/\d+/g) ?? []).map(Number);
    expect(started.length).toBeGreaterThan(0);
    expect(started.filter(alive)).toEqual([]);
  }, 60_000);

  it.runIf(process.platform !== 'win32')('a disk read blocks the deciding thread (the recipe is a FIFO nobody writes)', async () => {
    const root = project('arreglo');
    engine.install(root);
    const recipe = join(root, '.ai-workflows', 'pipeline.yml');
    rmSync(recipe);
    execFileSync('mkfifo', [recipe]);

    const output = await runLoader(root, writeRequest(join(root, 'src', 'b.mjs'), root), process.env);
    expect(output.ms).toBeLessThan(30_000);
    denyReason(output);
  }, 60_000);
});
