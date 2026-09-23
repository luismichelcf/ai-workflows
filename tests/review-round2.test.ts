import { hostname } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ProcessTreeSurvived,
  StaleVersion,
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type Recipe,
  type Store,
} from '../src/index.js';
import { checkQuarantine, launchInGroup, type ProcessGroup, type ProcessGroupControl } from '../src/process-group.js';
import { groupExitFromReport, terminateResultFromReport } from '../src/process-group-windows.js';

import { passed, refused, runBlock } from './block-harness.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// Review round 2 of PR #17 (delta 8a8bf2c..e865f72): what the second look found. Each block
// names the rule it pins; together with review round 1 they are the evidence that the fixes
// hold, and that the mutants the reviewers ran now die.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

const QUARANTINE = { host: 'here', platform: 'posix', pgid: 1, confirmed: false } as const;
const ONE_STAGE = { locale: 'es', stages: [{ name: 'only', nature: 'recompute' as const, gate: () => ({ ok: true as const }) }] };

// ---------------------------------------------------------------------------------------
// The engine and the quarantine
// ---------------------------------------------------------------------------------------

describe('a stored quarantine binds every run, rehearsals included', () => {
  it('a dry run of a quarantined piece is blocked and runs no stage', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QUARANTINE }, undefined);
    let ran = 0;
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => { ran += 1; return { ok: true }; } }] },
      store,
      confirmQuarantine: async () => 'the process group 1 still has processes',
    });
    const outcome = await engine.run('42', { mode: 'dry-run' });
    expect(outcome).toMatchObject({ outcome: 'ran', status: { state: 'blocked:technical', reason: 'the process group 1 still has processes' } });
    expect(ran).toBe(0);
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QUARANTINE);
  });
});

describe('only the quarantine check may remove a quarantine', () => {
  it('is stored even when the lease was lost while the stage ran', async () => {
    let clock = 1_000_000;
    // The store must read the same clock as the engine, or taking the piece cannot be seen.
    const store = createMemoryStore({ now: () => clock });
    const engine = createEngine({
      config: {
        locale: 'es',
        stages: [{
          name: 'only',
          nature: 'recompute',
          gate: async () => {
            clock += 10 * 60_000; // the lease lapses…
            expect((await store.reserve('42', 'thief', 30_000)).ok).toBe(true); // …and someone takes the piece
            throw new ProcessTreeSurvived(QUARANTINE, 'the process group of "x" is not confirmed empty');
          },
        }],
      },
      store,
      now: () => clock,
      leaseMs: 30_000,
    });
    await engine.run('42');
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QUARANTINE);
  });

  it('a run that was already going keeps a quarantine written meanwhile', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      config: {
        locale: 'es',
        stages: [{
          name: 'only',
          nature: 'recompute',
          gate: async () => {
            const current = await store.loadStatus('42');
            if (current !== undefined) {
              await store.saveStatus({ ...current.status, quarantine: QUARANTINE }, current.version);
            }
            return { ok: true };
          },
        }],
      },
      store,
    });
    await engine.run('42');
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QUARANTINE);
  });

  it('retries saving a quarantine that lost a race with another write', async () => {
    const inner = createMemoryStore();
    let raced = false;
    const store: Store = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (!raced && status.quarantine !== undefined) {
          raced = true;
          throw new StaleVersion(status.piece);
        }
        return inner.saveStatus(status, expected);
      },
    };
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => { throw new ProcessTreeSurvived(QUARANTINE); } }] },
      store,
    });
    await engine.run('42');
    expect(raced).toBe(true);
    expect((await inner.loadStatus('42'))?.status.quarantine).toEqual(QUARANTINE);
  });
});

describe('facts that cannot be frozen are refused, never shared', () => {
  it('a change description that is not plain data blocks the piece', async () => {
    const engine = createEngine({
      config: ONE_STAGE,
      store: createMemoryStore(),
      describeChange: () => ({ files: ['a.ts'], compute: () => 1 }),
    });
    expect(await engine.run('42')).toMatchObject({ outcome: 'ran', status: { state: 'blocked:technical', reason: expect.stringMatching(/facts|change/) } });
  });
});

// ---------------------------------------------------------------------------------------
// What the Windows launcher reports, read the same way on every system
// ---------------------------------------------------------------------------------------

describe('the report of the Windows launcher', () => {
  const report = (fields: Record<string, unknown>) => JSON.stringify(fields);

  it('a lost report (no file, unreadable, or a launcher that did not end cleanly) is lost, never empty', () => {
    expect(terminateResultFromReport(undefined, 0)).toEqual({ empty: false, lost: true });
    expect(terminateResultFromReport('not json', 0)).toEqual({ empty: false, lost: true });
    expect(terminateResultFromReport(report({ childExit: 0, treeEmpty: true }), 1)).toEqual({ empty: false, lost: true });
    expect(terminateResultFromReport(report({ childExit: 0, treeEmpty: true }), null)).toEqual({ empty: false, lost: true });
  });

  it('an explicit "not empty" carries the survivors the launcher named', () => {
    const survivors = [{ pid: 4242, created: '133700000000000000' }];
    expect(terminateResultFromReport(report({ childExit: 1, treeEmpty: false, survivors }), 0))
      .toEqual({ empty: false, survivors });
  });

  it('an explicit "empty" is empty', () => {
    expect(terminateResultFromReport(report({ childExit: 0, treeEmpty: true }), 0)).toEqual({ empty: true });
  });

  it('a report without the exit code of the command is never a clean exit', () => {
    const exit = groupExitFromReport(report({ treeEmpty: true }), 0, { stdout: '{"ok":true}', stderr: '', truncated: false });
    expect(exit).toMatchObject({ kind: 'technical' });
  });

  it('a lost report is never a clean exit either', () => {
    expect(groupExitFromReport(undefined, 0, { stdout: '{"ok":true}', stderr: '', truncated: false })).toMatchObject({ kind: 'technical' });
  });

  it('a readable report gives the exit code of the command', () => {
    expect(groupExitFromReport(report({ childExit: 3, treeEmpty: true }), 0, { stdout: 'x', stderr: 'y', truncated: false }))
      .toEqual({ kind: 'exited', code: 3, stdout: 'x', stderr: 'y', truncated: false });
  });
});

describe('the survivors a group names end up in the quarantine', () => {
  // Survivors are how a Windows quarantine names what is still alive; on POSIX the process group
  // itself is asked, so there is no list to carry.
  it.runIf(process.platform === 'win32')('a command block stores them, so the check can wait for exactly those processes', async () => {
    const root = repository();
    write(root, 'block.mjs', 'process.stdout.write(JSON.stringify({ ok: true }));\n');
    commit(root, 'block');
    const survivors = [{ pid: 4242, created: '133700000000000000' }];
    const groups: ProcessGroupControl = {
      launch: (options) => {
        const group = launchInGroup(options);
        return { ...group, terminate: async () => { await group.terminate(); return { empty: false, survivors }; } };
      },
      check: checkQuarantine,
    };
    const recipe = recipeOf(lines(
      'version: 1', 'locale: es', 'stages:', '  - id: only', '    summary: "Uno"', '    phase: merge', '    nature: recompute', '    gate:', '      run: node block.mjs',
    ));
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store, processGroups: groups });
    await createEngine({ config: compiled.config, store, describeChange: compiled.describeChange }).run('42');
    expect((await store.loadStatus('42'))?.status.quarantine).toMatchObject({ survivors });
  });
});

describe('on Windows a survivor that cannot be read keeps the quarantine', () => {
  const job = String.raw`Local\ai-workflows-00000000-0000-0000-0000-000000000002`;

  it.runIf(process.platform === 'win32')('a survivor recorded without its creation time is unknown, never gone', async () => {
    const quarantine = { host: hostname(), platform: 'win32', job, confirmed: false, survivors: [{ pid: process.pid, created: 'unknown' }] };
    expect(await checkQuarantine(quarantine)).toMatchObject({ empty: false });
  });

  it.runIf(process.platform === 'win32')('a malformed survivor entry is not ignored', async () => {
    const quarantine = { host: hostname(), platform: 'win32', job, confirmed: false, survivors: [{ pid: 'x' }] };
    expect(await checkQuarantine(quarantine)).toMatchObject({ empty: false });
  });

  it.runIf(process.platform === 'win32')('a quarantine of another logon session cannot be asked from this one', async () => {
    const quarantine = { host: hostname(), platform: 'win32', job, confirmed: false, session: 987654 };
    expect(await checkQuarantine(quarantine)).toMatchObject({ empty: false, reason: expect.stringMatching(/another session/) });
  });
});

describe('on Linux a process that escaped the group never hangs the engine', () => {
  it.runIf(process.platform !== 'win32')('a time limit ends the wait even if an escaped process keeps the output open', async () => {
    const root = repository();
    const group = launchInGroup({ command: 'sh', args: ['-c', 'setsid sleep 30 & echo hi; sleep 100'], cwd: root, stdin: '', timeoutMs: 1000 });
    const started = Date.now();
    const exit = await group.wait();
    await group.terminate();
    expect(exit).toMatchObject({ kind: 'technical', reason: expect.stringMatching(/ran out of time/) });
    expect(Date.now() - started).toBeLessThan(8000);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// The reviewer, wired the way compileRecipe wires it in production
// ---------------------------------------------------------------------------------------

describe('the default reviewer runner gets the time limit and the stop signal', () => {
  const BUILDER = { provider: 'deepseek', model: 'deepseek-flash', session: 's-build' };
  const CLAUDE_OUTPUT = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's-review',
    result: 'Bien.\nVERDICT:APPROVED',
    modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } },
  });
  const reviewRecipe = (...extra: string[]) => recipeOf(lines(
    'version: 1', 'locale: es', 'stages:', '  - id: review', '    summary: "Revisión"', '    phase: merge', '    nature: attest', '    gate:',
    '      uses: ai-workflows/sandboxed-review@1',
    '      with:',
    '        reviewer: { provider: claude, model: claude-opus-5-5 }',
    '        prompt: "docs/review.md"',
    '        angle: spec',
    ...extra,
  ));

  function fakeGroups(hold: boolean) {
    const launched: { command: string; timeoutMs?: number }[] = [];
    let terminated = 0;
    const groups: ProcessGroupControl = {
      launch: (options) => {
        launched.push({ command: options.command, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
        let release: () => void = () => undefined;
        const done = new Promise<void>((resolve) => { release = resolve; });
        const group: ProcessGroup = {
          quarantine: { host: hostname(), platform: 'posix', pgid: 1, confirmed: false },
          wait: async () => {
            if (hold) await done;
            return { kind: 'exited', code: 0, stdout: CLAUDE_OUTPUT, stderr: '', truncated: false };
          },
          terminate: async () => { terminated += 1; release(); return { empty: true }; },
        };
        return group;
      },
      check: async () => ({ empty: true }),
    };
    return { groups, launched, terminated: () => terminated };
  }

  function project() {
    const root = repository();
    write(root, 'docs/review.md', 'Revisa.\n');
    commit(root, 'prompt');
    return root;
  }

  it('launches the provider with the recipe time limit through the configured process groups', async () => {
    const root = project();
    const fake = fakeGroups(false);
    const store = createMemoryStore();
    const compiled = await compileRecipe(reviewRecipe('        timeout-minutes: 2'), { root, baseRef: 'main', declared: () => ({ builder: BUILDER }), store, processGroups: fake.groups });
    await createEngine({ config: compiled.config, store, describeChange: compiled.describeChange }).run('42');
    expect(fake.launched).toEqual([{ command: 'claude', timeoutMs: 120_000 }]);
  });

  it('terminates the provider when the piece is stopped', async () => {
    const root = project();
    const fake = fakeGroups(true);
    const store = createMemoryStore();
    const compiled = await compileRecipe(reviewRecipe(), { root, baseRef: 'main', declared: () => ({ builder: BUILDER }), store, processGroups: fake.groups });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, cancellationPollMs: 20 });
    const running = engine.run('42');
    while (fake.launched.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await createEngine({ config: compiled.config, store }).stop('42', 'stop');
    expect((await running).outcome).toBe('parked');
    expect(fake.terminated()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// build-verify, on the repositories people really have
// ---------------------------------------------------------------------------------------

const RUNNER = [
  'import { pathToFileURL } from "node:url";',
  'import { resolve } from "node:path";',
  'const files = process.argv.slice(2);',
  'let passedCount = 0; let failedCount = 0; const out = [];',
  'for (const file of files) {',
  '  const mod = await import(pathToFileURL(resolve(file)).href);',
  '  for (const [name, fn] of Object.entries(mod.cases ?? {})) {',
  '    try { await fn(); passedCount += 1; }',
  '    catch (error) { failedCount += 1; out.push(` FAIL  ${file} > ${name}`, `AssertionError: ${error.message}`); }',
  '  }',
  '}',
  'if (out.length > 0) console.log(out.join("\\n"));',
  'const total = passedCount + failedCount;',
  'console.log(failedCount > 0 ? ` Test Files  1 failed (${files.length})` : ` Test Files  ${files.length} passed (${files.length})`);',
  'let tests = `${passedCount} passed (${total})`;',
  'if (failedCount > 0) tests = passedCount > 0 ? `${failedCount} failed | ${passedCount} passed (${total})` : `${failedCount} failed (${total})`;',
  'console.log(`      Tests  ${tests}`);',
  'process.exitCode = failedCount > 0 ? 1 : 0;',
  '',
].join('\n');

const value = (name: string, amount: number) => `export const ${name} = () => ${amount};\n`;
const TWO_CASES = [
  'import assert from "node:assert/strict";',
  'import { bonus } from "../src/bonus.mjs";',
  'import { extra } from "../src/extra.mjs";',
  'export const cases = {',
  '  "A bono": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`),',
  '  "B extra": () => assert.equal(extra(), 1000, `expected ${extra()} to be 1000`),',
  '};',
  '',
].join('\n');
const ONE_CASE = [
  'import assert from "node:assert/strict";',
  'import { bonus } from "../src/bonus.mjs";',
  'export const cases = { "A bono": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`) };',
  '',
].join('\n');

const COMMAND = 'node runner.mjs {tests}';
const TESTS = '["tests/**/*.test.mjs"]';
const RED = ['  - id: red', '    summary: "Prueba roja"', '    nature: execution-record', '    valid-while: forever', '    gate:', '      uses: ai-workflows/red-test@1', `      with: { command: "${COMMAND}", tests: ${TESTS} }`];
const BUILD = ['    nature: execution-record', '    gate:', '      uses: ai-workflows/build-verify@1', `      with: { command: "${COMMAND}", tests: ${TESTS}, red-stage: red }`];

describe('build-verify requires the same failing test, not only the same message', () => {
  it('refuses when the retired run fails another test with the same assertion text', async () => {
    // Red: "A bono" fails (a half-done bonus returns 800) while "B extra" passes.
    // Retired: "A bono" passes (the base bonus is right) and "B extra" fails with the same text.
    const root = repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': value('bonus', 1000), 'src/extra.mjs': value('extra', 800) });
    write(root, 'tests/pay.test.mjs', TWO_CASES);
    write(root, 'src/bonus.mjs', value('bonus', 800));
    write(root, 'src/extra.mjs', value('extra', 1000));
    commit(root, 'red with a half-done bonus');
    const first = await runBlock(root, BUILD, { before: RED });
    expect(first.journal.find((entry) => entry.stage === 'red')?.outcome).toBe('passed');
    write(root, 'src/bonus.mjs', value('bonus', 1000));
    commit(root, 'bonus done');
    expect((await first.again()).outcome).toMatchObject(refused(/misma/));
  });
});

describe('build-verify on Windows line endings', () => {
  it('does not flag the commit that saves, unchanged, a test red while unsaved with CRLF endings', async () => {
    const root = repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': value('bonus', 800) });
    git(root, 'config', 'core.autocrlf', 'true');
    write(root, 'tests/pay.test.mjs', ONE_CASE.replace(/\n/g, '\r\n'));
    const first = await runBlock(root, BUILD, { before: RED });
    write(root, 'src/bonus.mjs', value('bonus', 1000));
    commit(root, 'test and implementation');
    expect((await first.again()).outcome).toMatchObject(passed);
  });
});

describe('build-verify on SHA-256 repositories', () => {
  it('still finds a test changed and put back in history', async () => {
    const root = repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': value('bonus', 800) }, { objectFormat: 'sha256' });
    write(root, 'tests/pay.test.mjs', ONE_CASE);
    commit(root, 'red');
    const first = await runBlock(root, BUILD, { before: RED });
    write(root, 'tests/pay.test.mjs', ONE_CASE.replace('1000', '800'));
    const touched = commit(root, 'softer test');
    write(root, 'tests/pay.test.mjs', ONE_CASE);
    write(root, 'src/bonus.mjs', value('bonus', 1000));
    commit(root, 'test put back and implementation');
    expect(touched).toMatch(/^[0-9a-f]{64}$/);
    expect((await first.again()).outcome).toMatchObject(refused(new RegExp(touched.slice(0, 7))));
  });
});

describe('every git call of the engine ignores inherited git variables', () => {
  async function withForeignGit<T>(run: () => Promise<T>): Promise<T> {
    const other = repository();
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, work: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = `${other}/.git`;
    process.env.GIT_INDEX_FILE = `${other}/.git/index`;
    process.env.GIT_WORK_TREE = other;
    try {
      return await run();
    } finally {
      for (const [key, value] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.index], ['GIT_WORK_TREE', saved.work]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('build-verify retires and checks history in its own repository', async () => {
    const root = repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': value('bonus', 800) });
    write(root, 'tests/pay.test.mjs', ONE_CASE);
    commit(root, 'red');
    const first = await runBlock(root, BUILD, { before: RED });
    write(root, 'src/bonus.mjs', value('bonus', 1000));
    commit(root, 'implementation');
    const second = await withForeignGit(() => first.again());
    expect(second.outcome).toMatchObject(passed);
  });

  it('a clean update is verified in its own repository', async () => {
    const { recordCleanUpdate } = await import('../src/recipe/validity.js');
    const root = repository({ 'app/list.txt': 'one\ntwo\n' });
    write(root, 'app/list.txt', 'one changed\ntwo\n');
    const from = commit(root, 'piece');
    git(root, 'switch', '-q', 'main');
    write(root, 'docs/news.md', 'n\n');
    commit(root, 'main moves');
    git(root, 'switch', '-q', 'piece');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    const to = git(root, 'rev-parse', 'HEAD');
    await withForeignGit(() => recordCleanUpdate({ store: createMemoryStore(), root, baseRef: 'main', piece: '42', from, to }));
  });
});

describe('command@1 passes only test files that exist', () => {
  it('leaves out a test file the piece deleted', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const out = join(mkdtempSync(join(tmpdir(), 'aiw-args-')), 'args.json');
    const root = repository({
      'args.mjs': `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
      'tests/old.test.ts': 'old\n',
    });
    git(root, 'rm', '-q', 'tests/old.test.ts');
    write(root, 'tests/new.test.ts', 'new\n');
    commit(root, 'replace a test');
    await runBlock(root, ['    nature: recompute', '    gate:', '      uses: ai-workflows/command@1', '      with: { command: "node args.mjs {tests}" }']);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['tests/new.test.ts']);
  });
});
