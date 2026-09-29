import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decideToolUse, lockContextFor, parseRecipe, runHook, type HookInput } from '../src/index.js';

import { emptyFolder, git, removeRepositories, repository } from './git-fixtures.js';

// Review of the flock, round 3, part 5 (PLAN-13-R5 §1.2, §1.3): what the round-2 fixes opened.
//  - The pattern for gh's global options backtracked: a command with a few dozen `--repo=x` took
//    over a minute, past the hook's 30 seconds, and Claude Code lets the tool through then.
//  - git answers in the user's language: the "not a repository" reading was English only, so with
//    a translated git every file outside a repository was refused.
//  - `gh pr review 5 -ab LGTM` approves (gh reads `-a -b`).

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
const withPiece = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe: parsed.recipe });
const broken = lockContextFor({ root: ROOT, branch: 'feat/13-x', recipe: { invalid: 'pipeline.yml:2:1 clave desconocida' } });
const bash = (command: string): HookInput => ({ toolName: 'Bash', toolInput: { command }, cwd: ROOT });

describe('rule 0 answers in bounded time, whatever the command', () => {
  const many = (option: string, count: number) => `${option} `.repeat(count);

  for (const [name, context, command] of [
    ['an approval behind 40 --repo=x, with a piece', withPiece, `gh ${many('--repo=o/r', 40)}api repos/o/r/pulls/5/reviews -f event=APPROVE`],
    ['a comment behind 40 --hostname=x, with a broken recipe', broken, `gh ${many('--hostname=github.com', 40)}pr comment 5 -b hola`],
    ['40 unknown long options and nothing after them', withPiece, `gh ${many('--algo=x', 40)}`],
  ] as const) {
    it(`${name}: decided in well under a second, and refused where it must be`, () => {
      const started = performance.now();
      const decision = decideToolUse(bash(command), context);
      expect(performance.now() - started).toBeLessThan(500);
      if (!command.trimEnd().endsWith('--algo=x')) expect(decision.allow).toBe(false);
    });
  }
});

describe('short flags glued together approve too', () => {
  for (const command of ['gh pr review 5 -ab LGTM', 'gh pr review 5 -ba LGTM']) {
    it(`refuses ${command}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  it('a comment review with its body still passes', () => {
    expect(decideToolUse(bash('gh pr review 5 -c -b "se ve bien"'), withPiece).allow).toBe(true);
  });
});

describe('a git that answers in another language', () => {
  // A git that speaks Spanish unless it is asked to speak the neutral language (LC_ALL=C), as a
  // translated git does. It hands everything else to the real git.
  const spanishGit = () => {
    const dir = emptyFolder();
    const file = join(dir, 'git');
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(file, [
      '#!/usr/bin/env bash',
      'if [ "${LC_ALL:-}" != "C" ]; then',
      `  out="$(${realGit} "$@" 2>&1)"; code=$?`,
      '  printf "%s\\n" "$out" | sed -e "s/not a git repository (or any of the parent directories)/no es un repositorio git (ni ninguno de los directorios superiores)/" -e "s/this operation must be run in a work tree/esta operación debe ser realizada en un árbol de trabajo/" >&2',
      '  exit $code',
      'fi',
      `exec ${realGit} "$@"`,
      '',
    ].join('\n'));
    chmodSync(file, 0o755);
    return file;
  };

  it.runIf(process.platform !== 'win32')('a file outside any repository still passes', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'a\n' });
    git(root, 'switch', '-q', '-C', 'arreglo');
    const scratch = emptyFolder();
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(scratch, 'notas.md'), content: 'x\n' }, cwd: root });
    const output = await runHook('editor', { projectDir: root, cwd: root, stdin, gitPath: spanishGit() } as never);
    expect(output.stdout).toBe('');
  });

  it.runIf(process.platform !== 'win32')('with a piece, the git folder is judged as the project, not refused as a failure', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'src/a.mjs': 'a\n' });
    git(root, 'switch', '-q', '-C', 'feat/13-x');
    const stdin = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(root, '.git', 'info', 'exclude'), content: 'x\n' }, cwd: root });
    const output = await runHook('editor', { projectDir: root, cwd: root, stdin, gitPath: spanishGit() } as never);
    expect(output.stdout).toBe('');
  });
});
