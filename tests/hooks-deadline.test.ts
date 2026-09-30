import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installHooks, runAgentCli, runHook, type HookKind, type HookResult } from '../src/index.js';
import {
  GIT_HOOK_DEADLINE_MS,
  HOOK_DEADLINE_MS,
  HOOK_GIT_CALL_MS,
  HOOK_WATCHDOG_MS,
  runHookGit,
  superviseHook,
} from '../src/locks/hook-cli.js';

import { emptyFolder, git, removeRepositories, repository } from './git-fixtures.js';

// PLAN-13-R6 §4: the editor hook answers before Claude Code's 30 s cut, which lets the tool through.
//
// Interface these tests fix (all exported from src/locks/hook-cli.ts; they may live in another
// module and be re-exported from there):
//  - `RunHookOptions.deadlineMs?: number` — the whole budget of one hook run. By default
//    `HOOK_DEADLINE_MS` (20 000) for `editor` and `GIT_HOOK_DEADLINE_MS` (60 000) for the git hooks.
//    When it runs out, the pending git call fails with «git no respondió a tiempo (N s)» and the
//    hook refuses. The deadline is kept with `setTimeout`/`Date.now` (so fake clocks drive it).
//  - `RunHookOptions.git?: HookGitRunner` — injected git (the Windows variant of the process tests).
//    `HookGitRunner = (request: { cwd: string; args: readonly string[]; timeoutMs: number;
//    signal: AbortSignal }) => Promise<{ ok: boolean; stdout: string; stderr: string }>`.
//    Each call gets `timeoutMs = min(HOOK_GIT_CALL_MS, what is left − reserve)` for `editor`, and
//    `signal` is aborted when the deadline passes. The hook never waits for a runner that ignores
//    it: when the deadline passes it answers anyway, and it leaves no timer behind.
//    Without `git`, the default runner is `runHookGit` with `options.gitPath` (default `git`).
//  - `runHookGit(request: { gitPath?: string; cwd: string; args: readonly string[];
//    timeoutMs: number; signal?: AbortSignal }): Promise<{ ok: boolean; stdout: string;
//    stderr: string }>` — the hook's own git on `spawn`: settles on the process's `exit` event
//    (not on the pipes closing), kills the whole process tree when the time runs out (then `ok` is
//    false and `stderr` says «git no respondió a tiempo (N s)»), and runs with the hook environment
//    (`LC_ALL=C`, `LANGUAGE=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, no credentials).
//  - `superviseHook(kind: HookKind, work: Promise<HookResult>, watchdogMs = HOOK_WATCHDOG_MS):
//    Promise<HookResult>` — the watchdog of the main thread: the work's answer if it comes first,
//    otherwise at `watchdogMs` the refusal of that kind (editor: the deny JSON with exit 0; git
//    hooks: the reason on stderr with exit 1). It clears its timer when the work answers.
//  - Constants: `HOOK_DEADLINE_MS = 20_000`, `HOOK_GIT_CALL_MS = 10_000`,
//    `HOOK_WATCHDOG_MS = 25_000`, `GIT_HOOK_DEADLINE_MS = 60_000`.
//  - `doctor` warns when the timeout configured for our editor hook in .claude/settings.json is
//    less than or equal to the watchdog; the warning says «tiempo del gancho».

afterEach(removeRepositories);
afterEach(() => {
  vi.useRealTimers();
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
const bashRequest = (command: string, cwd: string) =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse' });

interface GitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}
type GitAnswer = { ok: boolean; stdout: string; stderr: string };
type Runner = (request: GitRequest) => Promise<GitAnswer>;

/** runHook with the options this slice adds; the cast keeps the rest of the file type-checked. */
const hook = (kind: HookKind, options: {
  projectDir: string;
  cwd: string;
  stdin: string;
  gitPath?: string;
  git?: Runner;
  deadlineMs?: number;
}): Promise<HookResult> => runHook(kind, options as never);

/** The reason of an editor refusal; fails the test when the hook let the tool through. */
function denyReason(output: HookResult): string {
  expect(output.exitCode).toBe(0);
  expect(output.stdout).not.toBe('');
  const parsed = JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

const GIT_TIMED_OUT = /git no respondió a tiempo \(\d+([.,]\d+)? s\)/i;

/** The real git, answered in the neutral language, for the injected-runner variants. */
const realGit: Runner = (request) =>
  new Promise((done) => {
    execFile('git', [...request.args], { cwd: request.cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } }, (error, stdout, stderr) => {
      done({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

/** A POSIX script named `git` in its own folder. */
function fakeGit(body: readonly string[]): string {
  const file = join(emptyFolder(), 'git');
  writeFileSync(file, ['#!/usr/bin/env bash', ...body, ''].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

const realGitPath = (): string => execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** Every pid written in a file, one per line (or JSON values), so a test can clean them up. */
const straysToKill: string[] = [];
afterEach(() => {
  for (const file of straysToKill.splice(0)) {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function eventuallyDead(pids: readonly number[], withinMs: number): Promise<number[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const living = pids.filter(alive);
    if (living.length === 0 || Date.now() >= until) return living;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('§4 test 1: a git that sleeps is a refusal within the deadline, naming git and the time', () => {
  it.runIf(process.platform !== 'win32')('Write in src/ with a 2 s deadline and a git that sleeps 120 s: refused in under 3 s', async () => {
    const root = project('arreglo');
    const sleeper = fakeGit(['exec sleep 120']);
    const started = Date.now();
    const output = await hook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'src', 'b.mjs'), root), gitPath: sleeper, deadlineMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(denyReason(output)).toMatch(GIT_TIMED_OUT);
  });

  it.runIf(process.platform !== 'win32')('the same with Bash', async () => {
    const root = project('arreglo');
    const sleeper = fakeGit(['exec sleep 120']);
    const started = Date.now();
    const output = await hook('editor', { projectDir: root, cwd: root, stdin: bashRequest('ls', root), gitPath: sleeper, deadlineMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(denyReason(output)).toMatch(GIT_TIMED_OUT);
  });

  // Injected variant (runs on Windows too): a runner that ignores its signal and answers after
  // 120 s. The hook does not wait for it.
  const stubborn = (calls: GitRequest[]): Runner => (request) => {
    calls.push(request);
    return new Promise((done) => {
      const timer = setTimeout(() => done({ ok: true, stdout: '', stderr: '' }), 120_000);
      timer.unref();
    });
  };

  for (const [name, stdin] of [
    ['Write in src/', (root: string) => writeRequest(join(root, 'src', 'b.mjs'), root)],
    ['Bash', (root: string) => bashRequest('ls', root)],
  ] as const) {
    it(`${name} with an injected git that answers after 120 s: refused in under 3 s`, async () => {
      const root = project('arreglo');
      const calls: GitRequest[] = [];
      const started = Date.now();
      const output = await hook('editor', { projectDir: root, cwd: root, stdin: stdin(root), git: stubborn(calls), deadlineMs: 2_000 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(denyReason(output)).toMatch(GIT_TIMED_OUT);
      // Each call is given what is left of the deadline, never more.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
      expect(calls[0]?.timeoutMs).toBeLessThan(2_000);
      expect(calls[0]?.signal.aborted).toBe(true);
    });
  }

  it('with the default deadline, one git call is given 10 s, not the whole budget', async () => {
    const root = project('arreglo');
    const calls: GitRequest[] = [];
    const runner: Runner = async (request) => {
      calls.push(request);
      return realGit(request);
    };
    const output = await hook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'docs', 'b.md'), root), git: runner });
    expect(output.stdout).toBe('');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(calls[0]?.timeoutMs).toBe(10_000);
  });
});

describe('§4 test 2: a git that leaves a grandchild holding the pipes', () => {
  it.runIf(process.platform !== 'win32')('the hook answers within the deadline, with the right decision', async () => {
    const root = project('arreglo');
    const pids = join(emptyFolder(), 'pids');
    straysToKill.push(pids);
    const leaky = fakeGit([`sleep 20 & echo $! >> '${pids}'`, `exec '${realGitPath()}' "$@"`]);
    const started = Date.now();
    const papers = await hook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'docs', 'b.md'), root), gitPath: leaky });
    const code = await hook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'src', 'b.mjs'), root), gitPath: leaky });
    // Answered by git's exit, not by the deadline (20 s by default) nor by the grandchild (20 s).
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(papers.stdout).toBe('');
    expect(denyReason(code)).not.toMatch(/git no respondió/i);
  });

  // The same property on the runner itself, with node playing git (runs on Windows too).
  const childScript = (pidFile: string, then: 'answer' | 'hang') => [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit", detached: true });',
    'g.unref();',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: g.pid }));`,
    then === 'answer'
      ? 'process.stdout.write("hola\\n"); process.exit(0);'
      : 'setInterval(() => {}, 1000);',
  ].join('\n');

  it('runHookGit settles when git exits, although a grandchild keeps its pipes open', async () => {
    const cwd = emptyFolder();
    const pidFile = join(cwd, 'pids.json');
    straysToKill.push(pidFile);
    const started = Date.now();
    const result = await runHookGit({ gitPath: process.execPath, cwd, args: ['-e', childScript(pidFile, 'answer')], timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('hola');
  });

  it('runHookGit, when the time runs out, kills the whole tree and says git did not answer in time', async () => {
    const cwd = emptyFolder();
    const pidFile = join(cwd, 'pids.json');
    straysToKill.push(pidFile);
    const started = Date.now();
    const result = await runHookGit({ gitPath: process.execPath, cwd, args: ['-e', childScript(pidFile, 'hang')], timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(GIT_TIMED_OUT);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
    expect(await eventuallyDead([pids.child, pids.grandchild], 5_000)).toEqual([]);
  });

  it('runHookGit stops at once when its signal is aborted', async () => {
    const cwd = emptyFolder();
    const pidFile = join(cwd, 'pids.json');
    straysToKill.push(pidFile);
    const controller = new AbortController();
    const pending = runHookGit({ gitPath: process.execPath, cwd, args: ['-e', childScript(pidFile, 'hang')], timeoutMs: 60_000, signal: controller.signal });
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    controller.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.ok).toBe(false);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
    expect(await eventuallyDead([pids.child, pids.grandchild], 5_000)).toEqual([]);
  });
});

describe('§4 test 4: a git that fails in the main working copy is a refusal, never "outside"', () => {
  // The session is in a linked working copy on a piece branch and writes into the git hooks of the
  // main copy. Git answers everywhere except in the main copy's folder. The main copy is on a piece
  // branch too, so with a working git the write would pass: only the failure may refuse it.
  function setup() {
    const root = project('feat/14-principal');
    const other = join(root, '.claude', 'worktrees', 'w4');
    git(root, 'worktree', 'add', '-q', '-b', 'feat/13-x', other, 'main');
    const target = join(root, '.git', 'hooks', 'pre-commit');
    return { root, other, target, stdin: writeRequest(target, other) };
  }

  it.runIf(process.platform !== 'win32')('with a fake git on disk', async () => {
    const { root, other, stdin } = setup();
    const main = realpathSync(root);
    const failing = fakeGit([
      `if [ "$(pwd -P)" = '${main}' ]; then echo 'fatal: fallo simulado en la principal' >&2; exit 128; fi`,
      `exec '${realGitPath()}' "$@"`,
    ]);
    const output = await hook('editor', { projectDir: other, cwd: other, stdin, gitPath: failing });
    expect(denyReason(output)).toMatch(/fallo simulado/);
  });

  it('with an injected git (runs on Windows too)', async () => {
    const { root, other, stdin } = setup();
    const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
    const main = fold(realpathSync.native(root));
    const runner: Runner = async (request) => {
      if (fold(realpathSync.native(request.cwd)) === main) {
        return { ok: false, stdout: '', stderr: 'fatal: fallo simulado en la principal' };
      }
      return realGit(request);
    };
    const output = await hook('editor', { projectDir: other, cwd: other, stdin, git: runner });
    expect(denyReason(output)).toMatch(/fallo simulado/);
  });
});

describe('§4 test 5: a runner that never answers, with fake clocks', () => {
  // A folder that does not exist: only the injected runner is asked, never a real git in it.
  const nowhere = () => join(tmpdir(), `aiw-no-existe-${process.pid}-${Date.now()}`);

  const silent = (calls: GitRequest[]): Runner => (request) => {
    calls.push(request);
    return new Promise<GitAnswer>(() => {});
  };

  it('editor: refused when the 20 s deadline passes, the runner aborted and no timer left behind', async () => {
    const folder = nowhere();
    vi.useFakeTimers();
    const calls: GitRequest[] = [];
    let settled: HookResult | undefined;
    void hook('editor', { projectDir: folder, cwd: folder, stdin: writeRequest(join(folder, 'src', 'b.mjs'), folder), git: silent(calls) }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBeDefined();
    expect(denyReason(settled as HookResult)).toMatch(GIT_TIMED_OUT);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pre-commit: the git hooks keep a 60 s deadline, then refuse with exit 1', async () => {
    const folder = nowhere();
    vi.useFakeTimers();
    const calls: GitRequest[] = [];
    let settled: HookResult | undefined;
    void hook('pre-commit', { projectDir: folder, cwd: folder, stdin: '', git: silent(calls) }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.length).toBeGreaterThan(0);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBeDefined();
    expect(settled?.exitCode).toBe(1);
    expect(settled?.stderr).toMatch(GIT_TIMED_OUT);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('§4: the watchdog of the main thread', () => {
  const never = new Promise<HookResult>(() => {});

  it('editor: at 25 s it writes the refusal of the client, not before', async () => {
    vi.useFakeTimers();
    let settled: HookResult | undefined;
    void superviseHook('editor', never).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeDefined();
    expect(denyReason(settled as HookResult)).toMatch(/tiempo/i);
  });

  it('pre-commit: the refusal goes to stderr with exit 1', async () => {
    vi.useFakeTimers();
    let settled: HookResult | undefined;
    void superviseHook('pre-commit', never, 1_000).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled?.exitCode).toBe(1);
    expect(settled?.stdout).toBe('');
    expect(settled?.stderr).toMatch(/tiempo/i);
  });

  it('a work that answers first keeps its answer and leaves no timer', async () => {
    vi.useFakeTimers();
    const answer: HookResult = { stdout: '', stderr: '', exitCode: 0 };
    const result = await superviseHook('editor', Promise.resolve(answer));
    expect(result).toEqual(answer);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('§4 test 6: the constants keep their order', () => {
  it('git deadline < watchdog < the installed hook timeout minus the cold start measured on Windows', async () => {
    expect(HOOK_GIT_CALL_MS).toBe(10_000);
    expect(HOOK_DEADLINE_MS).toBe(20_000);
    expect(HOOK_WATCHDOG_MS).toBe(25_000);
    expect(GIT_HOOK_DEADLINE_MS).toBe(60_000);

    const root = project('feat/13-x');
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as { hooks: { PreToolUse: { hooks: { timeout: number }[] }[] } };
    const timeoutMs = (settings.hooks.PreToolUse[0]?.hooks[0]?.timeout ?? 0) * 1000;
    // §4: the cold start of `hook editor` measured on this PC was 2.4 s.
    const coldStartMs = 2_400;
    expect(HOOK_GIT_CALL_MS).toBeLessThanOrEqual(HOOK_DEADLINE_MS);
    expect(HOOK_DEADLINE_MS).toBeLessThan(HOOK_WATCHDOG_MS);
    expect(HOOK_WATCHDOG_MS).toBeLessThan(timeoutMs - coldStartMs);
  });
});

describe('§4 test 7: doctor warns when the hook timeout does not leave room for the watchdog', () => {
  async function doctorWithTimeout(timeout: number): Promise<string> {
    const root = project('feat/13-x');
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    const file = join(root, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: { PreToolUse: { hooks: { timeout: number }[] }[] } };
    const handler = settings.hooks.PreToolUse[0]?.hooks[0];
    if (handler === undefined) throw new Error('no hook');
    handler.timeout = timeout;
    writeFileSync(file, JSON.stringify(settings, null, 2));
    return (await runAgentCli(['doctor'], { cwd: root, env: {} })).text;
  }

  it('equal to the watchdog (25 s): warns, naming the value', async () => {
    const text = await doctorWithTimeout(25);
    expect(text).toMatch(/tiempo del gancho/i);
    expect(text).toMatch(/\b25\b/);
  });

  it('below the watchdog (20 s): warns', async () => {
    expect(await doctorWithTimeout(20)).toMatch(/tiempo del gancho/i);
  });

  it('as installed (30 s): no warning', async () => {
    expect(await doctorWithTimeout(30)).not.toMatch(/tiempo del gancho/i);
  });
});

describe('§4 test 8: the hook runs git without prompts or optional locks', () => {
  const envScript = 'process.stdout.write(JSON.stringify({ prompt: process.env.GIT_TERMINAL_PROMPT ?? null, locks: process.env.GIT_OPTIONAL_LOCKS ?? null, lang: process.env.LC_ALL ?? null, token: process.env.GH_TOKEN ?? null }));';

  it('runHookGit sets GIT_TERMINAL_PROMPT=0 and GIT_OPTIONAL_LOCKS=0 over what the process had', async () => {
    const saved = { prompt: process.env.GIT_TERMINAL_PROMPT, locks: process.env.GIT_OPTIONAL_LOCKS, token: process.env.GH_TOKEN };
    process.env.GIT_TERMINAL_PROMPT = '1';
    process.env.GIT_OPTIONAL_LOCKS = '1';
    process.env.GH_TOKEN = 'no-debe-llegar';
    try {
      const result = await runHookGit({ gitPath: process.execPath, cwd: emptyFolder(), args: ['-e', envScript], timeoutMs: 10_000 });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({ prompt: '0', locks: '0', lang: 'C', token: null });
    } finally {
      for (const [key, value] of [['GIT_TERMINAL_PROMPT', saved.prompt], ['GIT_OPTIONAL_LOCKS', saved.locks], ['GH_TOKEN', saved.token]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.runIf(process.platform !== 'win32')('every git call of the editor hook gets them', async () => {
    const root = project('arreglo');
    const log = join(emptyFolder(), 'env.log');
    const spy = fakeGit([
      `echo "prompt=\${GIT_TERMINAL_PROMPT:-unset} locks=\${GIT_OPTIONAL_LOCKS:-unset}" >> '${log}'`,
      `exec '${realGitPath()}' "$@"`,
    ]);
    await hook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'docs', 'b.md'), root), gitPath: spy });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toBe('prompt=0 locks=0');
  });
});
