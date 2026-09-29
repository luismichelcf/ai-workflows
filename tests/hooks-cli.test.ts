import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HOOK_LOADER, installHooks, renderGitHook, runHook } from '../src/index.js';

import { buildEngine, type BuiltEngine } from './built-engine.js';
import { commit, emptyFolder, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R5 §1.2 and §1.5: the hook commands read the recipe and the branch of the working copy
// that holds each file, never the folder the session started in; any failure is a refusal; the
// installer writes nothing without --apply, keeps what is not ours, and never writes a path of
// this machine. Git and the file system are real.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const SHA = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

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

/** A project on `branch` with the recipe committed on main. */
function project(branch = 'arreglo'): string {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'export const a = 1;\n', 'docs/nota.md': 'nota\n' });
  git(root, 'switch', '-q', '-C', branch);
  return root;
}

const writeRequest = (file: string, cwd: string, content = 'x\n') =>
  JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd, hook_event_name: 'PreToolUse' });

const denied = (output: { stdout: string; exitCode: number }) => {
  expect(output.exitCode).toBe(0);
  return (JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
};

describe('hook editor', () => {
  it('without a piece, code is refused and papers pass', async () => {
    const root = project('arreglo');
    const code = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'src', 'b.mjs'), root) });
    expect(denied(code)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/pieza/) });
    const paper = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'docs', 'otra.md'), root) });
    expect(paper).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('on a piece branch, code passes', async () => {
    const root = project('feat/13-boton');
    const output = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'src', 'b.mjs'), root) });
    expect(output.stdout).toBe('');
    expect(output.exitCode).toBe(0);
  });

  it('a relative path is read against the cwd of the request', async () => {
    const root = project('arreglo');
    const output = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest('src/b.mjs', join(root, 'src', '..')) });
    expect(denied(output).permissionDecision).toBe('deny');
  });

  it('a file in another working copy without a piece is refused, although the session folder has one', async () => {
    const root = project('feat/13-boton');
    const other = join(root, '.claude', 'worktrees', 'w1');
    git(root, 'worktree', 'add', '-q', '-b', 'sin-pieza', other, 'main');
    const output = await runHook('editor', { projectDir: root, cwd: other, stdin: writeRequest(join(other, 'src', 'b.mjs'), other) });
    expect(denied(output).permissionDecision).toBe('deny');
  });

  it('and the other way round: a working copy with a piece may write though the session folder has none', async () => {
    const root = project('arreglo');
    const other = join(root, '.claude', 'worktrees', 'w2');
    git(root, 'worktree', 'add', '-q', '-b', 'feat/14-otra', other, 'main');
    const inOther = await runHook('editor', { projectDir: root, cwd: other, stdin: writeRequest(join(other, 'src', 'b.mjs'), other) });
    expect(inOther.stdout).toBe('');
    const inRoot = await runHook('editor', { projectDir: root, cwd: other, stdin: writeRequest(join(root, 'src', 'b.mjs'), other) });
    expect(denied(inRoot).permissionDecision).toBe('deny');
  });

  it('a working copy of the same repository without a recipe is in broken-recipe mode', async () => {
    const root = project('arreglo');
    const other = join(root, '.claude', 'worktrees', 'sin-receta');
    git(root, 'worktree', 'add', '-q', '-b', 'feat/15-sin-receta', other, 'main');
    git(other, 'rm', '-q', '.ai-workflows/pipeline.yml');
    git(other, 'commit', '-q', '-m', 'sin receta');
    const output = await runHook('editor', { projectDir: root, cwd: other, stdin: writeRequest(join(other, 'src', 'b.mjs'), other) });
    expect(denied(output).permissionDecisionReason).toMatch(/receta/);
  });

  it('a file in another repository is not this lock s business', async () => {
    const root = project('arreglo');
    const elsewhere = repository({ 'src/z.mjs': 'z\n' });
    const output = await runHook('editor', { projectDir: root, cwd: elsewhere, stdin: writeRequest(join(elsewhere, 'src', 'y.mjs'), elsewhere) });
    expect(output.stdout).toBe('');
  });

  it('a file outside any repository passes', async () => {
    const root = project('arreglo');
    const scratch = emptyFolder();
    const output = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(scratch, 'notas.md'), root) });
    expect(output.stdout).toBe('');
  });

  it('a patch is refused when one of its paths is refused', async () => {
    const root = project('arreglo');
    const patch = ['*** Begin Patch', '*** Add File: docs/ok.md', '+ok', '*** Add File: src/mal.mjs', '+mal', '*** End Patch'].join('\n');
    const stdin = JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: root });
    expect(denied(await runHook('editor', { projectDir: root, cwd: root, stdin })).permissionDecision).toBe('deny');
  });

  it('a project folder that is not a repository is a refusal, never a pass', async () => {
    const folder = emptyFolder();
    const output = await runHook('editor', { projectDir: folder, cwd: folder, stdin: writeRequest(join(folder, 'src', 'b.mjs'), folder) });
    expect(denied(output).permissionDecision).toBe('deny');
  });

  it('unreadable input is a refusal', async () => {
    const root = project('arreglo');
    expect(denied(await runHook('editor', { projectDir: root, cwd: root, stdin: '{roto' })).permissionDecision).toBe('deny');
  });

  it('the owner order of the recipe is refused even on a piece branch', async () => {
    const root = project('feat/13-boton');
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh pr comment 3 -b "/approve-judge-change ${SHA}"` }, cwd: root });
    expect(denied(await runHook('editor', { projectDir: root, cwd: root, stdin })).permissionDecision).toBe('deny');
  });
});

describe('hook pre-commit and pre-push', () => {
  it('pre-commit refuses staged code without a piece, with the reason on stderr and exit 1', async () => {
    const root = project('arreglo');
    write(root, 'src/b.mjs', 'b\n');
    git(root, 'add', 'src/b.mjs');
    const output = await runHook('pre-commit', { projectDir: root, cwd: root, stdin: '' });
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toMatch(/src\/b\.mjs/);
  });

  it('pre-commit lets papers and piece branches through', async () => {
    const root = project('arreglo');
    write(root, 'docs/b.md', 'b\n');
    git(root, 'add', 'docs/b.md');
    expect((await runHook('pre-commit', { projectDir: root, cwd: root, stdin: '' })).exitCode).toBe(0);
    git(root, 'switch', '-q', '-c', 'feat/13-x');
    write(root, 'src/b.mjs', 'b\n');
    git(root, 'add', 'src/b.mjs');
    expect((await runHook('pre-commit', { projectDir: root, cwd: root, stdin: '' })).exitCode).toBe(0);
  });

  it('pre-push without origin/HEAD refuses and says how to fix it', async () => {
    const root = project('feat/13-x');
    const output = await runHook('pre-push', { projectDir: root, cwd: root, stdin: `refs/heads/feat/13-x ${SHA} refs/heads/feat/13-x ${'0'.repeat(40)}\n` });
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('git remote set-head origin --auto');
  });

  it('pre-push refuses the default branch read offline from origin/HEAD, and lets others through', async () => {
    const remote = repository({ 'a.txt': 'a\n' });
    const root = project('feat/13-x');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'fetch', '-q', 'origin');
    git(root, 'remote', 'set-head', 'origin', 'main');
    const toMain = await runHook('pre-push', { projectDir: root, cwd: root, stdin: `refs/heads/feat/13-x ${SHA} refs/heads/main ${'0'.repeat(40)}\n` });
    expect(toMain.exitCode).toBe(1);
    const toBranch = await runHook('pre-push', { projectDir: root, cwd: root, stdin: `refs/heads/feat/13-x ${SHA} refs/heads/feat/13-x ${'0'.repeat(40)}\n` });
    expect(toBranch.exitCode).toBe(0);
  });
});

describe('hooks install', () => {
  const allFiles = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes(`${join(root, '.git')}`))
      .map((entry) => join(entry.parentPath, entry.name));

  it('without --apply shows the plan and writes nothing', async () => {
    const root = project();
    const before = allFiles(root).length;
    const result = await installHooks({ root, apply: false });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/--apply/);
    expect(allFiles(root)).toHaveLength(before);
    expect(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status).toBe(1);
  });

  it('with --apply writes the Claude hook in direct form, the git hooks and the local hooksPath', async () => {
    const root = project();
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as { hooks: { PreToolUse: { matcher: string; hooks: unknown[] }[] } };
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor',
        hooks: [{ type: 'command', command: 'node', args: ['-e', HOOK_LOADER, '${CLAUDE_PROJECT_DIR}', 'hook', 'editor'], timeout: 30 }],
      },
    ]);
    for (const kind of ['pre-commit', 'pre-push'] as const) {
      const file = join(root, '.ai-workflows', 'githooks', kind);
      expect(readFileSync(file, 'utf8')).toBe(renderGitHook(kind, ['node', 'node_modules/ai-workflows/dist/bin.js', 'hook']));
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o111).not.toBe(0);
    }
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath')).toBe('.ai-workflows/githooks');
  });

  it('keeps what was in the settings, including another node hook, and reinstalling does not duplicate', async () => {
    const root = project();
    const foreign = { type: 'command', command: 'node', args: ['otro.mjs'] };
    write(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } }));
    await installHooks({ root, apply: true });
    await installHooks({ root, apply: true });
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as { permissions: unknown; hooks: { PreToolUse: { hooks: { args?: string[] }[] }[] } };
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    const handlers = settings.hooks.PreToolUse.flatMap((group) => group.hooks);
    expect(handlers.filter((handler) => handler.args?.[0] === 'otro.mjs')).toHaveLength(1);
    expect(handlers.filter((handler) => handler.args?.[1] === HOOK_LOADER)).toHaveLength(1);
  });

  it('refuses a hooksPath that belongs to another tool, writing nothing', async () => {
    const root = project();
    git(root, 'config', '--local', 'core.hooksPath', '.husky');
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('.husky');
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(root, '.ai-workflows', 'githooks'))).toBe(false);
  });

  it('refuses a settings file it cannot read, leaving it as it was', async () => {
    const root = project();
    write(root, '.claude/settings.json', '[1, 2]');
    const result = await installHooks({ root, apply: true });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('[1, 2]');
  });

  it('refuses an invalid recipe or one without pieces:, writing nothing', async () => {
    for (const text of ['version: 1\nnada: 1\n', RECIPE.replace(/pieces:\n.*\n.*\nhooks:\n.*\n/, '')]) {
      const root = project();
      write(root, '.ai-workflows/pipeline.yml', text);
      commit(root, 'receta');
      const result = await installHooks({ root, apply: true });
      expect(result.ok).toBe(false);
      expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    }
  });

  it('no file it writes carries a path of this machine', async () => {
    const root = project();
    await installHooks({ root, apply: true });
    for (const file of [join(root, '.claude', 'settings.json'), join(root, '.ai-workflows', 'githooks', 'pre-commit'), join(root, '.ai-workflows', 'githooks', 'pre-push')]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(root);
      expect(text).not.toContain(root.replaceAll('\\', '/'));
      expect(text).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\//);
    }
  });
});

describe('the loader of the Claude hook blocks when the engine cannot run', () => {
  let engine: BuiltEngine;
  beforeAll(() => {
    engine = buildEngine();
  }, 180_000);
  afterAll(() => engine.remove());

  const loader = (projectDir: string, stdin: string) =>
    spawnSync(process.execPath, ['-e', HOOK_LOADER, projectDir, 'hook', 'editor'], { cwd: projectDir, input: stdin, encoding: 'utf8' });

  it('with the engine installed, it answers like runHook', () => {
    const root = project('arreglo');
    engine.install(root);
    const output = loader(root, writeRequest(join(root, 'src', 'b.mjs'), root));
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('without the engine installed, it exits 2 with the reason', () => {
    const root = project('feat/13-x');
    const output = loader(root, writeRequest(join(root, 'src', 'b.mjs'), root));
    expect(output.status).toBe(2);
    expect(output.stderr).toMatch(/ai-workflows/);
  });

  it('with an engine that throws while loading, it exits 2', () => {
    const root = project('feat/13-x');
    mkdirSync(join(root, 'node_modules', 'ai-workflows', 'dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'dist', 'bin.js'), 'throw new Error("motor roto");\n');
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'package.json'), '{"type":"module"}\n');
    const output = loader(root, writeRequest(join(root, 'src', 'b.mjs'), root));
    expect(output.status).toBe(2);
    expect(output.stderr).toMatch(/motor roto/);
  });
});
