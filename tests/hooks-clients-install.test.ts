import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { installHooks, runAgentCli, runHook } from '../src/index.js';

import { buildEngine, type BuiltEngine } from './built-engine.js';
import { OPENCODE_INPUT, addFilePatch, codexPatch, codexTool, inProject, opencodeWrite } from './client-payloads.js';
import { git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R6 §3.3 and §3.5 (unit tests 3, 5, 6, 7 and 8, and `doctor`): what `hooks install`
// writes for Codex and OpenCode, the file loader both of them run, and the OpenCode plugin.
//
// Interface this file defines:
//   installHooks({ root, apply, client?: 'claude' | 'codex' | 'opencode' })
//     - without `client` it writes the three clients; with it, only that one (plus the loader when
//       the client is codex or opencode). The plan (no --apply) names every file and writes none.
//     - `.codex/hooks.json`: merged with what is there (mergeHooksConfig); our group is
//       `{ matcher: '.*', hooks: [{ type: 'command', command, commandWindows, timeout: 30 }] }`.
//       Both orders look for the loader from the repository root (`git rev-parse --show-toplevel`)
//       and run `.ai-workflows/hook.cjs codex`. `command` works under `sh -c`; `commandWindows`
//       works under cmd.exe and Windows PowerShell, from any subfolder.
//     - `.opencode/plugins/ai-workflows.js`: a whole ES module with ONE export (OpenCode calls every
//       export as a plugin), recognized by a fixed header; a file there without it is not ours: the
//       install refuses (ok: false, the file named) and writes nothing.
//     - `.ai-workflows/hook.cjs`: the loader, run as `node .ai-workflows/hook.cjs <codex|opencode>`.
//       It loads `<its folder>/../node_modules/ai-workflows/dist/bin.js` with the arguments
//       `hook editor --client <client>`. If the engine is missing, throws while loading or exits
//       with anything but 0: for codex it prints the JSON refusal and exits 0; for opencode it
//       exits with a code other than 0, with the reason on stderr.
//     - no written file carries a path of the machine. The applied text mentions Codex's `/hooks`.
//   The plugin: `export const <Name> = async (ctx, options?) => ({ 'tool.execute.before': fn })`.
//     - `ctx` is OpenCode's plugin input (`directory`, `worktree`); `options.timeoutMs` shortens its
//       own time limit (a seam for tests; OpenCode never passes it).
//     - `fn(input, output)` spawns `node` (from PATH, never process.execPath: inside OpenCode that is
//       OpenCode itself) with `.ai-workflows/hook.cjs opencode`, sends
//       `{tool, sessionID, callID, args, cwd: ctx.directory}` on stdin, and resolves only when the
//       process exits 0 with nothing on stdout. It throws, with the process's stderr in the message,
//       on a refusal (exit 2), on any other exit, on unexpected output, when node cannot start,
//       and when its time runs out (the child is killed).
//   CLI: `ai-workflows hooks install [--client claude|codex|opencode] [--apply]` (an unknown client
//        is exit 1 with the usage) and `ai-workflows hook editor --client <claude|codex|opencode>`.
//   doctor: one line per client; Codex counts as installed only with our handler under the matcher
//        `.*` and the loader in place; OpenCode only with our plugin and the loader.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
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

const CODEX_FILE = ['.codex', 'hooks.json'] as const;
const PLUGIN_FILE = ['.opencode', 'plugins', 'ai-workflows.js'] as const;
const LOADER_FILE = ['.ai-workflows', 'hook.cjs'] as const;

interface CodexHandler {
  readonly type: string;
  readonly command: string;
  readonly commandWindows: string;
  readonly timeout: number;
}
interface CodexGroup {
  readonly matcher: string;
  readonly hooks: readonly Record<string, unknown>[];
}

const readCodex = (root: string) =>
  JSON.parse(readFileSync(join(root, ...CODEX_FILE), 'utf8')) as { hooks: { PreToolUse: CodexGroup[] } & Record<string, unknown> } & Record<string, unknown>;

const isOurCodexHandler = (handler: Record<string, unknown>): boolean =>
  typeof handler.command === 'string' && handler.command.includes('.ai-workflows/hook.cjs');

/** Our group of `.codex/hooks.json`, as the installer wrote it. */
function ourCodexGroup(root: string): { group: CodexGroup; handler: CodexHandler } {
  const groups = readCodex(root).hooks.PreToolUse.filter((group) => group.hooks.some(isOurCodexHandler));
  expect(groups).toHaveLength(1);
  const group = groups[0] as CodexGroup;
  const handler = group.hooks.find(isOurCodexHandler) as unknown as CodexHandler;
  return { group, handler };
}

/** The environment of a hook Codex or OpenCode runs: no CLAUDE_PROJECT_DIR, no folder handed over. */
function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AI_WORKFLOWS_PROJECT_DIR;
  return env;
}

const machinePath = /[A-Za-z]:[\\/]|\/Users\/|\/home\//;

describe('§3.5 test 6: hooks install writes Codex, OpenCode and the loader', () => {
  it('without --apply names the new files and writes none of them', async () => {
    const root = project();
    const result = await installHooks({ root, apply: false });
    expect(result.ok).toBe(true);
    for (const file of ['.codex/hooks.json', '.opencode/plugins/ai-workflows.js', '.ai-workflows/hook.cjs']) {
      expect(result.text).toContain(file);
    }
    expect(existsSync(join(root, ...CODEX_FILE))).toBe(false);
    expect(existsSync(join(root, ...PLUGIN_FILE))).toBe(false);
    expect(existsSync(join(root, ...LOADER_FILE))).toBe(false);
  });

  it('with --apply writes the three clients by default, Codex with the matcher .*, timeout 30 and both orders', async () => {
    const root = project();
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('/hooks');
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(root, ...PLUGIN_FILE))).toBe(true);
    expect(existsSync(join(root, ...LOADER_FILE))).toBe(true);

    const { group, handler } = ourCodexGroup(root);
    expect(group.matcher).toBe('.*');
    expect(group.hooks).toHaveLength(1);
    expect(handler).toEqual({ type: 'command', command: expect.any(String), commandWindows: expect.any(String), timeout: 30 });
    for (const order of [handler.command, handler.commandWindows]) {
      expect(order).toContain('git rev-parse --show-toplevel');
      expect(order).toContain('.ai-workflows/hook.cjs');
      expect(order).toMatch(/\bcodex\b/);
    }
  });

  it('keeps the foreign Codex hooks exactly and never repeats its own', async () => {
    const root = project();
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node otro.mjs', timeout: 5 }] };
    const post = [{ matcher: '.*', hooks: [{ type: 'command', command: 'registra' }] }];
    write(root, '.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [foreign], PostToolUse: post } }));
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    const file = readCodex(root);
    expect(file.hooks.PostToolUse).toEqual(post);
    expect(file.hooks.PreToolUse.filter((group) => JSON.stringify(group) === JSON.stringify(foreign))).toHaveLength(1);
    expect(file.hooks.PreToolUse.flatMap((group) => group.hooks).filter(isOurCodexHandler)).toHaveLength(1);
    ourCodexGroup(root);
  });

  it('reinstalling leaves the plugin and the loader byte for byte as they were', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    const plugin = readFileSync(join(root, ...PLUGIN_FILE), 'utf8');
    const loader = readFileSync(join(root, ...LOADER_FILE), 'utf8');
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    expect(readFileSync(join(root, ...PLUGIN_FILE), 'utf8')).toBe(plugin);
    expect(readFileSync(join(root, ...LOADER_FILE), 'utf8')).toBe(loader);
  });

  it('a plugin file that is not ours is never overwritten: the install refuses and names it', async () => {
    const root = project();
    write(root, '.opencode/plugins/ai-workflows.js', 'export const Ajeno = async () => ({});\n');
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('.opencode/plugins/ai-workflows.js');
    expect(readFileSync(join(root, ...PLUGIN_FILE), 'utf8')).toBe('export const Ajeno = async () => ({});\n');
    expect(existsSync(join(root, ...CODEX_FILE))).toBe(false);
  });

  it('--client limits the install to one client', async () => {
    const codex = project();
    expect((await installHooks({ root: codex, apply: true, client: 'codex' })).ok).toBe(true);
    expect(existsSync(join(codex, ...CODEX_FILE))).toBe(true);
    expect(existsSync(join(codex, ...LOADER_FILE))).toBe(true);
    expect(existsSync(join(codex, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(codex, ...PLUGIN_FILE))).toBe(false);

    const opencode = project();
    expect((await installHooks({ root: opencode, apply: true, client: 'opencode' })).ok).toBe(true);
    expect(existsSync(join(opencode, ...PLUGIN_FILE))).toBe(true);
    expect(existsSync(join(opencode, ...LOADER_FILE))).toBe(true);
    expect(existsSync(join(opencode, ...CODEX_FILE))).toBe(false);
    expect(existsSync(join(opencode, '.claude', 'settings.json'))).toBe(false);

    const claude = project();
    expect((await installHooks({ root: claude, apply: true, client: 'claude' })).ok).toBe(true);
    expect(existsSync(join(claude, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(claude, ...CODEX_FILE))).toBe(false);
    expect(existsSync(join(claude, ...PLUGIN_FILE))).toBe(false);
  });

  it('neither the plugin, the loader nor the Codex file carries a path of this machine', async () => {
    const root = project();
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    for (const file of [CODEX_FILE, PLUGIN_FILE, LOADER_FILE]) {
      const text = readFileSync(join(root, ...file), 'utf8');
      expect(text).not.toContain(root);
      expect(text).not.toContain(root.replaceAll('\\', '/'));
      expect(text).not.toMatch(machinePath);
    }
  });
});

describe('§3.5 test 3: an unknown tool reaches the hook through the installed configuration', () => {
  it('the matcher read from .codex/hooks.json lets any tool reach the hook, which refuses one with a path', async () => {
    const root = project('feat/13-boton');
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    const matcher = new RegExp(`^(?:${ourCodexGroup(root).group.matcher})$`);
    for (const tool of ['herramienta_nueva', 'apply_patch', 'Bash', 'mcp__docs__escribir']) {
      expect(matcher.test(tool)).toBe(true);
    }
    const stdin = JSON.stringify(codexTool(root, 'herramienta_nueva', { filePath: inProject(root, 'src/x.mjs') }));
    const output = await runHook('editor', { client: 'codex', cwd: root, stdin });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('herramienta_nueva') } });
  });
});

// ------------------------------------------------------------------------------------------------
// The OpenCode plugin (§3.5 test 7), run under Node against a stand-in for the loader.

type BeforeHook = (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => Promise<void>;
type PluginFn = (ctx: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>;

let pluginCopies = 0;

/** Imports the installed plugin as OpenCode would, from a fresh copy next to it (ES module). */
async function loadPlugin(root: string): Promise<PluginFn> {
  const source = readFileSync(join(root, ...PLUGIN_FILE), 'utf8');
  pluginCopies += 1;
  const copy = join(root, '.opencode', 'plugins', `ai-workflows-${pluginCopies}.mjs`);
  writeFileSync(copy, source);
  // The long form of the path: on the GitHub Windows runner the temp folder is an 8.3 short name
  // (`RUNNER~1`), and the test runner's module loader cannot open a URL with an encoded `~`.
  const module = (await import(pathToFileURL(realpathSync.native(copy)).href)) as Record<string, unknown>;
  const exported = Object.values(module);
  // OpenCode calls every export of a plugin file as a plugin: there must be exactly one.
  expect(exported).toHaveLength(1);
  expect(typeof exported[0]).toBe('function');
  return exported[0] as PluginFn;
}

async function beforeHook(root: string, options?: { timeoutMs?: number }, directory = root): Promise<BeforeHook> {
  const plugin = await loadPlugin(root);
  const hooks = await plugin({ directory, worktree: root }, options);
  const before = hooks['tool.execute.before'];
  expect(typeof before).toBe('function');
  return before as BeforeHook;
}

/** Replaces the installed loader with a stand-in script. */
function standIn(root: string, script: string): void {
  writeFileSync(join(root, ...LOADER_FILE), script);
}

const RECORDING_LOADER = [
  "const fs = require('fs'), path = require('path');",
  "let data = '';",
  "process.stdin.on('data', (c) => { data += c; });",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(path.join(__dirname, 'recibido.json'), JSON.stringify({ argv: process.argv.slice(2), stdin: data }));",
  '  process.exit(0);',
  '});',
].join('\n');

const call = { tool: 'write', ...OPENCODE_INPUT };

describe('§3.5 test 7: the OpenCode plugin fails closed on its own', () => {
  it('forwards every tool, even an unknown one, to the loader with the opencode client, and passes on exit 0', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, RECORDING_LOADER);
    const before = await beforeHook(root);
    const args = { filePath: inProject(root, 'src/x.mjs') };
    await expect(before({ ...call, tool: 'herramienta_nueva' }, { args })).resolves.toBeUndefined();
    const received = JSON.parse(readFileSync(join(root, '.ai-workflows', 'recibido.json'), 'utf8')) as { argv: string[]; stdin: string };
    expect(received.argv).toEqual(['opencode']);
    expect(JSON.parse(received.stdin)).toEqual({ tool: 'herramienta_nueva', sessionID: OPENCODE_INPUT.sessionID, callID: OPENCODE_INPUT.callID, args, cwd: root });
  });

  it('a refusal (exit 2) throws with the reason of the engine', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, "process.stderr.write('motivo del motor: src/x sin pieza\\n'); process.exit(2);\n");
    const before = await beforeHook(root);
    await expect(before(call, { args: { filePath: inProject(root, 'src/x.mjs'), content: 's' } })).rejects.toThrow(/motivo del motor/);
  });

  it('an exit 1 throws', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, 'process.exit(1);\n');
    const before = await beforeHook(root);
    await expect(before(call, { args: { filePath: inProject(root, 'docs/x.md'), content: 's' } })).rejects.toThrow();
  });

  it('an exit 0 with something on stdout is not a pass: it throws', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, "process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'formato de otro cliente' } })); process.exit(0);\n");
    const before = await beforeHook(root);
    await expect(before(call, { args: { filePath: inProject(root, 'docs/x.md'), content: 's' } })).rejects.toThrow();
  });

  it('a process that hangs is killed and the call throws when its time runs out', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, "require('fs').writeFileSync(require('path').join(__dirname, 'pid.txt'), String(process.pid)); setInterval(() => {}, 1000);\n");
    const before = await beforeHook(root, { timeoutMs: 1_000 });
    const started = Date.now();
    await expect(before(call, { args: { filePath: inProject(root, 'docs/x.md'), content: 's' } })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(join(root, '.ai-workflows', 'pid.txt'), 'utf8'));
    let alive = true;
    for (let tries = 0; tries < 30 && alive; tries += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((done) => setTimeout(done, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('without the loader, or with the loader but no engine, it throws', async () => {
    const noEngine = project();
    await installHooks({ root: noEngine, apply: true });
    const before = await beforeHook(noEngine);
    await expect(before(call, { args: { filePath: inProject(noEngine, 'docs/x.md'), content: 's' } })).rejects.toThrow(/motor/i);

    const noLoader = project();
    await installHooks({ root: noLoader, apply: true });
    rmSync(join(noLoader, ...LOADER_FILE));
    const beforeNoLoader = await beforeHook(noLoader);
    await expect(beforeNoLoader(call, { args: { filePath: inProject(noLoader, 'docs/x.md'), content: 's' } })).rejects.toThrow();
  });

  it('when node cannot start, it throws', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    standIn(root, 'process.exit(0);\n');
    const before = await beforeHook(root);
    const saved = process.env.PATH;
    const emptyBin = join(root, 'sin-node');
    mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    try {
      await expect(before(call, { args: { filePath: inProject(root, 'docs/x.md'), content: 's' } })).rejects.toThrow();
    } finally {
      process.env.PATH = saved;
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The file loader (§3.5 test 8), with the engine missing or replaced by a stand-in.

function runLoader(root: string, client: 'codex' | 'opencode', stdin: string, cwd = root) {
  return spawnSync(process.execPath, [join(root, ...LOADER_FILE), client], { cwd, input: stdin, encoding: 'utf8', env: hookEnv(), timeout: 30_000 });
}

function fakeEngine(root: string, body: string): void {
  mkdirSync(join(root, 'node_modules', 'ai-workflows', 'dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'ai-workflows', 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'node_modules', 'ai-workflows', 'dist', 'bin.js'), body);
}

const codexDenied = (output: { status: number | null; stdout: string }) => {
  expect(output.status).toBe(0);
  return (JSON.parse(output.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
};

describe('§3.5 test 8: the file loader refuses in each client s format when the engine cannot answer', () => {
  const codexStdin = (root: string) => JSON.stringify(codexPatch(root, addFilePatch('docs/x.md')));
  const opencodeStdin = (root: string) => JSON.stringify(opencodeWrite(root, 'docs/x.md'));

  it('engine missing: Codex gets the JSON refusal with exit 0, OpenCode an exit other than 0', async () => {
    const root = project('feat/13-x');
    await installHooks({ root, apply: true });
    const codex = runLoader(root, 'codex', codexStdin(root));
    expect(codexDenied(codex)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/motor/) });
    const opencode = runLoader(root, 'opencode', opencodeStdin(root));
    expect(opencode.status).not.toBe(0);
    expect(opencode.stderr).toMatch(/motor/);
  });

  it('engine exiting 1: Codex gets the JSON refusal with exit 0 (never 1 or 2), OpenCode an exit other than 0', async () => {
    const root = project('feat/13-x');
    await installHooks({ root, apply: true });
    fakeEngine(root, 'process.exit(1);\n');
    expect(codexDenied(runLoader(root, 'codex', codexStdin(root))).permissionDecision).toBe('deny');
    expect(runLoader(root, 'opencode', opencodeStdin(root)).status).not.toBe(0);
  });

  it('engine throwing while loading: the same', async () => {
    const root = project('feat/13-x');
    await installHooks({ root, apply: true });
    fakeEngine(root, 'throw new Error("motor roto");\n');
    expect(codexDenied(runLoader(root, 'codex', codexStdin(root))).permissionDecisionReason).toMatch(/motor roto/);
    const opencode = runLoader(root, 'opencode', opencodeStdin(root));
    expect(opencode.status).not.toBe(0);
    expect(opencode.stderr).toMatch(/motor roto/);
  });

  it('hands the engine `hook editor --client <client>` and lets its answer through', async () => {
    const root = project('feat/13-x');
    await installHooks({ root, apply: true });
    fakeEngine(root, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('../../../argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));",
      'process.exit(0);',
    ].join('\n'));
    const codex = runLoader(root, 'codex', codexStdin(root));
    expect(codex.status).toBe(0);
    expect(codex.stdout).toBe('');
    expect(JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'))).toEqual(['hook', 'editor', '--client', 'codex']);
    const opencode = runLoader(root, 'opencode', opencodeStdin(root));
    expect(opencode.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'))).toEqual(['hook', 'editor', '--client', 'opencode']);
  });
});

// ------------------------------------------------------------------------------------------------
// doctor (§3.3: «doctor revisa los tres»).

async function doctorLines(root: string): Promise<string[]> {
  return (await runAgentCli(['doctor'], { cwd: root, env: {} })).text.split('\n');
}

const says = (all: readonly string[], client: RegExp, state: RegExp) => all.some((line) => client.test(line) && state.test(line));

describe('doctor checks the Codex and OpenCode hooks', () => {
  it('says both are installed after hooks install --apply', async () => {
    const root = project();
    expect((await installHooks({ root, apply: true })).ok).toBe(true);
    const all = await doctorLines(root);
    expect(says(all, /Codex/, /instalad/i)).toBe(true);
    expect(says(all, /OpenCode/, /instalad/i)).toBe(true);
    expect(says(all, /Codex|OpenCode/, /falta/i)).toBe(false);
  });

  it('says the Codex hook is missing without .codex/hooks.json, and how to install it', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    rmSync(join(root, ...CODEX_FILE));
    const all = await doctorLines(root);
    expect(says(all, /Codex/, /falta/i)).toBe(true);
    expect(all.join('\n')).toContain('hooks install');
  });

  it('does not count a Codex hook whose matcher no longer lets every tool through', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    const file = readCodex(root);
    const narrowed = {
      ...file,
      hooks: { ...file.hooks, PreToolUse: file.hooks.PreToolUse.map((group) => (group.hooks.some(isOurCodexHandler) ? { ...group, matcher: 'apply_patch|Bash' } : group)) },
    };
    writeFileSync(join(root, ...CODEX_FILE), JSON.stringify(narrowed));
    expect(says(await doctorLines(root), /Codex/, /falta/i)).toBe(true);
  });

  it('says the OpenCode plugin is missing when the file there is not ours', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    writeFileSync(join(root, ...PLUGIN_FILE), 'export const Ajeno = async () => ({});\n');
    expect(says(await doctorLines(root), /OpenCode/, /falta/i)).toBe(true);
  });

  it('without the loader, neither Codex nor OpenCode counts as installed', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    rmSync(join(root, ...LOADER_FILE));
    const all = await doctorLines(root);
    expect(says(all, /Codex/, /falta/i)).toBe(true);
    expect(says(all, /OpenCode/, /falta/i)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// End to end with the compiled engine: the CLI flags, the loader, the installed Codex order run
// through the shell from a subfolder (§3.5 test 5), and the plugin with the real engine.

describe('end to end with the compiled engine', () => {
  let engine: BuiltEngine;
  beforeAll(() => {
    engine = buildEngine();
  }, 180_000);
  afterAll(() => engine.remove());

  const bin = (cwd: string, args: readonly string[], input = '') =>
    spawnSync(process.execPath, [join(engine.packageDir, 'dist', 'bin.js'), ...args], { cwd, input, encoding: 'utf8', env: hookEnv(), timeout: 60_000 });

  it('hooks install --client codex --apply writes only Codex and the loader; an unknown client is exit 1', () => {
    const root = project();
    const done = bin(root, ['hooks', 'install', '--client', 'codex', '--apply']);
    expect(done.status).toBe(0);
    expect(existsSync(join(root, ...CODEX_FILE))).toBe(true);
    expect(existsSync(join(root, ...LOADER_FILE))).toBe(true);
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    const bad = bin(root, ['hooks', 'install', '--client', 'nadie', '--apply']);
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain('--client');
  });

  it('hook editor --client opencode refuses code without a piece with exit 2 and the reason on stderr', () => {
    const root = project('arreglo');
    const output = bin(root, ['hook', 'editor', '--client', 'opencode'], JSON.stringify(opencodeWrite(root, 'src/x.mjs')));
    expect(output.status).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toMatch(/pieza/);
  });

  it('the loader with the engine installed, run from a subfolder without CLAUDE_PROJECT_DIR, judges the real root', async () => {
    const root = project('arreglo');
    await installHooks({ root, apply: true });
    engine.install(root);
    const sub = join(root, 'src');
    const code = runLoader(root, 'codex', JSON.stringify(codexPatch(sub, addFilePatch('x.mjs'))), sub);
    expect(codexDenied(code).permissionDecisionReason).toMatch(/pieza/);
    const paper = runLoader(root, 'codex', JSON.stringify(codexPatch(sub, addFilePatch('../docs/y.md'))), sub);
    expect(paper.status).toBe(0);
    expect(paper.stdout).toBe('');
  });

  it('the installed Codex order resolves the loader from a subfolder through the shell', async () => {
    const root = project('arreglo');
    await installHooks({ root, apply: true });
    engine.install(root);
    const { handler } = ourCodexGroup(root);
    const sub = join(root, 'src');
    const input = JSON.stringify(codexPatch(sub, addFilePatch('x.mjs')));
    const shells =
      process.platform === 'win32'
        ? [
            // cmd.exe, the way Node runs a shell line.
            () => spawnSync(handler.commandWindows, { shell: true, cwd: sub, input, encoding: 'utf8', env: hookEnv(), timeout: 60_000 }),
            // Windows PowerShell, with the order passed encoded so no quoting of this test interferes.
            () =>
              spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(handler.commandWindows, 'utf16le').toString('base64')], {
                cwd: sub,
                input,
                encoding: 'utf8',
                env: hookEnv(),
                timeout: 60_000,
              }),
          ]
        : [() => spawnSync('sh', ['-c', handler.command], { cwd: sub, input, encoding: 'utf8', env: hookEnv(), timeout: 60_000 })];
    for (const shell of shells) {
      expect(codexDenied(shell()).permissionDecisionReason).toMatch(/pieza/);
    }
  });

  it('the plugin with the real loader and engine: code without a piece throws with the engine s reason, papers pass', async () => {
    const root = project('arreglo');
    await installHooks({ root, apply: true });
    engine.install(root);
    const before = await beforeHook(root);
    await expect(before(call, { args: { filePath: inProject(root, 'src/x.mjs'), content: 's' } })).rejects.toThrow(/pieza/);
    await expect(before(call, { args: { filePath: inProject(root, 'docs/x.md'), content: 's' } })).resolves.toBeUndefined();
  });
});
