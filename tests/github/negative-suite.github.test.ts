import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  agentCredentialsFromEnv,
  createAgentEdges,
  createAppTokenSource,
  createGhRunner,
  createGitHubStatePort,
  installHooks,
  renderEventComment,
  runAgentCli,
  type AgentCliDeps,
  type PieceEvent,
  type StatePort,
} from '../../src/index.js';

import { buildEngine, type BuiltEngine } from '../built-engine.js';
import { commit, git, write } from '../git-fixtures.js';

import { recordCase, type CaseRecord } from './report.js';
import { attachSandbox, createGhSandboxPort, type Sandbox } from './sandbox.js';

// PLAN-13-R5 §2: the negative suite on real GitHub. Every attempt to get around the process that
// was only tried with simulated pieces is tried here, in socialabs-margin/ai-workflows-pruebas,
// with the agents' GitHub App (R21), the real merge queue and the judge pinned to the engine commit
// under test. Each attempt starts from a COMPLETE piece that the judge passes, changes ONE thing,
// reads from the judge's own run which stage failed and why, and then shows the same piece with
// only that thing fixed passing again (§2.4).
//
// Everything that changes the test repository goes through the harness (tests/github/sandbox.ts):
// one lock for the whole run, taken by the global setup, a snapshot kept in GitHub, restoration
// that never overwrites someone else's change. The owner's account on this machine configures the
// rehearsal and writes the owner's orders of the positive controls (R22); the "Approve" of CN-05b
// is pressed by the owner, outside this machine.
//
// It needs credentials, a person and Actions minutes, so it never runs in the public CI. It FAILS
// — never skips — without AI_WORKFLOWS_GITHUB_TEST_REPO, AI_WORKFLOWS_APP_ID,
// AI_WORKFLOWS_APP_KEY_FILE and AI_WORKFLOWS_AGENT_ACCOUNT, and the engine commit under test must
// already be on GitHub.

const REPO = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';
const AGENT = process.env['AI_WORKFLOWS_AGENT_ACCOUNT'] ?? '';
const ENGINE_REPO = 'luismichelcf/ai-workflows';
const MINUTE = 60_000;
const ENGINE_ROOT = join(import.meta.dirname, '..', '..');

const WORKFLOW = '.github/workflows/ai-workflows.yml';
const RED_WORKFLOW = '.github/workflows/ai-workflows-red-test.yml';
const SIGNAL_WORKFLOW = '.github/workflows/ai-workflows-review-signal.yml';
const SUITE_WORKFLOW = '.github/workflows/todo-verde.yml';
const BOUNDARY_WORKFLOW = '.github/workflows/fronteras.yml';

const gh = (...args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const ghJson = <T>(...args: string[]): T => JSON.parse(gh(...args)) as T;
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => process.stdout.write(`[negative.github] ${new Date().toISOString()} ${message}\n`);

async function waitFor<T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 15 * MINUTE, everyMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = await probe();
    } catch (error) {
      log(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Identities: the owner (the gh session of this machine, R22) and the agents (the GitHub App).

const OWNER = REPO === '' ? '' : gh('api', 'user', '--jq', '.login');
let agentToken: () => Promise<string> = async () => {
  throw new Error('no agent token yet');
};

/** gh as the agents: the installation token travels only in the environment of this call. */
async function asAgent(...args: string[]): Promise<string> {
  const token = await agentToken();
  return execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * git against GitHub as the agents, retried on TLS hiccups. The token travels in a header set
 * through the environment of this call only (never in the command line: a failed git prints its
 * command line, and the first real run printed the header in its log). A refusal of the remote
 * is final and not retried.
 */
function gitAuth(token: string): { env: NodeJS.ProcessEnv; redact: (text: string) => string } {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  const header = `AUTHORIZATION: basic ${encoded}`;
  // No tracing inherited from the machine: a trace would print the header on its own.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_TRACE|^GIT_CURL_VERBOSE$/.test(name)));
  return {
    env: { ...inherited, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header },
    redact: (text) => text.split(header).join('***').split(encoded).join('***').split(token).join('***'),
  };
}

async function agentGit(root: string, ...args: string[]): Promise<string> {
  const { env, redact } = gitAuth(await agentToken());
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      last = `git ${args.join(' ')} failed: ${redact(stderr)}`;
      if (/remote rejected|\[rejected\]/.test(stderr)) break;
      await sleep(attempt * 3000);
    }
  }
  throw new Error(last);
}

/**
 * git against GitHub as the owner (the gh session of this machine), the same way as `agentGit`.
 * Used only where GitHub itself refuses the agents (R22 as extended in part 5): a change to a
 * workflow file needs the `workflows` permission, which the agents' app does not have.
 */
async function ownerGit(root: string, ...args: string[]): Promise<string> {
  const { env, redact } = gitAuth(gh('auth', 'token'));
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    throw new Error(`git ${args.join(' ')} failed as the owner: ${redact(stderr)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// What main holds during the run (installed through the harness, restored at the end)

const RECIPE = () => lines(
  '# La receta de la suite negativa (PLAN-13-R5 §2.3).',
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  `agent-account: "${AGENT}"`,
  'classify:',
  '  money: ["src/calc/**"]',
  '  visible: ["components/**"]',
  'kinds:',
  '  names: [behavior, visual-only, docs]',
  '  default: behavior',
  '  from-paths: { docs: ["docs/**"] }',
  '  elevate:',
  '    - when: { touches-any: [money], kind-none: [behavior] }',
  '      to: behavior',
  'labels:',
  '  behavior: "comportamiento"',
  '  visual-only: "solo visual"',
  '  docs: "papeles"',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  '  declared-kind: { file: "docs/plans/PLAN-{piece}.md", line: "Tipo de cambio" }',
  'hooks: { papers: ["docs"] }',
  'stages:',
  '  - id: spec',
  '    summary: "El plan tiene sus secciones"',
  '    nature: structure',
  '    applies-if: { kind-any: [behavior] }',
  '    gate:',
  '      uses: ai-workflows/spec-structure@1',
  '      with: { file: "docs/plans/PLAN-{piece}.md", sections: ["En tres líneas", "Casos de aceptación"] }',
  '    server: recompute',
  '  - id: benchmark',
  '    summary: "El plan compara con tres fuentes distintas"',
  '    after: spec',
  '    nature: structure',
  '    applies-if: { kind-any: [behavior] }',
  '    gate:',
  '      uses: ai-workflows/benchmark-sources@1',
  '      with: { files: ["docs/plans/PLAN-{piece}.md"], categories: [{ heading: "Benchmark", min: 3 }] }',
  '    server: recompute',
  '  - id: red-test',
  '    summary: "Primero una prueba que falla por la razón correcta"',
  '    after: benchmark',
  '    nature: execution-record',
  '    applies-if: { kind-any: [behavior] }',
  '    valid-while: forever',
  '    gate:',
  '      uses: ai-workflows/red-test@1',
  '      with: { command: "node runner.mjs {tests}", tests: ["tests/suite/**/*.test.mjs"] }',
  '    server: { require-check: ai-workflows/red-test }',
  '  - id: suite',
  '    summary: "Todas las pruebas en verde"',
  '    after: red-test',
  '    nature: recompute',
  '    applies-if: { kind-any: [behavior] }',
  '    gate:',
  '      uses: ai-workflows/command@1',
  '      with: { command: "node runner.mjs tests/suite/zona.test.mjs" }',
  '    server: { require-check: todo-verde }',
  '  - id: boundaries',
  '    summary: "Nada visible toca la base de datos"',
  '    after: suite',
  '    nature: recompute',
  '    applies-if: { kind-any: [behavior] }',
  '    gate:',
  '      uses: ai-workflows/command@1',
  '      with: { command: "node scripts/fronteras.mjs" }',
  '    server: { require-check: fronteras }',
  '  - id: review',
  '    summary: "Una revisión independiente aprueba esta versión"',
  '    after: boundaries',
  '    nature: attest',
  '    applies-if: { kind-any: [behavior] }',
  '    gate:',
  '      uses: ai-workflows/independent-review@1',
  '      with: { angles: [correctness], forbid-same-family: false }',
  '    server: attestation',
  '  - id: approval',
  '    summary: "El dueño aprueba lo que se ve"',
  '    after: review',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/approval-review@1',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Entra a la cola y se fusiona"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  '      with: { method: squash, timeout-minutes: 45, poll-seconds: 20 }',
);

/** The runner of tests/red-test-check.test.ts, rebuilt from its source so both stay the same. */
function runnerSource(): string {
  const source = readFileSync(join(ENGINE_ROOT, 'tests', 'red-test-check.test.ts'), 'utf8').split('const RUNNER = [')[1]?.split('].join(')[0];
  if (source === undefined) throw new Error('cannot find RUNNER in tests/red-test-check.test.ts');
  return (new Function(`return [${source}];`)() as string[]).join('\n');
}

const ZONE = (value: number) => `export const zona = () => ${value};\n`;
const ZONE_TEST = lines(
  'import assert from "node:assert/strict";',
  'import { zona } from "../../src/calc/zona.mjs";',
  'export const cases = { "la zona vale 1": () => assert.equal(zona(), 1, `expected ${zona()} to be 1`) };',
);

const BOUNDARIES = lines(
  'import { existsSync, readdirSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>',
  '  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]) : []);',
  'const offenders = walk("components").filter((file) => /src\\/db/.test(readFileSync(file, "utf8")));',
  'if (offenders.length > 0) { console.error(`components no puede importar src/db: ${offenders.join(", ")}`); process.exit(1); }',
  'console.log("fronteras en orden");',
);

/** A project check workflow whose job name is the check the recipe requires. */
const checkWorkflow = (name: string, run: string) => lines(
  `name: ${name}`,
  'on:',
  '  pull_request:',
  '  merge_group:',
  '    types: [checks_requested]',
  'permissions: { contents: read }',
  'jobs:',
  '  check:',
  `    name: ${name}`,
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  '        with: { persist-credentials: false }',
  `      - run: ${run}`,
);

/**
 * The judge workflows of the templates, pinned to the engine commit under test. With `branches`,
 * the judge gets that input, as `init` writes it from a recipe with working branches (R6 §1.2).
 */
function judgeWorkflows(engineSha: string, branches?: string): Record<string, string> {
  const read = (name: string) => readFileSync(join(ENGINE_ROOT, 'templates', name), 'utf8').replaceAll('<ENGINE_SHA>', engineSha);
  const judge = parse(read('ai-workflows.yml')) as Record<string, any>;
  judge['on']['workflow_run']['workflows'] = [...new Set([...(judge['on']['workflow_run']['workflows'] as string[]), 'todo-verde', 'fronteras'])];
  if (branches !== undefined) judge['jobs']['judge']['steps'][0]['with']['branches'] = branches;
  const red = parse(read('ai-workflows-red-test.yml')) as Record<string, any>;
  for (const job of Object.values(red['jobs'] as Record<string, any>)) {
    job['steps'] = (job['steps'] as Record<string, any>[]).filter((step) => !/pnpm|setup-node|action-setup/.test(`${step['run'] ?? ''}${step['uses'] ?? ''}`));
  }
  return {
    [WORKFLOW]: stringify(judge),
    [RED_WORKFLOW]: stringify(red),
    [SIGNAL_WORKFLOW]: read('ai-workflows-review-signal.yml'),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading what GitHub says

interface Status { context: string; state: string; description: string; target_url: string | null; created_at: string }

function statuses(sha: string): Status[] {
  const pages = ghJson<Status[][]>('api', `repos/${REPO}/commits/${sha}/statuses`, '--paginate', '--slurp');
  return pages.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const latest = (sha: string, context = 'ai-workflows') => statuses(sha).find((status) => status.context === context);

function settled(sha: string, states: string[] = ['success', 'failure', 'error'], timeoutMs = 15 * MINUTE): Promise<Status> {
  return waitFor(`ai-workflows on ${sha.slice(0, 7)} in ${states.join('/')}`, () => {
    const status = latest(sha);
    return status !== undefined && states.includes(status.state) ? status : undefined;
  }, timeoutMs);
}

/** The judge waits for a check that is still running as `pending`: wait until its answer is final. */
function checkRun(sha: string, name: string) {
  const pages = ghJson<{ check_runs: { name: string; status: string; conclusion: string | null }[] }[]>(
    'api', `repos/${REPO}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`, '--paginate', '--slurp');
  return pages.flatMap((page) => page.check_runs).find((run) => run.name === name);
}

const checkDone = (sha: string, name: string) =>
  waitFor(`check ${name} on ${sha.slice(0, 7)}`, () => {
    const run = checkRun(sha, name);
    return run?.status === 'completed' ? run : undefined;
  });

/** The stage lines of the judge's own summary, read from the run that published the latest status. */
function stagesOf(status: Status): Record<string, { outcome: string; reason: string }> {
  const text = judgeRunLog(status);
  const stages: Record<string, { outcome: string; reason: string }> = {};
  for (const match of text.matchAll(/^.*?- ([\w-]+): (passed|rejected|waiting|technical|skipped|informative)(?: — (.*))?$/gm)) {
    const [, stage, outcome, reason] = match;
    if (stage !== undefined && outcome !== undefined) stages[stage] = { outcome, reason: reason ?? '' };
  }
  return stages;
}

/** The whole log of the run that published a status. */
function judgeRunLog(status: Status): string {
  const id = /\/actions\/runs\/(\d+)/.exec(status.target_url ?? '')?.[1];
  if (id === undefined) throw new Error(`the status has no run: ${JSON.stringify(status)}`);
  return runLogText(id);
}

/** The log of a run, once it ended. */
function runLogText(id: string): string {
  // The judge publishes its verdict before its run ends, and GitHub only gives the log of an ended
  // run: wait for it (seen in the first real run).
  const deadline = Date.now() + 10 * MINUTE;
  while (ghJson<{ status: string }>('run', 'view', id, '--repo', REPO, '--json', 'status').status !== 'completed') {
    if (Date.now() > deadline) throw new Error(`the judge run ${id} did not end`);
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  }
  // Right after the end GitHub can still answer "log not found" (seen in the real run, SV-07).
  let text: string | undefined;
  for (let attempt = 1; text === undefined; attempt += 1) {
    try {
      text = gh('run', 'view', id, '--repo', REPO, '--log');
    } catch (error) {
      if (attempt >= 10) throw error;
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    }
  }
  return text;
}

const notPassing = (stages: Record<string, { outcome: string }>) =>
  Object.entries(stages).filter(([, stage]) => !['passed', 'skipped', 'informative'].includes(stage.outcome)).map(([id]) => id).sort();

const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const runUrl = (status: Status) => status.target_url ?? prUrl(0);

function prState(n: number) {
  return ghJson<{ state: string; mergedAt: string | null; author: { login: string } }>('pr', 'view', String(n), '--repo', REPO, '--json', 'state,mergedAt,author');
}

// ---------------------------------------------------------------------------------------------
// Pieces

let sandbox: Sandbox;
let clone = '';
let mainSha = '';
let engineSha = '';
let engine: BuiltEngine | undefined;
const folders: string[] = [];

const ALL_STAGES = ['spec', 'benchmark', 'red-test', 'suite', 'boundaries', 'review', 'approval', 'merge'];

interface Piece { n: number; branch: string; pr: number; head: string; base: string; files: Record<string, string | null>; mark: number }

const planOf = (n: number, kind: string, benchmark: readonly string[] = ['https://productive.io/a', 'https://scoro.com/b', 'https://runn.io/c']) => lines(
  `# Plan ${n}`,
  '',
  '## En tres líneas',
  '',
  'Qué pasa hoy: se prueba el motor.',
  'Qué cambia: una pieza de la suite negativa.',
  'Por qué importa: para confiar en él.',
  '',
  `Tipo de cambio: ${kind}`,
  '',
  '## Casos de aceptación',
  '',
  '- CA-01 la prueba de la pieza pasa.',
  '',
  '## Benchmark',
  '',
  ...benchmark.map((url, index) => `- [fuente ${index + 1}](${url})`),
);

/** The files of a complete behaviour piece: a real red test and its implementation (§2.4). */
function completeFiles(n: number): Record<string, string> {
  return {
    [`docs/plans/PLAN-${n}.md`]: planOf(n, 'comportamiento'),
    [`src/calc/p${n}.mjs`]: `export const p${n} = () => ${n};\n`,
    [`tests/suite/p${n}.test.mjs`]: lines(
      'import assert from "node:assert/strict";',
      'import { existsSync } from "node:fs";',
      `export const cases = { "la pieza ${n} existe": () => assert.ok(existsSync("src/calc/p${n}.mjs"), "falta src/calc/p${n}.mjs") };`,
    ),
  };
}

/**
 * A new issue (the piece), its branch pushed by the agents and its pull request opened by them,
 * into `main` or, with `base`, into another working branch (R6 §1).
 */
async function openPiece(name: string, files: (n: number) => Record<string, string | null>, options: { pullRequest?: boolean; workflowByOwner?: boolean; base?: string } = {}): Promise<Piece> {
  const n = await sandbox.createIssue(`suite negativa · ${name}`);
  const branch = `feat/${n}-${name}`;
  const into = options.base ?? 'main';
  await agentGit(clone, 'fetch', '-q', 'origin', into);
  git(clone, 'switch', '-q', '-C', branch, `origin/${into}`);
  const base = git(clone, 'rev-parse', 'HEAD');
  const content = files(n);
  for (const [path, text] of Object.entries(content)) {
    if (text === null) git(clone, 'rm', '-q', '--ignore-unmatch', path);
    else write(clone, path, text);
  }
  const head = commit(clone, `suite negativa: ${name}`);
  if (options.workflowByOwner === true) {
    // GitHub refuses the agents a change to a workflow file (their app has no `workflows`
    // permission): that refusal is the first lock. The owner's account then pushes the same
    // commit, so the judge's own lock is tried too (R22, part 5).
    let refusedPush = '';
    try {
      await agentGit(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
    } catch (error) {
      refusedPush = error instanceof Error ? error.message : String(error);
    }
    expect(refusedPush, 'GitHub let the agents push a workflow change').toMatch(/without `workflows` permission/);
    await ownerGit(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
  } else {
    await agentGit(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
  }
  // Without a pull request the engine opens its own (with its mark), as in CN-06.
  if (options.pullRequest === false) return { n, branch, pr: 0, head, base, files: content, mark: 0 };
  const url = await asAgent('pr', 'create', '--repo', REPO, '--head', branch, '--base', into, '--title', `Suite negativa · ${name} (#${n})`, '--body', `Pieza #${n} de la suite negativa (PLAN-13-R5). Se cierra sola.`);
  const pr = Number(url.split('/').at(-1));
  await sandbox.trackPullRequest(pr, branch);
  expect(prState(pr).author.login.replace(/^app\//, '')).toMatch(new RegExp(`^${AGENT.replace(/\[bot\]$/, '')}`));
  return { n, branch, pr, head, base, files: content, mark: 0 };
}

/** A new commit on the piece's branch with these changes, pushed by the agents. */
async function change(piece: Piece, files: Record<string, string | null>, message: string): Promise<string> {
  git(clone, 'switch', '-q', piece.branch);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git(clone, 'rm', '-q', '--ignore-unmatch', path);
    else write(clone, path, text);
  }
  const head = commit(clone, message);
  await agentGit(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${piece.branch}`);
  piece.head = head;
  piece.mark = 0;
  return head;
}

const identity = (provider: string, session: string, model = `${provider}-model`) => ({ provider, model, effort: 'high', session });
const BUILDER = identity('deepseek', 'sesion-constructor');

/** Publishes an event on the piece's issue as the agents, exactly as the engine renders it. */
async function publish(piece: Piece, event: PieceEvent): Promise<number> {
  // What the judge publishes after this event counts; what it published before does not.
  piece.mark = statuses(piece.head).length;
  const body = renderEventComment(event, 'es');
  const created = JSON.parse(await asAgent('api', '-X', 'POST', `repos/${REPO}/issues/${piece.n}/comments`, '-f', `body=${body}`)) as { id: number };
  return created.id;
}

const treeOf = (sha: string) => git(clone, 'rev-parse', `${sha}^{tree}`);

async function builderEvent(piece: Piece): Promise<number> {
  return publish(piece, { type: 'builder', op: `build:${piece.base}`, piece: String(piece.n), sha: piece.base, identity: BUILDER, result: treeOf(piece.head), at: '' });
}

async function verdict(piece: Piece, sha: string, by = identity('claude', `sesion-revisor-${piece.n}`)): Promise<number> {
  const tree = treeOf(sha);
  return publish(piece, {
    type: 'verdict',
    op: `review:${sha}:correctness:${by.session}`,
    piece: String(piece.n),
    sha,
    identity: by,
    angle: 'correctness',
    approved: true,
    workspace: { before: tree, after: tree },
    at: '',
  });
}

/** The judge's final status on the piece's current head, with the stage table of its run. */
/**
 * The judge's final status on the piece's current head, with the stage table of its run. Only a
 * status published AFTER the last thing the test did to the piece counts (`piece.mark`): right
 * after a new verdict on the same head, the previous verdict is still the newest one.
 */
async function judged(
  piece: Piece,
  states: string[] = ['success', 'failure', 'error'],
  settledStages: readonly string[] = [],
) {
  let seen: { status: Status; stages: ReturnType<typeof stagesOf>; since: number } | undefined;
  try {
    return await waitFor(`ai-workflows on ${piece.head.slice(0, 7)} in ${states.join('/')} after mark ${piece.mark}`, () => {
      const all = statuses(piece.head);
      // The judge first posts «juzgando» (pending) when a run starts (action.yml); that is not a
      // verdict, and taking it for one read an empty stage table (seen in the real run, SV-03).
      const newest = all.find((entry) => entry.context === 'ai-workflows');
      const inProgress = newest?.state === 'pending' && newest.description === 'juzgando';
      if (!(all.length > piece.mark && newest !== undefined && !inProgress && states.includes(newest.state))) return undefined;
      // A run cancelled by a newer one posts «el juez no pudo decidir» (error) on its way out, and
      // the newer one then posts its own verdict (seen in the fifth real run, CN-05b). A verdict
      // counts only once it has stayed the newest for a minute.
      if (seen?.status.target_url !== newest.target_url || seen.status.created_at !== newest.created_at) {
        seen = { status: newest, stages: {}, since: Date.now() };
        return undefined;
      }
      if (Date.now() - seen.since < MINUTE) return undefined;
      if (Object.keys(seen.stages).length === 0) seen.stages = stagesOf(newest);
      // A stage whose check GitHub has not finished yet waits: the judge runs again when it ends
      // (seen in the real run, CN-09, where the red-test check was still running).
      return settledStages.every((stage) => seen?.stages[stage] !== undefined && seen.stages[stage]?.outcome !== 'waiting') ? seen : undefined;
    });
  } catch (error) {
    // Timed out on stages that stayed waiting: hand back what the judge last said, so the test's
    // own assertion reports it instead of a bare timeout. A stage missing from the table is never
    // handed back: `notPassing` would not see it (flock round 8).
    if (seen !== undefined && settledStages.length > 0 && settledStages.every((stage) => seen?.stages[stage] !== undefined)) return seen;
    throw error;
  }
}

/**
 * The merge effect of a piece as the engine's store keeps it in the test repository: its state,
 * and whether the commit that settled it was a reconciliation (the store's own commit message)
 * rather than the confirmation written right after the effect.
 */
async function mergeEffect(n: number): Promise<{ state: string; byReconciliation: boolean }> {
  const ref = `ai-workflows/pieces/${n}`;
  const head = ghJson<{ object: { sha: string } }>('api', `repos/${REPO}/git/ref/${ref}`).object.sha;
  const effects = JSON.parse(Buffer.from(ghJson<{ content: string }>('api', `repos/${REPO}/contents/effects.json?ref=${head}`).content, 'base64').toString('utf8')) as Record<string, { state: string }>;
  const [op, entry] = Object.entries(effects).find(([key]) => /^merge:/.test(key)) ?? [];
  if (op === undefined || entry === undefined) return { state: 'absent', byReconciliation: false };
  let sha: string | undefined = head;
  for (let depth = 0; sha !== undefined && depth < 50; depth += 1) {
    const commitInfo: { message: string; parents: { sha: string }[] } = ghJson('api', `repos/${REPO}/git/commits/${sha}`);
    if (commitInfo.message.includes(`effect ${op} `)) {
      return { state: entry.state, byReconciliation: commitInfo.message.startsWith('ai-workflows: reconcile effect') };
    }
    sha = commitInfo.parents[0]?.sha;
  }
  return { state: entry.state, byReconciliation: false };
}

function record(entry: Omit<CaseRecord, 'run'>): void {
  recordCase({ run: sandbox.run, ...entry });
}

/**
 * The rehearsal's own queue lock (`candado-cola`, a copy of the real project's, not the engine)
 * downloads the engine; in the seventh real run GitHub answered that download with a 500 and the
 * lock stayed red, so the piece never entered the queue. A lock that failed on a GitHub server
 * error is re-run once, as a person would, and the case says so. Any other red stays red.
 */
function rerunQueueLock(piece: Piece, reruns: number[]): void {
  if (reruns.includes(piece.pr) || latest(piece.head, 'candado-cola')?.state !== 'failure') return;
  const failed = ghJson<{ databaseId: number; conclusion: string; createdAt: string }[]>('run', 'list', '--repo', REPO, '--commit', piece.head, '--workflow', 'Candado de la cola', '--json', 'databaseId,conclusion,createdAt')
    .filter((run) => run.conclusion === 'failure')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (failed === undefined) return;
  const text = gh('run', 'view', String(failed.databaseId), '--repo', REPO, '--log');
  if (!/returned error: 5\d\d/.test(text)) throw new Error(`the rehearsal queue lock of PR #${piece.pr} failed for a reason other than a GitHub server error`);
  gh('run', 'rerun', String(failed.databaseId), '--repo', REPO, '--failed');
  reruns.push(piece.pr);
  log(`the rehearsal queue lock of PR #${piece.pr} failed on a GitHub server error; re-run once`);
}

async function tryToMerge(piece: Piece): Promise<void> {
  try {
    await asAgent('pr', 'merge', String(piece.pr), '--repo', REPO, '--squash', '--auto');
  } catch (error) {
    log(`merge of #${piece.pr} refused at once: ${String((error as { stderr?: string }).stderr ?? error).trim()}`);
  }
}

/**
 * The attempt did not merge. Then the merge the attempt armed is disarmed: otherwise the positive
 * control, which makes the same pull request green on purpose, would let GitHub merge it (seen in
 * the first real run, where two positive controls merged).
 */
async function stillOpen(piece: Piece): Promise<void> {
  await sleep(60_000);
  const state = prState(piece.pr);
  expect(state.state, `PR #${piece.pr} must not merge`).toBe('OPEN');
  expect(state.mergedAt).toBeNull();
  try {
    await asAgent('pr', 'merge', String(piece.pr), '--repo', REPO, '--disable-auto');
  } catch (error) {
    // Not armed (GitHub refused it at once): nothing to disarm. Anything else is a failure.
    const text = String((error as { stderr?: string }).stderr ?? error);
    if (!/not enabled|auto.?merge is not|no auto/i.test(text)) throw error;
  }
  const after = ghJson<{ autoMergeRequest: unknown }>('pr', 'view', String(piece.pr), '--repo', REPO, '--json', 'autoMergeRequest');
  expect(after.autoMergeRequest, `the merge armed on #${piece.pr} must be disarmed`).toBeNull();
}

// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  const missing = ['AI_WORKFLOWS_GITHUB_TEST_REPO', 'AI_WORKFLOWS_APP_ID', 'AI_WORKFLOWS_APP_KEY_FILE', 'AI_WORKFLOWS_AGENT_ACCOUNT']
    .filter((name) => (process.env[name] ?? '') === '');
  if (missing.length > 0) throw new Error(`the real run needs ${missing.join(', ')}; it never skips`);

  engineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ENGINE_ROOT, encoding: 'utf8' }).trim();
  gh('api', `repos/${ENGINE_REPO}/commits/${engineSha}`); // push the branch under test first

  sandbox = await attachSandbox({ port: createGhSandboxPort(REPO), run: inject('sandboxRun') });
  await sandbox.baseline();

  clone = mkdtempSync(join(tmpdir(), 'aiw-negative-'));
  folders.push(clone);
  const credentials = agentCredentialsFromEnv(process.env, clone);
  if (!('appId' in credentials)) throw new Error(`credentials: ${JSON.stringify(credentials)}`);
  const tokens = createAppTokenSource({ credentials, repository: REPO });
  agentToken = () => tokens.token();
  expect(await tokens.account()).toBe(AGENT);

  gh('repo', 'clone', REPO, clone, '--', '-q');
  git(clone, 'config', 'user.email', 'agentes@example.com');
  git(clone, 'config', 'user.name', 'agentes');
  git(clone, 'config', 'commit.gpgsign', 'false');

  mainSha = await sandbox.writeMainFiles({
    ...judgeWorkflows(engineSha),
    [SUITE_WORKFLOW]: checkWorkflow('todo-verde', 'node runner.mjs tests/suite/*.test.mjs'),
    [BOUNDARY_WORKFLOW]: checkWorkflow('fronteras', 'node scripts/fronteras.mjs'),
    '.ai-workflows/pipeline.yml': RECIPE(),
    'runner.mjs': runnerSource(),
    'scripts/fronteras.mjs': BOUNDARIES,
    'src/calc/zona.mjs': ZONE(1),
    'src/db/cliente.mjs': 'export const db = 1;\n',
    'tests/suite/zona.test.mjs': ZONE_TEST,
    'estilos/tema.css': 'body { color: black; }\n',
  }, `suite negativa ${sandbox.run}: se instala`);
  await sandbox.setVariable('on');
  await sandbox.addRequiredStatus('ai-workflows');
  await agentGit(clone, 'fetch', '-q', 'origin', 'main');
  log(`engine ${engineSha}, run ${sandbox.run}, owner ${OWNER}, main ${mainSha}`);
}, 15 * MINUTE);

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  engine?.remove();
});

// ---------------------------------------------------------------------------------------------
// CN-05b first: its positive control waits for a person, so it is asked for at the start and the
// other cases run meanwhile (§2.7).

let visible: Piece;
const ownerApproval = { asked: false };

describe.sequential('the negative suite on GitHub (PLAN-13-R5 §2)', () => {
  it('CN-05b: a visible piece without the owner Approve waits; the owner button makes the judge pass on its own', async () => {
    visible = await openPiece('visible', (n) => ({
      [`docs/plans/PLAN-${n}.md`]: planOf(n, 'solo visual'),
      [`components/boton-${n}.tsx`]: 'export const Boton = () => null;\n',
    }));
    const waiting = await judged(visible, ['pending', 'failure', 'error']);
    expect(waiting.status.state).toBe('pending');
    expect(notPassing(waiting.stages)).toEqual(['approval']);
    await tryToMerge(visible);
    await stillOpen(visible);
    process.stdout.write(`\n\n>>> DUEÑO: pulsa «Approve» en ${prUrl(visible.pr)} (desde tu teléfono o navegador, fuera de esta PC). Espero hasta 30 minutos.\n\n`);
    ownerApproval.asked = true;
  }, 30 * MINUTE);

  it('PIEZA-COMPLETA: a complete behaviour piece passes every stage of the judge', async () => {
    const piece = await openPiece('completa', completeFiles);
    await builderEvent(piece);
    await verdict(piece, piece.head);
    const result = await judged(piece, ['success', 'failure', 'error']);
    expect(result.status.state, JSON.stringify(result.stages)).toBe('success');
    expect(notPassing(result.stages)).toEqual([]);
    record({ id: 'PIEZA-COMPLETA', attempt: 'Una pieza completa, sin trampa, como control de todo lo demás', stoppedBy: [], negative: 'frenado', positive: 'no-aplica', result: 'pasó', evidence: [prUrl(piece.pr), runUrl(result.status)] });
  }, 30 * MINUTE);

  it('CN-01: the benchmark cites a single vendor; only the benchmark stage fails; three sources pass', async () => {
    const piece = await openPiece('benchmark', (n) => ({
      ...completeFiles(n),
      [`docs/plans/PLAN-${n}.md`]: planOf(n, 'comportamiento', ['https://productive.io/a', 'https://productive.io/b', 'https://docs.productive.io/c']),
    }));
    await builderEvent(piece);
    await verdict(piece, piece.head);
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['benchmark']);
    await tryToMerge(piece);
    await stillOpen(piece);
    await change(piece, { [`docs/plans/PLAN-${piece.n}.md`]: planOf(piece.n, 'comportamiento') }, 'tres fuentes distintas');
    await verdict(piece, piece.head);
    const fixed = await judged(piece, ['success', 'failure', 'error']);
    expect(fixed.status.state, JSON.stringify(fixed.stages)).toBe('success');
    record({ id: 'CN-01', attempt: 'Avanzar con un benchmark que solo cita a un proveedor', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)] });
  }, 40 * MINUTE);

  it('CN-02: a verdict from the builder session under another model name fails only the review; another session passes', async () => {
    const piece = await openPiece('autorrevision', completeFiles);
    await builderEvent(piece);
    await verdict(piece, piece.head, identity('deepseek', BUILDER.session, 'deepseek-flash-otra-etiqueta'));
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['review']);
    await tryToMerge(piece);
    await stillOpen(piece);
    await verdict(piece, piece.head, identity('deepseek', 'otra-sesion'));
    const fixed = await judged(piece, ['success', 'failure', 'error']);
    expect(fixed.status.state, JSON.stringify(fixed.stages)).toBe('success');
    record({ id: 'CN-02', attempt: 'El constructor se revisa a sí mismo con otro nombre de modelo', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)] });
  }, 40 * MINUTE);

  it('CN-03 and CN-03e: a verdict of an older head does not count; editing or deleting a verdict withdraws the green', async () => {
    const piece = await openPiece('diff-viejo', completeFiles);
    await builderEvent(piece);
    const old = piece.head;
    await verdict(piece, old);
    await change(piece, { [`docs/plans/nota-${piece.n}.md`]: 'nada\n' }, 'otra versión');
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['review']);
    expect(refused.stages['review']?.reason).toMatch(new RegExp(old.slice(0, 7)));
    await tryToMerge(piece);
    await stillOpen(piece);
    const comment = await verdict(piece, piece.head);
    const green = await judged(piece, ['success', 'failure', 'error']);
    expect(green.status.state, JSON.stringify(green.stages)).toBe('success');
    record({ id: 'CN-03', attempt: 'Usar la revisión de una versión anterior para la versión nueva', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(green.status)] });

    // CN-03e: the verdict is edited (the judge runs by itself) and the green goes away.
    piece.mark = statuses(piece.head).length;
    await asAgent('api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${comment}`, '-f', 'body=Veredicto retirado.');
    const edited = await judged(piece, ['failure', 'error']);
    expect(notPassing(edited.stages)).toEqual(['review']);
    const again = await verdict(piece, piece.head);
    await judged(piece, ['success']);
    piece.mark = statuses(piece.head).length;
    await asAgent('api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${again}`);
    const deleted = await judged(piece, ['failure', 'error']);
    expect(notPassing(deleted.stages)).toEqual(['review']);
    record({ id: 'CN-03e', attempt: 'Editar o borrar un veredicto después de que el juez dio verde', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(edited.status), runUrl(deleted.status)] });
  }, 60 * MINUTE);

  it('CN-04: a change that breaks an existing test of the zone fails only the suite stage, the red-test check stays green', async () => {
    const piece = await openPiece('zona-roja', (n) => ({ ...completeFiles(n), 'src/calc/zona.mjs': ZONE(2) }));
    await builderEvent(piece);
    await verdict(piece, piece.head);
    expect((await checkDone(piece.head, 'todo-verde')).conclusion).toBe('failure');
    expect((await checkDone(piece.head, 'ai-workflows/red-test')).conclusion).toBe('success');
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['suite']);
    await tryToMerge(piece);
    await stillOpen(piece);
    await change(piece, { 'src/calc/zona.mjs': ZONE(1) }, 'la zona vuelve a valer 1');
    await verdict(piece, piece.head);
    expect((await checkDone(piece.head, 'todo-verde')).conclusion).toBe('success');
    const fixed = await judged(piece, ['success', 'failure', 'error']);
    expect(fixed.status.state, JSON.stringify(fixed.stages)).toBe('success');
    record({ id: 'CN-04', attempt: 'Declarar todo en verde con una prueba de la zona en rojo', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)] });
  }, 40 * MINUTE);

  it('CN-09: a visible file that imports the database fails only the boundary stage', async () => {
    const piece = await openPiece('frontera', (n) => ({ ...completeFiles(n), [`components/lista-${n}.mjs`]: 'import { db } from "../src/db/cliente.mjs";\nexport const lista = db;\n', [`docs/plans/PLAN-${n}.md`]: planOf(n, 'comportamiento') }));
    await builderEvent(piece);
    await verdict(piece, piece.head);
    expect((await checkDone(piece.head, 'fronteras')).conclusion).toBe('failure');
    const refused = await judged(piece, ['failure', 'pending'], ['red-test', 'suite', 'boundaries']);
    // It touches components/, so the owner approval applies too; it waits for the owner on top.
    expect(notPassing(refused.stages)).toEqual(['approval', 'boundaries']);
    expect(refused.stages['boundaries']?.outcome).toBe('rejected');
    await tryToMerge(piece);
    await stillOpen(piece);
    await change(piece, { [`components/lista-${piece.n}.mjs`]: 'export const lista = [];\n' }, 'sin tocar la base');
    await verdict(piece, piece.head);
    expect((await checkDone(piece.head, 'fronteras')).conclusion).toBe('success');
    const fixed = await judged(piece, ['pending', 'success', 'failure', 'error'], ['red-test', 'suite', 'boundaries']);
    expect(notPassing(fixed.stages)).toEqual(['approval']);
    expect(fixed.stages['boundaries']?.outcome).toBe('passed');
    record({ id: 'CN-09', attempt: 'Cruzar la frontera: algo visible importa la base de datos', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)] });
  }, 40 * MINUTE);

  it('CN-10: a piece declared visual that touches money is judged as behaviour; a visual piece outside money stays visual', async () => {
    const piece = await openPiece('solo-visual-con-dinero', (n) => ({
      [`docs/plans/PLAN-${n}.md`]: planOf(n, 'solo visual'),
      [`src/calc/p${n}.mjs`]: `export const p${n} = () => ${n};\n`,
    }));
    const refused = await judged(piece, ['failure', 'pending', 'error']);
    for (const stage of ['spec', 'benchmark', 'red-test', 'suite', 'boundaries', 'review']) {
      expect(refused.stages[stage]?.outcome, stage).not.toBe('skipped');
    }
    expect(notPassing(refused.stages)).toEqual(expect.arrayContaining(['review']));
    await tryToMerge(piece);
    await stillOpen(piece);
    const control = await openPiece('solo-visual', (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'solo visual'), 'estilos/tema.css': `body { color: #${String(n).padStart(6, '0').slice(-6)}; }\n` }));
    const green = await judged(control, ['success', 'failure', 'error']);
    expect(green.status.state, JSON.stringify(green.stages)).toBe('success');
    for (const stage of ['spec', 'benchmark', 'red-test', 'suite', 'boundaries', 'review', 'approval']) {
      expect(green.stages[stage]?.outcome, stage).toBe('skipped');
    }
    record({ id: 'CN-10', attempt: 'Declarar «solo visual» una pieza que toca el cálculo de dinero', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), prUrl(control.pr), runUrl(green.status)] });
  }, 40 * MINUTE);

  it('CN-11a: a builder that weakens the given test so it passes on main fails only the red test; CN-11b is the declared limit', async () => {
    const piece = await openPiece('prueba-debilitada', (n) => ({
      ...completeFiles(n),
      [`tests/suite/p${n}.test.mjs`]: lines('import assert from "node:assert/strict";', `export const cases = { "la pieza ${n} existe": () => assert.ok(true) };`),
    }));
    await builderEvent(piece);
    await verdict(piece, piece.head);
    expect((await checkDone(piece.head, 'ai-workflows/red-test')).conclusion).toBe('failure');
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['red-test']);
    await tryToMerge(piece);
    await stillOpen(piece);
    await change(piece, completeFiles(piece.n), 'la prueba entregada, intacta');
    await verdict(piece, piece.head);
    const fixed = await judged(piece, ['success', 'failure', 'error']);
    expect(fixed.status.state, JSON.stringify(fixed.stages)).toBe('success');
    record({ id: 'CN-11a', attempt: 'El constructor debilita la prueba entregada para que pase sin su código', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)] });
    record({ id: 'CN-11b', attempt: 'Editar la prueba entregada y devolverla igual, byte por byte: nadie puede verlo (límite declarado del plan)', stoppedBy: [], negative: 'limite', positive: 'no-aplica', evidence: [prUrl(piece.pr)] });
  }, 40 * MINUTE);

  it('SV-08: a journal forged by hand in the state refs does not stand in for the missing verdict', async () => {
    const piece = await openPiece('diario-falso', completeFiles);
    await builderEvent(piece);
    const forged = await sandbox.forgeStateRef(`refs/ai-workflows/pieces/${piece.n}`, { stage: 'review', outcome: 'passed', note: 'marcado a mano' });
    const refused = await judged(piece, ['failure']);
    expect(notPassing(refused.stages)).toEqual(['review']);
    record({ id: 'SV-08', attempt: 'Marcar a mano en el diario del motor que la revisión ya se hizo', stoppedBy: ['juez'], negative: 'frenado', positive: 'no-aplica', evidence: [prUrl(piece.pr), runUrl(refused.status), `https://github.com/${REPO}/commit/${forged}`] });
  }, 30 * MINUTE);

  it('CN-07: without a piece the hooks refuse and Claude Code writes nothing; with --no-verify the judge still refuses', async () => {
    engine = buildEngine();
    const local = mkdtempSync(join(tmpdir(), 'aiw-cn07-'));
    folders.push(local);
    gh('repo', 'clone', REPO, local, '--', '-q');
    git(local, 'config', 'user.email', 'agentes@example.com');
    git(local, 'config', 'user.name', 'agentes');
    git(local, 'switch', '-q', '-c', `arreglo-${sandbox.run}`);
    engine.install(local);
    const installed = await installHooks({ root: local, apply: true });
    expect(installed.ok, installed.text).toBe(true);

    // The installed Claude hook, run as written, refuses code and lets papers through.
    const settings = JSON.parse(readFileSync(join(local, '.claude', 'settings.json'), 'utf8')) as { hooks: { PreToolUse: { hooks: { command: string; args: string[] }[] }[] } };
    const handler = settings.hooks.PreToolUse.flatMap((group) => group.hooks).find((item) => item.command === 'node');
    if (handler === undefined) throw new Error('no node hook');
    const hook = (file: string) => spawnSync(process.execPath, handler.args.map((arg) => arg.replaceAll('${CLAUDE_PROJECT_DIR}', local)), {
      cwd: local, input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(local, file), content: 'x\n' }, cwd: local }), encoding: 'utf8',
    });
    expect(JSON.parse(hook('src/calc/x.mjs').stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(hook('docs/nota.md').stdout).toBe('');

    // Claude Code itself (§1.6). It must really run (exit 0), and the same request must write the
    // file on a piece branch; otherwise "the file is absent" would prove nothing.
    const askClaude = (file: string) => {
      // Without a shell: through one, Windows split the request into words and Claude Code got
      // only «Crea» (seen in the real run). The request goes on standard input.
      const run = spawnSync('claude', ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Write'], {
        cwd: local,
        encoding: 'utf8',
        timeout: 5 * MINUTE,
        input: `Crea el archivo ${file} con el contenido "export const x = 1;". Usa la herramienta Write. No hagas nada más.`,
      });
      log(`claude (${git(local, 'rev-parse', '--abbrev-ref', 'HEAD')}): status ${run.status} ${String(run.stdout).slice(0, 300)}`);
      expect(run.status, String(run.stderr)).toBe(0);
      return spawnSync('git', ['status', '--porcelain', '--', file], { cwd: local, encoding: 'utf8' }).stdout.trim() !== '';
    };
    expect(askClaude('src/calc/intento.mjs')).toBe(false);
    const noPieceBranch = git(local, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(local, 'switch', '-q', '-c', `feat/999998-${sandbox.run}`);
    expect(askClaude('src/calc/con-pieza-claude.mjs')).toBe(true);
    git(local, 'clean', '-qfd', '--', 'src/calc');
    git(local, 'switch', '-q', noPieceBranch);
    // With the engine gone, the loader blocks: Claude Code writes nothing, even on a piece branch.
    git(local, 'switch', '-q', `feat/999998-${sandbox.run}`);
    // Only the link goes, never the built engine it points at.
    rmSync(join(local, 'node_modules', 'ai-workflows'), { force: true });
    expect(askClaude('src/calc/sin-motor.mjs')).toBe(false);
    engine.install(local);
    git(local, 'switch', '-q', noPieceBranch);

    // The git hook refuses the commit; the attempt goes on with --no-verify and a pushed branch.
    write(local, 'src/calc/sin-pieza.mjs', 'export const sinPieza = 1;\n');
    git(local, 'add', 'src/calc/sin-pieza.mjs');
    const before = git(local, 'rev-parse', 'HEAD');
    expect(spawnSync('git', ['commit', '-q', '-m', 'sin pieza'], { cwd: local, encoding: 'utf8' }).status).not.toBe(0);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    git(local, 'commit', '-q', '--no-verify', '-m', 'sin pieza, saltando el gancho');
    const branch = `arreglo-${sandbox.run}`;
    await agentGit(local, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    const url = await asAgent('pr', 'create', '--repo', REPO, '--head', branch, '--base', 'main', '--title', `Suite negativa · sin pieza ${sandbox.run}`, '--body', 'Intento CN-07 (PLAN-13-R5). Se cierra solo.');
    const pr = Number(url.split('/').at(-1));
    await sandbox.trackPullRequest(pr, branch);
    const head = git(local, 'rev-parse', 'HEAD');
    const refused = await settled(head, ['failure']);
    expect(refused.description).toMatch(/pieza/);
    await asAgent('pr', 'merge', String(pr), '--repo', REPO, '--squash', '--auto').catch(() => undefined);
    await sleep(60_000);
    expect(prState(pr).state).toBe('OPEN');

    // Positive: on a piece branch the hook and the commit pass.
    git(local, 'switch', '-q', '-c', `feat/999999-${sandbox.run}`, before);
    expect(hook('src/calc/x.mjs').stdout).toBe('');
    write(local, 'src/calc/con-pieza.mjs', 'export const conPieza = 1;\n');
    git(local, 'add', 'src/calc/con-pieza.mjs');
    expect(spawnSync('git', ['commit', '-q', '-m', 'con pieza'], { cwd: local, encoding: 'utf8' }).status).toBe(0);
    record({ id: 'CN-07', attempt: 'Escribir código sin una pieza activa, y luego saltarse el gancho con --no-verify', stoppedBy: ['gancho', 'juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(pr), runUrl(refused)] });
  }, 40 * MINUTE);

  it('SV-04s: a pull request that rewrites the review signal is refused by the official judge and its imitation is traced', async () => {
    const piece = await openPiece('senal-alterada', (n) => ({
      [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles'),
      [SIGNAL_WORKFLOW]: lines(
        'name: ai-workflows review signal',
        'on:',
        '  pull_request_review:',
        '    types: [submitted, dismissed]',
        'permissions: { statuses: write }',
        'jobs:',
        '  imitar:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - env:',
        '          GH_TOKEN: ${{ github.token }}',
        '          SHA: ${{ github.event.pull_request.head.sha }}',
        '        run: gh api "repos/$GITHUB_REPOSITORY/statuses/$SHA" -f state=success -f context=ai-workflows -f description=imitado -f target_url=https://example.com/imitado',
      ),
    }), { workflowByOwner: true });
    const refused = await settled(piece.head, ['failure']);
    expect(refused.description).toMatch(/approve-judge-change|juez/);
    await asAgent('api', '-X', 'POST', `repos/${REPO}/pulls/${piece.pr}/reviews`, '-f', 'event=COMMENT', '-f', 'body=Revisión de comentario que dispara la señal.');
    await waitFor('the imitated status', () => statuses(piece.head).find((status) => status.target_url === 'https://example.com/imitado'));
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${piece.pr}`);
    const trace = await waitFor('the trace comment', () => {
      const comments = ghJson<{ body: string }[][]>('api', `repos/${REPO}/issues/${piece.pr}/comments`, '--paginate', '--slurp').flat();
      return comments.find((comment) => comment.body.includes('ai-workflows:trace') && comment.body.includes('https://example.com/imitado'));
    });
    expect(trace).toBeDefined();
    const observed = ghJson<{ mergeStateStatus: string }>('pr', 'view', String(piece.pr), '--repo', REPO, '--json', 'mergeStateStatus');
    log(`SV-04s: with the imitated status GitHub reports mergeStateStatus=${observed.mergeStateStatus} (not tried, R13)`);

    // Positive: another PR that only changes a comment of the signal, with the owner attestation (R22).
    const other = await openPiece('senal-comentario', (n) => ({
      [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles'),
      [SIGNAL_WORKFLOW]: `${readFileSync(join(ENGINE_ROOT, 'templates', 'ai-workflows-review-signal.yml'), 'utf8')}# comentario ${n}\n`,
    }), { workflowByOwner: true });
    await settled(other.head, ['failure']);
    gh('pr', 'comment', String(other.pr), '--repo', REPO, '--body', `/approve-judge-change ${other.head.slice(0, 16)}`);
    const accepted = await waitFor('the judge after the attestation', () => (latest(other.head)?.state === 'success' ? latest(other.head) : undefined));
    record({ id: 'SV-04s', attempt: `Un PR reescribe la señal de revisión para imitar al juez. GitHub no dejó subir el cambio a los agentes (su aplicación no tiene permiso sobre los flujos); para ensayar también el juez, la suite lo subió con la cuenta del dueño (R22). Lo que GitHub mostró con el estado imitado: ${observed.mergeStateStatus}; la fusión no se ensayó (R13)`, stoppedBy: ['github', 'juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr), runUrl(refused), prUrl(other.pr), runUrl(accepted as Status)], owner: { ordersBySuite: ['/approve-judge-change'], pushesBySuite: true } });
  }, 40 * MINUTE);

  it('CN-06: a cut between arming the merge and recording it is reconciled, never armed twice', async () => {
    // The engine opens the pull request itself: one opened by the suite carries no engine mark, and
    // the engine rightly refuses to take over a pull request it cannot tell is its own (real run).
    const piece = await openPiece('corte', (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') }), { pullRequest: false });
    const folder = mkdtempSync(join(tmpdir(), 'aiw-cn06-'));
    folders.push(folder);
    gh('repo', 'clone', REPO, folder, '--', '-q');
    git(folder, 'config', 'user.email', 'agentes@example.com');
    git(folder, 'config', 'user.name', 'agentes');
    git(folder, 'fetch', '-q', 'origin', piece.branch);
    git(folder, 'switch', '-q', piece.branch);
    const credentials = agentCredentialsFromEnv(process.env, folder);
    if (!('appId' in credentials)) throw new Error('credentials');
    const tokens = createAppTokenSource({ credentials, repository: REPO });
    const edges = createAgentEdges({ repository: REPO, runner: createGhRunner(), tokenSource: tokens, root: folder });
    const runner = createGhRunner();
    const real = createGitHubStatePort({
      owner: REPO.split('/')[0] ?? '',
      repo: REPO.split('/')[1] ?? '',
      run: async (args, input) => runner(args, input, { GH_TOKEN: await tokens.token() }),
    });
    const cut = { done: false };
    // The write that would move the merge effect from pending to confirmed never reaches GitHub,
    // as if the connection dropped right after arming the merge (§2.5).
    const cutting: StatePort = {
      head: (name) => real.head(name),
      refs: (prefix) => real.refs(prefix),
      read: (commitSha, path) => real.read(commitSha, path),
      async commit(name, parent, changes, message) {
        // The store names the merge effect `merge:<pr>:<sha>` (src/blocks/github-merge.ts); the
        // second real run looked for `merge:<sha>` and never cut.
        if (!cut.done && /confirm effect merge:\d+:[0-9a-f]{40} /.test(message)) {
          cut.done = true;
          throw new Error('corte de red justo antes de registrar que la fusión quedó armada');
        }
        return real.commit(name, parent, changes, message);
      },
    };
    const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({ cwd: folder, env: process.env as Record<string, string>, github: edges.github, remote: edges.remote, statePort: real, ...over });

    // Whatever happens to the first run, every pull request the engine opened is handed to the
    // harness, so the clean-up closes it (flock round 8).
    let opened: { number: number }[] = [];
    let handOver: unknown;
    try {
      const first = await runAgentCli(['run', String(piece.n)], deps({ statePort: cutting }));
      log(first.text);
    } finally {
      // A failure here never hides the error of the run itself: it is logged, and thrown below
      // when the run did not fail (flock round 9).
      try {
        opened = ghJson<{ number: number }[]>('pr', 'list', '--repo', REPO, '--head', piece.branch, '--state', 'all', '--json', 'number');
        for (const item of opened) await sandbox.trackPullRequest(item.number, piece.branch);
      } catch (error) {
        handOver = error;
        log(`CN-06: could not hand the engine's pull request to the harness: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (handOver !== undefined) throw handOver;
    expect(opened).toHaveLength(1);
    piece.pr = opened[0]?.number ?? 0;
    expect(cut.done).toBe(true);
    expect((await mergeEffect(piece.n)).state).toBe('pending');

    // A new run resumes. If it stops on a technical failure (the fifth real run: GitHub answered
    // «malformed request» to a lease renewal), it is run again, as the engine itself asks («vuelve
    // a ejecutarla con run»), up to three times. What is required does not change.
    let settledEffect = await mergeEffect(piece.n);
    try {
      for (let attempt = 1; attempt <= 3 && (settledEffect.state === 'pending' || settledEffect.state === 'uncertain'); attempt += 1) {
        const outcome = await runAgentCli(['run', String(piece.n)], deps());
        log(`CN-06 resume ${attempt}: ${outcome.text}`);
        settledEffect = await mergeEffect(piece.n);
      }
    } finally {
      // The merge is noted whatever the assertions say, so the clean-up never trips on it.
      if (await waitFor(`PR #${piece.pr} merged`, () => (prState(piece.pr).state === 'MERGED' ? true : undefined), 30 * MINUTE).catch(() => false)) {
        await sandbox.noteMerged(piece.pr);
      }
    }
    expect(settledEffect).toEqual({ state: 'confirmed', byReconciliation: true });
    const history = ghJson<{ timelineItems: { nodes: { __typename: string }[] } }>('api', 'graphql', '-f', `query=query { repository(owner: "${REPO.split('/')[0]}", name: "${REPO.split('/')[1]}") { pullRequest(number: ${piece.pr}) { timelineItems(first: 100, itemTypes: [AUTO_MERGE_ENABLED_EVENT]) { nodes { __typename } } } } }`, '--jq', '.data.repository.pullRequest');
    expect(history.timelineItems.nodes).toHaveLength(1);
    record({ id: 'CN-06', attempt: 'El motor se corta entre armar la fusión y registrarlo; otra corrida retoma', stoppedBy: ['motor'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(piece.pr)] });
  }, 60 * MINUTE);

  it('SV-03: each broken dependency blocks only its piece, and a piece of papers merges meanwhile', async () => {
    // B, the piece of papers that must keep entering the queue.
    const papers = await openPiece('papeles', (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') }));
    await settled(papers.head, ['success']);

    // SV-03d: the boundary check never arrives (its workflow is off). A waits; B is not blocked.
    await sandbox.setWorkflowEnabled(BOUNDARY_WORKFLOW, false);
    const down = await openPiece('componente-caido', completeFiles);
    await builderEvent(down);
    await verdict(down, down.head);
    const waiting = await judged(down, ['pending', 'failure', 'error']);
    expect(waiting.status.state).toBe('pending');
    expect(notPassing(waiting.stages)).toEqual(['boundaries']);

    // SV-03c: the plan of A is a folder; the engine throws inside the judge for this PR only.
    const internal = await openPiece('fallo-interno', (n) => ({ ...completeFiles(n), [`docs/plans/PLAN-${n}.md`]: null, [`docs/plans/PLAN-${n}.md/dentro.md`]: 'Tipo de cambio: comportamiento\n' }));
    const technical = await settled(internal.head, ['error']);

    // SV-03a: the store of a piece is unreadable. The agent's engine blocks that piece; the judge
    // keeps judging it the same way (it never reads the store).
    const corrupted = await openPiece('almacen-roto', completeFiles);
    await builderEvent(corrupted);
    const judgedBefore = await judged(corrupted, ['failure']);
    await sandbox.forgeStateRef(`refs/ai-workflows/pieces/${corrupted.n}`, 'esto no es un diario');
    const agentFolder = mkdtempSync(join(tmpdir(), 'aiw-sv03-'));
    folders.push(agentFolder);
    gh('repo', 'clone', REPO, agentFolder, '--', '-q');
    git(agentFolder, 'fetch', '-q', 'origin', corrupted.branch);
    git(agentFolder, 'switch', '-q', corrupted.branch);
    const blocked = await runAgentCli(['run', String(corrupted.n)], { cwd: agentFolder, env: process.env as Record<string, string> });
    log(blocked.text);
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toMatch(/técnic|almacén|leer/i);
    corrupted.mark = statuses(corrupted.head).length;
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${corrupted.pr}`);
    await sleep(90_000);
    const judgedAfter = await judged(corrupted, ['failure', 'error']);
    expect(judgedAfter.status.state).toBe(judgedBefore.status.state);

    // SV-03b: the review provider is not installed. The agent's review of A is technical; no verdict.
    // A complete order, so the stop comes from the missing provider and not from the order itself:
    // the fifth real run found this call without its options, refused as "Usage", and counted as
    // stopped. Only the folders that hold the provider are taken out of PATH; git stays.
    // The prompt lives outside the folder: a new file inside it would be refused as unsaved work.
    const promptName = `${basename(agentFolder)}-revision.md`;
    writeFileSync(join(dirname(agentFolder), promptName), 'Revisa la pieza.\n');
    const withoutClaude = (process.env['PATH'] ?? '').split(delimiter)
      .filter((dir) => dir !== '' && !['claude', 'claude.exe', 'claude.cmd'].some((name) => existsSync(join(dir, name))))
      .join(delimiter);
    const commentsBefore = ghJson<unknown[][]>('api', `repos/${REPO}/issues/${corrupted.n}/comments`, '--paginate', '--slurp').flat().length;
    const noProvider = await runAgentCli(
      ['review', String(corrupted.n), '--provider', 'claude', '--model', 'claude-opus', '--prompt', `../${promptName}`, '--angle', 'correctness'],
      { cwd: agentFolder, env: { ...(process.env as Record<string, string>), PATH: withoutClaude, Path: withoutClaude } },
    );
    log(noProvider.text);
    expect(noProvider.ok).toBe(false);
    expect(noProvider.text).not.toMatch(/^Usage/);
    // What the engine says when the provider cannot be started (tried on this machine).
    expect(noProvider.text).toMatch(/could not start the process|no se pudo iniciar/i);
    expect(ghJson<unknown[][]>('api', `repos/${REPO}/issues/${corrupted.n}/comments`, '--paginate', '--slurp').flat().length).toBe(commentsBefore);

    // Meanwhile B enters the queue and merges.
    await asAgent('pr', 'merge', String(papers.pr), '--repo', REPO, '--squash', '--auto');
    await waitFor(`PR #${papers.pr} merged`, () => (prState(papers.pr).state === 'MERGED' ? true : undefined), 30 * MINUTE);
    await sandbox.noteMerged(papers.pr);

    // With advisory and off, the piece whose check is missing is not blocked.
    await sandbox.setVariable('advisory');
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${down.pr}`);
    await waitFor('green in advisory', () => (latest(down.head)?.state === 'success' ? true : undefined));
    await sandbox.setVariable('off');
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${down.pr}`);
    await waitFor('green with the engine off', () => (latest(down.head)?.description.includes('motor apagado') ? true : undefined));
    await sandbox.setVariable('on');
    await sandbox.setWorkflowEnabled(BOUNDARY_WORKFLOW, true);

    const evidenceB = [prUrl(papers.pr)];
    record({ id: 'SV-03a', attempt: 'El diario del motor de una pieza queda ilegible', stoppedBy: ['motor'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(corrupted.pr), ...evidenceB] });
    record({ id: 'SV-03b', attempt: 'El proveedor de modelos de la revisión no está', stoppedBy: ['motor'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(corrupted.pr), ...evidenceB] });
    record({ id: 'SV-03c', attempt: 'El motor encuentra algo que no sabe manejar al juzgar un solo PR', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(internal.pr), runUrl(technical), ...evidenceB] });
    record({ id: 'SV-03d', attempt: 'Un check exigido nunca llega (su flujo está apagado)', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(down.pr), runUrl(waiting.status), ...evidenceB] });
  }, 90 * MINUTE);

  it('COLA-6: six pieces of papers armed at once in the real queue all merge, each group judged', async () => {
    const pieces: Piece[] = [];
    for (let index = 0; index < 6; index += 1) {
      pieces.push(await openPiece(`cola-${index}`, (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') })));
    }
    for (const piece of pieces) await settled(piece.head, ['success']);
    for (const piece of pieces) await asAgent('pr', 'merge', String(piece.pr), '--repo', REPO, '--squash', '--auto');
    // The rehearsal's own queue lock may fail on a GitHub server error: see `rerunQueueLock`.
    const reruns: number[] = [];
    const rerunIfServerError = (piece: Piece): void => rerunQueueLock(piece, reruns);
    const noted: number[] = [];
    try {
      for (const piece of pieces) {
        // `waitFor` only logs what a probe throws; a closed pull request or a lock refused for a
        // real reason must end the case at once, not after an hour (final review of part 5).
        let fatal: unknown;
        await waitFor(`PR #${piece.pr} merged`, () => {
          try {
            const state = prState(piece.pr).state;
            if (state === 'CLOSED') throw new Error(`PR #${piece.pr} was closed without merging`);
            if (state === 'MERGED') return true;
            for (const other of pieces) rerunIfServerError(other);
            return undefined;
          } catch (error) {
            if (error instanceof Error && /closed without merging|other than a GitHub server error/.test(error.message)) {
              fatal = error;
              return true;
            }
            throw error;
          }
        }, 60 * MINUTE, 30_000);
        if (fatal !== undefined) throw fatal;
        await sandbox.noteMerged(piece.pr);
        noted.push(piece.pr);
      }
    } finally {
      // Whatever failed, every piece that did merge is noted, so the clean-up never trips on it
      // (seen in the seventh real run: two merges after the stuck piece went unnoted).
      for (const piece of pieces) {
        if (!noted.includes(piece.pr) && prState(piece.pr).state === 'MERGED') await sandbox.noteMerged(piece.pr);
      }
    }
    const rerunNote = reruns.length === 0 ? '' : ` (GitHub falló con un error de servidor el candado propio del ensayo en ${reruns.map((pr) => `#${pr}`).join(', ')}; la suite lo relanzó una vez con la cuenta del dueño)`;
    record({ id: 'COLA-6', attempt: `Seis piezas de papeles armadas a la vez en la cola${rerunNote}`, stoppedBy: [], negative: 'frenado', positive: 'no-aplica', result: 'pasó', evidence: pieces.map((piece) => prUrl(piece.pr)) });
  }, 90 * MINUTE);

  it('CN-05b positive: after the owner pressed Approve, the judge ran by itself and passed', async () => {
    expect(ownerApproval.asked).toBe(true);
    await waitFor('the owner approval', () => {
      const reviews = ghJson<{ user: { login: string }; state: string; commit_id: string }[]>('api', `repos/${REPO}/pulls/${visible.pr}/reviews`);
      return reviews.some((review) => review.user.login.toLowerCase() === OWNER.toLowerCase() && review.state === 'APPROVED' && review.commit_id === visible.head) ? true : undefined;
    }, 30 * MINUTE, 15_000);
    const passed = await judged(visible, ['success']);
    expect(notPassing(passed.stages)).toEqual([]);
    record({ id: 'CN-05b', attempt: 'Cerrar una pieza visible sin la aprobación del dueño', stoppedBy: ['juez'], negative: 'frenado', positive: 'pasó', evidence: [prUrl(visible.pr), runUrl(passed.status)], owner: { button: true } });
  }, 35 * MINUTE);
});

// ---------------------------------------------------------------------------------------------
// PLAN-13-R6 §11 (R29): the real evidence of slice 6. Only the cases that touch what slice 6 adds,
// with the same harness, pieces and records as the cases above. `AI_WORKFLOWS_SUITE_SLICE=6 pnpm
// test:github:report` runs only these (their names start with «R29:»); the report then refers to
// the report of 29-sep for the rest of the suite. None of them needs the owner's Approve button.

const RUN_URL = (id: number | string) => `https://github.com/${REPO}/actions/runs/${id}`;

interface JudgeRun { id: number; event: string; status: string; conclusion: string | null; head_sha: string; html_url: string }
interface JobInfo { started_at: string | null; completed_at: string | null; steps?: { name: string; status: string; conclusion: string | null }[] }

/** The newest runs of the judge workflow (one page is plenty inside one case). */
function newestJudgeRuns(): JudgeRun[] {
  return ghJson<{ workflow_runs: JudgeRun[] }>('api', `repos/${REPO}/actions/workflows/ai-workflows.yml/runs?per_page=100`).workflow_runs;
}

/** The id of the newest run of the judge: run ids only grow, so it marks "from here on". */
function lastJudgeRunId(): number {
  return Math.max(0, ...newestJudgeRuns().map((run) => run.id));
}

/** The runs of the judge created after a known run id. */
function judgeRunsAfter(afterId: number): JudgeRun[] {
  const runs = newestJudgeRuns();
  const after = runs.filter((run) => run.id > afterId);
  if (after.length === runs.length && runs.length >= 100) throw new Error(`more than 100 judge runs after ${afterId}: the case cannot tell them apart`);
  return after;
}

function judgeRun(id: number): JudgeRun {
  return ghJson<JudgeRun>('api', `repos/${REPO}/actions/runs/${id}`);
}

function jobsOf(id: number): JobInfo[] {
  return ghJson<{ jobs: JobInfo[] }>('api', `repos/${REPO}/actions/runs/${id}/jobs?filter=all&per_page=100`).jobs;
}

/** A run «started» when one of its steps really ran; a run that waited in its group and was replaced has none. */
const ranSteps = (jobs: readonly JobInfo[]): boolean =>
  jobs.some((job) => (job.steps ?? []).some((step) => step.status === 'in_progress' || step.conclusion === 'success' || step.conclusion === 'failure'));

/** Waits until no run of the judge created after `afterId` is still queued or running. */
async function judgeIdle(afterId: number): Promise<void> {
  await waitFor('the judge runs to end', () => (judgeRunsAfter(afterId).every((run) => run.status === 'completed') ? true : undefined), 20 * MINUTE, 15_000);
}

/** Waits until a piece armed in the queue is merged, noting the merge for the harness whatever happens. */
async function mergedThroughQueue(piece: Piece, reruns: number[]): Promise<void> {
  let fatal: unknown;
  try {
    await waitFor(`PR #${piece.pr} merged`, () => {
      try {
        const state = prState(piece.pr).state;
        if (state === 'CLOSED') throw new Error(`PR #${piece.pr} was closed without merging`);
        if (state === 'MERGED') return true;
        rerunQueueLock(piece, reruns);
        return undefined;
      } catch (error) {
        if (error instanceof Error && /closed without merging|other than a GitHub server error/.test(error.message)) {
          fatal = error;
          return true;
        }
        throw error;
      }
    }, 60 * MINUTE, 30_000);
  } finally {
    if (prState(piece.pr).state === 'MERGED') await sandbox.noteMerged(piece.pr);
  }
  if (fatal !== undefined) throw fatal;
}

/** Where a pull request stands with the queue: merged, still in it, or out of it and open. */
function queueState(n: number): { state: string; inQueue: boolean; autoMerge: boolean } {
  const [owner, name] = REPO.split('/');
  const pr = ghJson<{ state: string; mergeQueueEntry: unknown; autoMergeRequest: unknown }>('api', 'graphql', '-f',
    `query=query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${n}) { state mergeQueueEntry { id } autoMergeRequest { enabledAt } } } }`,
    '--jq', '.data.repository.pullRequest');
  return { state: pr.state, inQueue: pr.mergeQueueEntry !== null, autoMerge: pr.autoMergeRequest !== null };
}

interface RedTestRun { checkRunId: number; status: string; conclusion: string | null; app: string; runId?: number; path?: string }

/**
 * Every check-run named `ai-workflows/red-test` on a SHA, with the workflow file it came from,
 * read the way the judge's chain reads it (R6 §7): check suite → Actions run → workflow → path.
 */
function redTestRuns(sha: string): RedTestRun[] {
  const pages = ghJson<{ check_runs: { id: number; name: string; status: string; conclusion: string | null; app: { slug: string } | null; check_suite: { id: number } | null }[] }[]>(
    'api', `repos/${REPO}/commits/${sha}/check-runs?check_name=${encodeURIComponent('ai-workflows/red-test')}&filter=all&per_page=100`, '--paginate', '--slurp');
  return pages.flatMap((page) => page.check_runs).filter((run) => run.name === 'ai-workflows/red-test').map((run) => {
    const suite = run.check_suite?.id;
    const actionRuns = suite === undefined ? [] : ghJson<{ workflow_runs: { id: number; workflow_id: number }[] }>('api', `repos/${REPO}/actions/runs?check_suite_id=${suite}`).workflow_runs;
    const actionRun = actionRuns.length === 1 ? actionRuns[0] : undefined;
    const path = actionRun === undefined ? undefined : ghJson<{ path: string }>('api', `repos/${REPO}/actions/workflows/${actionRun.workflow_id}`).path;
    return {
      checkRunId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      app: run.app?.slug ?? '',
      ...(actionRun === undefined ? {} : { runId: actionRun.id }),
      ...(path === undefined ? {} : { path }),
    };
  });
}

/** A workflow of the pull request that imitates the red test: its job is named like the official one. */
const IMPOSTOR_RED_TEST = lines(
  'name: ai-workflows red-test',
  'on:',
  '  pull_request:',
  'permissions: { contents: read }',
  'jobs:',
  '  red-test:',
  '    name: ai-workflows/red-test',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: sleep 180',
);
const IMPOSTOR_OTHER_NAME = '.github/workflows/prueba-roja-propia.yml';
const IMPOSTOR_SUFFIXED = '.github/workflows/ai-workflows-red-test.yml@falso.yml';

/** A test that already passes on main: the official red test must fail it. */
const weakTest = (n: number) => lines('import assert from "node:assert/strict";', `export const cases = { "la pieza ${n} existe": () => assert.ok(true) };`);

const CLAUDE_SETTINGS = (withHook: boolean) => `${JSON.stringify({
  hooks: withHook
    ? { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'node', args: ['node_modules/ai-workflows/dist/bin.js', 'hook', 'editor'] }] }] }
    : {},
}, null, 2)}\n`;
const PROJECT_MANIFEST = (engine: string, leftPad: string) => `${JSON.stringify({ name: 'ensayo', private: true, devDependencies: { 'ai-workflows': engine, 'left-pad': leftPad } }, null, 2)}\n`;

/** The judge workflow alone, with or without the `branches` input. */
function judgeWorkflow(branches?: string): string {
  const text = judgeWorkflows(engineSha, branches)[WORKFLOW];
  if (text === undefined) throw new Error('the judge workflow is missing from the templates');
  return text;
}

/** The working branches of R6 §1.1, as the recipe of main and of staging declare them in RAMA. */
const BRANCHES_BLOCK = lines('branches:', '  into: [staging, main]', '  promotions:', '    - { from: staging, to: main }');
const STAGING_SECTION = lines('', '## Prueba en staging', '', 'Se prueba en staging antes de pasar a main.');

/** The recipe of staging: one stage more than main's, which only a pull request into staging must meet. */
function stagingRecipe(): string {
  const recipe = RECIPE();
  const merge = "    after: approval\n    phase: merge\n";
  if (!recipe.includes(merge)) throw new Error('the suite recipe changed: cannot add the stage of staging');
  return `${recipe.replace(merge, lines(
    '    after: solo-staging',
    '    phase: merge',
  )).replace('  - id: merge\n', lines(
    '  - id: solo-staging',
    '    summary: "El plan dice cómo se prueba en staging"',
    '    after: approval',
    '    nature: structure',
    '    applies-if: { kind-any: [behavior] }',
    '    gate:',
    '      uses: ai-workflows/spec-structure@1',
    '      with: { file: "docs/plans/PLAN-{piece}.md", sections: ["Prueba en staging"] }',
    '    server: recompute',
    '  - id: merge',
  ))}${BRANCHES_BLOCK}`;
}

describe.sequential('the evidence of slice 6 on GitHub (PLAN-13-R6 §11, R29)', () => {
  it('R29: SV-04s+: removing the editor hook or changing the engine version is refused; the owner attestation passes; an unrelated dependency passes alone', async () => {
    await sandbox.writeMainFiles({
      '.claude/settings.json': CLAUDE_SETTINGS(true),
      'package.json': PROJECT_MANIFEST('1.0.0', '1.3.0'),
    }, `suite negativa ${sandbox.run}: el gancho del editor y la versión del motor en main (R29)`);
    const papers = (n: number) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') });

    const hook = await openPiece('sin-gancho', (n) => ({ ...papers(n), '.claude/settings.json': CLAUDE_SETTINGS(false) }));
    const hookRefused = await settled(hook.head, ['failure']);
    expect(hookRefused.description).toContain(`/approve-judge-change ${hook.head.slice(0, 16)}`);
    expect(judgeRunLog(hookRefused)).toContain('.claude/settings.json');

    const version = await openPiece('otra-version', (n) => ({ ...papers(n), 'package.json': PROJECT_MANIFEST('1.0.1', '1.3.0') }));
    const versionRefused = await settled(version.head, ['failure']);
    expect(versionRefused.description).toContain(`/approve-judge-change ${version.head.slice(0, 16)}`);
    expect(judgeRunLog(versionRefused)).toContain('package.json');
    await tryToMerge(version);
    await stillOpen(version);

    const unrelated = await openPiece('otra-dependencia', (n) => ({ ...papers(n), 'package.json': PROJECT_MANIFEST('1.0.0', '1.3.1') }));
    const unrelatedPassed = await settled(unrelated.head, ['success', 'failure', 'error']);
    expect(unrelatedPassed.state, unrelatedPassed.description).toBe('success');

    // The owner's attestation for this head, written with the owner's account (R22), as in SV-04s.
    await tryToMerge(hook);
    await stillOpen(hook);
    gh('pr', 'comment', String(hook.pr), '--repo', REPO, '--body', `/approve-judge-change ${hook.head.slice(0, 16)}`);
    const accepted = await waitFor('the judge after the attestation', () => (latest(hook.head)?.state === 'success' ? latest(hook.head) : undefined));
    record({
      id: 'SV-04s+',
      attempt: 'Un PR quita el gancho del editor de .claude/settings.json y otro cambia la versión del motor en package.json, sin la orden del dueño. Control: con la orden del dueño para esa versión el primero pasa, y un PR que solo sube otra dependencia pasa sin orden',
      stoppedBy: ['juez'],
      negative: 'frenado',
      positive: 'pasó',
      evidence: [prUrl(hook.pr), runUrl(hookRefused), runUrl(accepted), prUrl(version.pr), runUrl(versionRefused), prUrl(unrelated.pr), runUrl(unrelatedPassed)],
      owner: { ordersBySuite: ['/approve-judge-change'] },
    });
  }, 45 * MINUTE);

  it('R29: BOT-1: a comment of the agents app with a link on a pull request starts no judgement; the same comment by a person does', async () => {
    const caseStart = lastJudgeRunId();
    const piece = await openPiece('comentario-robot', (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') }));
    await settled(piece.head, ['success']);
    await judgeIdle(caseStart);
    const count = statuses(piece.head).length;
    const body = `Vista previa lista: https://example.com/vista-${sandbox.run}`;

    const beforeBot = lastJudgeRunId();
    const bot = JSON.parse(await asAgent('api', '-X', 'POST', `repos/${REPO}/issues/${piece.pr}/comments`, '-f', `body=${body}`)) as { user: { type: string } };
    expect(bot.user.type).toBe('Bot');
    await sleep(2 * MINUTE);
    await judgeIdle(beforeBot);
    const botRuns = judgeRunsAfter(beforeBot).filter((run) => run.event === 'issue_comment');
    for (const run of botRuns) expect(ranSteps(jobsOf(run.id)), `judge run ${run.id} after the app comment ran its job`).toBe(false);
    expect(statuses(piece.head)).toHaveLength(count);

    // Positive control: the same comment by a person (the owner's account, R22) wakes the judge.
    const beforeOwner = lastJudgeRunId();
    gh('api', '-X', 'POST', `repos/${REPO}/issues/${piece.pr}/comments`, '-f', `body=${body}`);
    const ownerRun = await waitFor('the judge run of the person comment', () => judgeRunsAfter(beforeOwner).find((run) => run.event === 'issue_comment' && run.status === 'completed'), 10 * MINUTE);
    expect(ranSteps(jobsOf(ownerRun.id))).toBe(true);
    expect(ownerRun.conclusion).toBe('success');
    await waitFor('a new judgement on the head', () => (statuses(piece.head).length > count ? true : undefined));
    record({
      id: 'BOT-1',
      attempt: `La aplicación de los agentes comenta en un PR con una dirección, como lo hacen Vercel o Supabase: ${botRuns.length === 0 ? 'GitHub no creó ninguna corrida del juez' : `GitHub creó ${botRuns.length} corrida(s) del juez sin ningún paso corrido`}, y no apareció ningún estado nuevo. Control: el mismo comentario de una persona sí despierta al juez`,
      stoppedBy: ['juez'],
      negative: 'frenado',
      positive: 'pasó',
      evidence: [prUrl(piece.pr), ownerRun.html_url],
    });
  }, 30 * MINUTE);

  it('R29: B-T6: a verdict deleted from the issue and its judge run cancelled leave «juzgando» on the head, never the old green', async () => {
    const piece = await openPiece('veredicto-borrado', completeFiles);
    await builderEvent(piece);
    let green: Status | undefined;
    let caught: { runId: number; status: Status } | undefined;
    // The run is cancelled between its «juzgando» and its verdict; a run that is quicker than the
    // cancellation is not the case, and the attempt is made again with a new verdict.
    for (let attempt = 1; attempt <= 4 && caught === undefined; attempt += 1) {
      const comment = await verdict(piece, piece.head);
      const passed = await judged(piece, ['success', 'failure', 'error']);
      expect(passed.status.state, JSON.stringify(passed.stages)).toBe('success');
      green ??= passed.status;
      const mark = statuses(piece.head).length;
      await asAgent('api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${comment}`);
      const seen = await waitFor('the first status after the verdict was deleted', () => {
        const all = statuses(piece.head);
        if (all.length <= mark) return undefined;
        return all.find((status) => status.context === 'ai-workflows');
      }, 10 * MINUTE, 2_000);
      if (seen.state !== 'pending' || seen.description !== 'juzgando') {
        log(`B-T6 attempt ${attempt}: the first new status was ${seen.state} «${seen.description}», not «juzgando»`);
        continue;
      }
      const runId = Number(/\/actions\/runs\/(\d+)/.exec(seen.target_url ?? '')?.[1] ?? 0);
      expect(judgeRun(runId).event).toBe('issue_comment');
      try {
        gh('run', 'cancel', String(runId), '--repo', REPO);
      } catch (error) {
        log(`B-T6 attempt ${attempt}: cancel refused: ${String((error as { stderr?: string }).stderr ?? error).trim()}`);
        continue;
      }
      const ended = await waitFor('the cancelled run', () => {
        const run = judgeRun(runId);
        return run.status === 'completed' ? run : undefined;
      }, 10 * MINUTE, 5_000);
      await sleep(MINUTE);
      const newest = latest(piece.head);
      if (ended.conclusion !== 'cancelled' || newest?.target_url !== seen.target_url || newest.state !== 'pending') {
        log(`B-T6 attempt ${attempt}: the run ended ${ended.conclusion} and the head shows ${newest?.state} «${newest?.description}»`);
        continue;
      }
      caught = { runId, status: newest };
    }
    if (caught === undefined || green === undefined) throw new Error('no attempt cancelled the run of the deleted verdict between its «juzgando» and its verdict');
    expect(caught.status.state).toBe('pending');
    expect(latest(piece.head)?.state).not.toBe('success');
    record({
      id: 'B-T6',
      attempt: 'Se borra el veredicto que dio el verde y la corrida del juez que eso dispara se cancela a mano antes de terminar: la cabeza queda en «juzgando», no en el verde viejo',
      stoppedBy: ['juez'],
      negative: 'frenado',
      positive: 'pasó',
      evidence: [prUrl(piece.pr), runUrl(green), RUN_URL(caught.runId)],
    });
  }, 60 * MINUTE);

  it('R29: CN-14: an impostor red-test workflow never makes the red test count; the same piece with a real red test passes', async () => {
    // Control first: a complete piece with a real red test. Its official run is also where the
    // chain of R6 §7 is checked against GitHub before relying on it.
    const control = await openPiece('roja-real', completeFiles);
    await builderEvent(control);
    await verdict(control, control.head);
    const official = await waitFor('the official red test of the control', () => redTestRuns(control.head).find((run) => run.path === RED_WORKFLOW && run.status === 'completed'));
    const actionRun = ghJson<{ pull_requests: { number: number; base?: { ref?: string; sha?: string } }[] }>('api', `repos/${REPO}/actions/runs/${official.runId ?? 0}`);
    const listed = actionRun.pull_requests.find((pr) => pr.number === control.pr);
    log(`CN-14: pull_requests of the red-test run ${official.runId}: ${JSON.stringify(actionRun.pull_requests.map((pr) => ({ number: pr.number, base: pr.base })))}`);
    if (listed === undefined || listed.base?.ref !== 'main' || !/^[0-9a-f]{40}$/.test(listed.base.sha ?? '')) {
      const reason = `GitHub no dio en la corrida oficial de la prueba roja lo que usa la cadena del juez: número ${listed === undefined ? 'ausente' : String(listed.number)}, base.ref ${listed?.base?.ref ?? 'ausente'}, base.sha ${listed?.base?.sha ?? 'ausente'}; hay que rediseñar la cadena antes de seguir`;
      record({ id: 'CN-14', attempt: 'Comprobar que la corrida de la prueba roja trae el PR y su base', stoppedBy: [], negative: 'error', positive: 'no-aplica', evidence: [prUrl(control.pr), RUN_URL(official.runId ?? 0)], partial: reason });
      throw new Error(reason);
    }
    const passed = await judged(control, ['success', 'failure', 'error']);
    expect(passed.status.state, JSON.stringify(passed.stages)).toBe('success');

    // The attack: the same piece with a test that already passes on main, plus two impostors.
    const attack = await openPiece('roja-impostora', (n) => ({
      ...completeFiles(n),
      [`tests/suite/p${n}.test.mjs`]: weakTest(n),
      [IMPOSTOR_OTHER_NAME]: IMPOSTOR_RED_TEST,
      [IMPOSTOR_SUFFIXED]: IMPOSTOR_RED_TEST,
    }), { workflowByOwner: true });
    await builderEvent(attack);
    await verdict(attack, attack.head);
    const officialAttack = await waitFor('the official red test of the attack', () => redTestRuns(attack.head).find((run) => run.path === RED_WORKFLOW && run.status === 'completed'));
    expect(officialAttack.conclusion).toBe('failure');
    const impostor = await waitFor('the impostor red test', () => redTestRuns(attack.head).find((run) => run.path === IMPOSTOR_OTHER_NAME && run.status === 'completed'), 20 * MINUTE);
    expect(impostor.conclusion).toBe('success');
    // Whether GitHub runs the file whose name carries the official one plus «@falso.yml» is noted.
    await sleep(2 * MINUTE);
    const all = redTestRuns(attack.head);
    const suffixed = all.filter((run) => run.path === IMPOSTOR_SUFFIXED);
    log(`CN-14: check-runs named ai-workflows/red-test on the attack: ${JSON.stringify(all.map((run) => ({ path: run.path, app: run.app, conclusion: run.conclusion })))}`);

    // The judge again, by hand, once every impostor ended (R22: the owner's account).
    attack.mark = statuses(attack.head).length;
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${attack.pr}`);
    const refused = await judged(attack, ['failure', 'pending', 'error'], ['red-test']);
    expect(refused.status.state).not.toBe('success');
    expect(notPassing(refused.stages)).toEqual(['red-test']);
    await tryToMerge(attack);
    await stillOpen(attack);
    const ranSuffixed = suffixed.length === 0
      ? 'GitHub no ejecutó el archivo con el nombre del oficial más «@falso.yml»'
      : `GitHub sí ejecutó el archivo con el nombre del oficial más «@falso.yml» (${suffixed.map((run) => run.conclusion ?? run.status).join(', ')}) y tampoco contó`;
    record({
      id: 'CN-14',
      attempt: `Un PR trae su propia prueba roja con el mismo nombre de trabajo que la oficial, que termina en verde, y una prueba que ya pasa sin el cambio. GitHub no dejó subir el cambio a los agentes; la suite lo subió con la cuenta del dueño (R22). ${ranSuffixed}. Antes se comprobó que la corrida oficial trae el PR y su base`,
      stoppedBy: ['github', 'juez'],
      negative: 'frenado',
      positive: 'pasó',
      evidence: [prUrl(control.pr), runUrl(passed.status), prUrl(attack.pr), RUN_URL(impostor.runId ?? 0), runUrl(refused.status)],
      owner: { pushesBySuite: true },
    });
  }, 60 * MINUTE);

  it('R29: A-T3: a queue group with three required checks is judged by runs in line, never two at once, and merges; a run cancelled by hand in «Juzgar» is noted', async () => {
    const caseStart = lastJudgeRunId();
    const piece = await openPiece('cola-en-fila', completeFiles);
    await builderEvent(piece);
    await verdict(piece, piece.head);
    const green = await judged(piece, ['success', 'failure', 'error']);
    expect(green.status.state, JSON.stringify(green.stages)).toBe('success');
    await judgeIdle(caseStart);

    // The group: the merge_group event plus the end of red-test, todo-verde and fronteras.
    const reruns: number[] = [];
    const armed = lastJudgeRunId();
    await asAgent('pr', 'merge', String(piece.pr), '--repo', REPO, '--squash', '--auto');
    await mergedThroughQueue(piece, reruns);
    await sleep(3 * MINUTE);
    await judgeIdle(armed);
    const groupRuns = judgeRunsAfter(armed).filter((run) => run.event === 'merge_group' || run.event === 'workflow_run');
    const groups = new Set(groupRuns.filter((run) => run.event === 'merge_group').map((run) => run.head_sha));
    expect(groups.size, `the queue made ${groups.size} groups; the runs cannot be told apart`).toBe(1);
    const analysed = groupRuns.map((run) => {
      const jobs = jobsOf(run.id);
      const starts = jobs.map((job) => job.started_at).filter((at): at is string => at !== null).sort();
      const ends = jobs.map((job) => job.completed_at).filter((at): at is string => at !== null).sort();
      return { run, started: ranSteps(jobs), start: starts[0] ?? '', end: ends.at(-1) ?? '' };
    });
    log(`A-T3: ${JSON.stringify(analysed.map((item) => ({ id: item.run.id, event: item.run.event, conclusion: item.run.conclusion, started: item.started, start: item.start, end: item.end })))}`);
    for (const item of analysed) {
      if (item.run.conclusion === 'cancelled') expect(item.started, `judge run ${item.run.id} was cancelled after it started`).toBe(false);
      if (item.started) expect(item.run.conclusion, `judge run ${item.run.id}`).toBe('success');
    }
    const ran = analysed.filter((item) => item.started).sort((a, b) => a.start.localeCompare(b.start));
    expect(ran.length).toBeGreaterThan(0);
    for (let index = 1; index < ran.length; index += 1) {
      const before = ran[index - 1];
      const after = ran[index];
      if (before === undefined || after === undefined) continue;
      expect(after.start >= before.end, `judge runs ${before.run.id} and ${after.run.id} of the group overlap`).toBe(true);
    }

    // The probe (§5): a run of another group is cancelled by hand while it is in «Juzgar», and the
    // status left on that group is noted. The moment «Juzgar» starts is read from a run above.
    let offset = 60;
    const sample = ran[0];
    if (sample !== undefined) {
      const text = runLogText(String(sample.run.id));
      const at = /(\d{4}-\d\d-\d\dT[\d:.]+Z).*dist\/bin\.js" judge/.exec(text)?.[1];
      // GitHub writes seven decimals; a date is read with three.
      const when = at === undefined ? Number.NaN : Date.parse(at.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
      if (Number.isFinite(when) && sample.start !== '') offset = Math.max(5, Math.round((when - Date.parse(sample.start)) / 1000));
    }
    const probePiece = await openPiece('cola-sonda', (n) => ({ [`docs/plans/PLAN-${n}.md`]: planOf(n, 'papeles') }));
    await settled(probePiece.head, ['success']);
    await judgeIdle(caseStart);
    const probeStart = lastJudgeRunId();
    await asAgent('pr', 'merge', String(probePiece.pr), '--repo', REPO, '--squash', '--auto');
    let probe: { runId: number; groupSha: string; state: string; description: string } | undefined;
    const tried = new Set<number>();
    try {
      for (let attempt = 1; attempt <= 3 && probe === undefined; attempt += 1) {
        const target = await waitFor('a run of the probe group in progress', () => judgeRunsAfter(probeStart)
          .filter((run) => (run.event === 'merge_group' || run.event === 'workflow_run') && run.status === 'in_progress' && !tried.has(run.id))[0], 20 * MINUTE, 3_000);
        tried.add(target.id);
        const job = await waitFor('its job to start', () => jobsOf(target.id).find((item) => item.started_at !== null), 5 * MINUTE, 2_000);
        const due = Date.parse(job.started_at ?? '') + (offset + 3 * attempt) * 1000;
        await sleep(Math.max(0, due - Date.now()));
        try {
          gh('run', 'cancel', String(target.id), '--repo', REPO);
        } catch (error) {
          log(`A-T3 probe attempt ${attempt}: cancel refused: ${String((error as { stderr?: string }).stderr ?? error).trim()}`);
          continue;
        }
        const ended = await waitFor('the cancelled probe run', () => {
          const run = judgeRun(target.id);
          return run.status === 'completed' ? run : undefined;
        }, 10 * MINUTE, 5_000);
        const text = runLogText(String(target.id));
        const inJudge = /dist\/bin\.js" judge/.test(text) && !/- [\w-]+: (passed|rejected|waiting|technical|skipped|informative)/.test(text);
        log(`A-T3 probe attempt ${attempt}: run ${target.id} ended ${ended.conclusion}; in «Juzgar» when cancelled: ${inJudge}`);
        if (ended.conclusion !== 'cancelled' || !inJudge) continue;
        await sleep(MINUTE);
        const groupSha = judgeRunsAfter(probeStart).find((run) => run.event === 'merge_group')?.head_sha ?? '';
        const left = groupSha === '' ? undefined : latest(groupSha);
        probe = { runId: target.id, groupSha, state: left?.state ?? 'ninguno', description: left?.description ?? '' };
      }
    } finally {
      // The probe piece ends merged or out of the queue; either way the harness knows about it.
      const end = await waitFor('the probe piece out of the queue', () => {
        const state = queueState(probePiece.pr);
        if (state.state !== 'OPEN' || !state.inQueue) return state;
        rerunQueueLock(probePiece, reruns);
        return undefined;
      }, 45 * MINUTE, 20_000).catch(() => undefined);
      if (end?.state === 'MERGED') await sandbox.noteMerged(probePiece.pr);
      else if (end?.state === 'OPEN' && end.autoMerge) await asAgent('pr', 'merge', String(probePiece.pr), '--repo', REPO, '--disable-auto').catch(() => undefined);
    }
    const probeText = probe === undefined
      ? 'la sonda no alcanzó a cancelar una corrida dentro de «Juzgar»'
      : `sonda: una corrida de otro grupo cancelada a mano dentro de «Juzgar» dejó en ese grupo el estado ${probe.state}${probe.description === '' ? '' : ` («${probe.description}»)`}`;
    record({
      id: 'A-T3',
      attempt: `Un grupo de la cola con tres checks exigidos que terminan casi juntos, más el evento de la cola: ${groupRuns.length} corridas del juez, ${ran.length} empezaron, ninguna empezada terminó cancelada, nunca dos a la vez, y el grupo se fusionó. ${probeText}`,
      stoppedBy: [],
      negative: 'frenado',
      positive: 'no-aplica',
      result: 'pasó',
      evidence: [prUrl(piece.pr), ...ran.map((item) => item.run.html_url), prUrl(probePiece.pr), ...(probe === undefined ? [] : [RUN_URL(probe.runId)])],
      ...(probe === undefined ? { partial: 'la sonda de cancelación a mano no alcanzó a cancelar una corrida del juez dentro de «Juzgar» en tres intentos' } : {}),
    });
  }, 120 * MINUTE);

  it('R29: RAMA-1 and RAMA-2: a pull request into staging is judged with the recipe of staging; a promotion to main only by the engine files', async () => {
    const mainRecipe = `${RECIPE()}${BRANCHES_BLOCK}`;
    const head = await sandbox.writeMainFiles({
      [WORKFLOW]: judgeWorkflow('staging, main'),
      '.ai-workflows/pipeline.yml': mainRecipe,
    }, `suite negativa ${sandbox.run}: ramas de trabajo staging y main (R29)`);
    try {
      await sandbox.createBranch('staging', head);

      // RAMA-2, without touching the engine files: a promotion is not a piece and passes.
      const quiet = await sandbox.writeBranchFiles('staging', { [`docs/staging-${sandbox.run}.md`]: 'Una nota que solo está en staging.\n' });
      const url = await asAgent('pr', 'create', '--repo', REPO, '--head', 'staging', '--base', 'main', '--title', `Suite negativa · pase de staging a main ${sandbox.run}`, '--body', 'Pase de prueba (PLAN-13-R6 §11). Se cierra solo.');
      const promotion = Number(url.split('/').at(-1));
      // Its head branch is the run's own working branch: the harness removes it by its own journal
      // entry (never as the branch of this pull request), so a moved staging is reported, not lost.
      await sandbox.trackPullRequest(promotion, '');
      const clean = await settled(quiet, ['success', 'failure', 'error']);
      expect(clean.state, clean.description).toBe('success');

      // RAMA-2, touching the recipe: staging gets its own recipe, so the promotion now changes it.
      const withRecipe = await sandbox.writeBranchFiles('staging', { '.ai-workflows/pipeline.yml': stagingRecipe() });
      const touched = await settled(withRecipe, ['failure', 'error']);
      expect(touched.state, touched.description).toBe('failure');
      expect(touched.description).toContain(`/approve-judge-change ${withRecipe.slice(0, 16)}`);
      expect(prState(promotion).state).toBe('OPEN');
      gh('pr', 'comment', String(promotion), '--repo', REPO, '--body', `/approve-judge-change ${withRecipe.slice(0, 16)}`);
      const attested = await waitFor('the promotion after the attestation', () => (latest(withRecipe)?.state === 'success' ? latest(withRecipe) : undefined));

      // RAMA-1: a piece into staging is judged stage by stage with staging's recipe, whose stage
      // `solo-staging` main's recipe does not have. Nothing into staging is ever merged here.
      const piece = await openPiece('hacia-staging', completeFiles, { base: 'staging' });
      await builderEvent(piece);
      await verdict(piece, piece.head);
      const refused = await judged(piece, ['failure']);
      expect(notPassing(refused.stages)).toEqual(['solo-staging']);
      await change(piece, { [`docs/plans/PLAN-${piece.n}.md`]: `${planOf(piece.n, 'comportamiento')}${STAGING_SECTION}` }, 'el plan dice cómo se prueba en staging');
      await verdict(piece, piece.head);
      const fixed = await judged(piece, ['success', 'failure', 'error']);
      expect(fixed.status.state, JSON.stringify(fixed.stages)).toBe('success');
      expect(fixed.stages['solo-staging']?.outcome).toBe('passed');

      record({
        id: 'RAMA-1',
        attempt: 'Una pieza entra a staging sin cumplir la etapa que solo existe en la receta de staging',
        stoppedBy: ['juez'],
        negative: 'frenado',
        positive: 'pasó',
        evidence: [prUrl(piece.pr), runUrl(refused.status), runUrl(fixed.status)],
      });
      record({
        id: 'RAMA-2',
        attempt: 'Un pase de staging a main que cambia la receta, sin la orden del dueño. Control: el mismo pase sin tocar los archivos del motor pasa sin buscar pieza, y con la orden del dueño para esa versión también pasa',
        stoppedBy: ['juez'],
        negative: 'frenado',
        positive: 'pasó',
        evidence: [prUrl(promotion), runUrl(clean), runUrl(touched), runUrl(attested)],
        owner: { ordersBySuite: ['/approve-judge-change'] },
      });
    } finally {
      // Main goes back to the recipe and the judge without working branches, for whatever runs next.
      await sandbox.writeMainFiles({
        [WORKFLOW]: judgeWorkflow(),
        '.ai-workflows/pipeline.yml': RECIPE(),
      }, `suite negativa ${sandbox.run}: main vuelve sin ramas de trabajo (R29)`);
    }
  }, 75 * MINUTE);
});

void ALL_STAGES;
