import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { emptyFolder, git, removeRepositories, write } from '../git-fixtures.js';

// PLAN-13-R3 §7, the real run: the judge installed in the test repository
// (socialabs-margin/ai-workflows-pruebas), pinned to the engine commit under test, judging real
// pull requests, a real merge queue, a real branch ruleset and the real switch variable.
//
// It needs credentials and costs Actions minutes, so it never runs in the public CI. It runs only
// through `pnpm test:github` with AI_WORKFLOWS_GITHUB_TEST_REPO set, and FAILS — never skips —
// without it. The commit under test must already be on GitHub (push the branch first). It takes
// the ruleset and the variables as it finds them, uses them during the run and restores them at
// the end, closes every pull request and deletes every branch it made, and removes the judge from
// the test repository's main when it is done.

const REPO = process.env.AI_WORKFLOWS_GITHUB_TEST_REPO ?? '';
const ENGINE_REPO = 'luismichelcf/ai-workflows';
const MINUTE = 60_000;
const WORKFLOW = '.github/workflows/ai-workflows.yml';
const RED_WORKFLOW = '.github/workflows/ai-workflows-red-test.yml';
const NO_STATUS_WORKFLOW = '.github/workflows/ai-workflows-sin-permiso.yml';
const IMITATOR = '.github/workflows/imitador.yml';

const gh = (...args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const ghJson = <T>(...args: string[]): T => JSON.parse(gh(...args)) as T;
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => process.stdout.write(`[judge.github] ${new Date().toISOString()} ${message}\n`);

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 12 * MINUTE): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = probe();
    } catch (error) {
      log(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15_000);
  }
}

// ---------------------------------------------------------------------------------------------
// What the test repository holds while the run lasts

const OWNER = REPO === '' ? '' : gh('api', 'user', '--jq', '.login');
const RUN_ID = randomInt(1000, 9999);
const piece = (offset: number) => String(RUN_ID * 10 + offset);

const RECIPE = () => lines(
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  'classify:',
  '  visible: ["app/**"]',
  'kinds:',
  '  names: [behavior, visual-only, docs]',
  '  default: behavior',
  '  from-paths: { docs: ["docs/**", ".ai-workflows/**"] }',
  'labels:',
  '  visual-only: "solo visual"',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  '  declared-kind:',
  '    file: "docs/plans/PLAN-{piece}.md"',
  '    line: "Tipo de cambio"',
  'stages:',
  '  - id: red-test',
  '    summary: "Primero una prueba que falla por la razón correcta"',
  '    nature: execution-record',
  '    applies-if: { kind-any: [behavior] }',
  '    valid-while: forever',
  '    gate:',
  '      uses: ai-workflows/red-test@1',
  '      with: { command: "node runner.mjs {tests}", tests: ["tests/**/*.test.mjs"] }',
  '    server: { require-check: ai-workflows/red-test }',
  '  - id: owner-approval',
  '    summary: "La dueña aprueba lo que se ve"',
  '    after: red-test',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    valid-while: same-fingerprint',
  '    gate:',
  '      uses: ai-workflows/approval-comment@1',
  '      with: { command: /approve }',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Entra a la cola"',
  '    after: owner-approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const RUNNER = readFileSync(new URL('../red-test-check.test.ts', import.meta.url), 'utf8')
  .split('const RUNNER = [')[1]
  ?.split('].join(')[0];

/** The runner of tests/red-test-check.test.ts, rebuilt from its source so both stay the same. */
function runnerSource(): string {
  if (RUNNER === undefined) throw new Error('cannot find RUNNER in tests/red-test-check.test.ts');
  // The array literal is valid JavaScript: evaluate it as data.
  const rows = new Function(`return [${RUNNER}];`)() as string[];
  return rows.join('\n');
}

const BONUS = (amount: number) => `export const bonus = () => ${amount};\n`;
const BONUS_TEST = lines(
  'import assert from "node:assert/strict";',
  'import { bonus } from "../src/bonus.mjs";',
  'const leaked = Object.keys(process.env).filter((name) => /TOKEN|SECRET|PASSWORD|KEY|^ACTIONS_|^GH_/i.test(name));',
  'export const cases = {',
  '  "paga el bono completo": () => assert.equal(bonus(), 1000, `expected ${bonus()} to be 1000`),',
  '  "no ve ningún token del job": () => assert.deepEqual(leaked, [], `leaked ${leaked.join(",")}`),',
  '};',
);

/** The judge workflows of the templates, pinned to the engine commit under test. */
function judgeWorkflows(engineSha: string): Record<string, string> {
  const judge = readFileSync(new URL('../../templates/ai-workflows.yml', import.meta.url), 'utf8').replaceAll('<ENGINE_SHA>', engineSha);
  const redTemplate = parse(readFileSync(new URL('../../templates/ai-workflows-red-test.yml', import.meta.url), 'utf8').replaceAll('<ENGINE_SHA>', engineSha)) as Record<string, any>;
  // The test project needs no install: drop the example install steps of the template.
  for (const job of Object.values(redTemplate['jobs'] as Record<string, any>)) {
    job['steps'] = (job['steps'] as Record<string, any>[]).filter((step) =>
      !/pnpm|setup-node|action-setup/.test(`${step['run'] ?? ''}${step['uses'] ?? ''}`));
  }
  // SV-05: the same judge without permission to publish statuses, only started by hand.
  const noStatus = parse(judge) as Record<string, any>;
  noStatus['name'] = 'ai-workflows sin permiso';
  noStatus['on'] = { workflow_dispatch: { inputs: { pr: { required: true, type: 'string' } } } };
  for (const job of Object.values(noStatus['jobs'] as Record<string, any>)) {
    job['permissions'] = { ...job['permissions'], statuses: 'read' };
    delete job['if'];
  }
  return {
    [WORKFLOW]: judge,
    [RED_WORKFLOW]: stringify(redTemplate),
    [NO_STATUS_WORKFLOW]: stringify(noStatus),
  };
}

// ---------------------------------------------------------------------------------------------
// GitHub helpers

interface Status { context: string; state: string; description: string; target_url: string | null; created_at: string }

function statuses(sha: string): Status[] {
  const pages = ghJson<Status[][]>('api', `repos/${REPO}/commits/${sha}/statuses`, '--paginate', '--slurp');
  return pages.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const latest = (sha: string, context = 'ai-workflows') => statuses(sha).find((status) => status.context === context);

/** Waits for the judge's final (non-pending) status on a SHA, optionally a given state. */
function settled(sha: string, context = 'ai-workflows', states: string[] = ['success', 'failure', 'error']) {
  return waitFor(`status ${context} on ${sha.slice(0, 7)} in ${states.join('/')}`, () => {
    const status = latest(sha, context);
    return status !== undefined && states.includes(status.state) ? status : undefined;
  });
}

interface Run { databaseId: number; status: string; conclusion: string; event: string; headSha: string; workflowName: string; createdAt: string }

function runs(workflow: string): Run[] {
  return ghJson<Run[]>('run', 'list', '--repo', REPO, '--workflow', workflow.split('/').at(-1) ?? workflow, '--limit', '100',
    '--json', 'databaseId,status,conclusion,event,headSha,workflowName,createdAt');
}

function checkRun(sha: string, name: string) {
  const pages = ghJson<{ check_runs: { name: string; status: string; conclusion: string | null }[] }[]>(
    'api', `repos/${REPO}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`, '--paginate', '--slurp');
  return pages.flatMap((page) => page.check_runs).find((run) => run.name === name);
}

/** git against GitHub, retried: this machine's network sometimes fails a TLS handshake. */
function remoteGit(root: string, ...args: string[]): string {
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return git(root, ...args);
    } catch (error) {
      last = error;
      execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${attempt * 3000})`]);
    }
  }
  throw last;
}

const branches: string[] = [];
let clone = '';
let mainAfterSetup = '';
let rulesetBefore: Record<string, any> | undefined;
let rulesetId = 0;
let modeBefore: string | undefined;

function setMode(mode: string | undefined): void {
  if (mode === undefined) {
    try {
      gh('variable', 'delete', 'AI_WORKFLOWS_MODE', '--repo', REPO);
    } catch {
      // Not there: nothing to delete.
    }
    return;
  }
  gh('variable', 'set', 'AI_WORKFLOWS_MODE', '--repo', REPO, '--body', mode);
}

function putRuleset(body: Record<string, any>): void {
  execFileSync('gh', ['api', '-X', 'PUT', `repos/${REPO}/rulesets/${rulesetId}`, '--input', '-'], {
    input: JSON.stringify({ name: body['name'], target: body['target'], enforcement: body['enforcement'], conditions: body['conditions'], rules: body['rules'], bypass_actors: body['bypass_actors'] ?? [] }),
    encoding: 'utf8',
  });
}

/** The ruleset of the run: the queue as it was, and the judge's status as the required check. */
function requireJudge(required: boolean): void {
  if (rulesetBefore === undefined) throw new Error('no ruleset recorded');
  const rules = (rulesetBefore['rules'] as Record<string, any>[]).map((rule) =>
    rule['type'] === 'required_status_checks'
      ? { ...rule, parameters: { ...rule['parameters'], required_status_checks: required ? [{ context: 'ai-workflows', integration_id: 15368 }] : [] } }
      : rule,
  ).filter((rule) => required || rule['type'] !== 'required_status_checks');
  putRuleset({ ...rulesetBefore, enforcement: 'active', rules });
}

function pushToMain(files: Readonly<Record<string, string | null>>, message: string): string {
  if (rulesetBefore === undefined) throw new Error('no ruleset recorded');
  const current = ghJson<Record<string, any>>('api', `repos/${REPO}/rulesets/${rulesetId}`);
  putRuleset({ ...current, enforcement: 'disabled' });
  try {
    remoteGit(clone, 'fetch', '-q', 'origin', 'main');
    git(clone, 'switch', '-q', '-C', 'main', 'origin/main');
    for (const [path, content] of Object.entries(files)) {
      if (content === null) git(clone, 'rm', '-q', '--ignore-unmatch', path);
      else write(clone, path, content);
    }
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '--allow-empty', '-m', message);
    remoteGit(clone, 'push', '-q', 'origin', 'HEAD:main');
    return git(clone, 'rev-parse', 'HEAD');
  } finally {
    putRuleset(current);
  }
}

/** A branch from main with these files, pushed, and its PR. Returns the PR number and head. */
function openPr(branch: string, files: Readonly<Record<string, string>>, base = 'main'): { number: number; head: string } {
  branches.push(branch);
  remoteGit(clone, 'fetch', '-q', 'origin', 'main');
  git(clone, 'switch', '-q', '-C', branch, 'origin/main');
  for (const [path, content] of Object.entries(files)) write(clone, path, content);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', `prueba del juez ${branch}`);
  remoteGit(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
  const url = gh('pr', 'create', '--repo', REPO, '--head', branch, '--base', base, '--title', `Prueba del juez ${branch}`, '--body', 'Prueba automática de ai-workflows (rebanada 3); se cierra sola.');
  const number = Number(url.split('/').at(-1));
  return { number, head: git(clone, 'rev-parse', 'HEAD') };
}

const planOf = (id: string, kind: string) => lines(`# Plan ${id}`, '', '## En tres líneas', '', 'Prueba del juez.', '', `Tipo de cambio: ${kind}`);

// ---------------------------------------------------------------------------------------------

describe.sequential('the judge on GitHub (PLAN-13-R3 §7)', () => {
  let engineSha = '';

  beforeAll(() => {
    if (REPO === '') return;
    engineSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const rulesets = ghJson<{ id: number; target: string }[]>('api', `repos/${REPO}/rulesets`);
    rulesetId = rulesets.find((ruleset) => ruleset.target === 'branch')?.id ?? 0;
    rulesetBefore = ghJson<Record<string, any>>('api', `repos/${REPO}/rulesets/${rulesetId}`);
    try {
      modeBefore = gh('variable', 'get', 'AI_WORKFLOWS_MODE', '--repo', REPO);
    } catch {
      modeBefore = undefined;
    }
    clone = emptyFolder();
    remoteGit(clone, 'clone', '-q', `https://github.com/${REPO}.git`, '.');
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'ai-workflows test');
    log(`engine ${engineSha}, run ${RUN_ID}, owner ${OWNER}, ruleset ${rulesetId}`);
  }, 5 * MINUTE);

  afterAll(() => {
    if (REPO === '') return;
    const problems: string[] = [];
    const attempt = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const branch of branches) {
      attempt(`close ${branch}`, () => {
        const numbers = gh('pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number').split('\n').filter(Boolean);
        for (const number of numbers) gh('pr', 'close', number, '--repo', REPO);
      });
      attempt(`delete ${branch}`, () => {
        try {
          gh('api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${branch}`);
        } catch (error) {
          // The queue deletes the branch of a merged PR: already gone is done.
          if (!/Reference does not exist|HTTP 422|Not Found/.test(String((error as { stderr?: string }).stderr ?? error))) throw error;
        }
      });
    }
    attempt('remove the judge from main', () => {
      pushToMain({ [WORKFLOW]: null, [RED_WORKFLOW]: null, [NO_STATUS_WORKFLOW]: null, '.ai-workflows/pipeline.yml': null }, 'prueba del juez: se retira');
    });
    attempt('restore the ruleset', () => {
      if (rulesetBefore !== undefined) putRuleset(rulesetBefore);
    });
    attempt('restore the variable', () => setMode(modeBefore));
    removeRepositories();
    if (problems.length > 0) throw new Error(`cleanup left work to do by hand:\n${problems.join('\n')}`);
  }, 15 * MINUTE);

  it('is asked to run with a test repository, a logged-in gh and the engine commit on GitHub', () => {
    expect(REPO, 'set AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo>').toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(() => gh('auth', 'status')).not.toThrow();
    expect(() => gh('api', `repos/${ENGINE_REPO}/commits/${engineSha}`), 'push the branch under test first').not.toThrow();
    expect(rulesetId).toBeGreaterThan(0);
  });

  it('installs the judge on main, pinned to the engine under test, with the switch on', () => {
    mainAfterSetup = pushToMain({
      ...judgeWorkflows(engineSha),
      '.ai-workflows/pipeline.yml': RECIPE(),
      'runner.mjs': runnerSource(),
      'src/bonus.mjs': BONUS(800),
    }, `prueba del juez ${RUN_ID}: se instala`);
    setMode('on');
    requireJudge(true);
    log(`main ${mainAfterSetup}`);
  });

  // Shared between the cases below.
  let good = { number: 0, head: '' };
  let visible = { number: 0, head: '' };
  let passing = { number: 0, head: '' };

  it('SV-01, SV-06, SV-09: a red test that is really red on main and green on the head makes the judge pass', async () => {
    good = openPr(`feat/${piece(1)}-bono`, {
      'src/bonus.mjs': BONUS(1000),
      [`tests/bonus-${RUN_ID}.test.mjs`]: BONUS_TEST,
    });
    const red = await waitFor('red-test check', () => {
      const run = checkRun(good.head, 'ai-workflows/red-test');
      return run?.status === 'completed' ? run : undefined;
    });
    expect(red.conclusion).toBe('success');
    const status = await settled(good.head);
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'success' });

    // SV-09: the privileged job checked out main, never the pull request.
    const judgeRun = await waitFor('the finished judge run on the PR', () => runs(WORKFLOW).find((run) => run.event === 'pull_request_target' && run.headSha === good.head && run.status === 'completed'));
    const judgeLog = gh('run', 'view', String(judgeRun?.databaseId), '--repo', REPO, '--log');
    expect(judgeLog).not.toMatch(/refs\/pull\//);
    expect(judgeLog).not.toContain(`HEAD is now at ${good.head.slice(0, 7)}`);
  }, 20 * MINUTE);

  it('SV-06: a test that already passes on main is not red, and the judge rejects naming the stage', async () => {
    passing = openPr(`feat/${piece(2)}-verde`, {
      [`tests/verde-${RUN_ID}.test.mjs`]: lines(
        'import assert from "node:assert/strict";',
        'import { bonus } from "../src/bonus.mjs";',
        'export const cases = { "cobra 800": () => assert.equal(bonus(), 800) };',
      ),
      'src/otro.mjs': 'export const otro = 1;\n',
    });
    // SV-08: a journal forged by hand in the state refs changes nothing.
    gh('api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/ai-workflows/pieces/${piece(2)}`, '-f', `sha=${passing.head}`);
    const red = await waitFor('red-test check', () => {
      const run = checkRun(passing.head, 'ai-workflows/red-test');
      return run?.status === 'completed' ? run : undefined;
    });
    expect(red.conclusion).toBe('failure');
    const status = await settled(passing.head, 'ai-workflows', ['failure']);
    expect(status.description).toContain('red-test');
    gh('api', '-X', 'DELETE', `repos/${REPO}/git/refs/ai-workflows/pieces/${piece(2)}`);
  }, 20 * MINUTE);

  it('CN-08: a free branch is never merged', async () => {
    const free = openPr(`libre/prueba-${RUN_ID}`, { 'docs/libre.md': 'libre\n' });
    const status = await settled(free.head, 'ai-workflows', ['failure']);
    expect(status.description).toMatch(/pieza/);
  }, 15 * MINUTE);

  it('RC-06 and SV-04: a PR that changes the recipe is judged with the recipe of main and needs the owner', async () => {
    const recipePr = openPr(`feat/${piece(4)}-receta`, {
      '.ai-workflows/pipeline.yml': RECIPE().replace(/ {2}- id: owner-approval[\s\S]*?server: attestation\n/, '').replace('    after: owner-approval\n', '    after: red-test\n'),
    });
    const refused = await settled(recipePr.head, 'ai-workflows', ['failure']);
    expect(refused.description).toContain('/approve-judge-change');
    gh('pr', 'comment', String(recipePr.number), '--repo', REPO, '--body', `/approve-judge-change ${recipePr.head.slice(0, 16)}`);
    const accepted = await waitFor('judge after the attestation', () => {
      const status = latest(recipePr.head);
      return status?.state === 'success' ? status : undefined;
    });
    expect(accepted.state).toBe('success');
  }, 20 * MINUTE);

  it('CN-05: what is visible waits for the owner; the sign-off survives a force push with the same changes', async () => {
    visible = openPr(`feat/${piece(5)}-visible`, {
      [`docs/plans/PLAN-${piece(5)}.md`]: planOf(piece(5), 'solo visual'),
      'app/boton.tsx': 'export const Boton = () => null;\n',
    });
    const waiting = await waitFor('pending with the command to write', () => {
      const status = latest(visible.head);
      return status?.state === 'pending' && status.description.includes('/approve') ? status : undefined;
    });
    expect(waiting.description).toContain(visible.head.slice(0, 7));
    gh('pr', 'comment', String(visible.number), '--repo', REPO, '--body', `/approve ${visible.head.slice(0, 7)}`);
    await waitFor('success after the sign-off', () => (latest(visible.head)?.state === 'success' ? true : undefined));

    // The same changes, rebuilt and force-pushed: a new head the owner never named.
    git(clone, 'switch', '-q', `feat/${piece(5)}-visible`);
    git(clone, 'commit', '-q', '--amend', '-m', 'rehecho con los mismos cambios');
    remoteGit(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/feat/${piece(5)}-visible`);
    const rebuilt = git(clone, 'rev-parse', 'HEAD');
    expect(rebuilt).not.toBe(visible.head);
    visible = { number: visible.number, head: rebuilt };
    const status = await settled(rebuilt);
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'success' });
  }, 25 * MINUTE);

  it('SV-04: a status imitated by another workflow is reported on the PR', async () => {
    const imitator = openPr(`feat/${piece(6)}-imitador`, {
      [IMITATOR]: lines(
        'name: imitador',
        'on: pull_request',
        'jobs:',
        '  ai-workflows:',
        '    name: ai-workflows',
        '    runs-on: ubuntu-latest',
        '    permissions: { statuses: write }',
        '    steps:',
        '      - env:',
        '          GH_TOKEN: ${{ github.token }}',
        '          SHA: ${{ github.event.pull_request.head.sha }}',
        '        run: gh api "repos/$GITHUB_REPOSITORY/statuses/$SHA" -f state=success -f context=ai-workflows -f description=imitado -f target_url=https://example.com/imitado',
      ),
      [`docs/plans/PLAN-${piece(6)}.md`]: planOf(piece(6), 'docs'),
    });
    await waitFor('the imitated status', () => statuses(imitator.head).find((status) => status.target_url === 'https://example.com/imitado'));
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${imitator.number}`);
    const trace = await waitFor('the trace comment', () => {
      const comments = ghJson<{ body: string }[][]>('api', `repos/${REPO}/issues/${imitator.number}/comments`, '--paginate', '--slurp').flat();
      return comments.find((comment) => comment.body.includes('ai-workflows:trace'));
    });
    expect(trace.body).toContain('https://example.com/imitado');
  }, 20 * MINUTE);

  it('§3.1: a judge started from another branch publishes nothing', async () => {
    const before = statuses(passing.head).length;
    gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', `feat/${piece(2)}-verde`, '-f', `pr=${passing.number}`);
    const run = await waitFor('the dispatched run', () => runs(WORKFLOW).find((candidate) => candidate.event === 'workflow_dispatch' && candidate.status === 'completed' && candidate.headSha === passing.head));
    expect(run).toBeDefined();
    expect(statuses(passing.head)).toHaveLength(before);
  }, 15 * MINUTE);

  it('§3.1: a PR into another branch gets no status; back to main, it is judged again', async () => {
    const develop = `develop-${RUN_ID}`;
    branches.push(develop);
    gh('api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/${develop}`, '-f', `sha=${mainAfterSetup}`);
    const target = openPr(`feat/${piece(8)}-destino`, { [`docs/plans/PLAN-${piece(8)}.md`]: planOf(piece(8), 'docs') }, develop);
    await waitFor('the judge run on the PR into another branch', () => runs(WORKFLOW).find((run) => run.event === 'pull_request_target' && run.status === 'completed' && run.headSha === target.head));
    expect(latest(target.head)).toBeUndefined();
    // A comment on it (the first step reads the live target branch) leaves no status either.
    const known = new Set(runs(WORKFLOW).map((run) => run.databaseId));
    gh('pr', 'comment', String(target.number), '--repo', REPO, '--body', '/approve 0000000');
    await waitFor('the judge run of the comment', () => runs(WORKFLOW).find((run) => run.event === 'issue_comment' && run.status === 'completed' && !known.has(run.databaseId)));
    expect(latest(target.head)).toBeUndefined();

    gh('pr', 'edit', String(target.number), '--repo', REPO, '--base', 'main');
    const first = await settled(target.head);
    expect(first.state).toBe('success');
    gh('pr', 'edit', String(target.number), '--repo', REPO, '--base', develop);
    await sleep(90_000);
    const count = statuses(target.head).length;
    gh('pr', 'edit', String(target.number), '--repo', REPO, '--base', 'main');
    await waitFor('a new judgement after coming back to main', () => (statuses(target.head).length > count ? true : undefined));
  }, 25 * MINUTE);

  it('SV-02: the two keys, in both orders and half switched', async () => {
    const judge = async (): Promise<void> => {
      const count = statuses(passing.head).length;
      gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${passing.number}`);
      await waitFor('a new status', () => (statuses(passing.head).length > count + 1 || (statuses(passing.head).length > count && latest(passing.head)?.state !== 'pending') ? true : undefined));
      await settled(passing.head, 'ai-workflows', ['success', 'failure', 'error']);
    };

    setMode('off');
    await judge();
    expect(latest(passing.head)).toMatchObject({ state: 'success', description: expect.stringMatching(/motor apagado/) });

    setMode('advisory');
    await judge();
    expect(latest(passing.head)?.state).toBe('success');
    const advisory = await settled(passing.head, 'ai-workflows/advisory', ['failure']);
    expect(advisory.description).toContain('red-test');

    // Half switched: variable on, the ruleset not requiring the status yet.
    requireJudge(false);
    setMode('on');
    await judge();
    expect(latest(passing.head)?.state).toBe('failure');
    expect(ghJson<{ mergeStateStatus: string }>('pr', 'view', String(passing.number), '--repo', REPO, '--json', 'mergeStateStatus').mergeStateStatus).not.toBe('BLOCKED');

    // Half switched the other way: the ruleset requires it, the variable is off.
    requireJudge(true);
    setMode('off');
    await judge();
    expect(latest(passing.head)?.state).toBe('success');

    setMode('on');
    await judge();
    expect(latest(passing.head)?.state).toBe('failure');
    expect(ghJson<{ mergeStateStatus: string }>('pr', 'view', String(passing.number), '--repo', REPO, '--json', 'mergeStateStatus').mergeStateStatus).toBe('BLOCKED');
  }, 40 * MINUTE);

  it('SV-05: a cancelled run and a run without permission to publish never leave a green', async () => {
    const before = latest(passing.head);
    let cancelled: Run | undefined;
    for (let attempt = 1; attempt <= 3 && cancelled === undefined; attempt += 1) {
      const known = new Set(runs(WORKFLOW).map((run) => run.databaseId));
      gh('workflow', 'run', 'ai-workflows.yml', '--repo', REPO, '--ref', 'main', '-f', `pr=${passing.number}`);
      const started = await waitFor('the run to cancel', () => runs(WORKFLOW).find((run) => run.event === 'workflow_dispatch' && !known.has(run.databaseId)), 3 * MINUTE);
      try {
        gh('run', 'cancel', String(started.databaseId), '--repo', REPO);
      } catch (error) {
        log(`cancel attempt ${attempt}: ${String((error as { stderr?: string }).stderr ?? error).trim()}`);
        await waitFor('the run that ended first', () => runs(WORKFLOW).find((run) => run.databaseId === started.databaseId && run.status === 'completed'));
        continue;
      }
      cancelled = await waitFor('the cancelled run', () => runs(WORKFLOW).find((run) => run.databaseId === started.databaseId && run.status === 'completed'));
    }
    expect(cancelled?.conclusion).toBe('cancelled');
    expect(['pending', before?.state]).toContain(latest(passing.head)?.state);
    expect(latest(passing.head)?.state).not.toBe('success');

    gh('workflow', 'run', NO_STATUS_WORKFLOW.split('/').at(-1) ?? '', '--repo', REPO, '--ref', 'main', '-f', `pr=${passing.number}`);
    const denied = await waitFor('the run without permission', () => runs(NO_STATUS_WORKFLOW).find((run) => run.status === 'completed'));
    expect(denied.conclusion).toBe('failure');
    expect(latest(passing.head)?.state).not.toBe('success');
  }, 20 * MINUTE);

  it('SV-07 and SV-09: two PRs through the real merge queue, judged on the group SHA', async () => {
    const second = openPr(`feat/${piece(9)}-cola`, { [`docs/plans/PLAN-${piece(9)}.md`]: planOf(piece(9), 'docs') });
    await settled(second.head, 'ai-workflows', ['success']);
    await settled(good.head, 'ai-workflows', ['success']);
    gh('pr', 'merge', String(good.number), '--repo', REPO, '--squash', '--auto');
    gh('pr', 'merge', String(second.number), '--repo', REPO, '--squash', '--auto');

    for (const pr of [good.number, second.number]) {
      await waitFor(`PR #${pr} merged`, () => (ghJson<{ state: string }>('pr', 'view', String(pr), '--repo', REPO, '--json', 'state').state === 'MERGED' ? true : undefined), 30 * MINUTE);
    }
    const groupRuns = runs(WORKFLOW).filter((run) => run.event === 'merge_group' && run.createdAt > new Date(Date.now() - 60 * MINUTE).toISOString());
    expect(groupRuns.length).toBeGreaterThan(0);
    for (const run of groupRuns) {
      const status = latest(run.headSha);
      log(`group ${run.headSha}: ${status?.state} ${status?.description}`);
      expect(status?.state).toBe('success');
      const red = checkRun(run.headSha, 'ai-workflows/red-test');
      expect(red?.conclusion).toBe('success');
      const groupLog = gh('run', 'view', String(run.databaseId), '--repo', REPO, '--log');
      expect(groupLog).toMatch(/gh-readonly-queue\/main\//);
    }
    // The group was also judged again when its red-test ended (workflow_run of a merge_group).
    // A workflow_run run's own head is main, so it is found through the status it published.
    const reJudged = groupRuns.some((run) => statuses(run.headSha).some((status) => {
      const id = /\/actions\/runs\/(\d+)/.exec(status.target_url ?? '')?.[1];
      return id !== undefined && gh('api', `repos/${REPO}/actions/runs/${id}`, '--jq', '.event') === 'workflow_run';
    }));
    expect(reJudged).toBe(true);
  }, 45 * MINUTE);
});
