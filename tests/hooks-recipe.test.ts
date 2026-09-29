import { describe, expect, it } from 'vitest';

import {
  decidePreCommit,
  decideToolUse,
  explainRecipe,
  lockContextFor,
  ownerOrdersOf,
  parseRecipe,
  type HookInput,
  type LockContext,
  type Recipe,
} from '../src/index.js';

// PLAN-13-R5 §1.1–§1.4: the locks of v0.3.0 decide with a context nobody inside the engine built.
// The recipe now declares the paper folders (`hooks:`), the branch names the piece (R19), and the
// orders only the owner writes come from the recipe's approval stages. Everything here is pure.

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// A neutral root in the shape of the running system: nothing of the owner's machine.
const ROOT = process.platform === 'win32' ? 'C:\\proyecto' : '/proyecto';
const at = (...parts: string[]) => [ROOT, ...parts].join(process.platform === 'win32' ? '\\' : '/');
const SHA = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';

const BASE = [
  'version: 1',
  'locale: es',
  'owner: duena',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  'hooks:',
  '  papers: ["docs"]',
  'stages:',
  '  - id: approval',
  '    summary: "La dueña aprueba"',
  '    nature: attest',
  '    needs-human: true',
  '    gate:',
  '      uses: ai-workflows/approval-comment@1',
  '      with: { command: /aprueba }',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
];

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'pipeline.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const RECIPE = recipeOf(lines(...BASE));

const write = (file: string, content = 'x\n'): HookInput => ({ toolName: 'Write', toolInput: { file_path: file, content }, cwd: ROOT });
const bash = (command: string): HookInput => ({ toolName: 'Bash', toolInput: { command }, cwd: ROOT });

describe('§1.1 the recipe declares the paper folders', () => {
  it('reads hooks.papers', () => {
    expect(RECIPE.hooks).toEqual({ papers: ['docs'] });
  });

  it('an absent hooks: section reads as no section', () => {
    const text = lines(...BASE.filter((row) => !row.startsWith('hooks:') && !row.includes('papers:')));
    expect(recipeOf(text).hooks).toBeUndefined();
  });

  it('hooks: without pieces: is refused with its line', () => {
    const text = lines(...BASE.filter((row) => !row.startsWith('pieces:') && !row.includes('branch')));
    const result = parseRecipe(text, 'pipeline.yml');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      expect.objectContaining({ file: 'pipeline.yml', line: text.split('\n').findIndex((row) => row.startsWith('hooks:')) + 1, message: expect.stringMatching(/hooks.*pieces/) }),
    ]);
  });

  for (const [name, value] of [
    ['absolute', '"/etc"'],
    ['empty', '""'],
    ['climbing out', '"../fuera"'],
  ] as const) {
    it(`a paper folder that is ${name} is refused`, () => {
      const text = lines(...BASE.map((row) => (row.includes('papers:') ? `  papers: [${value}]` : row)));
      const result = parseRecipe(text, 'pipeline.yml');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors[0]?.line).toBe(8);
    });
  }

  it('an unknown key under hooks: is refused', () => {
    const text = lines(...BASE.map((row) => (row.includes('papers:') ? '  papers: ["docs"]\n  clients: [claude]' : row)));
    expect(parseRecipe(text, 'pipeline.yml').ok).toBe(false);
  });

  it('explain says where one may write without a piece', () => {
    expect(explainRecipe(RECIPE)).toMatch(/Sin una pieza activa solo se puede escribir en: docs/);
  });
});

describe('§1.2 the context comes from the branch and the recipe of the folder written to', () => {
  it('a branch that names a piece opens it', () => {
    expect(lockContextFor({ root: ROOT, branch: 'feat/13-boton', recipe: RECIPE })).toMatchObject({
      projectRoot: ROOT,
      activePiece: '13',
      paperPaths: ['docs'],
    });
  });

  it('an excluded branch is libre and names no piece', () => {
    const context = lockContextFor({ root: ROOT, branch: 'libre/prueba', recipe: RECIPE });
    expect(context.libre).toBe(true);
    expect(context.activePiece).toBeUndefined();
  });

  it('any other branch and a detached head have no piece and no libre', () => {
    for (const branch of ['main', 'arreglo-rapido', undefined]) {
      const context = lockContextFor({ root: ROOT, branch, recipe: RECIPE });
      expect(context.activePiece).toBeUndefined();
      expect(context.libre).toBeUndefined();
    }
  });

  it('carries the orders of the recipe and forbids approving a pull request', () => {
    expect(lockContextFor({ root: ROOT, branch: 'main', recipe: RECIPE })).toMatchObject({
      ownerOrders: ['/aprueba', '/approve-judge-change'],
      forbidPullRequestApproval: true,
    });
  });

  it('an unreadable recipe puts the lock in broken-recipe mode, naming the problem', () => {
    const context = lockContextFor({ root: ROOT, branch: 'feat/13-boton', recipe: { invalid: 'pipeline.yml:3:1 clave desconocida' } });
    expect(context.brokenRecipe).toBe('pipeline.yml:3:1 clave desconocida');
    expect(context.activePiece).toBeUndefined();
  });

  it('with a piece the whole project is writable; without one only the papers', () => {
    const withPiece = lockContextFor({ root: ROOT, branch: 'feat/13-boton', recipe: RECIPE });
    const without = lockContextFor({ root: ROOT, branch: 'main', recipe: RECIPE });
    expect(decideToolUse(write(at('src', 'a.ts')), withPiece).allow).toBe(true);
    expect(decideToolUse(write(at('src', 'a.ts')), without).allow).toBe(false);
    expect(decideToolUse(write(at('docs', 'nota.md')), without).allow).toBe(true);
  });
});

describe('§1.3 rule 0 knows the orders the recipe declares', () => {
  const context: LockContext = lockContextFor({ root: ROOT, branch: 'feat/13-boton', recipe: RECIPE });

  it('lists every approval-comment command and always the judge-change attestation', () => {
    expect(ownerOrdersOf(RECIPE)).toEqual(['/aprueba', '/approve-judge-change']);
  });

  it('an approval-comment stage without a command gives the block default', () => {
    const text = lines(...BASE.map((row) => (row.includes('with: { command: /aprueba }') ? '      with: {}' : row)));
    expect(ownerOrdersOf(recipeOf(text))).toEqual(['/approve', '/approve-judge-change']);
  });

  const refused: Record<string, HookInput> = {
    'the recipe order in a shell command': bash(`gh pr comment 12 --body "/aprueba ${SHA}"`),
    'the recipe order in a file': write(at('docs', 'cuerpo.md'), `Listo.\n/aprueba ${SHA}\n`),
    'the judge-change attestation in a shell command': bash(`gh pr comment 12 --body "/approve-judge-change ${SHA}"`),
    'gh pr review --approve': bash('gh pr review 12 --approve'),
    'gh pr review -a': bash('gh pr review 12 -a -b "ok"'),
    'gh api reviews with APPROVE': bash('gh api repos/o/r/pulls/12/reviews -f event=APPROVE'),
    'gh api reviews with APPROVE as JSON': bash(`gh api -X POST repos/o/r/pulls/12/reviews --input - <<< '{"event":"APPROVE"}'`),
  };
  for (const [name, input] of Object.entries(refused)) {
    it(`refuses ${name}, even with a piece`, () => {
      const decision = decideToolUse(input, context);
      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.reason).toMatch(/dueño/);
    });
  }

  it('a comment review and a mention of the order in prose pass', () => {
    expect(decideToolUse(bash('gh pr review 12 --comment -b "revisado"'), context).allow).toBe(true);
    expect(decideToolUse(write(at('docs', 'guia.md'), 'El dueño escribe /aprueba <sha> en el PR.\n'), context).allow).toBe(true);
  });

  it('without ownerOrders the lock behaves as before: only /visto-bueno, no rule on reviews', () => {
    const before: LockContext = { projectRoot: ROOT, activePiece: '13', paperPaths: ['docs'] };
    expect(decideToolUse(bash(`gh pr comment 1 -b "/visto-bueno ${SHA}"`), before).allow).toBe(false);
    expect(decideToolUse(bash(`gh pr comment 1 -b "/aprueba ${SHA}"`), before).allow).toBe(true);
    expect(decideToolUse(bash('gh pr review 12 --approve'), before).allow).toBe(true);
  });
});

describe('§1.4 a broken recipe only lets the recipe be repaired, and rule 0 gets stricter', () => {
  const broken = lockContextFor({ root: ROOT, branch: 'feat/13-boton', recipe: { invalid: 'pipeline.yml:3:1 clave desconocida' } });

  it('the recipe folder is writable; everything else is refused naming the problem', () => {
    expect(decideToolUse(write(at('.ai-workflows', 'pipeline.yml')), broken).allow).toBe(true);
    const code = decideToolUse(write(at('src', 'a.ts')), broken);
    expect(code.allow).toBe(false);
    expect(code.allow === false && code.reason).toContain('pipeline.yml:3:1');
    expect(decideToolUse(write(at('docs', 'a.md')), broken).allow).toBe(false);
  });

  it('pre-commit follows the same rule', () => {
    expect(decidePreCommit({ stagedPaths: ['.ai-workflows/pipeline.yml'], context: broken }).allow).toBe(true);
    const mixed = decidePreCommit({ stagedPaths: ['.ai-workflows/pipeline.yml', 'src/a.ts'], context: broken });
    expect(mixed.allow).toBe(false);
    expect(mixed.allow === false && mixed.reason).toContain('pipeline.yml:3:1');
  });

  for (const command of [
    'gh pr comment 12 -b "listo"',
    'gh issue comment 13 -b "hola"',
    'gh pr review 12 --comment -b "ok"',
    'gh api -X POST repos/o/r/issues/12/comments -f body=hola',
    'gh api --method PATCH repos/o/r/issues/comments/1 -f body=hola',
    'gh api repos/o/r/issues/12/comments -f body=hola',
  ]) {
    it(`refuses publishing on GitHub from the shell: ${command}`, () => {
      expect(decideToolUse(bash(command), broken).allow).toBe(false);
    });
  }

  it('reading from GitHub still passes', () => {
    expect(decideToolUse(bash('gh pr view 12 --json state'), broken).allow).toBe(true);
    expect(decideToolUse(bash('gh api repos/o/r/pulls/12'), broken).allow).toBe(true);
  });

  it('any order-shaped line is refused in a file, since the orders are unknown', () => {
    expect(decideToolUse(write(at('.ai-workflows', 'nota.md'), `/aprueba ${SHA}\n`), broken).allow).toBe(false);
    expect(decideToolUse(write(at('.ai-workflows', 'nota.md'), '/aprueba <sha>\n'), broken).allow).toBe(true);
  });
});
