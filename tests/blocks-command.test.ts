import { afterEach, describe, expect, it } from 'vitest';

import { passed, refused, runBlock, technical } from './block-harness.js';
import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §3.6: `ai-workflows/command@1` runs a command of the project with a time limit.
// A command that cannot run is a technical block; one that runs and says no is an ordinary
// rejection, because there the red suite is the answer, not a breakdown. With `reader:
// vitest` the output is read too, so a red suite that exits 0 does not pass (CN-04). The zone
// suite and the module boundaries (CN-09) are just command stages with applies-if.

afterEach(removeRepositories);

const stage = (command: string, ...extra: string[]) => [
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/command@1',
  '      with:',
  `        command: "${command}"`,
  ...extra.map((row) => `        ${row}`),
];

function projectWith(files: Readonly<Record<string, string>>): string {
  const root = repository();
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  commit(root, 'project');
  return root;
}

describe('§3.6 command@1', () => {
  it('passes a command that exits 0 and records its exit code', async () => {
    const root = projectWith({ 'ok.mjs': 'process.exit(0);\n' });
    const result = await runBlock(root, stage('node ok.mjs'));
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({ block: { exitCode: 0 } });
  });

  it('refuses a command that exits 1, saying so with the end of its output', async () => {
    const root = projectWith({ 'fail.mjs': 'console.error("la zona de nómina está en rojo"); process.exit(1);\n' });
    const result = await runBlock(root, stage('node fail.mjs'));
    expect(result.outcome).toMatchObject(refused(/«node fail\.mjs» terminó con código 1[\s\S]*la zona de nómina está en rojo/));
  });

  it('speaks English when the recipe does', async () => {
    const root = projectWith({ 'fail.mjs': 'process.exit(2);\n' });
    const result = await runBlock(root, stage('node fail.mjs'), { locale: 'en' });
    expect(result.outcome).toMatchObject(refused(/"node fail\.mjs" exited with code 2/));
  });

  it('is a technical block when the program does not exist', async () => {
    const root = projectWith({});
    const result = await runBlock(root, stage('no-such-program-aiw-13 check'));
    expect(result.outcome).toMatchObject(technical(/no-such-program-aiw-13/));
  });

  it('passes the test files of the change as arguments when asked with {tests}', async () => {
    const root = projectWith({
      'args.mjs': 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.AIW_ARGS_OUT, JSON.stringify(process.argv.slice(2))); process.exit(0);\n',
      'tests/b.test.ts': 'b\n',
      'tests/a.test.ts': 'a\n',
    });
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const out = join(mkdtempSync(join(tmpdir(), 'aiw-args-')), 'args.json');
    process.env.AIW_ARGS_OUT = out;
    await runBlock(root, stage('node args.mjs {tests}'));
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });
});

describe('CN-04 · declaring all green with a test of the zone in red, through the block', () => {
  const RED = 'process.stdout.write(" FAIL  tests/nomina.test.ts > el bono\\nAssertionError: expected 800 to be 1000\\n Tests  1 failed | 170 passed (171)\\n"); process.exit(0);\n';
  const GREEN = 'process.stdout.write(" Tests  171 passed (171)\\n"); process.exit(0);\n';

  it('refuses a red suite that exits 0 when the output is read', async () => {
    const root = projectWith({ 'suite.mjs': RED });
    const result = await runBlock(root, stage('node suite.mjs', 'reader: vitest'));
    expect(result.outcome).toMatchObject(refused(/nomina\.test\.ts/));
  });

  it('refuses a run that ran no test at all', async () => {
    const root = projectWith({ 'suite.mjs': 'process.exit(0);\n' });
    const result = await runBlock(root, stage('node suite.mjs', 'reader: vitest'));
    expect(result.outcome).toMatchObject({ status: { stage: 'check', state: 'blocked:rejected' } });
  });

  it('positive control: a genuinely green suite passes', async () => {
    const root = projectWith({ 'suite.mjs': GREEN });
    expect((await runBlock(root, stage('node suite.mjs', 'reader: vitest'))).outcome).toMatchObject(passed);
  });

  it('only runs for the zone it guards: another zone skips it with the motive', async () => {
    const root = projectWith({ 'suite.mjs': RED, 'app/page.tsx': 'p\n' });
    const result = await runBlock(
      root,
      [
        '    nature: recompute',
        '    applies-if: { touches-any: [payroll] }',
        '    gate:',
        '      uses: ai-workflows/command@1',
        '      with: { command: "node suite.mjs", reader: vitest }',
      ],
      { top: ['classify:', '  payroll: ["lib/nomina/**"]'] },
    );
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry).toMatchObject({ outcome: 'skipped', reason: 'No aplica: el cambio no toca «payroll».' });
  });
});
