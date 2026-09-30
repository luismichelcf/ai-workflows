import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Runs after the stray-killing hook below (after-hooks run in reverse order). A fake `taskkill` that
// was just killed can still hold its folder on Windows for a moment, so the removal waits first.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  removeRepositories();
});

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

// PLAN-13-R6 §15 P6 (the flock, 30-sep): the watchdog is armed when the process starts, and reading
// stdin is inside its time. A client (or the Codex order, whose stdin is inherited) that never
// closes stdin must still get the refusal before its cut.
//
// Interface this test fixes: `AI_WORKFLOWS_HOOK_WATCHDOG_MS`, a positive whole number of
// milliseconds, shortens the watchdog of `hook editor`. Only `bin.ts` reads it (a seam for tests;
// no client sets it); anything else leaves the watchdog at HOOK_WATCHDOG_MS (25 s).
describe('R6 §15 P6: the watchdog covers reading stdin', () => {
  /** Runs the compiled `hook editor` with stdin left open after a partial request. */
  function runWithOpenStdin(root: string, client: 'claude' | 'codex', env: NodeJS.ProcessEnv, killAfterMs = 40_000): Promise<Finished> {
    return new Promise((done) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(engine.packageDir, 'dist', 'bin.js'), 'hook', 'editor', '--client', client], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      child.on('close', (status) => {
        clearTimeout(killer);
        done({ status, stdout, stderr, ms: Date.now() - started });
      });
      child.stdin.on('error', () => {});
      // Half a request, and stdin is never ended.
      child.stdin.write('{"tool_name":"Write","tool_input":');
    });
  }

  it('stdin never closed: the deny JSON and exit 0, well within the client s 30 s', async () => {
    const root = project('arreglo');
    engine.install(root);
    const env: NodeJS.ProcessEnv = { ...process.env, AI_WORKFLOWS_HOOK_WATCHDOG_MS: '1500' };
    delete env.CLAUDE_PROJECT_DIR;
    for (const client of ['claude', 'codex'] as const) {
      const output = await runWithOpenStdin(root, client, env);
      denyReason(output);
      expect(output.ms).toBeLessThan(15_000);
    }
  }, 120_000);

  // Delta review of the flock fixes, finding M3: the seam may only SHORTEN the watchdog. A value
  // above HOOK_WATCHDOG_MS (25 s) would let a client's 30 s cut arrive first, so it is ignored and
  // the default applies: the answer comes at about 25 s, never at 60 s. (A value at or below 25 s
  // is honoured: the test above, with 1.5 s.)
  it('a watchdog above 25 s (60000) is ignored: the deny JSON before the client s 30 s', async () => {
    const root = project('arreglo');
    engine.install(root);
    const env: NodeJS.ProcessEnv = { ...process.env, AI_WORKFLOWS_HOOK_WATCHDOG_MS: '60000' };
    delete env.CLAUDE_PROJECT_DIR;
    const output = await runWithOpenStdin(root, 'claude', env);
    expect(output.status, 'the hook ended by itself, before the 40 s kill').not.toBeNull();
    expect(output.ms).toBeLessThan(28_000);
    denyReason(output);
  }, 60_000);
});

// Delta review of the flock fixes, finding M4: ending a timed-out git on POSIX lists the process
// tree with `ps` first. That listing gets its own timeout: a `ps` that hangs must not keep the hook
// from answering. Here git hangs (so its call times out at HOOK_GIT_CALL_MS, 10 s) and the `ps`
// first on PATH sleeps; the git hook `pre-commit` must still refuse with the reason, well within
// GIT_HOOK_DEADLINE_MS (60 s).
describe('M4: a hanging ps does not keep the git hook from answering', () => {
  it.runIf(process.platform !== 'win32')('pre-commit with git and ps both hanging: exit 1 with the git timeout, before 60 s', async () => {
    const root = project('arreglo');
    engine.install(root);
    const bin = emptyFolder();
    const pids = join(bin, 'pids');
    strays.push(pids);
    for (const name of ['git', 'ps']) {
      writeFileSync(join(bin, name), ['#!/usr/bin/env bash', `echo $$ >> '${pids}'`, 'exec sleep 120', ''].join('\n'));
      chmodSync(join(bin, name), 0o755);
    }
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };

    const output = await new Promise<Finished>((done) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(engine.packageDir, 'dist', 'bin.js'), 'hook', 'pre-commit'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const killer = setTimeout(() => child.kill('SIGKILL'), 70_000);
      child.on('close', (status) => {
        clearTimeout(killer);
        done({ status, stdout, stderr, ms: Date.now() - started });
      });
    });

    expect(output.status, 'the hook ended by itself, before the 70 s kill').toBe(1);
    expect(output.ms).toBeLessThan(60_000);
    expect(output.stderr).toMatch(/git no respondió a tiempo/i);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
// Second delta review of the flock fixes (PLAN-13-R6 §15), finding M-a: the watchdog ends the
// deciding process with its tree (`cancel()` of `spawnHookProcess`), but `bin.ts` calls it on EVERY
// run, before writing the answer, synchronously and without a time limit (on Windows
// `spawnSync('taskkill', … /T /F)` with no timeout). A child that already closed by itself has no
// tree left to end: killing by its old pid (or process group) can reach an unrelated process that
// now owns the number, and a kill command that hangs holds the answer past the client's 30 s cut.
//
// Interface these tests fix (no new export; the builder chooses how):
//  - After the deciding process closed by itself, nothing is ended: no `taskkill` is started
//    (Windows) and the hook process sends no kill signal (`process.kill` with a signal other than
//    0, POSIX).
//  - When the watchdog fires, the tree IS ended (the control below, a guard that passes today), but
//    the kill command cannot delay the answer: with the default watchdog (25 s) and a `taskkill`
//    that never returns, the hook still writes the deny JSON and exits 0 within the client's 30 s.
//    (Windows only: on POSIX the kill is a signal, a system call that cannot hang, so there is no
//    command to stub.)
//
// The spy is a preload given through NODE_OPTIONS. In the hook process (argv holds `hook`, not
// `--child`) it records every `process.kill` with a real signal. In a process whose executable is
// named `taskkill.exe` (a link to node placed first on PATH, which is where `spawnSync('taskkill')`
// finds it) it records the call and then exits 0 — or, with AIW_SPY_HANG=1, blocks for 120 s like a
// `taskkill` that never returns (its pid goes to AIW_SPY_STRAYS, killed after the test).

const SPY = [
  "'use strict';",
  "const { appendFileSync } = require('node:fs');",
  "const { basename } = require('node:path');",
  'const log = process.env.AIW_SPY_LOG;',
  "const record = (file, line) => { if (file) appendFileSync(file, line + '\\n'); };",
  "if (basename(process.execPath).toLowerCase().startsWith('taskkill')) {",
  "  record(log, 'taskkill ' + process.argv.slice(2).join(' '));",
  "  if (process.env.AIW_SPY_HANG === '1') {",
  '    record(process.env.AIW_SPY_STRAYS, String(process.pid));',
  '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);',
  '  }',
  '  process.exit(0);',
  "} else if (process.argv.includes('hook') && !process.argv.includes('--child')) {",
  '  const kill = process.kill.bind(process);',
  '  process.kill = (pid, signal) => {',
  "    if (signal !== 0) record(log, 'kill ' + pid + ' ' + String(signal));",
  '    return kill(pid, signal);',
  '  };',
  '}',
  '',
].join('\n');

interface Spy {
  readonly env: NodeJS.ProcessEnv;
  /** The recorded lines: `taskkill <its arguments after /pid>` or `kill <pid> <signal>`. */
  lines(): string[];
}

/** The environment of a spied hook run; `hang` makes the fake `taskkill` block for 120 s. */
function spy(hang: boolean, extra: NodeJS.ProcessEnv = {}): Spy {
  const bin = emptyFolder();
  const preload = join(bin, 'spy.cjs');
  writeFileSync(preload, SPY);
  const log = join(bin, 'spy.log');
  const hung = join(bin, 'strays');
  strays.push(hung);
  if (process.platform === 'win32') {
    // A hard link spares copying the executable; another volume falls back to a copy.
    try {
      linkSync(process.execPath, join(bin, 'taskkill.exe'));
    } catch {
      copyFileSync(process.execPath, join(bin, 'taskkill.exe'));
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows keeps the variable as `Path`: replace that same key, never add a second one.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
  env.NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`;
  env.AIW_SPY_LOG = log;
  env.AIW_SPY_STRAYS = hung;
  env.AIW_SPY_HANG = hang ? '1' : '0';
  delete env.CLAUDE_PROJECT_DIR;
  Object.assign(env, extra);
  return { env, lines: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []) };
}

/** Runs the compiled `hook editor`; with `request` undefined, stdin gets half a request and stays open. */
function runHookEditor(root: string, env: NodeJS.ProcessEnv, request: string | undefined, killAfterMs: number): Promise<Finished> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(engine.packageDir, 'dist', 'bin.js'), 'hook', 'editor'], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', (status) => {
      clearTimeout(killer);
      // Release the deciding process too, if it is still waiting on this stdin.
      child.stdin.destroy();
      done({ status, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    if (request === undefined) child.stdin.write('{"tool_name":"Write","tool_input":');
    else child.stdin.end(request);
  });
}

describe('M-a: the deciding process is ended only when the watchdog fires, and never holds the answer', () => {
  it('a normal answer: after the deciding process closed, no taskkill is started and no kill signal is sent', async () => {
    const root = project('arreglo');
    engine.install(root);
    const watch = spy(false);

    const output = await runHookEditor(root, watch.env, writeRequest(join(root, 'docs', 'b.md'), root), 40_000);

    expect(output.stderr).toBe('');
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(watch.lines(), 'the deciding process had already closed: nothing to end').toEqual([]);
  }, 60_000);

  // Guard: it passes today and must keep passing. It is also the positive control of the spy: when
  // the watchdog fires, the deciding process (blocked on stdin) is ended with its tree.
  it('control: the watchdog fires (1.5 s) and the tree of the deciding process is ended', async () => {
    const root = project('arreglo');
    engine.install(root);
    const watch = spy(false, { AI_WORKFLOWS_HOOK_WATCHDOG_MS: '1500' });

    const output = await runHookEditor(root, watch.env, undefined, 40_000);

    denyReason(output);
    const recorded = watch.lines();
    if (process.platform === 'win32') {
      expect(recorded.some((line) => /^taskkill .*\/T/.test(line)), recorded.join('\n')).toBe(true);
    } else {
      expect(recorded.some((line) => /^kill -?\d+ SIGKILL$/.test(line)), recorded.join('\n')).toBe(true);
    }
  }, 60_000);

  it.runIf(process.platform === 'win32')('a taskkill that never returns cannot delay the answer: deny JSON and exit 0 before 30 s with the watchdog at 25 s', async () => {
    const root = project('arreglo');
    engine.install(root);
    const watch = spy(true);

    const output = await runHookEditor(root, watch.env, undefined, 45_000);

    expect(output.status, 'the hook ended by itself, before the 45 s kill').not.toBeNull();
    expect(output.ms).toBeLessThan(30_000);
    denyReason(output);
  }, 90_000);

  // Third delta review (PLAN-13-R6 §15, last paragraph): «la orden de matar el árbol del gancho se
  // lanza sin esperarla, para no gastar el margen de 30 s». Today the hook waits for `taskkill` up to
  // its 2 s limit before it answers and exits. Interface: when the watchdog fires, the kill command
  // is started and NOT waited for; the hook writes the deny JSON and ends at once, and the pipes it
  // gives the client are not held by the kill command. With the watchdog at 1.5 s and a `taskkill`
  // that hangs 120 s, the whole run ends in under 3.5 s = 1.5 s of watchdog + the 2 s kill limit
  // (KILL_COMMAND_TIMEOUT_MS): a hook that waits that limit can never fit, whatever its start-up
  // time (measured today: 3.66 s), while one that does not wait ends near 1.7 s.
  it.runIf(process.platform === 'win32')('the watchdog fires (1.5 s) and taskkill hangs 120 s: the hook process ends in under 3.5 s, without waiting for the kill', async () => {
    const root = project('arreglo');
    engine.install(root);
    const watch = spy(true, { AI_WORKFLOWS_HOOK_WATCHDOG_MS: '1500' });

    const output = await runHookEditor(root, watch.env, undefined, 45_000);

    expect(output.status, 'the hook ended by itself, before the 45 s kill').not.toBeNull();
    denyReason(output);
    // The kill command was started (the tree is still ended), only not waited for.
    const recorded = await eventuallyRecorded(watch, /^taskkill .*\/T/, 5_000);
    expect(recorded.some((line) => /^taskkill .*\/T/.test(line)), recorded.join('\n')).toBe(true);
    expect(output.ms, 'the hook waited for the kill command').toBeLessThan(3_500);
  }, 90_000);
});

/** The spy's lines once one matches `pattern`, or whatever it holds after `withinMs`. */
async function eventuallyRecorded(watch: Spy, pattern: RegExp, withinMs: number): Promise<string[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const recorded = watch.lines();
    if (recorded.some((line) => pattern.test(line)) || Date.now() >= until) return recorded;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Second delta review, finding M-b (POSIX): the watchdog ends the process group of the deciding
// process, but the hook's git runs `detached`, in a group of its own, so a git that hangs outlives
// the process that started it. When the watchdog ends the deciding process, that git (and what it
// started) is ended too.
describe('M-b: the watchdog also ends the git the deciding process started', () => {
  it.runIf(process.platform !== 'win32')('git hangs, the watchdog fires at 1.5 s: afterwards no process of that git is alive', async () => {
    const root = project('arreglo');
    engine.install(root);
    const bin = emptyFolder();
    const pids = join(bin, 'pids');
    strays.push(pids);
    writeFileSync(join(bin, 'git'), ['#!/usr/bin/env bash', `echo $$ >> '${pids}'`, `sleep 120 & echo $! >> '${pids}'`, 'sleep 120', ''].join('\n'));
    chmodSync(join(bin, 'git'), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, AI_WORKFLOWS_HOOK_WATCHDOG_MS: '1500' };
    delete env.CLAUDE_PROJECT_DIR;

    const output = await runHookEditor(root, env, writeRequest(join(root, 'src', 'b.mjs'), root), 40_000);

    denyReason(output);
    // The watchdog answered, not git's own 10 s limit inside the deciding process.
    expect(output.ms).toBeLessThan(10_000);
    const started = (readFileSync(pids, 'utf8').match(/\d+/g) ?? []).map(Number);
    expect(started.length).toBeGreaterThan(0);
    // A killed process may take a moment to be reaped.
    const until = Date.now() + 3_000;
    while (started.some(alive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started.filter(alive)).toEqual([]);
  }, 60_000);
});
