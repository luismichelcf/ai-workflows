import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decideToolUse, lockContextFor, parseRecipe, runHook, type HookInput } from '../src/index.js';

import { git, removeRepositories, repository, write } from './git-fixtures.js';

// Review of the flock, round 2, part 5 (PLAN-13-R5 §1.2–§1.4): what the round-1 fixes left open.
//  - `gh` glued to a shell separator (`;gh`, `&&gh`, `|gh`, `(gh`, `$(gh`, a backquote) was no
//    longer recognized by rule 0.
//  - On Windows, the short 8.3 name of `.git` (`GIT~1`) and the NTFS stream form reached inside
//    `.git` without being judged.
//  - A path under the project whose git fails (a broken `.git` in a subfolder) passed.
//  - gh uses the LAST -X; global flags go between `gh` and the command; `--input=file` and
//    `submitPullRequestReview` approve too.

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

const parsed = parseRecipe(RECIPE, 'pipeline.yml');
if (!parsed.ok) throw new Error('recipe');
const ROOT = process.platform === 'win32' ? 'C:\\proyecto' : '/proyecto';
const broken = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe: { invalid: 'pipeline.yml:2:1 clave desconocida' } });
const withPiece = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe: parsed.recipe });
const bash = (command: string): HookInput => ({ toolName: 'Bash', toolInput: { command }, cwd: ROOT });

describe('rule 0 sees gh wherever the shell can start it', () => {
  for (const command of [
    'true;gh pr comment 5 -b hola',
    'true&&gh api repos/o/r/issues/5/comments -F body=x',
    'echo x|gh api repos/o/r/issues/5/comments --input -',
    '(gh pr comment 5 -b hola)',
    '`gh pr comment 5 -b hola`',
    'x=$(gh api repos/o/r/issues/5/comments -F body=x)',
  ]) {
    it(`a broken recipe refuses: ${command}`, () => {
      expect(decideToolUse(bash(command), broken).allow).toBe(false);
    });
  }

  for (const command of ['(gh pr review 5 --approve)', 'true&&gh pr review 5 --approve', 'x=$(gh pr review 5 -a)']) {
    it(`approving is refused even with a piece: ${command}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  it('a word that only ends in gh is not gh', () => {
    expect(decideToolUse(bash('high pr comment 5 -b hola'), broken).allow).toBe(true);
  });
});

describe('rule 0 reads gh api as gh does', () => {
  for (const command of [
    'gh api -X GET --method PUT repos/o/r/pulls/5/merge',
    'gh api -XGET -XPOST repos/o/r/issues/5/comments',
    'gh --repo o/r api repos/o/r/issues/5/comments -f body=x',
    'gh -R o/r pr comment 5 -b hola',
  ]) {
    it(`a broken recipe refuses: ${command}`, () => {
      expect(decideToolUse(bash(command), broken).allow).toBe(false);
    });
  }

  for (const command of [
    'gh api repos/o/r/pulls/5/reviews --input=revision.json',
    'gh api graphql -f query="mutation { submitPullRequestReview(input: {pullRequestReviewId: \\"x\\", event: APPROVE}) { clientMutationId } }"',
  ]) {
    it(`approving is refused even with a piece: ${command}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }
});

describe('the git folder under every name Windows gives it', () => {
  const project = () => {
    const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'a\n' });
    git(root, 'switch', '-q', '-C', 'arreglo');
    return root;
  };
  const writeRequest = (file: string, cwd: string) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'x\n' }, cwd });
  const denies = (output: { stdout: string }) => output.stdout !== '' && (JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'deny';

  it.runIf(process.platform === 'win32')('its short 8.3 name is refused without a piece', async () => {
    const root = project();
    const listing = spawnSync('cmd', ['/c', 'dir', '/x', '/a:h', root], { encoding: 'utf8' }).stdout;
    const short = /\s(\S+~\d)\s+\.git\s*$/m.exec(listing)?.[1];
    if (short === undefined) return; // 8.3 names are off on this volume: nothing to reach it by
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, short, 'config'), root) }))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('its NTFS stream form is refused without a piece', async () => {
    const root = project();
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(`${join(root, '.git')}::$INDEX_ALLOCATION\\config`, root) }))).toBe(true);
  });

  it('a subfolder of the project whose git fails is refused, never read as outside', async () => {
    const root = project();
    write(root, 'vendor/roto/.git', 'gitdir: ./no-existe\n');
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin: writeRequest(join(root, 'vendor', 'roto', 'x.mjs'), root) }))).toBe(true);
  });
});
