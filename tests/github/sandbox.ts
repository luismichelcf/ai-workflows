import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import type { CaseRecord } from './report.js';

// PLAN-13-R5 §2.2: the harness every real GitHub test goes through. One run, one lock, one
// snapshot kept in GitHub. The lock (`refs/ai-workflows-suite/lock`) points, from its creation,
// at a commit whose tree carries the run, the time, the whole snapshot and the journal. Every
// mutation writes its intention first and marks it done after. Restoration puts back only what
// this run wrote last; a resource somebody else changed is reported, never overwritten. The lock
// is released only after a clean final verification. `recoverSandbox` is the only way to release
// somebody else's lock: the orchestrator runs it on purpose.
//
// This module has no dependency on the engine: it is a test tool. The real port (`gh`) lives at
// the end; the false port of `tests/sandbox.test.ts` is the contract of this interface.

export const LOCK_REF = 'refs/ai-workflows-suite/lock';

/** The fields of a ruleset a person configures; the rest is managed by GitHub and never counts. */
export const RULESET_FIELDS = ['name', 'target', 'enforcement', 'conditions', 'rules', 'bypass_actors'] as const;

export interface SandboxPermissions {
  admin: boolean;
  appOnlyHere: boolean;
}

export interface SandboxInventory {
  branches: string[];
  openPullRequests: number[];
  openIssues: number[];
  stateRefs: string[];
  deployments: { id: number; state: string }[];
}

export interface SandboxJournalEntry {
  op: string;
  resource: string;
  before: unknown;
  after: unknown;
  marker?: string;
  path?: string;
  done: boolean;
}

export interface SandboxSnapshot {
  main: { head: string; tree: string };
  variable?: string;
  ruleset: Record<string, unknown>;
  workflows: Record<string, boolean>;
  branches: string[];
  openPullRequests: number[];
  openIssues: number[];
  stateRefs: string[];
  deployments: { id: number; state: string }[];
}

export interface SandboxState {
  run: string;
  startedAt: string;
  snapshot: SandboxSnapshot;
  journal: SandboxJournalEntry[];
}

/** The external edge of the harness: GitHub. Implemented by the fake of the test and by `gh`. */
export interface SandboxPort {
  permissions(): Promise<SandboxPermissions>;
  getRef(name: string): Promise<string | undefined>;
  createRef(name: string, sha: string): Promise<'created' | 'exists'>;
  updateRef(name: string, sha: string, expected: string): Promise<'updated' | 'conflict'>;
  deleteRef(name: string, expected: string): Promise<'deleted' | 'conflict'>;
  writeCommit(files: Record<string, string>, parent?: string): Promise<string>;
  readCommit(sha: string): Promise<Record<string, string>>;
  main(): Promise<{ head: string; tree: string }>;
  mainHistory(since: string): Promise<{ sha: string; message: string; pr?: number }[]>;
  commitToMain(o: { expectedHead: string; tree?: string; message: string }): Promise<'conflict' | { sha: string; tree: string }>;
  variable(): Promise<string | undefined>;
  setVariable(value: string | undefined): Promise<void>;
  ruleset(): Promise<Record<string, unknown>>;
  putRuleset(body: Record<string, unknown>): Promise<void>;
  workflowEnabled(path: string): Promise<boolean>;
  setWorkflowEnabled(path: string, on: boolean): Promise<void>;
  inventory(): Promise<SandboxInventory>;
  createIssue(title: string, body?: string): Promise<number>;
  findIssues(marker: string): Promise<number[]>;
  closeIssue(n: number): Promise<void>;
  createDeployment(o: { sha: string; environment: string; url: string; payload: string; autoInactive: boolean }): Promise<number>;
  findDeployments(marker: string): Promise<number[]>;
  deactivateDeployment(id: number): Promise<void>;
  deleteDeployment(id: number): Promise<void>;
  closePullRequest(n: number): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  findPullRequests(marker: string): Promise<number[]>;
}

export interface Sandbox {
  /** The run this object belongs to; every attached object holds the same one. */
  readonly run: string;
  acquire(): Promise<void>;
  restore(): Promise<{ ok: boolean; problems: string[] }>;
  /** Puts the snapshot back without verifying and without releasing the lock, for the next file. */
  baseline(): Promise<void>;
  setVariable(value: string): Promise<void>;
  addRequiredStatus(context: string): Promise<void>;
  removeRequiredStatus(context: string): Promise<void>;
  setWorkflowEnabled(path: string, on: boolean): Promise<void>;
  /** Writes files to `main` and returns the new head of `main`. */
  writeMainFiles(files: Record<string, string>, message: string): Promise<string>;
  createIssue(title: string): Promise<number>;
  createBranch(name: string, sha: string): Promise<void>;
  createDeployment(o: { sha: string; environment: string; url: string }): Promise<number>;
  trackPullRequest(number: number, branch: string): Promise<void>;
  noteMerged(number: number): Promise<void>;
  /** Forges a piece-state ref: `journal.json` holds the object's JSON or the text as it comes. */
  forgeStateRef(ref: string, content: Record<string, unknown> | string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The configurable projection of a ruleset: what a person sets, never what GitHub manages. */
function pickRuleset(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  const picked: Record<string, unknown> = {};
  for (const field of RULESET_FIELDS) picked[field] = record[field];
  return picked;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortValue(a)) === JSON.stringify(sortValue(b));
}

function show(value: unknown): string {
  return value === undefined ? 'nada' : JSON.stringify(value);
}

function lastEntry(
  state: SandboxState,
  resource: string,
  predicate?: (entry: SandboxJournalEntry) => boolean,
): SandboxJournalEntry | undefined {
  for (let index = state.journal.length - 1; index >= 0; index -= 1) {
    const entry = state.journal[index];
    if (entry === undefined || entry.resource !== resource || !entry.done) continue;
    if (predicate === undefined || predicate(entry)) return entry;
  }
  return undefined;
}

function trackedPullRequests(state: SandboxState): { number: number; branch: string }[] {
  const tracked: { number: number; branch: string }[] = [];
  for (const entry of state.journal) {
    if (entry.resource !== 'pull-request' || !entry.done || typeof entry.after !== 'number') continue;
    tracked.push({ number: entry.after, branch: entry.path ?? '' });
  }
  return tracked;
}

function isMerged(state: SandboxState, number: number): boolean {
  return state.journal.some(
    (entry) => entry.resource === 'pull-request' && entry.after === number && entry.op === 'merged',
  );
}

async function readLock(port: SandboxPort, sha: string): Promise<SandboxState> {
  const files = await port.readCommit(sha);
  const raw = files['lock.json'];
  if (raw === undefined) throw new Error(`el candado ${sha} no lleva lock.json`);
  return JSON.parse(raw) as SandboxState;
}

async function persistLock(port: SandboxPort, state: SandboxState, previous: string): Promise<string> {
  const commit = await port.writeCommit({ 'lock.json': JSON.stringify(state, null, 2) });
  const result = await port.updateRef(LOCK_REF, commit, previous);
  if (result === 'conflict') throw new Error('el candado de la suite fue movido por otra corrida');
  return commit;
}

function addRequiredStatusTo(body: Record<string, unknown>, context: string): Record<string, unknown> {
  const rules = Array.isArray(body['rules']) ? [...body['rules']] : [];
  let found = false;
  const next = rules.map((rule) => {
    if (!isRecord(rule) || rule['type'] !== 'required_status_checks') return rule;
    found = true;
    const parameters = isRecord(rule['parameters']) ? rule['parameters'] : {};
    const checks = Array.isArray(parameters['required_status_checks']) ? [...parameters['required_status_checks']] : [];
    checks.push({ context });
    return { ...rule, parameters: { ...parameters, required_status_checks: checks } };
  });
  if (!found) next.push({ type: 'required_status_checks', parameters: { required_status_checks: [{ context }] } });
  return { ...body, rules: next };
}

function removeRequiredStatusFrom(body: Record<string, unknown>, context: string): Record<string, unknown> {
  const rules = Array.isArray(body['rules']) ? [...body['rules']] : [];
  const next = rules.map((rule) => {
    if (!isRecord(rule) || rule['type'] !== 'required_status_checks') return rule;
    const parameters = isRecord(rule['parameters']) ? rule['parameters'] : {};
    const checks = Array.isArray(parameters['required_status_checks']) ? [...parameters['required_status_checks']] : [];
    return {
      ...rule,
      parameters: { ...parameters, required_status_checks: checks.filter((check) => !isRecord(check) || check['context'] !== context) },
    };
  });
  return { ...body, rules: next };
}

/**
 * Reconciles every intention without its `done` against GitHub: the new value means it happened,
 * the old one means it did not, anything else is a conflict that stops the recovery.
 */
async function performReconcile(port: SandboxPort, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  for (let index = 0; index < state.journal.length; index += 1) {
    const entry = state.journal[index];
    if (entry === undefined || entry.done) continue;
    const remove = () => {
      state.journal.splice(index, 1);
      index -= 1;
    };
    if (entry.resource === 'variable') {
      const remote = (await port.variable()) ?? null;
      if (sameValue(remote, entry.after ?? null)) entry.done = true;
      else if (sameValue(remote, entry.before ?? null)) remove();
      else problems.push(`variable AI_WORKFLOWS_MODE: no se pudo conciliar (la foto tenía ${show(entry.before)}, se iba a dejar ${show(entry.after)}, ahora vale ${show(remote)})`);
      continue;
    }
    if (entry.resource === 'ruleset') {
      const remote = pickRuleset(await port.ruleset());
      if (sameValue(remote, pickRuleset(entry.after))) entry.done = true;
      else if (sameValue(remote, pickRuleset(entry.before))) remove();
      else problems.push('ruleset: no se pudo conciliar la intención con el estado remoto');
      continue;
    }
    if (entry.resource === 'workflow') {
      const remote = await port.workflowEnabled(entry.path ?? '');
      if (remote === entry.after) entry.done = true;
      else if (remote === entry.before) remove();
      else problems.push(`workflow ${entry.path ?? ''}: no se pudo conciliar la intención con el estado remoto`);
      continue;
    }
    if (entry.resource === 'main') {
      const since = typeof entry.before === 'string' ? entry.before : '';
      const history = await port.mainHistory(since);
      const match = history.find((commit) => entry.marker !== undefined && commit.message.includes(entry.marker));
      if (match !== undefined) {
        entry.done = true;
        entry.after = match.sha;
      } else if (history.length === 0) remove();
      else problems.push('main: hay commits que no son de esta corrida entre la foto y la cabeza');
      continue;
    }
    if (entry.resource === 'issue' || entry.resource === 'deployment') {
      const found = entry.resource === 'issue'
        ? await port.findIssues(entry.marker ?? '')
        : await port.findDeployments(entry.marker ?? '');
      if (found.length === 1) {
        entry.done = true;
        entry.after = found[0];
      } else if (found.length === 0) remove();
      else problems.push(`${entry.resource}: ${found.length} recursos llevan la marca ${entry.marker ?? ''} de una sola intención`);
      continue;
    }
    if (entry.resource === 'branch') {
      const remote = await port.getRef(`refs/heads/${entry.path ?? ''}`);
      if (remote === entry.after) entry.done = true;
      else if (remote === undefined) remove();
      else problems.push(`rama ${entry.path ?? ''}: no se pudo conciliar la intención con el estado remoto`);
      continue;
    }
  }
  return problems;
}

async function restoreMain(port: SandboxPort, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = state.snapshot;
  const current = await port.main();
  const history = await port.mainHistory(snapshot.main.head);
  let changed = false;
  for (const commit of history) {
    if (commit.pr !== undefined) {
      if (isMerged(state, commit.pr)) changed = true;
      else problems.push(`main: la fusión del pull request ${commit.pr} no la registró esta corrida`);
      continue;
    }
    if (commit.message.includes(state.run)) changed = true;
    else problems.push(`main: hay un commit ajeno (${commit.sha.slice(0, 12)}) entre la foto y la cabeza`);
  }
  if (problems.length > 0) return problems;
  if (changed) {
    const result = await port.commitToMain({
      expectedHead: current.head,
      tree: snapshot.main.tree,
      message: `la suite ${state.run} repone la foto de main`,
    });
    if (result === 'conflict') problems.push('main: se movió mientras la suite reponía la foto');
  }
  return problems;
}

function compareArray(label: string, current: readonly unknown[], snapshot: readonly unknown[], problems: string[]): void {
  if (!sameValue(current, snapshot)) {
    problems.push(`${label}: la foto tenía ${show(snapshot)} y ahora hay ${show(current)}`);
  }
}

async function verifyAgainstSnapshot(port: SandboxPort, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = state.snapshot;
  const inventory = await port.inventory();
  compareArray('ramas', inventory.branches, snapshot.branches, problems);
  compareArray('pull requests abiertos', inventory.openPullRequests, snapshot.openPullRequests, problems);
  compareArray('issues abiertos', inventory.openIssues, snapshot.openIssues, problems);
  compareArray('referencias de estado', inventory.stateRefs.filter((ref) => ref !== LOCK_REF), snapshot.stateRefs, problems);
  compareArray('despliegues', inventory.deployments, snapshot.deployments, problems);
  const main = await port.main();
  if (main.tree !== snapshot.main.tree) problems.push('main: el árbol no volvió al de la foto');
  const variable = await port.variable();
  if (variable !== snapshot.variable) problems.push(`variable AI_WORKFLOWS_MODE: la foto tenía ${show(snapshot.variable)} y vale ${show(variable)}`);
  if (!sameValue(pickRuleset(await port.ruleset()), pickRuleset(snapshot.ruleset))) problems.push('ruleset: no volvió al de la foto');
  for (const path of Object.keys(snapshot.workflows)) {
    if ((await port.workflowEnabled(path)) !== snapshot.workflows[path]) problems.push(`workflow ${path}: no volvió al de la foto`);
  }
  return problems;
}

/**
 * A restoration write may be interrupted after the effect landed but before the answer arrived.
 * Re-read to know what really happened: if the snapshot value is already there, the write is
 * good; otherwise the failure is reported, never swallowed.
 */
async function restoreWrite(
  problems: string[],
  label: string,
  write: () => Promise<void>,
  confirm: () => Promise<boolean>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (await confirm()) return;
    problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Puts back only what this run wrote last, then verifies everything against the snapshot. Never
 * overwrites a change made by somebody else: it reports it instead. Never swallows an error.
 */
async function performRestore(port: SandboxPort, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = state.snapshot;

  const variableEntry = lastEntry(state, 'variable');
  if (variableEntry !== undefined) {
    const remote = await port.variable();
    if (sameValue(remote, variableEntry.after)) {
      await restoreWrite(
        problems,
        'variable AI_WORKFLOWS_MODE',
        () => port.setVariable(snapshot.variable),
        async () => sameValue(await port.variable(), snapshot.variable),
      );
    } else if (!sameValue(remote, snapshot.variable)) {
      problems.push(`variable AI_WORKFLOWS_MODE: la foto tenía ${show(snapshot.variable)}, la corrida escribió ${show(variableEntry.after)} y ahora vale ${show(remote)}`);
    }
  }

  const rulesetEntry = lastEntry(state, 'ruleset');
  if (rulesetEntry !== undefined) {
    const remote = pickRuleset(await port.ruleset());
    if (sameValue(remote, pickRuleset(rulesetEntry.after))) {
      await restoreWrite(
        problems,
        'ruleset',
        () => port.putRuleset(pickRuleset(snapshot.ruleset)),
        async () => sameValue(pickRuleset(await port.ruleset()), pickRuleset(snapshot.ruleset)),
      );
    } else if (!sameValue(remote, pickRuleset(snapshot.ruleset))) {
      problems.push('ruleset: la corrida lo cambió y ahora no coincide con lo último que escribió');
    }
  }

  for (const path of Object.keys(snapshot.workflows)) {
    const entry = lastEntry(state, 'workflow', (candidate) => candidate.path === path);
    if (entry === undefined) continue;
    const remote = await port.workflowEnabled(path);
    if (remote === entry.after) {
      await restoreWrite(
        problems,
        `workflow ${path}`,
        () => port.setWorkflowEnabled(path, snapshot.workflows[path] === true),
        async () => (await port.workflowEnabled(path)) === snapshot.workflows[path],
      );
    } else if (remote !== snapshot.workflows[path]) problems.push(`workflow ${path}: no coincide con lo último que escribió la corrida`);
  }

  problems.push(...(await restoreMain(port, state)));

  for (const entry of state.journal) {
    if (entry.resource === 'issue' && entry.done && typeof entry.after === 'number') await port.closeIssue(entry.after);
  }

  for (const entry of state.journal) {
    if (entry.resource === 'deployment' && entry.done && typeof entry.after === 'number') {
      await port.deactivateDeployment(entry.after);
      await port.deleteDeployment(entry.after);
    }
  }

  for (const entry of state.journal) {
    if (entry.resource !== 'branch' || !entry.done || entry.path === undefined) continue;
    const current = await port.getRef(`refs/heads/${entry.path}`);
    if (current === entry.after) await port.deleteBranch(entry.path);
    else if (current !== undefined) problems.push(`rama ${entry.path}: no coincide con lo último que escribió la corrida`);
  }

  for (const tracked of trackedPullRequests(state)) {
    await port.closePullRequest(tracked.number);
    await port.deleteBranch(tracked.branch);
  }

  for (const entry of state.journal) {
    if (entry.resource !== 'state-ref' || !entry.done || entry.path === undefined) continue;
    const current = await port.getRef(entry.path);
    if (typeof entry.after === 'string' && current === entry.after) {
      const deleted = await port.deleteRef(entry.path, entry.after);
      if (deleted === 'conflict') problems.push(`referencia de estado ${entry.path}: no se pudo borrar`);
    } else if (current !== undefined) {
      problems.push(`referencia de estado ${entry.path}: no coincide con lo último que escribió la corrida`);
    }
  }

  for (const entry of state.journal) {
    if (entry.resource !== 'issue' || !entry.done || typeof entry.after !== 'number') continue;
    const ref = `refs/ai-workflows/pieces/${entry.after}`;
    const current = await port.getRef(ref);
    if (current !== undefined) {
      const deleted = await port.deleteRef(ref, current);
      if (deleted === 'conflict') problems.push(`referencia de estado ${ref}: no se pudo borrar`);
    }
  }

  problems.push(...(await verifyAgainstSnapshot(port, state)));
  return problems;
}

/**
 * Puts back what this run wrote last (variable, ruleset, workflows, `main`) without verifying and
 * without releasing the lock: each test file starts from the snapshot while the journal survives.
 */
async function performBaseline(port: SandboxPort, state: SandboxState): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = state.snapshot;

  const variableEntry = lastEntry(state, 'variable');
  if (variableEntry !== undefined) {
    const remote = await port.variable();
    if (sameValue(remote, variableEntry.after) && !sameValue(remote, snapshot.variable)) {
      await restoreWrite(
        problems,
        'variable AI_WORKFLOWS_MODE',
        () => port.setVariable(snapshot.variable),
        async () => sameValue(await port.variable(), snapshot.variable),
      );
    }
  }

  const rulesetEntry = lastEntry(state, 'ruleset');
  if (rulesetEntry !== undefined) {
    const remote = pickRuleset(await port.ruleset());
    if (sameValue(remote, pickRuleset(rulesetEntry.after)) && !sameValue(remote, pickRuleset(snapshot.ruleset))) {
      await restoreWrite(
        problems,
        'ruleset',
        () => port.putRuleset(pickRuleset(snapshot.ruleset)),
        async () => sameValue(pickRuleset(await port.ruleset()), pickRuleset(snapshot.ruleset)),
      );
    }
  }

  for (const path of Object.keys(snapshot.workflows)) {
    const entry = lastEntry(state, 'workflow', (candidate) => candidate.path === path);
    if (entry === undefined) continue;
    const remote = await port.workflowEnabled(path);
    if (remote === entry.after && remote !== snapshot.workflows[path]) {
      await restoreWrite(
        problems,
        `workflow ${path}`,
        () => port.setWorkflowEnabled(path, snapshot.workflows[path] === true),
        async () => (await port.workflowEnabled(path)) === snapshot.workflows[path],
      );
    }
  }

  problems.push(...(await restoreMain(port, state)));
  return problems;
}

function emptySnapshot(): SandboxSnapshot {
  return {
    main: { head: '', tree: '' },
    ruleset: {},
    workflows: {},
    branches: [],
    openPullRequests: [],
    openIssues: [],
    stateRefs: [],
    deployments: [],
  };
}

function makeSandbox(port: SandboxPort, run: string): { sandbox: Sandbox; adopt: (lockSha: string, state: SandboxState) => void } {
  let lockSha: string | undefined;
  let opCount = 0;
  let state: SandboxState = {
    run,
    startedAt: new Date().toISOString(),
    snapshot: emptySnapshot(),
    journal: [],
  };
  let queue: Promise<unknown> = Promise.resolve();

  // Every write waits its turn inside one object, so a file that does not await a journal write
  // still sees it before the next one: track, merge and restore land in order on the lock.
  const serialize = function <T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const nextMarker = (kind: string): string => `${run}:${kind}:${(opCount += 1)}`;

  // Reads the lock that is in GitHub before every write: another object of the run may have moved
  // it, and its journal is the only truth. A lock of another run, or an unreadable one, stops here.
  const refresh = async (): Promise<void> => {
    const sha = await port.getRef(LOCK_REF);
    if (sha === undefined) throw new Error('el candado de la suite no está puesto');
    let remote: SandboxState;
    try {
      remote = await readLock(port, sha);
    } catch {
      throw new Error('el candado de la suite no se pudo leer: lo movió otra corrida');
    }
    if (remote.run !== run) throw new Error(`el candado de la suite es de la corrida ${remote.run}, no de ${run}`);
    state = remote;
    lockSha = sha;
  };

  const persist = async (): Promise<void> => {
    if (lockSha === undefined) throw new Error('el candado de la suite todavía no se tomó');
    lockSha = await persistLock(port, state, lockSha);
  };

  const addIntention = async (entry: Omit<SandboxJournalEntry, 'done'>): Promise<number> => {
    state.journal.push({ ...entry, done: false });
    await persist();
    return state.journal.length - 1;
  };

  const markDone = async (index: number, after?: unknown): Promise<void> => {
    const entry = state.journal[index];
    if (entry === undefined) return;
    entry.done = true;
    if (after !== undefined) entry.after = after;
    await persist();
  };

  const findTracked = (number: number): SandboxJournalEntry | undefined =>
    state.journal.find((entry) => entry.resource === 'pull-request' && entry.after === number && entry.op === 'tracked');

  const sandbox: Sandbox = {
    run,
    async acquire(): Promise<void> {
      const permissions = await port.permissions();
      if (!permissions.admin || !permissions.appOnlyHere) {
        throw new Error(
          `el repositorio de ensayo no admite la corrida: se necesita administración y la aplicación de los agentes instalada solo aquí (R22)`,
        );
      }
      const existing = await port.getRef(LOCK_REF);
      if (existing !== undefined) {
        const lock = await readLock(port, existing);
        throw new Error(`el candado ya lo tiene la corrida ${lock.run} desde ${lock.startedAt}`);
      }
      const main = await port.main();
      const variable = await port.variable();
      const ruleset = await port.ruleset();
      const inventory = await port.inventory();
      state.snapshot = {
        main: { head: main.head, tree: main.tree },
        ...(variable === undefined ? {} : { variable }),
        ruleset,
        workflows: {},
        branches: inventory.branches,
        openPullRequests: inventory.openPullRequests,
        openIssues: inventory.openIssues,
        stateRefs: inventory.stateRefs,
        deployments: inventory.deployments,
      };
      state.journal = [];
      const commit = await port.writeCommit({ 'lock.json': JSON.stringify(state, null, 2) });
      const created = await port.createRef(LOCK_REF, commit);
      if (created === 'exists') {
        const sha = (await port.getRef(LOCK_REF)) ?? commit;
        const lock = await readLock(port, sha);
        throw new Error(`el candado ya lo tiene la corrida ${lock.run} desde ${lock.startedAt}`);
      }
      lockSha = commit;
    },

    async restore(): Promise<{ ok: boolean; problems: string[] }> {
      return serialize(async () => {
        await refresh();
        const problems = await performRestore(port, state);
        if (problems.length > 0) return { ok: false, problems };
        const deleted = await port.deleteRef(LOCK_REF, lockSha ?? '');
        if (deleted === 'conflict') return { ok: false, problems: ['candado: se movió antes de soltarlo'] };
        lockSha = undefined;
        return { ok: true, problems: [] };
      });
    },

    async baseline(): Promise<void> {
      await serialize(async () => {
        await refresh();
        await performBaseline(port, state);
      });
    },

    async setVariable(value: string): Promise<void> {
      await serialize(async () => {
        await refresh();
        const before = (await port.variable()) ?? null;
        const index = await addIntention({ op: 'set-variable', resource: 'variable', before, after: value });
        await port.setVariable(value);
        await markDone(index, value);
      });
    },

    async addRequiredStatus(context: string): Promise<void> {
      await serialize(async () => {
        await refresh();
        const before = await port.ruleset();
        const next = addRequiredStatusTo(before, context);
        const index = await addIntention({ op: 'add-required-status', resource: 'ruleset', before, after: pickRuleset(next) });
        await port.putRuleset(pickRuleset(next));
        await markDone(index);
      });
    },

    async removeRequiredStatus(context: string): Promise<void> {
      await serialize(async () => {
        await refresh();
        const before = await port.ruleset();
        const next = removeRequiredStatusFrom(before, context);
        const index = await addIntention({ op: 'remove-required-status', resource: 'ruleset', before, after: pickRuleset(next) });
        await port.putRuleset(pickRuleset(next));
        await markDone(index);
      });
    },

    async setWorkflowEnabled(path: string, on: boolean): Promise<void> {
      await serialize(async () => {
        await refresh();
        const before = await port.workflowEnabled(path);
        if (!(path in state.snapshot.workflows)) state.snapshot.workflows[path] = before;
        const index = await addIntention({ op: 'set-workflow', resource: 'workflow', path, before, after: on });
        await port.setWorkflowEnabled(path, on);
        await markDone(index);
      });
    },

    async writeMainFiles(files: Record<string, string>, message: string): Promise<string> {
      return serialize(async () => {
        await refresh();
        const current = await port.main();
        const marker = nextMarker('main');
        const index = await addIntention({ op: 'write-main', resource: 'main', before: current.head, after: marker, marker });
        const commit = await port.writeCommit(files, current.head);
        const result = await port.commitToMain({ expectedHead: current.head, tree: commit, message: `${message} [${marker}]` });
        if (result === 'conflict') throw new Error(`main se movió antes de escribir: ${message}`);
        await markDone(index, result.sha);
        return result.sha;
      });
    },

    async createIssue(title: string): Promise<number> {
      return serialize(async () => {
        await refresh();
        const marker = nextMarker('issue');
        const index = await addIntention({ op: 'create-issue', resource: 'issue', before: null, after: marker, marker });
        const number = await port.createIssue(`[${marker}] ${title}`);
        await markDone(index, number);
        return number;
      });
    },

    async createBranch(name: string, sha: string): Promise<void> {
      await serialize(async () => {
        await refresh();
        const index = await addIntention({ op: 'create-branch', resource: 'branch', path: name, before: null, after: sha });
        const created = await port.createRef(`refs/heads/${name}`, sha);
        if (created === 'exists') throw new Error(`la rama ${name} ya existía`);
        await markDone(index);
      });
    },

    async createDeployment(o: { sha: string; environment: string; url: string }): Promise<number> {
      return serialize(async () => {
        await refresh();
        const marker = nextMarker('deployment');
        const index = await addIntention({ op: 'create-deployment', resource: 'deployment', before: null, after: marker, marker });
        const id = await port.createDeployment({ ...o, payload: marker, autoInactive: false });
        await markDone(index, id);
        return id;
      });
    },

    async trackPullRequest(number: number, branch: string): Promise<void> {
      await serialize(async () => {
        await refresh();
        state.journal.push({ op: 'tracked', resource: 'pull-request', before: null, after: number, path: branch, done: true });
        await persist();
      });
    },

    async noteMerged(number: number): Promise<void> {
      await serialize(async () => {
        await refresh();
        const entry = findTracked(number);
        state.journal.push({
          op: 'merged',
          resource: 'pull-request',
          before: null,
          after: number,
          ...(entry?.path === undefined ? {} : { path: entry.path }),
          done: true,
        });
        await persist();
      });
    },

    async forgeStateRef(ref: string, content: Record<string, unknown> | string): Promise<string> {
      return serialize(async () => {
        await refresh();
        const body = typeof content === 'string' ? content : JSON.stringify(content);
        const sha = await port.writeCommit({ 'journal.json': body });
        const index = await addIntention({ op: 'forge-state', resource: 'state-ref', before: null, after: sha, path: ref });
        const created = await port.createRef(ref, sha);
        if (created === 'exists') throw new Error(`la referencia ${ref} ya existía`);
        await markDone(index);
        return sha;
      });
    },
  };

  const adopt = (sha: string, adopted: SandboxState): void => {
    lockSha = sha;
    state = adopted;
  };

  return { sandbox, adopt };
}

export function createSandbox(options: { port: SandboxPort; run: string }): Sandbox {
  const { port, run } = options;
  return makeSandbox(port, run).sandbox;
}

/**
 * Every test file works with its own object, in another scope, attached to the lock that the global
 * setup left in GitHub. The run must be the one that holds the lock; otherwise it says both.
 */
export async function attachSandbox(options: { port: SandboxPort; run: string }): Promise<Sandbox> {
  const { port, run } = options;
  const sha = await port.getRef(LOCK_REF);
  if (sha === undefined) throw new Error('no hay candado de la suite al que engancharse');
  const state = await readLock(port, sha);
  if (state.run !== run) throw new Error(`el candado es de la corrida ${state.run}, no de ${run}`);
  const { sandbox, adopt } = makeSandbox(port, run);
  adopt(sha, state);
  return sandbox;
}

/**
 * The teardown of the whole suite: restores, and records the LIMPIEZA case of the report when a
 * report file is given. A dirty restoration leaves the lock in place and records it as failed.
 */
export async function finishSandbox(options: {
  sandbox: Sandbox;
  repository: string;
  reportFile?: string;
}): Promise<{ ok: boolean; problems: string[] }> {
  const { sandbox, repository, reportFile } = options;
  const result = await sandbox.restore();
  if (reportFile !== undefined && reportFile.length > 0) {
    const record: CaseRecord = {
      run: sandbox.run,
      id: 'LIMPIEZA',
      attempt: result.ok
        ? 'la suite repuso la foto del ensayo, la verificó y soltó el candado'
        : 'la suite no pudo dejar el ensayo limpio: quedó algo fuera de la foto y el candado sigue puesto',
      stoppedBy: [],
      negative: 'frenado',
      positive: 'no-aplica',
      evidence: [`https://github.com/${repository}/actions`],
      result: result.ok ? 'pasó' : 'falló',
    };
    appendFileSync(reportFile, `${JSON.stringify(record)}\n`, 'utf8');
  }
  return result;
}

/**
 * Reads the lock left by an abandoned run, reconciles every intention without its `done` against
 * GitHub, then does exactly what `restore` does. Without a lock there is nothing to recover.
 */
export async function recoverSandbox(options: { port: SandboxPort }): Promise<{ ok: boolean; problems: string[]; note?: string }> {
  const { port } = options;
  const permissions = await port.permissions();
  if (!permissions.admin || !permissions.appOnlyHere) {
    return { ok: false, problems: ['el repositorio de ensayo no admite la recuperación: se necesita administración y la aplicación de los agentes instalada solo aquí (R22)'] };
  }
  const sha = await port.getRef(LOCK_REF);
  if (sha === undefined) return { ok: true, problems: [], note: 'no hay candado de una corrida abandonada' };
  const state = await readLock(port, sha);
  const conflicts = await performReconcile(port, state);
  if (conflicts.length > 0) return { ok: false, problems: conflicts };
  const persisted = await persistLock(port, state, sha);
  const problems = await performRestore(port, state);
  if (problems.length > 0) return { ok: false, problems };
  const deleted = await port.deleteRef(LOCK_REF, persisted);
  if (deleted === 'conflict') return { ok: false, problems: ['candado: se movió antes de soltarlo'] };
  return { ok: true, problems: [] };
}

// ---------------------------------------------------------------------------------------------
// The real port: the owner's `gh` session with administration over the test repository (R22).
// The agents' application writes pull requests and events; this session prepares, restores and
// recovers the harness. It is exercised by the real suite, never by the local test.

function runGh(args: readonly string[], input?: string): string {
  return execFileSync('gh', [...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGh(args: readonly string[]): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: runGh(args) };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    return { ok: false, error: (stderr === undefined ? String(error) : stderr).trim() };
  }
}

function workflowFile(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function createGhSandboxPort(repository: string): SandboxPort {
  const repo = repository;
  const api = (method: string, path: string, body?: unknown): string =>
    runGh(['api', '-X', method, path, ...(body === undefined ? [] : ['--input', '-'])], body === undefined ? undefined : JSON.stringify(body));
  const paginate = (path: string): unknown[] =>
    (JSON.parse(runGh(['api', '--paginate', '--slurp', path])) as unknown[]).flat();
  const rulesetId = (): number => {
    const list = JSON.parse(runGh(['api', `repos/${repo}/rulesets`])) as { id: number; target: string }[];
    const id = list.find((ruleset) => ruleset.target === 'branch')?.id;
    if (id === undefined) throw new Error(`el repositorio de ensayo ${repo} no tiene ruleset de rama`);
    return id;
  };
  const treeOfCommit = (sha: string): string => {
    const commit = JSON.parse(runGh(['api', `repos/${repo}/git/commits/${sha}`])) as { tree: { sha: string } };
    return commit.tree.sha;
  };
  const refSha = (name: string): string | undefined => {
    const result = tryGh(['api', `repos/${repo}/git/ref/${name}`]);
    if (!result.ok) return undefined;
    const parsed = JSON.parse(result.out) as { object?: { sha?: string } };
    return parsed.object?.sha;
  };
  return {
    async permissions() {
      const view = JSON.parse(runGh(['api', `repos/${repo}`])) as { permissions?: { admin?: boolean } };
      let appOnlyHere = false;
      const installed = tryGh(['api', `repos/${repo}/installation`]);
      if (installed.ok) {
        const installation = JSON.parse(installed.out) as { id: number };
        const list = tryGh(['api', `user/installations/${installation.id}/repositories?per_page=100`]);
        if (list.ok) appOnlyHere = (JSON.parse(list.out) as { total_count?: number }).total_count === 1;
      }
      return { admin: view.permissions?.admin === true, appOnlyHere };
    },
    async getRef(name) {
      return refSha(name);
    },
    async createRef(name, sha) {
      const result = tryGh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=${name}`, '-f', `sha=${sha}`]);
      if (result.ok) return 'created';
      if (/already exists|Reference already exists|422/i.test(result.error)) return 'exists';
      throw new Error(`no se pudo crear la referencia ${name}: ${result.error}`);
    },
    async updateRef(name, sha, expected) {
      if (refSha(name) !== expected) return 'conflict';
      const result = tryGh(['api', '-X', 'PATCH', `repos/${repo}/git/refs/${name}`, '-f', `sha=${sha}`, '-f', 'force=true']);
      return result.ok ? 'updated' : 'conflict';
    },
    async deleteRef(name, expected) {
      if (refSha(name) !== expected) return 'conflict';
      runGh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/${name}`]);
      return 'deleted';
    },
    async writeCommit(files, parent) {
      const entries = Object.entries(files).map(([path, content]) => {
        const blob = JSON.parse(runGh(['api', '-X', 'POST', `repos/${repo}/git/blobs`, '-f', `content=${content}`, '-f', 'encoding=utf-8'])) as { sha: string };
        return { path, mode: '100644', type: 'blob', sha: blob.sha };
      });
      const tree: Record<string, unknown> = { tree: entries };
      if (parent !== undefined) tree['base_tree'] = treeOfCommit(parent);
      const createdTree = JSON.parse(runGh(['api', '-X', 'POST', `repos/${repo}/git/trees`, '--input', '-'], JSON.stringify(tree))) as { sha: string };
      const commit: Record<string, unknown> = { message: `ai-workflows suite ${repo}`, tree: createdTree.sha };
      if (parent !== undefined) commit['parents'] = [parent];
      const created = JSON.parse(runGh(['api', '-X', 'POST', `repos/${repo}/git/commits`, '--input', '-'], JSON.stringify(commit))) as { sha: string };
      return created.sha;
    },
    async readCommit(sha) {
      const tree = JSON.parse(runGh(['api', `repos/${repo}/git/trees/${treeOfCommit(sha)}?recursive=1`])) as {
        tree: { path: string; type: string; sha: string }[];
      };
      const files: Record<string, string> = {};
      for (const entry of tree.tree) {
        if (entry.type !== 'blob') continue;
        const blob = JSON.parse(runGh(['api', `repos/${repo}/git/blobs/${entry.sha}`])) as { content: string; encoding: string };
        files[entry.path] = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
      }
      return files;
    },
    async main() {
      const head = refSha('heads/main');
      if (head === undefined) throw new Error(`el repositorio de ensayo ${repo} no tiene main`);
      return { head, tree: treeOfCommit(head) };
    },
    async mainHistory(since) {
      const commits = JSON.parse(runGh(['api', `repos/${repo}/commits?sha=main&per_page=100`])) as {
        sha: string;
        commit: { message: string };
      }[];
      const index = commits.findIndex((commit) => commit.sha === since);
      if (index < 0) throw new Error(`${since} no está en main`);
      return commits.slice(0, index).reverse().map((commit) => {
        const pr = /Merge pull request #(\d+)/.exec(commit.commit.message)?.[1];
        return { sha: commit.sha, message: commit.commit.message, ...(pr === undefined ? {} : { pr: Number(pr) }) };
      });
    },
    async commitToMain(o) {
      const head = refSha('heads/main');
      if (head !== o.expectedHead) return 'conflict';
      const tree = o.tree === undefined ? treeOfCommit(o.expectedHead) : treeOfCommit(o.tree);
      const created = JSON.parse(runGh(['api', '-X', 'POST', `repos/${repo}/git/commits`, '--input', '-'],
        JSON.stringify({ message: o.message, tree, parents: [o.expectedHead] }))) as { sha: string };
      const updated = tryGh(['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/main`, '-f', `sha=${created.sha}`, '-f', 'force=false']);
      if (!updated.ok) return 'conflict';
      return { sha: created.sha, tree };
    },
    async variable() {
      const result = tryGh(['api', `repos/${repo}/actions/variables/AI_WORKFLOWS_MODE`]);
      if (!result.ok) return undefined;
      return (JSON.parse(result.out) as { value?: string }).value;
    },
    async setVariable(value) {
      if (value === undefined) {
        tryGh(['variable', 'delete', 'AI_WORKFLOWS_MODE', '--repo', repo]);
        return;
      }
      runGh(['variable', 'set', 'AI_WORKFLOWS_MODE', '--repo', repo, '--body', value]);
    },
    async ruleset() {
      return JSON.parse(runGh(['api', `repos/${repo}/rulesets/${rulesetId()}`])) as Record<string, unknown>;
    },
    async putRuleset(body) {
      api('PUT', `repos/${repo}/rulesets/${rulesetId()}`, pickRuleset(body));
    },
    async workflowEnabled(path) {
      const result = tryGh(['api', `repos/${repo}/actions/workflows/${workflowFile(path)}`]);
      if (!result.ok) return false;
      return (JSON.parse(result.out) as { state?: string }).state === 'active';
    },
    async setWorkflowEnabled(path, on) {
      runGh(['workflow', on ? 'enable' : 'disable', workflowFile(path), '--repo', repo]);
    },
    async inventory() {
      const branches = paginate(`repos/${repo}/branches?per_page=100`) as { name: string }[];
      const openPullRequests = JSON.parse(runGh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number'])) as { number: number }[];
      const openIssues = JSON.parse(runGh(['issue', 'list', '--repo', repo, '--state', 'open', '--json', 'number'])) as { number: number }[];
      const refs = tryGh(['api', '--paginate', '--slurp', `repos/${repo}/git/matching-refs/ai-workflows`]);
      const stateRefs = refs.ok && refs.out !== '' ? ((JSON.parse(refs.out) as { ref: string }[][]).flat()).map((entry) => entry.ref) : [];
      const deployments = paginate(`repos/${repo}/deployments?per_page=100`) as { id: number }[];
      const states: { id: number; state: string }[] = [];
      for (const deployment of deployments) {
        const statuses = JSON.parse(runGh(['api', `repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`])) as { state: string }[];
        states.push({ id: deployment.id, state: statuses[0]?.state ?? 'unknown' });
      }
      return {
        branches: branches.map((branch) => branch.name).sort(),
        openPullRequests: openPullRequests.map((pr) => pr.number).sort((a, b) => a - b),
        openIssues: openIssues.map((issue) => issue.number).sort((a, b) => a - b),
        stateRefs: stateRefs.sort(),
        deployments: states.sort((a, b) => a.id - b.id),
      };
    },
    async createIssue(title, body) {
      const url = runGh(['issue', 'create', '--repo', repo, '--title', title, '--body', body ?? '']);
      return Number(url.split('/').pop());
    },
    async findIssues(marker) {
      const out = runGh(['issue', 'list', '--repo', repo, '--state', 'all', '--search', `${marker} in:title`, '--json', 'number', '--jq', '.[].number']);
      return out === '' ? [] : out.split('\n').map(Number);
    },
    async closeIssue(n) {
      runGh(['issue', 'close', String(n), '--repo', repo]);
    },
    async createDeployment(o) {
      const created = api('POST', `repos/${repo}/deployments`, {
        ref: o.sha,
        environment: o.environment,
        payload: o.payload,
        auto_inactive: o.autoInactive,
        required_contexts: [],
      });
      const deployment = JSON.parse(created) as { id: number };
      api('POST', `repos/${repo}/deployments/${deployment.id}/statuses`, { state: 'success', environment_url: o.url });
      return deployment.id;
    },
    async findDeployments(marker) {
      const deployments = paginate(`repos/${repo}/deployments?per_page=100`) as { id: number; payload?: string }[];
      return deployments.filter((deployment) => (deployment.payload ?? '').includes(marker)).map((deployment) => deployment.id);
    },
    async deactivateDeployment(id) {
      api('POST', `repos/${repo}/deployments/${id}/statuses`, { state: 'inactive' });
    },
    async deleteDeployment(id) {
      api('DELETE', `repos/${repo}/deployments/${id}`);
    },
    async closePullRequest(n) {
      runGh(['pr', 'close', String(n), '--repo', repo]);
    },
    async deleteBranch(name) {
      runGh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${name}`]);
    },
    async findPullRequests(marker) {
      const out = runGh(['pr', 'list', '--repo', repo, '--state', 'all', '--search', marker, '--json', 'number', '--jq', '.[].number']);
      return out === '' ? [] : out.split('\n').map(Number);
    },
  };
}
