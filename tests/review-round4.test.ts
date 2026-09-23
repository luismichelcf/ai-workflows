import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

import { describe, expect, it } from 'vitest';

import { ProcessTreeSurvived, createEngine, createMemoryStore, parseRecipe, compileRecipe, type Store } from '../src/index.js';
import { checkQuarantine } from '../src/process-group.js';

import { commit, removeRepositories, repository, write } from './git-fixtures.js';

// Review round 4 of PR #17 (delta c804cca..e033ec1). Probes written by the reviewer, kept as the
// permanent proof: under concurrent controllers a quarantine is never erased, never lifted for a
// quarantine that was not checked, and the owner's stop is never undone — whatever path the run
// takes (still alive, changed while checking, merged, lifted, rehearsed).

const QA = { host: 'elsewhere-a', platform: 'posix', pgid: 11, confirmed: false } as const;
const QB = { host: 'elsewhere-b', platform: 'posix', pgid: 22, confirmed: false } as const;
const PARKED = { state: 'parked', reason: 'the owner stopped it' } as const;

function counting() {
  let ran = 0;
  const config = { locale: 'es', stages: [{ name: 'only', nature: 'recompute' as const, gate: () => { ran += 1; return { ok: true as const }; } }] };
  return { config, ran: () => ran };
}

async function quarantinedStore(extra: Record<string, unknown> = {}) {
  const store = createMemoryStore();
  await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA, ...extra }, undefined);
  return store;
}

describe('the owner stop survives every path of a quarantine', () => {
  it('a run that still finds the processes alive keeps the stop, and the stop wins once they are gone', async () => {
    const store = await quarantinedStore({ previous: PARKED });
    const { config, ran } = counting();
    await createEngine({ config, store, confirmQuarantine: async () => 'still alive' }).run('42');
    expect((await store.loadStatus('42'))?.status).toMatchObject({ quarantine: QA, previous: PARKED });
    const out = await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(out).toMatchObject({ outcome: 'parked', status: { state: 'parked', reason: PARKED.reason } });
    expect(ran()).toBe(0);
  });

  it('a quarantine that changed while it was checked keeps the stop', async () => {
    const store = await quarantinedStore({ previous: PARKED });
    const { config, ran } = counting();
    await createEngine({
      config,
      store,
      confirmQuarantine: async () => {
        const current = await store.loadStatus('42');
        if (current) await store.saveStatus({ ...current.status, quarantine: [QA, QB] }, current.version);
        return undefined;
      },
    }).run('42');
    expect((await store.loadStatus('42'))?.status).toMatchObject({ previous: PARKED });
    const out = await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(out.outcome).toBe('parked');
    expect(ran()).toBe(0);
  });

  it('merging a second quarantine keeps the stop', async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      config: {
        locale: 'es',
        stages: [{
          name: 'only',
          nature: 'recompute',
          gate: async () => {
            const current = await store.loadStatus('42');
            await store.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA, previous: PARKED }, current?.version);
            throw new ProcessTreeSurvived(QB);
          },
        }],
      },
      store,
    });
    await engine.run('42');
    const status = (await store.loadStatus('42'))?.status;
    expect(status?.quarantine).toEqual(expect.arrayContaining([QA, QB]));
    expect(status?.previous).toMatchObject(PARKED);
  });

  it('a rehearsal that would lift the quarantine and restore the stop writes nothing', async () => {
    const store = await quarantinedStore({ previous: PARKED });
    const before = (await store.loadStatus('42'))?.version;
    const { config, ran } = counting();
    const out = await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42', { mode: 'dry-run' });
    expect(out.outcome).toBe('parked');
    expect(ran()).toBe(0);
    expect((await store.loadStatus('42'))?.version).toBe(before);
  });
});

describe('a quarantine is never erased on the way', () => {
  it('a quarantine merged while "still alive" is being answered is kept', async () => {
    const store = await quarantinedStore();
    const { config } = counting();
    await createEngine({
      config,
      store,
      confirmQuarantine: async () => {
        const current = await store.loadStatus('42');
        if (current) await store.saveStatus({ ...current.status, quarantine: [QA, QB] }, current.version);
        return 'still alive';
      },
    }).run('42');
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(expect.arrayContaining([QA, QB]));
  });

  it('the same quarantine re-stored many times stays one', async () => {
    const store = await quarantinedStore();
    const { config } = counting();
    for (let i = 0; i < 3; i += 1) {
      await createEngine({ config, store, confirmQuarantine: async () => 'alive' }).run('42');
    }
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QA);
  });

  it('a group that fails again with the quarantine it already has does not duplicate it', async () => {
    const store = await quarantinedStore();
    const engine = createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => { throw new ProcessTreeSurvived(QA); } }] },
      store,
      confirmQuarantine: async () => undefined,
    });
    await engine.run('42');
    expect((await store.loadStatus('42'))?.status.quarantine).toEqual(QA);
  });
});

describe('no stage runs unless the checked quarantine was really lifted', () => {
  it('a quarantine added between the check and the lift keeps every stage from running', async () => {
    const inner = createMemoryStore();
    let armed = true;
    const store: Store = {
      ...inner,
      saveStatus: async (status, version) => {
        if (armed && status.quarantine === undefined && status.state === 'blocked:technical') {
          armed = false;
          const current = await inner.loadStatus('42');
          if (current) await inner.saveStatus({ ...current.status, quarantine: [QA, QB] }, current.version);
        }
        return inner.saveStatus(status, version);
      },
    };
    await inner.saveStatus({ piece: '42', state: 'blocked:technical', reason: 'processes', quarantine: QA }, undefined);
    const { config, ran } = counting();
    await createEngine({ config, store, confirmQuarantine: async () => undefined }).run('42');
    expect(ran()).toBe(0);
    expect((await inner.loadStatus('42'))?.status.quarantine).toEqual(expect.arrayContaining([QA, QB]));
  });
});

describe('checking facts for cycles costs time proportional to their size', () => {
  it('shared references deep in the facts do not make the check explode', async () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 24; i += 1) node = { a: node, b: node };
    const started = Date.now();
    await createEngine({
      config: { locale: 'es', stages: [{ name: 'only', nature: 'recompute', gate: () => ({ ok: true }) }] },
      store: createMemoryStore(),
      describeChange: () => node,
    }).run('42');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('compileRecipe asks about every quarantine of a list', () => {
  const recipe = (() => {
    const parsed = parseRecipe('version: 1\nlocale: es\nstages:\n  - id: m\n    summary: "M"\n    phase: merge\n    nature: recompute\n    gate:\n      run: node m.mjs\n', 'r.yml');
    if (!parsed.ok) throw new Error('fixture');
    return parsed.recipe;
  })();
  // Empty on this machine: a job or process group that does not exist. Alive: one on another host.
  const EMPTY = process.platform === 'win32'
    ? { host: hostname(), platform: 'win32', job: String.raw`Local\ai-workflows-00000000-0000-0000-0000-000000000009`, confirmed: false }
    : { host: hostname(), platform: 'posix', pgid: 4_000_000, confirmed: false };
  const ELSEWHERE = { host: `${hostname()}-other`, platform: 'posix', pgid: 1, confirmed: false };

  it('says empty only when every quarantine of the list is empty', async () => {
    const root = repository();
    write(root, 'm.mjs', '');
    commit(root, 'm');
    const compiled = await compileRecipe(recipe, { root, baseRef: 'main', declared: () => ({}), store: createMemoryStore() });
    expect(await compiled.confirmQuarantine([EMPTY, EMPTY])).toBeUndefined();
    expect(await compiled.confirmQuarantine([EMPTY, ELSEWHERE])).toMatch(/another machine/);
    expect(await compiled.confirmQuarantine([ELSEWHERE, EMPTY])).toMatch(/another machine/);
    expect(await compiled.confirmQuarantine([])).toBeDefined();
    removeRepositories();
  });
});

describe('on Windows a live process whose start time cannot be read is not gone', () => {
  it.runIf(process.platform === 'win32')('a survivor that exists but cannot be inspected keeps the quarantine', async (context) => {
    const pid = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process csrss | Select-Object -First 1).Id'], { encoding: 'utf8' }).trim());
    expect(pid).toBeGreaterThan(0);
    // An administrator can read a system process's start time; then there is no unreadable case here.
    const readable = execFileSync('powershell', ['-NoProfile', '-Command', `$null -ne (Get-Process -Id ${pid}).StartTime`], { encoding: 'utf8' }).trim();
    if (readable === 'True') context.skip();
    const job = String.raw`Local\ai-workflows-00000000-0000-0000-0000-000000000010`;
    const quarantine = { host: hostname(), platform: 'win32', job, confirmed: false, survivors: [{ pid, created: '1' }] };
    expect(await checkQuarantine(quarantine)).toMatchObject({ empty: false });
  });
});
