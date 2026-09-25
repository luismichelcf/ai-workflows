import { describe, expect, it } from 'vitest';

import { attachSandbox, createSandbox } from './github/sandbox.js';

import { fakeGitHub } from './sandbox-fake.js';

// Review of the flock, part 5 (PLAN-13-R5 §2.2): what the fake GitHub did not say and the real one
// does. Closing a merged pull request or deleting a branch GitHub already deleted fails in `gh`; a
// squash merge leaves "title (#N)" and nothing else; and a read that fails is not an absence.

const RUN = 'r-7003';
const LOCK = 'refs/ai-workflows-suite/lock';

describe('pull requests the run merged', () => {
  it('a merged pull request is not closed again and its branch, already deleted by GitHub, is not an error', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    const issue = await file.createIssue('pieza');
    gh.openPr(960, `feat/${issue}-x`, RUN);
    await file.trackPullRequest(960, `feat/${issue}-x`);
    gh.mergeByQueue(960);
    await file.noteMerged(960);

    const result = await setup.restore();

    expect(result).toEqual({ ok: true, problems: [] });
    expect(gh.state.refs.has(LOCK)).toBe(false);
  });

  it('a squash merge of a tracked pull request, "title (#N)", counts as the run s own', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    gh.openPr(961, 'feat/961-y', RUN);
    await file.trackPullRequest(961, 'feat/961-y');
    gh.mergeByQueue(961, { squash: true });
    await file.noteMerged(961);

    const result = await setup.restore();

    expect(result.problems).toEqual([]);
    expect(gh.state.trees.get(gh.state.mainHead)).toBe(gh.firstTree);
  });

  it('a squash merge of a pull request the run did not track is someone else s', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    gh.openPr(962, 'feat/962-ajeno', 'ajeno');
    gh.mergeByQueue(962, { squash: true });

    const result = await setup.restore();

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('962');
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });

  it('a tracked pull request someone else already closed is accepted as closed, not an error', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    const file = await attachSandbox({ port: gh.port, run: RUN });
    gh.openPr(963, 'feat/963-z', RUN);
    await file.trackPullRequest(963, 'feat/963-z');
    const entry = gh.state.prs.get(963);
    if (entry) entry.open = false;

    const result = await setup.restore();

    expect(result.problems).toEqual([]);
    expect(gh.state.branches.has('feat/963-z')).toBe(false);
  });
});

describe('a read that fails is not an absence', () => {
  it('acquire refuses to take a snapshot when the variable cannot be read, and creates no lock', async () => {
    const gh = fakeGitHub();
    gh.failing.add('variable');
    await expect(createSandbox({ port: gh.port, run: RUN }).acquire()).rejects.toThrow(/502/);
    expect(gh.state.refs.has(LOCK)).toBe(false);
  });

  it('acquire refuses when the inventory cannot be read', async () => {
    const gh = fakeGitHub();
    gh.failing.add('inventory');
    await expect(createSandbox({ port: gh.port, run: RUN }).acquire()).rejects.toThrow(/502/);
    expect(gh.state.refs.has(LOCK)).toBe(false);
  });

  it('a restoration whose final verification cannot read the inventory fails and keeps the lock', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    await setup.setVariable('on');
    gh.failing.add('inventory');

    const result = await setup.restore();

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/502/);
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });

  it('a workflow whose state cannot be read is not turned off by the restoration', async () => {
    const gh = fakeGitHub();
    const setup = createSandbox({ port: gh.port, run: RUN });
    await setup.acquire();
    await setup.setWorkflowEnabled('.github/workflows/fronteras.yml', false);
    await setup.setWorkflowEnabled('.github/workflows/fronteras.yml', true);
    gh.failing.add('workflow');

    const result = await setup.restore();

    expect(result.ok).toBe(false);
    expect(gh.state.workflows.get('.github/workflows/fronteras.yml')).toBe(true);
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });
});
