import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { attachSandbox, createSandbox, finishSandbox } from './github/sandbox.js';

import { fakeGitHub } from './sandbox-fake.js';

// PLAN-13-R5 §2.2, second part: the lock is taken once by the global setup, but every test file
// works with its own harness object, in another scope. So every object attaches to the lock that
// is in GitHub, reads the latest journal from it before each write, and journals everything the
// restoration needs (pull requests it tracked, merges, forged state refs), never only in memory.
// Each file starts from the snapshot (`baseline`), and the final teardown records LIMPIEZA.

const RUN = 'r-7002';
const LOCK = 'refs/ai-workflows-suite/lock';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('attaching to the run of the global setup', () => {
  it('attaches only to the run that holds the lock', async () => {
    const gh = fakeGitHub();
    await createSandbox({ port: gh.port, run: RUN }).acquire();
    const attached = await attachSandbox({ port: gh.port, run: RUN });
    expect(attached.run).toBe(RUN);
    await expect(attachSandbox({ port: gh.port, run: 'r-otra' })).rejects.toThrow(/r-otra|r-7002/);
  });

  it('without a lock there is nothing to attach to', async () => {
    const gh = fakeGitHub();
    await expect(attachSandbox({ port: gh.port, run: RUN })).rejects.toThrow();
  });

  it('two objects of the same run write one after the other without losing entries, and the teardown restores what both did', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const fileA = await attachSandbox({ port: gh.port, run: RUN });
    const fileB = await attachSandbox({ port: gh.port, run: RUN });
    await fileA.setVariable('on');
    await fileB.setWorkflowEnabled('.github/workflows/fronteras.yml', false);
    await fileA.addRequiredStatus('ai-workflows');

    const result = await setup.restore();

    expect(result).toEqual({ ok: true, problems: [] });
    expect(gh.state.variable).toBeUndefined();
    expect(gh.state.workflows.get('.github/workflows/fronteras.yml')).toBe(true);
    expect(gh.state.refs.has(LOCK)).toBe(false);
  });

  it('tracked pull requests and merges are journaled, so another object can restore them', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    const issue = await file.createIssue('pieza');
    gh.openPr(950, `feat/${issue}-x`, RUN);
    await file.trackPullRequest(950, `feat/${issue}-x`);
    gh.mergeByQueue(950);
    await file.noteMerged(950);
    gh.openPr(951, `feat/${issue}-y`, RUN);
    await file.trackPullRequest(951, `feat/${issue}-y`);

    const result = await setup.restore();

    expect(result.problems).toEqual([]);
    expect(gh.state.prs.get(951)?.open).toBe(false);
    expect(gh.state.branches.has(`feat/${issue}-y`)).toBe(false);
    expect(gh.state.trees.get(gh.state.mainHead)).toBe(gh.firstTree);
  });
});

describe('what the suite needs from the harness', () => {
  it('forgeStateRef writes a hand-made journal under refs/ai-workflows, returns its commit and the restoration removes it', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    const sha = await file.forgeStateRef('refs/ai-workflows/pieces/4242', { stage: 'review', outcome: 'passed' });
    expect(gh.state.refs.get('refs/ai-workflows/pieces/4242')).toBe(sha);
    expect(JSON.parse((await gh.port.readCommit(sha))['journal.json'] ?? 'null')).toEqual({ stage: 'review', outcome: 'passed' });
    await file.forgeStateRef('refs/ai-workflows/pieces/4243', 'esto no es un diario');
    expect((await gh.port.readCommit(gh.state.refs.get('refs/ai-workflows/pieces/4243') ?? ''))['journal.json']).toBe('esto no es un diario');

    expect((await setup.restore()).ok).toBe(true);
    expect(gh.state.refs.has('refs/ai-workflows/pieces/4242')).toBe(false);
    expect(gh.state.refs.has('refs/ai-workflows/pieces/4243')).toBe(false);
  });

  it('the engine state refs of the pieces the run created are removed at the end; others are not touched', async () => {
    const gh = fakeGitHub();
    gh.state.refs.set('refs/ai-workflows/pieces/1', 'a'.repeat(40));
    gh.state.stateRefs.add('refs/ai-workflows/pieces/1');
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    const issue = await file.createIssue('pieza del motor');
    // The engine writes the piece's state by itself during the run.
    gh.state.refs.set(`refs/ai-workflows/pieces/${issue}`, 'b'.repeat(40));
    gh.state.stateRefs.add(`refs/ai-workflows/pieces/${issue}`);

    expect((await setup.restore()).ok).toBe(true);
    expect(gh.state.stateRefs.has(`refs/ai-workflows/pieces/${issue}`)).toBe(false);
    expect(gh.state.stateRefs.has('refs/ai-workflows/pieces/1')).toBe(true);
  });

  it('removeRequiredStatus takes out only that status', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    await file.addRequiredStatus('ai-workflows');
    await file.removeRequiredStatus('ai-workflows');
    const rules = gh.state.ruleset['rules'] as { parameters: { required_status_checks: { context: string }[] } }[];
    expect(rules[0]?.parameters.required_status_checks.map((check) => check.context)).toEqual(['candado-cola']);
  });

  it('baseline puts main, the variable, the ruleset and the workflows back to the snapshot and keeps the lock', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    await file.writeMainFiles({ 'x.txt': 'x' }, 'escribe');
    await file.setVariable('on');
    await file.addRequiredStatus('ai-workflows');
    await file.setWorkflowEnabled('.github/workflows/fronteras.yml', false);

    await file.baseline();

    expect(gh.state.trees.get(gh.state.mainHead)).toBe(gh.firstTree);
    expect(gh.state.variable).toBeUndefined();
    const rules = gh.state.ruleset['rules'] as { parameters: { required_status_checks: { context: string }[] } }[];
    expect(rules[0]?.parameters.required_status_checks.map((check) => check.context)).toEqual(['candado-cola']);
    expect(gh.state.workflows.get('.github/workflows/fronteras.yml')).toBe(true);
    expect(gh.state.refs.has(LOCK)).toBe(true);
    expect((await setup.restore()).ok).toBe(true);
  });

  it('writeMainFiles returns the new head of main', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const head = await setup.writeMainFiles({ 'x.txt': 'x' }, 'escribe');
    expect(head).toBe(gh.state.mainHead);
  });
});

describe('the teardown records LIMPIEZA for the report', () => {
  it('a clean restoration records LIMPIEZA passed; a dirty one records it failed and keeps the lock', async () => {
    for (const dirty of [false, true]) {
      const gh = fakeGitHub();
      const dir = mkdtempSync(join(tmpdir(), 'aiw-limpieza-'));
      dirs.push(dir);
      const report = join(dir, 'registro.jsonl');
      const setup = createSandbox({ port: gh.port, run: RUN });
      await setup.acquire();
      await setup.setVariable('on');
      if (dirty) gh.outsider.setVariable('advisory');

      const result = await finishSandbox({ sandbox: setup, repository: 'socialabs-margin/ai-workflows-pruebas', reportFile: report });

      expect(result.ok).toBe(!dirty);
      const record = JSON.parse(readFileSync(report, 'utf8').trim()) as { id: string; run: string; result: string; evidence: string[] };
      expect(record).toMatchObject({ id: 'LIMPIEZA', run: RUN, result: dirty ? 'falló' : 'pasó' });
      expect(record.evidence[0]).toMatch(/^https:\/\/github\.com\/socialabs-margin\/ai-workflows-pruebas\//);
      expect(gh.state.refs.has(LOCK)).toBe(dirty);
    }
  });
});
