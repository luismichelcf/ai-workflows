import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HOOK_LOADER, decideToolUse, explainRecipe, lockContextFor, parseRecipe, runHook, installHooks, runAgentCli, type HookInput } from '../src/index.js';

import { emptyFolder, git, removeRepositories, repository } from './git-fixtures.js';

// Review of the flock, part 5 (PLAN-13-R5 §1): what the reviewers found open in the hooks.
//  - A file inside .git/ (git answers "not a work tree" there) was read as "outside any
//    repository" and passed: an agent could rewrite .git/config and switch the git hooks off.
//  - A git that fails, a link that leads into the project, and a request with no paths all passed.
//  - With a broken recipe, `gh api` sending fields with -F, --raw-field, -XPOST or --method=POST
//    passed; so did approving a pull request through gh.exe, GraphQL or a reviews body file.
//  - The loader let an engine exit 1 (an older engine without `hook`) pass the tool.
//  - `explain` said nothing when no folder is writable without a piece.

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

function project(branch: string, recipe = RECIPE): string {
  const root = repository({ '.ai-workflows/pipeline.yml': recipe, 'src/a.mjs': 'a\n', 'docs/nota.md': 'nota\n' });
  git(root, 'switch', '-q', '-C', branch);
  return root;
}

const writeRequest = (file: string, cwd: string) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'x\n' }, cwd });
const denies = (output: { stdout: string }) => output.stdout !== '' && (JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'deny';

describe('the editor hook guards the repository s own git folder', () => {
  for (const file of ['.git/config', '.git/hooks/pre-commit', '.git/info/exclude']) {
    it(`without a piece, writing ${file} is refused`, async () => {
      const root = project('arreglo');
      expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, file), root) }))).toBe(true);
    });
  }

  it('with a broken recipe, writing .git/config is refused too', async () => {
    const root = project('feat/13-x', 'version: 1\nnada: 1\n');
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, '.git', 'config'), root) }))).toBe(true);
  });

  it('the git folder of a linked working copy is guarded as well', async () => {
    const root = project('arreglo');
    const other = join(root, '.claude', 'worktrees', 'w9');
    git(root, 'worktree', 'add', '-q', '-b', 'sin-pieza-9', other, 'main');
    const gitDir = git(other, 'rev-parse', '--absolute-git-dir');
    expect(denies(await runHook('editor', { projectDir: root, cwd: other, stdin: writeRequest(join(gitDir, 'HEAD'), other) }))).toBe(true);
  });
});

describe('the editor hook never passes what it cannot read', () => {
  it('a git that does not answer is a refusal, never "outside the project"', async () => {
    const root = project('arreglo');
    const broken = await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'src', 'b.mjs'), root), gitPath: join(emptyFolder(), 'no-existe-git') } as never);
    expect(denies(broken)).toBe(true);
  });

  it('a link that leads into the project is judged by where it leads', async () => {
    const root = project('arreglo');
    const outside = emptyFolder();
    symlinkSync(join(root, 'src'), join(outside, 'atajo'), 'junction');
    expect(denies(await runHook('editor', { projectDir: root, cwd: outside, stdin: writeRequest(join(outside, 'atajo', 'b.mjs'), outside) }))).toBe(true);
  });

  it('a writing request whose paths cannot be read is refused', async () => {
    const root = project('arreglo');
    const stdin = JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' }, cwd: root });
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin }))).toBe(true);
  });
});

describe('rule 0 closes the cheap ways around it', () => {
  const recipe = (() => {
    const parsed = parseRecipe(RECIPE, 'pipeline.yml');
    if (!parsed.ok) throw new Error('recipe');
    return parsed.recipe;
  })();
  const ROOT = process.platform === 'win32' ? 'C:\\proyecto' : '/proyecto';
  const broken = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe: { invalid: 'pipeline.yml:2:1 clave desconocida' } });
  const withPiece = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe });
  const bash = (command: string): HookInput => ({ toolName: 'Bash', toolInput: { command }, cwd: ROOT });

  for (const command of [
    'gh api repos/o/r/issues/1/comments -F body=hola',
    'gh api repos/o/r/issues/1/comments --raw-field body=hola',
    'gh api -XPOST repos/o/r/issues/1/comments',
    'gh api --method=POST repos/o/r/issues/1/comments',
    'gh api repos/o/r/issues/1/comments -fbody=hola',
    'gh api repos/o/r/issues/1/comments -F=body=hola',
    'GH api repos/o/r/issues/1/comments --FIELD body=hola',
  ]) {
    it(`a broken recipe refuses publishing through gh api: ${command}`, () => {
      expect(decideToolUse(bash(command), broken).allow).toBe(false);
    });
  }

  it('a broken recipe still lets GitHub be read', () => {
    expect(decideToolUse(bash('gh api repos/o/r/pulls/1 --jq .state'), broken).allow).toBe(true);
    expect(decideToolUse(bash('gh api -X GET repos/o/r/pulls/1'), broken).allow).toBe(true);
  });

  for (const command of [
    'gh.exe pr review 5 --approve',
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr review 5 -a',
    'gh api graphql -f query="mutation { addPullRequestReview(input: {pullRequestId: \\"x\\", event: APPROVE}) { clientMutationId } }"',
    'gh api repos/o/r/pulls/5/reviews --input revision.json',
  ]) {
    it(`approving a pull request is refused, even with a piece: ${command}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }
});

describe('the loader blocks every exit that is not an answer', () => {
  it('an engine that exits 1 (e.g. an older engine without `hook`) makes the loader exit 2', () => {
    const root = emptyFolder();
    mkdirSync(join(root, 'node_modules', 'ai-workflows', 'dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'dist', 'bin.js'), 'process.stdout.write("uso: ai-workflows <orden>\\n"); process.exitCode = 1;\n');
    const output = spawnSync(process.execPath, ['-e', HOOK_LOADER, root, 'hook', 'editor'], { cwd: root, input: '{}', encoding: 'utf8' });
    expect(output.status).toBe(2);
  });

  it('an engine that answers with exit 0 keeps its answer', () => {
    const root = emptyFolder();
    mkdirSync(join(root, 'node_modules', 'ai-workflows', 'dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'node_modules', 'ai-workflows', 'dist', 'bin.js'), 'process.stdout.write("{\\"ok\\":1}");\n');
    const output = spawnSync(process.execPath, ['-e', HOOK_LOADER, root, 'hook', 'editor'], { cwd: root, input: '{}', encoding: 'utf8' });
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('{"ok":1}');
  });
});

describe('explain and doctor say exactly what is there', () => {
  it('explain says that without a piece no folder is writable when papers is empty', () => {
    const parsed = parseRecipe(RECIPE.replace('papers: ["docs"]', 'papers: []'), 'pipeline.yml');
    if (!parsed.ok) throw new Error('recipe');
    expect(explainRecipe(parsed.recipe)).toMatch(/Sin una pieza activa no se puede escribir en ninguna carpeta/);
  });

  it('doctor recognizes the hook only by its exact command and arguments, and says when the settings cannot be read', async () => {
    const root = project('feat/13-x');
    const installed = await installHooks({ root, apply: true });
    expect(installed.ok).toBe(true);
    const settingsFile = join(root, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { hooks: { PreToolUse: { hooks: { args: string[] }[] }[] } };
    const handler = settings.hooks.PreToolUse[0]?.hooks[0];
    if (handler === undefined) throw new Error('no hook');
    handler.args = ['otro.mjs', 'hook'];
    writeFileSync(settingsFile, JSON.stringify(settings));
    const lookalike = await runAgentCli(['doctor'], { cwd: root, env: {} });
    expect(lookalike.text).toMatch(/gancho del editor.*(no|falta)|editor hook.*(not|missing)/i);
    writeFileSync(settingsFile, '{roto');
    const unreadable = await runAgentCli(['doctor'], { cwd: root, env: {} });
    expect(unreadable.text).toMatch(/no se pudo leer|could not be read/i);
  });
});
