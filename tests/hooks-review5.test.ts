import { describe, expect, it } from 'vitest';

import { decideToolUse, lockContextFor, parseRecipe, type HookInput } from '../src/index.js';

// Review of the flock, round 5, part 5 (PLAN-13-R5 §1.3, §1.4): every attempt to read the shell
// the way the shell reads it left a new way through (a line break, a redirection in the middle, a
// command substitution as an argument, PowerShell's line continuation, a stray quote, gh inside
// `bash -c "…"`). The rule stops parsing: it OVER-APPROXIMATES on the whole text of the command.
// A command that names gh and a review and carries anything shaped like an approval is refused,
// wherever those words are; with a broken recipe, a command that names gh and anything that
// writes on GitHub is refused. It may refuse an innocent chain (declared); it never lets one of
// these through because of how it was written, and it answers in linear time.

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
const powershell = (command: string): HookInput => ({ toolName: 'PowerShell', toolInput: { command }, cwd: ROOT });

describe('approving a pull request is refused however the command is written', () => {
  for (const command of [
    'gh pr view 1\ngh pr review 1 --approve',
    'gh pr view 1\r\ngh pr review 1 --approve',
    'gh pr review 1 2>/dev/null --approve',
    'gh pr review 1 >out.txt -a',
    'gh api 2>/dev/null repos/o/r/pulls/1/reviews -f event=APPROVE',
    'gh pr review $(gh pr list -q .[0].number) --approve',
    'gh pr review `cat n` --approve',
    '# don\'t\ngh pr review 1 --approve',
    'echo don\\\'t; gh pr review 1 --approve',
    'echo "a\\"b"; gh pr review 1 --approve',
    'bash -c "gh pr review 1 --approve"',
    'eval \'gh pr review 1 -a\'',
    'gh pr review 1 --appr\\\nove',
  ]) {
    it(`in Bash: ${JSON.stringify(command)}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  for (const command of [
    'gh pr review (1) --approve',
    'gh pr review 1 `\n  --approve',
    'echo "a`"b"; gh pr review 1 --approve',
    'pwsh -Command "gh pr review 1 --approve"',
    '& {gh pr review 1 --approve}',
  ]) {
    it(`in PowerShell: ${JSON.stringify(command)}`, () => {
      expect(decideToolUse(powershell(command), withPiece).allow).toBe(false);
    });
  }
});

describe('with a broken recipe, writing on GitHub from the shell is refused however it is written', () => {
  for (const command of [
    'gh pr view 1\ngh pr comment 1 -b hola',
    'gh api 2>/dev/null -X POST repos/o/r/issues/1/comments',
    'gh api $(echo repos/o/r/issues/1/comments) -f body=x',
    '# it\'s\ngh issue comment 1 -b x',
    'bash -c "gh pr comment 1 -b hola"',
    'gh pr create --title t --body b',
    'gh pr merge 5 --squash',
    'gh pr edit 5 --body nuevo',
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(decideToolUse(bash(command), broken).allow).toBe(false);
    });
  }

  it('reading GitHub still passes', () => {
    for (const command of ['gh pr view 5 --json state', 'gh api repos/o/r/pulls/5', 'gh pr checks 5', 'gh run list --limit 5']) {
      expect(decideToolUse(bash(command), broken).allow, command).toBe(true);
    }
  });
});

describe('round 6: the GraphQL twin of the REST body file, the obvious disguises, and reading approvals', () => {
  for (const command of [
    'gh api graphql -F query=@q.graphql',
    'gh api graphql --input q.json',
    'gh pr re$()view 1 --approve',
    'gh pr review 1 --approv$()e',
    'g$()h pr review 1 --approve',
    'gh pr re${x}view 1 --approve',
    'cmd /c gh pr review 1 --appro^ve',
    'cmd /c g^h pr review 1 --approve',
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  it('reading the reviews filtered by APPROVED is a read, not an approval', () => {
    expect(decideToolUse(bash('gh api repos/o/r/pulls/5/reviews --jq \'.[] | select(.state=="APPROVED")\''), withPiece).allow).toBe(true);
  });

  it('git HEAD^ is not disturbed by removing the cmd escape', () => {
    expect(decideToolUse(bash('git diff HEAD^ -- src && gh pr view 5'), withPiece).allow).toBe(true);
  });
});

describe('what the over-approximation accepts and what it costs', () => {
  it('ordinary commands that do not approve pass', () => {
    for (const command of [
      'git status && git log --oneline -3',
      'pnpm check',
      'rg "approve" src',
      'ls -la; echo listo',
      'git commit -m "approve the plan"',
      'gh pr view 5; gh pr checks 5',
      'gh pr review 5 --comment -b "revisado"',
      'gh pr review 5 -c -b "se ve bien"',
      'echo "gh pr view"',
    ]) {
      expect(decideToolUse(bash(command), withPiece).allow, command).toBe(true);
    }
  });

  it('declared cost: an approval-shaped flag anywhere next to gh and a review is refused, even if another command owns it', () => {
    const decision = decideToolUse(bash('gh pr review 5 -c -b "ok" && ls -la'), withPiece);
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toMatch(/separa|split|por separado/i);
  });

  it('answers a command of 60 000 characters built to be slow in well under a second', () => {
    for (const command of [
      `gh pr review ${'"'.repeat(60_000)}`,
      `gh ${'-a '.repeat(20_000)}`,
      `${'gh review '.repeat(6000)}`,
      `gh api ${'-X GET '.repeat(8000)}`,
    ]) {
      const started = performance.now();
      decideToolUse(bash(command), broken);
      decideToolUse(bash(command), withPiece);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});
