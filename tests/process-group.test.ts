import { existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  parseRecipe,
  type Recipe,
} from '../src/index.js';
import { checkQuarantine, launchInGroup, type ProcessGroupControl } from '../src/process-group.js';

import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13 RC-10 and PLAN-13-R2 §2.2: a command block runs inside a group the operating system
// keeps together — a job object on Windows, a process group elsewhere — so cancelling it ends
// every descendant, even a grandchild whose parent already died. The engine only lets go of a
// piece once the group is confirmed empty; when it cannot confirm that, the piece stays in
// quarantine, and quarantine is lifted only by asking the system again, never by a list.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function recipeOf(text: string): Recipe {
  const result = parseRecipe(text, 'receta.yml');
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  return result.recipe;
}

/**
 * A child that starts a grandchild writing a heartbeat file every 50 ms, then exits at once:
 * the grandchild is orphaned within milliseconds. `answer` is what the child prints first.
 */
const ORPHANING_BLOCK = (answer: 'wait' | 'pass') => [
  'import { spawn } from "node:child_process";',
  'const grandchild = spawn(process.execPath, ["-e", `',
  '  const fs = require("fs");',
  '  setInterval(() => fs.appendFileSync("heartbeat.txt", "."), 50);',
  '`], { stdio: "ignore" });',
  'grandchild.unref();',
  answer === 'pass'
    ? 'process.stdout.write(JSON.stringify({ ok: true }));'
    : 'setInterval(() => {}, 1000);',
  '',
].join('\n');

const HOLD = 'process.stdout.write(JSON.stringify({ ok: false, reason: "held" }));\n';

const recipe = recipeOf(lines(
  'version: 1',
  'locale: es',
  'stages:',
  '  - id: check',
  '    summary: "Comprobación"',
  '    nature: recompute',
  '    gate:',
  '      run: node block.mjs',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: check',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node hold.mjs',
));

const until = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const size = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

/** True when `file` stops growing for 400 ms, which is eight heartbeats. */
async function stoppedGrowing(file: string): Promise<boolean> {
  const before = size(file);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return size(file) === before;
}

async function project(answer: 'wait' | 'pass') {
  const root = repository();
  write(root, 'block.mjs', ORPHANING_BLOCK(answer));
  write(root, 'hold.mjs', HOLD);
  commit(root, 'blocks');
  return root;
}

describe('RC-10: cancelling a piece ends every process of its block', () => {
  it('kills an orphaned grandchild when the piece is stopped mid-stage', async () => {
    const root = await project('wait');
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({
      config: compiled.config,
      store,
      describeChange: compiled.describeChange,
      confirmQuarantine: compiled.confirmQuarantine,
      cancellationPollMs: 20,
    });
    const heartbeat = join(root, 'heartbeat.txt');
    const running = engine.run('42');
    await until(() => size(heartbeat) > 0);
    await createEngine({ config: compiled.config, store }).stop('42', 'the owner stops it');
    await running;
    expect(await stoppedGrowing(heartbeat)).toBe(true);
    const other = await store.reserve('42', 'someone-else', 30_000);
    expect(other.ok).toBe(true);
  }, 30_000);

  it('kills a grandchild left alive by a block that finished normally', async () => {
    const root = await project('pass');
    const store = createMemoryStore();
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange });
    await engine.run('42');
    expect(await stoppedGrowing(join(root, 'heartbeat.txt'))).toBe(true);
  }, 30_000);
});

describe('RC-10: a group the engine cannot confirm empty keeps the piece in quarantine', () => {
  it('blocks every later run, after the lease expires too, until the group is really empty', async () => {
    const root = await project('wait');
    const store = createMemoryStore();
    let clock = 1_000_000;
    const now = () => clock;
    // A terminator that fails: it reports the group as not empty and leaves it running.
    const leftRunning: { terminate(): Promise<unknown> }[] = [];
    const failing: ProcessGroupControl = {
      launch: (options) => {
        const group = launchInGroup(options);
        leftRunning.push(group);
        return { ...group, terminate: async () => ({ empty: false }) };
      },
      check: checkQuarantine,
    };
    const compiled = await compileRecipe(recipe, {
      root,
      baseRef: 'main',
      declared: () => ({}),
      store,
      processGroups: failing,
    });
    const options = {
      config: compiled.config,
      store,
      describeChange: compiled.describeChange,
      confirmQuarantine: compiled.confirmQuarantine,
      cancellationPollMs: 20,
      leaseMs: 30_000,
      now,
    };
    const first = createEngine({ ...options, runId: 'first' });
    const heartbeat = join(root, 'heartbeat.txt');
    const running = first.run('42');
    await until(() => size(heartbeat) > 0);
    await createEngine({ ...options, runId: 'stopper' }).stop('42', 'stop');
    await running;

    const status = await first.status('42');
    expect(status).toMatchObject({ state: 'blocked:technical', stage: 'check' });
    expect(status?.quarantine).toMatchObject({ host: hostname(), confirmed: false });

    clock += 10 * 60_000; // the first controller's lease is long gone
    const second = createEngine({ ...options, runId: 'second' });
    await first.resume('42').catch(() => undefined);
    const blocked = await second.run('42');
    expect(blocked).toMatchObject({ outcome: 'ran', status: { state: 'blocked:technical' } });
    expect((await store.journal('42')).filter((entry) => entry.stage === 'check')).toHaveLength(1);

    for (const group of leftRunning) await group.terminate();
    expect(await stoppedGrowing(heartbeat)).toBe(true);
    // The block now passes at once, so the next run can finish its first stage.
    write(root, 'block.mjs', 'process.stdout.write(JSON.stringify({ ok: true }));\n');
    await first.resume('42').catch(() => undefined);
    const after = await second.run('42');
    expect(after).toMatchObject({ outcome: 'ran', status: { state: 'blocked:rejected', stage: 'merge' } });
    expect((await first.status('42'))?.quarantine).toBeUndefined();
  }, 60_000);
});

describe('RC-10: quarantine is lifted only by asking the system', () => {
  it('a group with a live grandchild is not empty; once terminated, it is', async () => {
    const root = await project('wait');
    const group = launchInGroup({
      command: process.execPath,
      args: [join(root, 'block.mjs')],
      cwd: root,
      stdin: '{}',
    });
    await until(() => size(join(root, 'heartbeat.txt')) > 0);
    expect(await checkQuarantine(group.quarantine)).toMatchObject({ empty: false });
    expect(await group.terminate()).toEqual({ empty: true });
    expect(await checkQuarantine(group.quarantine)).toEqual({ empty: true });
  }, 30_000);

  it('a group of another machine cannot be asked, so it stays in quarantine', async () => {
    const root = await project('pass');
    const group = launchInGroup({ command: process.execPath, args: [join(root, 'hold.mjs')], cwd: root, stdin: '{}' });
    await group.wait();
    await group.terminate();
    const elsewhere = { ...group.quarantine, host: `${hostname()}-other` };
    expect(await checkQuarantine(elsewhere)).toMatchObject({ empty: false, reason: expect.stringMatching(/another machine/) });
  }, 30_000);

  it('a quarantine it cannot read is not empty', async () => {
    expect(await checkQuarantine({ nonsense: true } as never)).toMatchObject({ empty: false });
  });

  it('reads what the group printed and how it ended', async () => {
    const root = await project('pass');
    write(root, 'echo.mjs', 'let t = ""; process.stdin.on("data", (c) => { t += c; }); process.stdin.on("end", () => { process.stdout.write(t.toUpperCase()); process.stderr.write("side"); process.exit(3); });\n');
    const group = launchInGroup({ command: process.execPath, args: [join(root, 'echo.mjs')], cwd: root, stdin: 'hola' });
    expect(await group.wait()).toMatchObject({ kind: 'exited', code: 3, stdout: 'HOLA', stderr: 'side' });
    expect(await group.terminate()).toEqual({ empty: true });
    expect(readFileSync(join(root, 'echo.mjs'), 'utf8')).toContain('toUpperCase');
  }, 30_000);
});
