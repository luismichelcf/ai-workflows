// PLAN-13-R6 §3.2–§3.3 (review of encargo B): the Codex order itself must fail closed.
//
// Measured on this PC (§3.1): Codex lets the tool through on any exit that is not 0 with the deny
// JSON. So the one-line order that `hooks install` writes in `.codex/hooks.json` cannot exit 1 when
// the loader is missing, when it exits with an error or dies without answering: it must print the
// deny JSON itself and exit 0, naming the engine. These run the order exactly as installed, through
// the shell Codex uses (cmd.exe and Windows PowerShell on Windows, `sh -c` elsewhere).
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function expectCodexDeny(result: SpawnSyncReturns<string>): void {
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
