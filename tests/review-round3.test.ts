import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProcessTreeSurvived, createEngine, createMemoryStore, type JsonValue } from '../src/index.js';
import { checkQuarantine, launchInGroup } from '../src/process-group.js';
import { groupExitFromReport, terminateResultFromReport } from '../src/process-group-windows.js';

import { passed, runBlock } from './block-harness.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// Review round 3 of PR #17 (delta e865f72..c804cca). The rule it tightens: a quarantine is only
// ever lifted by an affirmative "empty" for THAT quarantine; nothing replaces or erases one on
// the way; what cannot be read is not empty; and what is truly gone must not stay stuck.

afterEach(removeRepositories);

const QA = { host: 'elsewhere-a', platform: 'posix', pgid: 11, confirmed: false } as const;
const QB = { host: 'elsewhere-b', platform: 'posix', pgid: 22, confirmed: false } as const;

describe('a quarantine is lifted only for the quarantine that was checked', () => {
  it('a quarantine stored by someone else while this run was checking is kept, and nothing runs', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    let ran = 0;
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => { ran += 1; return { ok: true }; } }] },
      store,
      confirmQuarantine: async () => {
        // While QA is being confirmed empty, another controller stores its own quarantine.
        const current = await store.loadStatus('42');
        if (current !== undefined) await store.saveStatus({ ...current.status, quarantine: QB }, current.version);
        return undefined;
      },
    });
    await engine.run('42');
    expect(ran).toBe(0);
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QB);
  });

  it('a new quarantine never replaces a different one already stored: both are kept', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      config: {
        locale: 'es',
        stages: [{
          name: 'only',
          nature: 'recompute',
          gate: async () => {
            const current = await store.loadStatus('42');
            if (current !== undefined) await store.saveStatus({ ...current.status, quarantine: QB }, current.version);
            throw new ProcessTreeSurvived(QA, 'the process group of "x" is not confirmed empty');
          },
        }],
      },
      store,
    });
    await engine.run('42');
    const stored = (await store.loadStatus('42'))?.status.quarantine as JsonValue;
    expect(stored).toEqual(expect.arrayContaining([QA, QB]));
  });

  it('several quarantines are lifted only when every one of them is confirmed empty', async () => {
    const store = createMemoryStore();
    await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: [QA, QB] }, undefined);
    const asked: unknown[] = [];
    let ran = 0;
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => { ran += 1; return { ok: true }; } }] },
      store,
      confirmQuarantine: async (quarantine) => {
        asked.push(quarantine);
        return undefined;
      },
    });
    await engine.run('42');
    expect(asked).toEqual([[QA, QB]]);
    expect(ran).toBe(1);
  });
});

describe('a stop by the owner survives a quarantine', () => {
  it('a piece stopped while its processes could not be confirmed stays stopped once they are gone', async () => {
    const store = createMemoryStore();
    let stopped = false;
    const config = {
      locale: 'es',
      stages: [{
        name: 'only',
        nature: 'recompute' as const,
        gate: async () => {
          await createEngine({ config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute' as const, gate: () => ({ ok: true as const }) }] }, store }).stop('42', 'the owner stops it');
          stopped = true;
          throw new ProcessTreeSurvived(QA);
        },
      }],
    };
    await createEngine({ config, store }).run('42');
    expect(stopped).toBe(true);
    const quarantined = (await store.loadStatus('42'))?.status;
    expect(quarantined).toMatchObject({ state: 'blocked:technical', quarantine: QA, previous: { state: 'parked' } });
    const released = await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(released).toMatchObject({ outcome: 'parked' });
  });
});

describe('facts with a cycle are refused with a readable reason', () => {
  it('blocks, saying the facts are not plain data', async () => {
    const facts: Record<string, unknown> = { files: ['a.ts'] };
    facts.self = facts;
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => ({ ok: true }) }] },
      store: createMemoryStore(),
      describeChange: () => facts,
    });
    expect(await engine.run('42')).toMatchObject({ status: { state: 'blocked:technical', reason: expect.stringMatching(/plain data/) } });
  });
});

describe('what the Windows launcher could not list is not empty', () => {
  const report = (fields: Record<string, unknown>) => JSON.stringify(fields);

  it('an explicit "not empty" without a readable list of survivors carries an unreadable list', () => {
    expect(terminateResultFromReport(report({ childExit: 1, treeEmpty: false }), 0)).toEqual({ empty: false, survivors: 'unreadable' });
    expect(terminateResultFromReport(report({ childExit: 1, treeEmpty: false, survivors: [] }), 0)).toEqual({ empty: false, survivors: 'unreadable' });
    expect(terminateResultFromReport(report({ childExit: 1, treeEmpty: false, survivors: [{ pid: 'x' }] }), 0)).toEqual({ empty: false, survivors: 'unreadable' });
  });

  it.runIf(process.platform === 'win32')('a quarantine whose survivors could not be listed is never empty', async () => {
    const job = String.raw`Local\ai-workflows-00000000-0000-0000-0000-000000000003`;
    expect(await checkQuarantine({ host: hostname(), platform: 'win32', job, confirmed: false, survivors: 'unreadable' })).toMatchObject({ empty: false });
  });

  it.runIf(process.platform === 'win32')('a survivor whose creation time was unknown is gone once its pid no longer exists', async () => {
    const job = String.raw`Local\ai-workflows-00000000-0000-0000-0000-000000000004`;
    const quarantine = { host: hostname(), platform: 'win32', job, confirmed: false, survivors: [{ pid: 4_000_000, created: 'unknown' }] };
    expect(await checkQuarantine(quarantine)).toEqual({ empty: true });
  });

  it.runIf(process.platform === 'win32')('the session is recorded when the group starts, not only when the launcher reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiw-session-'));
    const group = launchInGroup({ command: process.execPath, args: ['-e', ''], cwd: root, stdin: '' });
    expect(group.quarantine).toMatchObject({ platform: 'win32', session: expect.any(Number) });
    await group.wait();
    await group.terminate();
  }, 30_000);
});

describe('build-verify does not depend on a git identity being configured', () => {
  const RUNNER = [
    'import { pathToFileURL } from "node:url";',
    'import { resolve } from "node:path";',
    'let failed = 0; let passed = 0; const out = [];',
    'for (const file of process.argv.slice(2)) {',
    '  const mod = await import(pathToFileURL(resolve(file)).href);',
    '  for (const [name, fn] of Object.entries(mod.cases ?? {})) {',
    '    try { await fn(); passed += 1; } catch (error) { failed += 1; out.push(` FAIL  ${file} > ${name}`, `AssertionError: ${error.message}`); }',
    '  }',
    '}',
    'if (out.length > 0) console.log(out.join("\\n"));',
    'console.log(failed > 0 ? " Test Files  1 failed (1)" : " Test Files  1 passed (1)");',
    'console.log(failed > 0 ? `      Tests  ${failed} failed (${failed + passed})` : `      Tests  ${passed} passed (${passed})`);',
    'process.exitCode = failed > 0 ? 1 : 0;',
    '',
  ].join('\n');
  const TEST = 'import assert from "node:assert/strict";\nimport { bonus } from "../src/bonus.mjs";\nexport const cases = { "A": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`) };\n';
  const COMMAND = 'node runner.mjs {tests}';
  const RED = ['  - id: red', '    summary: "Roja"', '    nature: execution-record', '    valid-while: forever', '    gate:', '      uses: ai-workflows/red-test@1', `      with: { command: "${COMMAND}", tests: ["tests/**/*.test.mjs"] }`];
  const BUILD = ['    nature: execution-record', '    gate:', '      uses: ai-workflows/build-verify@1', `      with: { command: "${COMMAND}", tests: ["tests/**/*.test.mjs"], red-stage: red }`];

  it('retires the implementation where no user name or email is set anywhere', async () => {
    const root = repository({ 'runner.mjs': RUNNER, 'src/bonus.mjs': 'export const bonus = () => 800;\n' });
    write(root, 'tests/pay.test.mjs', TEST);
    commit(root, 'red');
    const first = await runBlock(root, BUILD, { before: RED });
    write(root, 'src/bonus.mjs', 'export const bonus = () => 1000;\n');
    commit(root, 'implementation');
    git(root, 'config', '--unset', 'user.name');
    git(root, 'config', '--unset', 'user.email');
    const home = mkdtempSync(join(tmpdir(), 'aiw-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = home;
    try {
      expect((await first.again()).outcome).toMatchObject(passed);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// Review round 3, tests: claims that were true but unproven
// ---------------------------------------------------------------------------------------

describe('every inherited git variable is removed, whatever its name or case', () => {
  it('drops GIT_CONFIG_* and lowercase git_ variables, keeps the rest and what the engine adds', async () => {
    const { gitEnvironment } = await import('../src/git-env.js');
    const saved = { ...process.env };
    process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=evil'";
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.git_lower = 'x';
    process.env.AIW_KEEP = 'kept';
    try {
      const environment = gitEnvironment({ GIT_INDEX_FILE: '/tmp/index' });
      expect(Object.keys(environment).filter((key) => key.toUpperCase().startsWith('GIT_'))).toEqual(['GIT_INDEX_FILE']);
      expect(environment.AIW_KEEP).toBe('kept');
    } finally {
      for (const key of ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'git_lower', 'AIW_KEEP']) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('a git setting injected through GIT_CONFIG_COUNT does not redirect the facts', async () => {
    const { describeChangeFromGit, parseRecipe } = await import('../src/index.js');
    const parsed = parseRecipe('version: 1\nlocale: es\nstages:\n  - id: m\n    summary: "M"\n    phase: merge\n    nature: recompute\n    gate:\n      run: node m.mjs\n', 'r.yml');
    if (!parsed.ok) throw new Error('fixture');
    const root = repository();
    write(root, 'app/page.tsx', 'x\n');
    commit(root, 'c');
    const other = repository();
    const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
    process.env.GIT_CONFIG_VALUE_0 = other;
    try {
      const facts = await describeChangeFromGit({ root, baseRef: 'main', recipe: parsed.recipe, piece: '42', declared: {} });
      expect(facts.files).toEqual(['app/page.tsx']);
    } finally {
      for (const [key, value] of [['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key], ['GIT_CONFIG_VALUE_0', saved.value]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('the session a Windows group records is the session it runs in', () => {
  it.runIf(process.platform === 'win32')('after a normal end, the quarantine names the current session', async () => {
    const { currentWindowsSessionId } = await import('../src/process-group-windows.js');
    const root = mkdtempSync(join(tmpdir(), 'aiw-session-'));
    const group = launchInGroup({ command: process.execPath, args: ['-e', ''], cwd: root, stdin: '' });
    await group.wait();
    await group.terminate();
    const current = await currentWindowsSessionId();
    expect(current).toEqual(expect.any(Number));
    expect(group.quarantine).toMatchObject({ session: current });
  }, 30_000);
});

describe('the launcher report, the remaining guards', () => {
  it('a launcher that did not end cleanly never yields a clean exit of the command', () => {
    const report = JSON.stringify({ childExit: 0, treeEmpty: true });
    expect(groupExitFromReport(report, 1, { stdout: '{"ok":true}', stderr: '', truncated: false })).toMatchObject({ kind: 'technical' });
  });
});

describe('the failure behind a quarantine is journalled even without the lease', () => {
  it('records the failed stage as well as the quarantine', async () => {
    let clock = 1_000_000;
    const store = createMemoryStore({ now: () => clock });
    const engine = createEngine({
      config: {
        locale: 'es',
        stages: [{
          name: 'only',
          nature: 'recompute',
          gate: async () => {
            clock += 10 * 60_000;
            await store.reserve('42', 'thief', 30_000);
            throw new ProcessTreeSurvived(QA, 'the process group of "x" is not confirmed empty');
          },
        }],
      },
      store,
      now: () => clock,
      leaseMs: 30_000,
    });
    await engine.run('42');
    expect((await store.journal('42')).filter((entry) => entry.stage === 'only' && entry.outcome === 'failed')).toHaveLength(1);
  });
});
