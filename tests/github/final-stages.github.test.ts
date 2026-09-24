import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentCredentialsFromEnv,
  createAgentEdges,
  createAppTokenSource,
  createGhRunner,
  runAgentCli,
  type AgentCliDeps,
} from '../../src/index.js';

import { commit, git, write } from '../git-fixtures.js';

// PLAN-13-R4 §10, the real run: a piece goes through the final stages in the test repository
// (socialabs-margin/ai-workflows-pruebas) with the real GitHub App of the agents (R21), the real
// merge queue and its required `candado-cola` status, real deployments (created by the test in
// place of a hosting provider) and the owner's real "Approve" button.
//
// It needs credentials and a person, so it never runs in the public CI. It runs only through
// `pnpm test:github` with AI_WORKFLOWS_GITHUB_TEST_REPO, AI_WORKFLOWS_APP_ID,
// AI_WORKFLOWS_APP_KEY_FILE and AI_WORKFLOWS_AGENT_ACCOUNT set, and FAILS — never skips — without
// them. The owner's approval is a MANUAL step outside this machine: the run prints the link and
// waits up to 30 minutes for the owner to press "Approve" on the phone or the browser; the test
// never approves with the owner's account. It closes every issue and pull request and deletes
// every branch and folder it made.

const REPO = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';
const AGENT = process.env['AI_WORKFLOWS_AGENT_ACCOUNT'] ?? '';
const MINUTE = 60_000;
const RUN = randomInt(1000, 9999);

const gh = (...args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const ghJson = <T>(...args: string[]): T => JSON.parse(gh(...args)) as T;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => process.stdout.write(`[final.github] ${new Date().toISOString()} ${message}\n`);

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 20 * MINUTE, everyMs = 20_000): Promise<T> {
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
    await sleep(everyMs);
  }
}

const OWNER = REPO === '' ? '' : gh('api', 'user', '--jq', '.login');
const made = { issues: [] as number[], branches: [] as string[], folders: [] as string[] };

function recipe(piece: number, stages: readonly string[]): string {
  return `${[
    'version: 1',
    'locale: es',
    `owner: ${OWNER}`,
    `agent-account: "${AGENT}"`,
    'pieces: { branch: ["*/{piece}-*"] }',
    'messages: { summary: { file: "docs/plans/PLAN-{piece}.md", section: "En tres líneas" } }',
    'stages:',
    ...stages,
  ].join('\n')}\n`;
}

const FULL = [
  '  - id: approval',
  '    summary: "La dueña aprueba con el botón"',
  '    nature: attest',
  '    needs-human: true',
  '    gate:',
  '      uses: ai-workflows/approval-review@1',
  '    server: attestation',
  '  - id: preview',
  '    summary: "La vista previa de esta versión está lista"',
  '    after: approval',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/preview-deployment@1',
  '      with: { environment: Preview, url-pattern: "*.example.com" }',
  '    server: { require-check: candado-cola }',
  '  - id: merge',
  '    summary: "Entra a la cola y se fusiona"',
  '    after: preview',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  '      with: { method: squash, timeout-minutes: 45, poll-seconds: 20 }',
  '  - id: after',
  '    summary: "Lo publicado queda en verde"',
  '    after: merge',
  '    phase: post-merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/post-merge@1',
  '      with: { merge-stage: merge, deployment: { environment: Production } }',
  '    server: local-only',
  '  - id: cleanup',
  '    summary: "Se borra la rama y se retira la carpeta"',
  '    after: after',
  '    phase: post-merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/cleanup@1',
  '      with: { merge-stage: merge }',
  '    server: local-only',
];

const ONLY_APPROVAL = FULL.slice(0, 7).concat([
  '  - id: merge',
  '    summary: "Se une"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
]);

/** A clone of the test repository and a linked worktree on the piece's branch, with its own recipe kept out of git. */
function workspace(piece: number, stages: readonly string[]) {
  const parent = mkdtempSync(join(tmpdir(), 'aiw-final-e2e-'));
  made.folders.push(parent);
  const main = join(parent, 'main');
  gh('repo', 'clone', REPO, main, '--', '-q');
  git(main, 'config', 'user.email', 'e2e@example.com');
  git(main, 'config', 'user.name', 'e2e');
  git(main, 'config', 'commit.gpgsign', 'false');
  const branch = `feat/${piece}-e2e-${RUN}`;
  made.branches.push(branch);
  const folder = join(parent, 'pieza');
  git(main, 'worktree', 'add', '-q', '-b', branch, folder, 'origin/main');
  // The recipe and the plan live next to the piece but never travel: the test repository's main
  // must not receive a recipe (it would change how its other tests are judged).
  appendFileSync(join(main, '.git', 'info', 'exclude'), '\n.ai-workflows/\ndocs/plans/\n');
  write(folder, '.ai-workflows/pipeline.yml', recipe(piece, stages));
  write(folder, `docs/plans/PLAN-${piece}.md`, '# Plan\n\n## En tres líneas\n\nQué pasa hoy: se prueba el motor.\nQué cambia: nada visible.\nPor qué importa: para confiar en él.\n');
  write(folder, `e2e/final-${RUN}-${piece}.md`, `Prueba real de la rebanada 4 (${RUN}).\n`);
  const head = commit(folder, `e2e: pieza ${piece}`);
  return { main, folder, branch, head };
}

function newIssue(title: string): number {
  const url = gh('issue', 'create', '--repo', REPO, '--title', title, '--body', 'Pieza de prueba del recorrido real de la rebanada 4. Se cierra sola.');
  const number = Number(url.split('/').pop());
  made.issues.push(number);
  return number;
}

function createDeployment(sha: string, environment: string, url: string): void {
  const body = JSON.stringify({ ref: sha, environment, auto_merge: false, required_contexts: [] });
  const created = JSON.parse(execFileSync('gh', ['api', '-X', 'POST', `repos/${REPO}/deployments`, '--input', '-'], { input: body, encoding: 'utf8' })) as { id: number };
  execFileSync('gh', ['api', '-X', 'POST', `repos/${REPO}/deployments/${created.id}/statuses`, '--input', '-'], {
    input: JSON.stringify({ state: 'success', environment_url: url }),
    encoding: 'utf8',
  });
  log(`deployment ${environment} ${created.id} for ${sha.slice(0, 7)} → ${url}`);
}

function deps(cwd: string, over: Partial<AgentCliDeps> = {}): AgentCliDeps {
  return { cwd, env: process.env as Record<string, string>, ...over };
}

beforeAll(() => {
  const missing = ['AI_WORKFLOWS_GITHUB_TEST_REPO', 'AI_WORKFLOWS_APP_ID', 'AI_WORKFLOWS_APP_KEY_FILE', 'AI_WORKFLOWS_AGENT_ACCOUNT']
    .filter((name) => (process.env[name] ?? '') === '');
  if (missing.length > 0) throw new Error(`the real run needs ${missing.join(', ')}; it never skips`);
});

afterAll(() => {
  if (REPO === '') return;
  for (const branch of made.branches) {
    try {
      for (const number of gh('pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number').split('\n').filter(Boolean)) {
        gh('pr', 'close', number, '--repo', REPO);
      }
    } catch (error) {
      log(`could not close the pull requests of ${branch}: ${String(error)}`);
    }
    try {
      gh('api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${branch}`);
    } catch {
      log(`branch ${branch} was already gone`);
    }
  }
  for (const issue of made.issues) {
    try {
      gh('issue', 'close', String(issue), '--repo', REPO);
    } catch (error) {
      log(`could not close issue #${issue}: ${String(error)}`);
    }
  }
  for (const folder of made.folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('the final stages on GitHub, with the agents identity and the owner button', () => {
  it('a piece goes from the pull request to the merge queue, the checks after it and the cleanup', async () => {
    const piece = newIssue(`e2e rebanada 4 · recorrido completo ${RUN}`);
    const w = workspace(piece, FULL);

    // 1. The agents open the pull request and the piece waits for the owner.
    const first = await runAgentCli(['run', String(piece)], deps(w.folder));
    log(first.text);
    expect(first.text).toMatch(/espera tu decisión|Approve/);
    const [pr] = ghJson<{ number: number; author: { login: string; is_bot: boolean }; url: string }[]>(
      'pr', 'list', '--repo', REPO, '--head', w.branch, '--state', 'open', '--json', 'number,author,url',
    );
    expect(pr).toBeDefined();
    if (pr === undefined) return;
    expect(`${pr.author.login.replace(/^app\//, '')}${pr.author.is_bot && !pr.author.login.endsWith('[bot]') ? '[bot]' : ''}`).toBe(AGENT);
    const messages = ghJson<{ body: string; user: { login: string } }[]>('api', `repos/${REPO}/issues/${piece}/comments`);
    expect(messages.some((comment) => comment.user.login === AGENT && comment.body.includes('owner-message:approval'))).toBe(true);

    // 2. CN-12 for real: two sessions on the piece at once; one works, the other is told.
    const [a, b] = await Promise.all([
      runAgentCli(['run', String(piece)], deps(w.folder)),
      runAgentCli(['run', String(piece)], deps(w.folder)),
    ]);
    expect([a, b].filter((output) => /otra sesión/.test(output.text))).toHaveLength(1);

    // 3. MANUAL: the owner approves from outside this machine.
    process.stdout.write(`\n\n>>> DUEÑA: pulsa «Approve» en ${pr.url} (desde tu teléfono o navegador). Espero hasta 30 minutos.\n\n`);
    await waitFor('the owner approval', () => {
      const reviews = ghJson<{ user: { login: string }; state: string; commit_id: string }[]>('api', `repos/${REPO}/pulls/${pr.number}/reviews`);
      return reviews.some((review) => review.user.login.toLowerCase() === OWNER.toLowerCase() && review.state === 'APPROVED' && review.commit_id === w.head) ? true : undefined;
    }, 30 * MINUTE, 15_000);

    // 4. The preview of this exact version is ready (the test plays the hosting provider).
    createDeployment(w.head, 'Preview', `https://p${piece}.example.com`);

    // 5. Approval, preview and merge pass; after the merge the production deployment is missing.
    const second = await runAgentCli(['run', String(piece)], deps(w.folder));
    log(second.text);
    const merged = ghJson<{ state: string; mergeCommit: { oid: string } | null }>('pr', 'view', String(pr.number), '--repo', REPO, '--json', 'state,mergeCommit');
    expect(merged.state).toBe('MERGED');
    expect(second.text).toMatch(/Lo publicado queda en verde|after/);

    // 6. Production of the merge commit is deployed; the checks after the merge pass and the cleanup ends it.
    createDeployment(merged.mergeCommit?.oid ?? '', 'Production', `https://prod-${piece}.example.com`);
    const third = await runAgentCli(['run', String(piece)], deps(w.folder));
    log(third.text);
    expect(third.ok).toBe(true);
    const branchGone = (() => {
      try {
        gh('api', `repos/${REPO}/git/refs/heads/${w.branch}`);
        return false;
      } catch {
        return true;
      }
    })();
    expect(branchGone).toBe(true);
  }, 90 * MINUTE);

  it('CN-13 for real: a crash right after the pull request is opened never opens a second one', async () => {
    const piece = newIssue(`e2e rebanada 4 · caída tras abrir el PR ${RUN}`);
    const w = workspace(piece, ONLY_APPROVAL);
    const credentials = agentCredentialsFromEnv(process.env, w.folder);
    if (!('appId' in credentials)) throw new Error(`credentials: ${JSON.stringify(credentials)}`);
    const tokenSource = createAppTokenSource({ credentials, repository: REPO });
    const edges = createAgentEdges({ repository: REPO, runner: createGhRunner(), tokenSource });
    let crashed = false;
    const crashing = Object.create(edges.github) as typeof edges.github;
    crashing.createDraftPullRequest = async (o) => {
      const number = await edges.github.createDraftPullRequest(o);
      if (!crashed) {
        crashed = true;
        throw new Error(`se cortó la conexión justo después de abrir el PR #${number}`);
      }
      return number;
    };

    const first = await runAgentCli(['run', String(piece)], deps(w.folder, { github: crashing, remote: edges.remote }));
    log(first.text);
    expect(first.ok).toBe(false);

    const second = await runAgentCli(['run', String(piece)], deps(w.folder, { github: crashing, remote: edges.remote }));
    log(second.text);
    expect(second.text).toMatch(/espera tu decisión|Approve/);
    const all = ghJson<{ number: number }[]>('pr', 'list', '--repo', REPO, '--head', w.branch, '--state', 'all', '--json', 'number');
    expect(all).toHaveLength(1);
  }, 20 * MINUTE);
});
