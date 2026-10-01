// PLAN-13-R6 §3.2–§3.3 (review of encargo B): the Codex order itself must fail closed.
//
// Measured on this PC (§3.1): Codex lets the tool through on any exit that is not 0 with the deny
// JSON. So the one-line order that `hooks install` writes in `.codex/hooks.json` cannot exit 1 when
// the loader is missing, when it exits with an error or dies without answering: it must print the
// deny JSON itself and exit 0, naming the engine. These run the order exactly as installed, through
// the shell Codex uses (cmd.exe and Windows PowerShell on Windows, `sh -c` elsewhere).
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installHooks } from '../src/index.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
}

const RECIPE = [
  'version: 1',
  'locale: es',
  'owner: dueno',
  'kinds:',
  '  names: [behavior, docs]',
  '  default: behavior',
  'pieces:',
  '  branch: ["*/{piece}", "*/{piece}-*"]',
  'hooks:',
  '  papers: ["docs"]',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  '',
].join('\n');

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-codex-order-'));
  created.push(root);
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.email', 'prueba@example.com');
  git(root, 'config', 'user.name', 'Prueba');
  writeFileSync(join(root, 'README.md'), 'x\n');
  spawnSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(join(root, '.ai-workflows'))},{recursive:true})`]);
  writeFileSync(join(root, '.ai-workflows', 'pipeline.yml'), RECIPE);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'switch', '-q', '-c', 'arreglo');
  return root;
}

function installedOrder(root: string): { command: string; commandWindows: string } {
  const file = JSON.parse(spawnSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(root, '.codex', 'hooks.json'))},'utf8'))`], { encoding: 'utf8' }).stdout) as {
    hooks: { PreToolUse: { hooks: { command?: string; commandWindows?: string }[] }[] };
  };
  const handler = file.hooks.PreToolUse.flatMap((group) => group.hooks).find((h) => String(h.command).includes('.ai-workflows/hook.cjs'));
  if (handler === undefined || handler.command === undefined || handler.commandWindows === undefined) throw new Error('no Codex handler');
  return { command: handler.command, commandWindows: handler.commandWindows };
}

function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  delete out.CLAUDE_PROJECT_DIR;
  delete out.AI_WORKFLOWS_PROJECT_DIR;
  return out;
}

function runThroughShells(root: string, input: string): SpawnSyncReturns<string>[] {
  const order = installedOrder(root);
  const options = { cwd: root, input, encoding: 'utf8' as const, env: env(), timeout: 60_000 };
  if (process.platform === 'win32') {
    return [
      spawnSync(order.commandWindows, { ...options, shell: true }),
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(order.commandWindows, 'utf16le').toString('base64')],
        options,
      ),
    ];
  }
  return [spawnSync('sh', ['-c', order.command], options)];
}

const input = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: { command: '*** Begin Patch\n*** Add File: src/x.mjs\n+x\n*** End Patch' },
  cwd: '<CWD>',
});

function expectCodexDeny(result: { readonly status: number | null; readonly stdout: string }): void {
  expect(result.status).toBe(0);
  const answer = JSON.parse(result.stdout.trim()) as {
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
  };
  expect(answer.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(answer.hookSpecificOutput?.permissionDecisionReason).toMatch(/motor|cargador/i);
}

describe('R6 §3.3: the installed Codex order fails closed on its own', () => {
  it('with the loader missing, it answers the deny JSON with exit 0 instead of exiting with an error', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    rmSync(join(root, '.ai-workflows', 'hook.cjs'));
    for (const result of runThroughShells(root, input.replace('<CWD>', root.replaceAll('\\', '\\\\')))) expectCodexDeny(result);
  }, 120_000);

  it('with a loader that exits 1 without answering, it answers the deny JSON with exit 0', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    writeFileSync(join(root, '.ai-workflows', 'hook.cjs'), "process.stderr.write('roto');\nprocess.exit(1);\n");
    for (const result of runThroughShells(root, input.replace('<CWD>', root.replaceAll('\\', '\\\\')))) expectCodexDeny(result);
  }, 120_000);

  it('with a loader that exits 0 but prints nothing it lets the tool through (the loader decided), and a loader that prints garbage with exit 0 is a deny', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    writeFileSync(join(root, '.ai-workflows', 'hook.cjs'), 'process.exit(0);\n');
    for (const result of runThroughShells(root, input.replace('<CWD>', root.replaceAll('\\', '\\\\')))) {
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    }
    writeFileSync(join(root, '.ai-workflows', 'hook.cjs'), "process.stdout.write('no es json');\nprocess.exit(0);\n");
    for (const result of runThroughShells(root, input.replace('<CWD>', root.replaceAll('\\', '\\\\')))) expectCodexDeny(result);
  }, 120_000);
});

// PLAN-13-R6 §15 P5 (the flock, 30-sep): the order has its own clock. `git rev-parse` gets about
// 3 s and the loader what is left up to about 27 s; when either runs out, the order prints the deny
// JSON itself and exits 0, because Codex cuts it at `timeout: 30` and then lets the tool through.
// These run the order exactly as installed, through the shells Codex uses, and time the whole run
// (shell, node and all): it must end in under 30 s.
//
// The hanging git is a fake first on PATH: a `.cmd` on Windows (found by cmd.exe through PATHEXT)
// and a script elsewhere. Its sleeping process does not hold the order's pipes (`exec` on POSIX,
// redirections on Windows), as a hung git of its own would not either; killing the process the
// order started is enough to end it. (If the fix runs git without a shell on Windows, libuv does
// not pick up a `.cmd`, the real git answers and the test still asserts a timely deny.)

const CLIENT_CUT_MS = 30_000;

interface Timed {
  readonly result: { readonly status: number | null; readonly stdout: string };
  readonly ms: number;
}

/** The environment with `bin` first on PATH, whatever the case of the variable's name. */
function withFirstOnPath(bin: string): NodeJS.ProcessEnv {
  const out = env();
  const key = Object.keys(out).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  out[key] = `${bin}${delimiter}${out[key] ?? ''}`;
  return out;
}

/** A folder holding a `git` that sleeps 120 s. */
function hangingGit(): string {
  const bin = mkdtempSync(join(tmpdir(), 'aiw-codex-git-'));
  created.push(bin);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), '@node -e "setTimeout(function(){},120000)" <nul >nul 2>nul\r\n');
  } else {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 120\n');
    chmodSync(join(bin, 'git'), 0o755);
  }
  return bin;
}

const GIVE_UP_MS = 45_000;

/** Kills a process and everything it started (the shell, the order, the loader, the fake git). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Runs one shell line asynchronously and times it. A run still going at 45 s is killed with its
 * whole tree (a synchronous spawn would wait on the grandchild that holds the pipes, forever) and
 * reported with no status.
 */
function timed(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; shell?: boolean }): Promise<Timed> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let finished = false;
    const finish = (status: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      done({ result: { status, stdout }, ms: Date.now() - started });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    const killer = setTimeout(() => {
      if (child.pid !== undefined) killTree(child.pid);
      setTimeout(() => finish(null), 3_000);
    }, GIVE_UP_MS);
    child.on('error', () => finish(null));
    child.on('close', (status) => finish(Date.now() - started >= GIVE_UP_MS ? null : status));
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin);
  });
}

/** Runs the installed order through every shell Codex uses, timing each run; the test gives up at 45 s. */
async function runTimed(root: string, stdin: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Timed[]> {
  const order = installedOrder(root);
  const base = { cwd: options.cwd ?? root, env: options.env ?? env(), stdin };
  if (process.platform === 'win32') {
    return [
      await timed(order.commandWindows, [], { ...base, shell: true }),
      await timed(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(order.commandWindows, 'utf16le').toString('base64')],
        base,
      ),
    ];
  }
  return [await timed('sh', ['-c', order.command], base)];
}

function expectDenyInTime(run: Timed): void {
  // A run the test had to kill has no status and no answer: that is the failure these tests catch.
  expect(run.result.status).toBe(0);
  expect(run.ms).toBeLessThan(CLIENT_CUT_MS);
  expectCodexDeny(run.result);
}

const codexStdin = (cwd: string) => input.replace('<CWD>', cwd.replaceAll('\\', '\\\\'));

describe('R6 §15 P5: the Codex order has its own clock and fails closed on time', () => {
  it('a git that hangs 120 s: the deny JSON with exit 0, in under 30 s', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    const bin = hangingGit();
    for (const run of await runTimed(root, codexStdin(root), { env: withFirstOnPath(bin) })) expectDenyInTime(run);
  }, 200_000);

  it('a loader that never answers: the deny JSON with exit 0, in under 30 s', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    writeFileSync(join(root, '.ai-workflows', 'hook.cjs'), 'setInterval(function () {}, 1000);\n');
    for (const run of await runTimed(root, codexStdin(root))) expectDenyInTime(run);
  }, 200_000);

  it('the real loader with an engine that never answers: the deny JSON with exit 0, in under 30 s', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    mkdirSync(join(root, 'node_modules', 'ai-workflows', 'dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'dist', 'bin.js'), 'setInterval(() => {}, 1000);\n');
    for (const run of await runTimed(root, codexStdin(root))) expectDenyInTime(run);
  }, 200_000);
});

// The flock's surviving mutants on the order (guards): a forwarded answer must be a DENY, and a
// session outside any repository is a refusal, never a pass.
describe('R6 §15: the Codex order forwards only a deny and refuses outside a repository', () => {
  it('a loader that prints an allow JSON with exit 0: the order prints its own deny', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    writeFileSync(
      join(root, '.ai-workflows', 'hook.cjs'),
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));\nprocess.exit(0);\n",
    );
    for (const run of await runTimed(root, codexStdin(root))) {
      expectDenyInTime(run);
      expect(run.result.stdout).not.toMatch(/"allow"/);
    }
  }, 200_000);

  it('run from a folder that is in no repository: the deny JSON with exit 0', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    const outside = mkdtempSync(join(tmpdir(), 'aiw-codex-outside-'));
    created.push(outside);
    for (const run of await runTimed(root, codexStdin(outside), { cwd: outside })) expectDenyInTime(run);
  }, 200_000);
});
