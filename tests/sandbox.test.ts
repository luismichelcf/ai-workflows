import { describe, expect, it } from 'vitest';

import {
  RULESET_FIELDS,
  createSandbox,
  recoverSandbox,
  type SandboxPort,
  type SandboxState,
} from './github/sandbox.js';

// PLAN-13-R5 §2.2: the harness every real GitHub test goes through. One lock per run that carries
// the snapshot and the journal from its creation; every mutation writes its intention first;
// restoration only puts back what this run wrote last, never someone else's change; the lock is
// released only after a clean verification. GitHub is a fake port here (its external edge); the
// real port is exercised by the real suite.

const RUN = 'r-7001';
const OTHER = 'r-6999';

interface FakeState {
  refs: Map<string, string>;
  commits: Map<string, { files: Record<string, string>; parent?: string }>;
  mainHead: string;
  trees: Map<string, string>; // main commit → tree
  mainLog: { sha: string; tree: string; by: 'harness' | 'merge' | 'someone'; pr?: number; message?: string }[];
  variable?: string;
  ruleset: Record<string, unknown>;
  workflows: Map<string, boolean>;
  branches: Set<string>;
  prs: Map<number, { head: string; open: boolean; merged: boolean; marker?: string }>;
  issues: Map<number, { title: string; open: boolean }>;
  deployments: Map<number, { environment: string; payload: string; state: string }>;
  stateRefs: Set<string>;
  seq: number;
}

function fakeGitHub(options: { crashAfter?: string } = {}) {
  let seq = 100;
  const next = () => `${(seq += 1).toString(16).padStart(40, '0')}`;
  const firstMain = next();
  const firstTree = next();
  const state: FakeState = {
    refs: new Map(),
    commits: new Map(),
    mainHead: firstMain,
    trees: new Map([[firstMain, firstTree]]),
    mainLog: [{ sha: firstMain, tree: firstTree, by: 'someone' }],
    variable: undefined,
    ruleset: {
      id: 7,
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'candado-cola' }] } }],
      bypass_actors: [],
      updated_at: '2026-09-25T10:00:00Z',
      _links: { self: { href: 'x' } },
      node_id: 'RRS_1',
      current_user_can_bypass: 'always',
    },
    workflows: new Map([['.github/workflows/fronteras.yml', true]]),
    branches: new Set(['main']),
    prs: new Map(),
    issues: new Map(),
    deployments: new Map([[1, { environment: 'Production', payload: '', state: 'success' }]]),
    stateRefs: new Set(),
    seq,
  };
  const calls: string[] = [];
  // The process dies once, at the first matching call; what runs after is the recovery.
  let armed = options.crashAfter !== undefined;
  const crash = (label: string) => {
    calls.push(label);
    if (armed && options.crashAfter !== undefined && label.startsWith(options.crashAfter)) {
      armed = false;
      throw new Error(`caída simulada después de ${label}`);
    }
  };
  const port: SandboxPort = {
    async permissions() {
      return { admin: true, appOnlyHere: true };
    },
    async getRef(name) {
      return state.refs.get(name);
    },
    async createRef(name, sha) {
      if (state.refs.has(name)) return 'exists';
      state.refs.set(name, sha);
      crash(`createRef:${name}`);
      return 'created';
    },
    async updateRef(name, sha, expected) {
      if (state.refs.get(name) !== expected) return 'conflict';
      state.refs.set(name, sha);
      crash(`updateRef:${name}`);
      return 'updated';
    },
    async deleteRef(name, expected) {
      if (state.refs.get(name) !== expected) return 'conflict';
      state.refs.delete(name);
      crash(`deleteRef:${name}`);
      return 'deleted';
    },
    async writeCommit(files, parent) {
      const sha = next();
      state.commits.set(sha, { files: { ...files }, ...(parent === undefined ? {} : { parent }) });
      return sha;
    },
    async readCommit(sha) {
      const commit = state.commits.get(sha);
      if (commit === undefined) throw new Error(`no commit ${sha}`);
      return { ...commit.files };
    },
    async main() {
      return { head: state.mainHead, tree: state.trees.get(state.mainHead) ?? '' };
    },
    async mainHistory(since) {
      const index = state.mainLog.findIndex((entry) => entry.sha === since);
      if (index < 0) throw new Error(`${since} is not in main`);
      return state.mainLog.slice(index + 1).map((entry) => ({ sha: entry.sha, message: entry.message ?? '', ...(entry.pr === undefined ? {} : { pr: entry.pr }) }));
    },
    async commitToMain(o) {
      if (o.expectedHead !== state.mainHead) return 'conflict';
      const sha = next();
      const tree = o.tree ?? next();
      state.trees.set(sha, tree);
      state.mainLog.push({ sha, tree, by: 'harness', message: o.message });
      state.mainHead = sha;
      crash(`commitToMain:${o.message}`);
      return { sha, tree };
    },
    async variable() {
      return state.variable;
    },
    async setVariable(value) {
      state.variable = value;
      crash(`setVariable:${value ?? 'none'}`);
    },
    async ruleset() {
      return structuredClone(state.ruleset);
    },
    async putRuleset(body) {
      state.ruleset = { ...structuredClone(body), id: 7, updated_at: new Date(Date.now() + state.seq++).toISOString(), _links: { self: { href: 'y' } }, node_id: 'RRS_1', current_user_can_bypass: 'always' };
      crash('putRuleset');
    },
    async workflowEnabled(path) {
      return state.workflows.get(path) ?? false;
    },
    async setWorkflowEnabled(path, on) {
      state.workflows.set(path, on);
      crash(`setWorkflowEnabled:${path}:${on}`);
    },
    async inventory() {
      return {
        branches: [...state.branches].sort(),
        openPullRequests: [...state.prs].filter(([, pr]) => pr.open).map(([n]) => n).sort(),
        openIssues: [...state.issues].filter(([, issue]) => issue.open).map(([n]) => n).sort(),
        stateRefs: [...state.stateRefs].sort(),
        deployments: [...state.deployments].map(([id, d]) => ({ id, state: d.state })).sort((a, b) => a.id - b.id),
      };
    },
    async createIssue(title) {
      const n = state.issues.size + 500;
      state.issues.set(n, { title, open: true });
      crash(`createIssue:${title}`);
      return n;
    },
    async findIssues(marker) {
      return [...state.issues].filter(([, issue]) => issue.title.includes(marker)).map(([n]) => n);
    },
    async closeIssue(n) {
      const issue = state.issues.get(n);
      if (issue) issue.open = false;
    },
    async createDeployment(o) {
      const id = state.deployments.size + 10;
      state.deployments.set(id, { environment: o.environment, payload: o.payload, state: 'success' });
      calls.push(`createDeployment:autoInactive=${String(o.autoInactive)}`);
      crash(`createDeployment:${o.payload}`);
      return id;
    },
    async findDeployments(marker) {
      return [...state.deployments].filter(([, d]) => d.payload.includes(marker)).map(([id]) => id);
    },
    async deactivateDeployment(id) {
      const d = state.deployments.get(id);
      if (d) d.state = 'inactive';
      calls.push(`deactivate:${id}`);
    },
    async deleteDeployment(id) {
      const d = state.deployments.get(id);
      if (d?.state !== 'inactive') throw new Error(`deployment ${id} is still active`);
      state.deployments.delete(id);
    },
    async closePullRequest(n) {
      const pr = state.prs.get(n);
      if (pr) pr.open = false;
    },
    async deleteBranch(name) {
      state.branches.delete(name);
    },
    async findPullRequests(marker) {
      return [...state.prs].filter(([, pr]) => pr.marker?.includes(marker)).map(([n]) => n);
    },
  };
  /** Someone else, outside the run, changes a resource while it lasts. */
  const outsider = {
    setVariable(value: string) {
      state.variable = value;
    },
    pushToMain() {
      const sha = next();
      const tree = next();
      state.trees.set(sha, tree);
      state.mainLog.push({ sha, tree, by: 'someone' });
      state.mainHead = sha;
    },
  };
  /** A pull request of the run merged by the queue. */
  const mergeByQueue = (pr: number) => {
    const sha = next();
    const tree = next();
    state.trees.set(sha, tree);
    state.mainLog.push({ sha, tree, by: 'merge', pr });
    state.mainHead = sha;
    const entry = state.prs.get(pr);
    if (entry) {
      entry.open = false;
      entry.merged = true;
    }
  };
  const openPr = (n: number, branch: string, marker: string) => {
    state.branches.add(branch);
    state.prs.set(n, { head: next(), open: true, merged: false, marker });
  };
  return { port, state, calls, outsider, mergeByQueue, openPr, firstTree };
}

const LOCK = 'refs/ai-workflows-suite/lock';

describe('the lock carries the snapshot and the journal from its creation', () => {
  it('acquire writes one ref whose commit holds the run, the snapshot and an empty journal', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    const sha = gh.state.refs.get(LOCK);
    expect(sha).toBeDefined();
    const files = await gh.port.readCommit(sha ?? '');
    const lock = JSON.parse(files['lock.json'] ?? '{}') as SandboxState;
    expect(lock.run).toBe(RUN);
    expect(lock.snapshot.main.tree).toBe(gh.firstTree);
    expect(lock.snapshot.variable).toBeUndefined();
    expect(lock.snapshot.deployments).toEqual([{ id: 1, state: 'success' }]);
    expect(lock.journal).toEqual([]);
    expect([...gh.state.refs.keys()]).toEqual([LOCK]);
  });

  it('an existing lock is never taken: the run does not start and says whose and since when', async () => {
    const gh = fakeGitHub();
    await createSandbox({ port: gh.port, run: OTHER }).acquire();
    await expect(createSandbox({ port: gh.port, run: RUN }).acquire()).rejects.toThrow(new RegExp(OTHER));
    expect(gh.calls.filter((call) => call.startsWith('createRef'))).toHaveLength(1);
  });

  it('refuses to start without admin on the test repository or with the agents app installed elsewhere (R22)', async () => {
    for (const permissions of [{ admin: false, appOnlyHere: true }, { admin: true, appOnlyHere: false }]) {
      const gh = fakeGitHub();
      gh.port.permissions = async () => permissions;
      await expect(createSandbox({ port: gh.port, run: RUN }).acquire()).rejects.toThrow();
      expect(gh.state.refs.size).toBe(0);
    }
  });

  it('every journal write moves the lock by comparison of its previous SHA; a lock moved by someone stops the run', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    gh.state.refs.set(LOCK, 'f'.repeat(40));
    await expect(sandbox.setVariable('on')).rejects.toThrow(/lock|candado/i);
    expect(gh.state.variable).toBeUndefined();
  });
});

describe('mutations: intention first, done after, additive protection', () => {
  it('adds a required status without replacing the ones already required', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await sandbox.addRequiredStatus('ai-workflows');
    const rules = gh.state.ruleset['rules'] as { type: string; parameters: { required_status_checks: { context: string }[] } }[];
    expect(rules[0]?.parameters.required_status_checks.map((check) => check.context)).toEqual(['candado-cola', 'ai-workflows']);
  });

  it('writes the intention before the effect and marks it done after', async () => {
    const gh = fakeGitHub({ crashAfter: 'setVariable:on' });
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await expect(sandbox.setVariable('on')).rejects.toThrow(/caída simulada/);
    const lock = JSON.parse((await gh.port.readCommit(gh.state.refs.get(LOCK) ?? ''))['lock.json'] ?? '{}') as SandboxState;
    expect(lock.journal).toEqual([expect.objectContaining({ resource: 'variable', before: null, after: 'on', done: false })]);
  });

  it('every deployment it creates keeps the others active (auto_inactive false) and carries the run marker', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await sandbox.createDeployment({ sha: 'a'.repeat(40), environment: 'Production', url: 'https://x.example.com' });
    expect(gh.calls).toContain('createDeployment:autoInactive=false');
    expect([...gh.state.deployments.values()].at(-1)?.payload).toContain(RUN);
  });
});

describe('restoration puts back only what this run wrote last', () => {
  it('a clean run: variable, ruleset (by its configurable fields), workflows, main tree and deployments come back; the lock is released', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    const rulesetBefore = await gh.port.ruleset();
    await sandbox.setVariable('on');
    await sandbox.addRequiredStatus('ai-workflows');
    await sandbox.setWorkflowEnabled('.github/workflows/fronteras.yml', false);
    await sandbox.writeMainFiles({ '.github/workflows/ai-workflows.yml': 'juez' }, 'se instala el juez');
    const issue = await sandbox.createIssue('pieza de prueba');
    gh.openPr(900, `feat/${issue}-x`, RUN);
    sandbox.trackPullRequest(900, `feat/${issue}-x`);
    gh.mergeByQueue(900);
    sandbox.noteMerged(900);
    await sandbox.createDeployment({ sha: 'b'.repeat(40), environment: 'Production', url: 'https://x.example.com' });

    const result = await sandbox.restore();

    expect(result).toEqual({ ok: true, problems: [] });
    expect(gh.state.variable).toBeUndefined();
    const pick = (body: Record<string, unknown>) => Object.fromEntries(RULESET_FIELDS.map((field) => [field, body[field]]));
    expect(pick(await gh.port.ruleset())).toEqual(pick(rulesetBefore));
    expect(gh.state.workflows.get('.github/workflows/fronteras.yml')).toBe(true);
    expect(gh.state.trees.get(gh.state.mainHead)).toBe(gh.firstTree);
    expect(gh.state.deployments.get(1)).toEqual({ environment: 'Production', payload: '', state: 'success' });
    expect([...gh.state.deployments.keys()]).toEqual([1]);
    expect(gh.state.issues.get(issue)?.open).toBe(false);
    expect(gh.state.refs.has(LOCK)).toBe(false);
  });

  it('RULESET_FIELDS are the configurable ones', () => {
    expect([...RULESET_FIELDS].sort()).toEqual(['bypass_actors', 'conditions', 'enforcement', 'name', 'rules', 'target']);
  });

  it('a variable changed by someone during the run is not overwritten; the run fails naming it; lock and snapshot stay', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await sandbox.setVariable('on');
    gh.outsider.setVariable('advisory');
    const result = await sandbox.restore();
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/AI_WORKFLOWS_MODE|variable/);
    expect(result.problems.join('\n')).toContain('advisory');
    expect(gh.state.variable).toBe('advisory');
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });

  it('a push to main by someone else during the run stops the restoration of main', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await sandbox.writeMainFiles({ 'x.txt': 'x' }, 'escribe');
    gh.outsider.pushToMain();
    const head = gh.state.mainHead;
    const result = await sandbox.restore();
    expect(result.ok).toBe(false);
    expect(gh.state.mainHead).toBe(head);
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });

  it('a merge of a pull request the run did not open counts as someone else', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    gh.openPr(901, 'feat/1-ajeno', 'ajeno');
    gh.mergeByQueue(901);
    const result = await sandbox.restore();
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('901');
  });

  it('a leftover open pull request, branch or state ref of the run fails the verification', async () => {
    const gh = fakeGitHub();
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    gh.state.stateRefs.add(`refs/ai-workflows/pieces/${RUN}`);
    const result = await sandbox.restore();
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(`refs/ai-workflows/pieces/${RUN}`);
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });
});

describe('recovery of an abandoned run', () => {
  // Prefixes of the fake's labels: the harness puts its own marker in titles and messages.
  const crashes = ['createRef:' + LOCK, 'setVariable:on', 'putRuleset', 'createIssue:', 'commitToMain:'];

  for (const label of crashes) {
    it(`after a crash at ${label}, recovery ends in the snapshot or stops naming the conflict, and only then releases`, async () => {
      const gh = fakeGitHub({ crashAfter: label });
      const sandbox = createSandbox({ port: gh.port, run: RUN });
      try {
        await sandbox.acquire();
        await sandbox.setVariable('on');
        await sandbox.addRequiredStatus('ai-workflows');
        await sandbox.createIssue(`pieza ${RUN}`);
        await sandbox.writeMainFiles({ 'x.txt': 'x' }, 'escribe');
      } catch {
        // The process "died" here.
      }
      const recovered = await recoverSandbox({ port: gh.port });
      expect(recovered.ok, recovered.problems.join('\n')).toBe(true);
      expect(gh.state.variable).toBeUndefined();
      expect([...gh.state.issues.values()].every((issue) => !issue.open)).toBe(true);
      expect(gh.state.trees.get(gh.state.mainHead)).toBe(gh.firstTree);
      expect(gh.state.refs.has(LOCK)).toBe(false);
    });
  }

  it('two issues with the marker of one intention is a conflict: recovery stops and keeps the lock', async () => {
    const gh = fakeGitHub({ crashAfter: 'createIssue:' });
    const sandbox = createSandbox({ port: gh.port, run: RUN });
    await sandbox.acquire();
    await sandbox.createIssue(`pieza ${RUN}`).catch(() => undefined);
    const marker = [...gh.state.issues.values()][0]?.title ?? '';
    await gh.port.createIssue(marker, '').catch(() => undefined);
    const recovered = await recoverSandbox({ port: gh.port });
    expect(recovered.ok).toBe(false);
    expect(gh.state.refs.has(LOCK)).toBe(true);
  });

  it('without a lock there is nothing to recover, and it says so', async () => {
    const gh = fakeGitHub();
    const recovered = await recoverSandbox({ port: gh.port });
    expect(recovered).toEqual({ ok: true, problems: [], note: expect.stringMatching(/no hay|nothing/i) });
  });
});
