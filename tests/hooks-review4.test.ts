import { describe, expect, it } from 'vitest';

import { decideToolUse, lockContextFor, parseRecipe, type HookInput } from '../src/index.js';

// Review of the flock, round 4, part 5 (PLAN-13-R5 §1.3): the word-by-word reading of gh.
//  - A flag glued to a shell separator (`--approve;echo`, `-a&&`, `-a|`, `-a>`) or with a value
//    (`--approve=true`, `-a=true`) approves and was no longer seen.
//  - Words after a separator belong to the next command: `ls -la` after a comment review is not
//    an approval.
//  - Flags between `pr` and `review` (`gh pr -R o/r review`) and a backslash line break are gh.
//  - The cost must be linear, and a shell command too large to read in the hook's time is refused
//    (fail closed) rather than read slowly.

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

describe('an approval flag glued to a separator or carrying a value still approves', () => {
  for (const command of [
    'gh pr review 1 --approve;echo ok',
    'gh pr review 1 -a&&echo ok',
    'gh pr review 1 -a|cat',
    'gh pr review 1 -a>out.txt',
    'gh pr review 1 --approve=true',
    'gh pr review 1 -a=true',
    'gh pr -R o/r review 1 -a',
    'gh pr --repo o/r review 1 --approve',
    'gh \\\npr review 1 --approve',
    'gh pr \\\nreview 1 -a',
  ]) {
    it(`refuses ${JSON.stringify(command)}`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  it('with a broken recipe, gh pr -R o/r comment is refused', () => {
    expect(decideToolUse(bash('gh pr -R o/r comment 5 -b hola'), broken).allow).toBe(false);
  });
});

// Round 5 replaced reading the shell with an over-approximation on the whole text (see
// tests/hooks-review5.test.ts): a chain that names gh, a review and an approval-shaped flag of
// ANOTHER command is refused on purpose, and the reason tells the agent to run them separately.
// A chain with no review in it still passes.
describe('the words of the next command, under the over-approximation of round 5', () => {
  for (const command of ['gh pr review 5 -c -b "ok" && ls -la', 'gh pr review 5 -c -b x; find . -name "*.ts"']) {
    it(`refuses ${JSON.stringify(command)} (declared cost)`, () => {
      expect(decideToolUse(bash(command), withPiece).allow).toBe(false);
    });
  }

  it('lets a chain with no review through', () => {
    expect(decideToolUse(bash('gh pr view 5; tar -xaf archivo.tar'), withPiece).allow).toBe(true);
  });
});

describe('the reading is linear, and a command too large to read is refused', () => {
  const timed = (command: string, context = withPiece) => {
    const started = performance.now();
    const decision = decideToolUse(bash(command), context);
    return { ms: performance.now() - started, allow: decision.allow };
  };

  for (const [name, command] of [
    ['thousands of `gh api `', 'gh api '.repeat(8000)],
    ['thousands of bare `gh `', 'gh '.repeat(16000)],
    ['one word of 100 000 separators after an approval', `gh pr review 1 --approve #${';'.repeat(100_000)}x`],
    ['one word of 100 000 closing parentheses', `gh pr review 1 -c ${')'.repeat(100_000)}`],
  ] as const) {
    it(`${name}: answered in under two seconds`, () => {
      expect(timed(command).ms).toBeLessThan(2000);
    });
  }

  it('a shell command over the size limit is refused, with a reason that says why', () => {
    const decision = decideToolUse(bash(`echo ${'x'.repeat(200_000)}`), withPiece);
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toMatch(/demasiado larg|too long|tamaño/i);
  });

  it('an ordinary long command under the limit still passes', () => {
    expect(decideToolUse(bash(`echo ${'x'.repeat(10_000)}`), withPiece).allow).toBe(true);
  });
});
