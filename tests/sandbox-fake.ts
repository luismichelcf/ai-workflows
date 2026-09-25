import type { SandboxPort } from './github/sandbox.js';

// The fake GitHub of the harness tests (PLAN-13-R5 §2.2): GitHub is the harness's external edge.

export interface FakeState {
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

export function fakeGitHub(options: { crashAfter?: string } = {}) {
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
      if (name.startsWith('refs/ai-workflows/')) state.stateRefs.add(name);
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
      state.stateRefs.delete(name);
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

