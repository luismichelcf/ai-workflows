import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentEdges,
  createGitStore,
  renderEventComment,
  runAgentCli,
  type AgentCliDeps,
  type GhRun,
  type Invocation,
  type PieceEvent,
  type RawRun,
} from '../src/index.js';

import { AGENT, BRANCH, FakeGitHub, OWNER, PIECE } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';
import { fakeRemote } from './remote.js';

// PLAN-13-R4, flock round 1, the command line: `run` hands the builders to the stages; a recipe
// without agent-account still reaches GitHub as the gh account; the installation token is asked
// for on every call (never cached past its life) and belongs to the declared account; the owner
// is told the exact thing to do and never a raw technical reason; a message is judged against the
// outcome that motivated it and this run; `finish` honours remove-folder: false; `sync` refuses
// every history that is not a clean update; `doctor` fails on what it checks.

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  removeRepositories();
});

const HEADER = (account = true) => [
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  ...(account ? [`agent-account: "${AGENT}"`] : []),
  'pieces: { branch: ["*/{piece}-*"] }',
];
const RECIPE = (stages: readonly string[], extra: readonly string[] = [], account = true) =>
  `${[...HEADER(account), ...extra, 'stages:', ...stages].join('\n')}\n`;
const HOLD_AFTER = (after: string) => [
  '  - id: merge',
  '    summary: "Se une"',
  `    after: ${after}`,
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node hold.mjs',
];
const HOLD_SCRIPT = "process.stdout.write(JSON.stringify({ ok: false, reason: 'se detiene aquí' }));\n";
const PLAN = '# Plan\n\n## En tres líneas\n\nQué pasa hoy: algo.\nQué cambia: otra cosa.\nPor qué importa: por eso.\n';
const MESSAGES = ['messages: { summary: { file: "docs/plans/PLAN-{piece}.md", section: "En tres líneas" } }'];

function project(recipe: string, files: Readonly<Record<string, string>> = {}) {
  const root = repository({ '.ai-workflows/pipeline.yml': recipe, 'hold.mjs': HOLD_SCRIPT, 'src/algo.ts': 'export const a = 1;\n', 'docs/plans/PLAN-13.md': PLAN, ...files });
  const base = git(root, 'rev-parse', 'main');
  git(root, 'switch', '-q', '-c', BRANCH);
  git(root, 'branch', '-q', '-D', 'piece');
  write(root, 'src/algo.ts', 'export const a = 2;\n');
  const head = commit(root, 'la pieza');
  const remote = fakeRemote();
  const github = new FakeGitHub();
  const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    cwd: root, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto',
    ghAccounts: async () => [], ...over,
  });
  return { root, base, head, remote, github, deps };
}

const agentMessages = (github: FakeGitHub) =>
  (github.issueCommentsOf.get(Number(PIECE)) ?? []).filter((comment) => comment.author === AGENT && comment.body.includes('ai-workflows:message'));

// ---------------------------------------------------------------------------------------------

describe('run hands the builders of the piece to the stages (§2.2)', () => {
  const SANDBOXED = [
    '  - id: review',
    '    summary: "Un revisor en solo lectura"',
    '    nature: attest',
    '    gate:',
    '      uses: ai-workflows/sandboxed-review@1',
    '      with:',
    '        reviewer: { provider: claude, model: claude-opus-5-5 }',
    '        prompt: "docs/review.md"',
    '        angle: correctitud',
    '    server: attestation',
    ...HOLD_AFTER('review'),
  ];
  const reviewer = {
    run: async (_invocation: Invocation): Promise<RawRun> => ({
      exitCode: 0,
      output: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'ses_rev', result: 'Bien.\nVERDICT:APPROVED', modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } } }),
    }),
  };
  function withBuilder(p: ReturnType<typeof project>) {
    const tree = git(p.root, 'rev-parse', `${p.head}^{tree}`);
    const body = renderEventComment({
      version: 1, type: 'builder', op: 'b1', piece: PIECE, sha: p.base,
      identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_build' },
      result: tree, source: 'provider-cli',
    } as unknown as PieceEvent, 'es');
    p.github.issueCommentsOf.set(Number(PIECE), [{ id: 1, author: AGENT, authorType: 'Bot', viaApp: 'mi-motor', body, createdAt: '2026-09-24T09:00:00Z', updatedAt: '2026-09-24T09:00:00Z' }]);
  }

  it('with a builder event on the issue, the sandboxed review runs and passes', async () => {
    const p = project(RECIPE(SANDBOXED), { 'docs/review.md': 'Revisa.\n' });
    withBuilder(p);
    const output = await runAgentCli(['run', PIECE], p.deps({ providers: reviewer }));
    expect(output.text).toMatch(/se detiene aquí/);
  });

  it('without one, it is refused as "nobody knows who built it"', async () => {
    const p = project(RECIPE(SANDBOXED), { 'docs/review.md': 'Revisa.\n' });
    const output = await runAgentCli(['run', PIECE], p.deps({ providers: reviewer }));
    expect(output.text).toMatch(/quién construyó/);
  });

  it('an issue that cannot be read makes the run technical, never a run without builders', async () => {
    const p = project(RECIPE(SANDBOXED), { 'docs/review.md': 'Revisa.\n' });
    withBuilder(p);
    p.github.readErrors.set('issueComments', 5);
    const output = await runAgentCli(['run', PIECE], p.deps({ providers: reviewer }));
    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/fallo técnico|technical/);
    expect(output.text).not.toMatch(/quién construyó/);
  });
});

describe('the GitHub edges', () => {
  const fakeRunner = () => {
    const calls: { args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
    const runner = async (args: readonly string[], _input?: string, env?: Readonly<Record<string, string>>): Promise<GhRun> => {
      calls.push({ args, ...(env === undefined ? {} : { env }) });
      return { exitCode: 0, stdout: JSON.stringify({ title: 'Pieza' }), stderr: '' };
    };
    return { runner, calls };
  };

  it('ask the installation for a token on every call, so one older than its life is never reused', async () => {
    let issued = 0;
    const tokenSource = { token: async () => `ghs_${++issued}`, account: async () => AGENT };
    const gh = fakeRunner();
    const edges = createAgentEdges({ repository: 'duena/proyecto', runner: gh.runner, tokenSource });
    await edges.github.issueTitle(13);
    await edges.github.issueTitle(13);
    expect(gh.calls.map((call) => call.env?.['GH_TOKEN'])).toEqual(['ghs_1', 'ghs_2']);
  });

  it('without a token source they run as the gh account, with no token in the environment', async () => {
    const gh = fakeRunner();
    const edges = createAgentEdges({ repository: 'duena/proyecto', runner: gh.runner });
    await edges.github.issueTitle(13);
    expect(gh.calls[0]?.env?.['GH_TOKEN']).toBeUndefined();
  });

  it('a recipe without agent-account still reaches GitHub as the gh account instead of refusing', async () => {
    const p = project(RECIPE([
      '  - id: approval',
      '    summary: "El dueño aprueba"',
      '    nature: attest',
      '    needs-human: true',
      '    gate:',
      '      uses: ai-workflows/approval-comment@1',
      '    server: attestation',
      ...HOLD_AFTER('approval'),
    ], [], false));
    const gh = fakeRunner();
    const output = await runAgentCli(['run', PIECE], p.deps({ github: undefined, remote: undefined, ghRunner: gh.runner }));
    expect(output.text).not.toMatch(/identidad de GitHub|GitHub identity|AI_WORKFLOWS_APP_ID/);
    expect(gh.calls.length).toBeGreaterThan(0);
  });

  it('a key of another app than agent-account is refused before touching anything', async () => {
    const p = project(RECIPE(HOLD_AFTER('x').slice(0, 2).concat(['    phase: merge', '    nature: recompute', '    gate:', '      run: node hold.mjs'])));
    const tokenSource = { token: async () => 'ghs_x', account: async () => 'otra-app[bot]' };
    const output = await runAgentCli(['run', PIECE], p.deps({ github: undefined, remote: undefined, tokenSource, ghRunner: fakeRunner().runner }));
    expect(output).toEqual({ ok: false, text: expect.stringMatching(/otra-app\[bot\]/) });
    expect(p.remote.commits).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Messages

describe('what the owner is told (§6)', () => {
  it('for an approval by comment, the exact order to write, never the button', async () => {
    const p = project(RECIPE([
      '  - id: approval',
      '    summary: "El dueño aprueba"',
      '    nature: attest',
      '    needs-human: true',
      '    gate:',
      '      uses: ai-workflows/approval-comment@1',
      '      with: { command: /ok, code-length: 10 }',
      '    server: attestation',
      ...HOLD_AFTER('approval'),
    ], MESSAGES));
    await runAgentCli(['run', PIECE], p.deps());
    const [message] = agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:approval'));
    expect(message?.body).toContain(`/ok ${p.head.slice(0, 10)}`);
    expect(message?.body).not.toMatch(/botón|button/);
  });

  it('a blocked piece is told in plain words by its stage summary, never with the raw reason', async () => {
    const fail = "process.stdout.write(JSON.stringify({ ok: false, reason: 'falló en C:\\\\Users\\\\secreto\\\\ruta con stack trace' }));\n";
    const p = project(RECIPE([
      '  - id: checks',
      '    summary: "Las comprobaciones del proyecto pasan"',
      '    nature: recompute',
      '    gate:',
      '      run: node fail.mjs',
      '    server: { require-check: checks }',
      ...HOLD_AFTER('checks'),
    ], MESSAGES), { 'fail.mjs': fail });
    await runAgentCli(['run', PIECE], p.deps());
    const [message] = agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:blocked'));
    expect(message?.body).toContain('Las comprobaciones del proyecto pasan');
    expect(message?.body).not.toMatch(/Users|secreto|stack/);
  });

  const APPROVAL = RECIPE([
    '  - id: approval',
    '    summary: "El dueño aprueba"',
    '    nature: attest',
    '    needs-human: true',
    '    gate:',
    '      uses: ai-workflows/approval-review@1',
    '    server: attestation',
    ...HOLD_AFTER('approval'),
  ], MESSAGES);

  it('is judged against the outcome that motivated it: a session that moved the piece right after the run wins', async () => {
    const p = project(APPROVAL);
    const output = await runAgentCli(['run', PIECE], p.deps({
      afterRun: async () => {
        p.github.reviewsOf.set(100, [{ author: OWNER, authorType: 'User', state: 'APPROVED', commitId: p.head, submittedAt: '2026-09-24T12:00:00Z' }]);
        await runAgentCli(['run', PIECE], p.deps({ statePort: p.remote.port() }));
      },
    }));
    expect(agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:approval'))).toHaveLength(0);
    expect(output.text).toMatch(/ya no corresponde|no longer/);
  });

  it('is not sent while another session holds the piece, and says so', async () => {
    const p = project(APPROVAL);
    const output = await runAgentCli(['run', PIECE], p.deps({
      afterRun: async () => {
        await createGitStore({ port: p.remote.port() }).reserve(PIECE, 'otra-sesion', 15 * 60_000);
      },
    }));
    expect(agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:approval'))).toHaveLength(0);
    expect(output.text).toMatch(/[Oo]tra sesión|[Aa]nother session/);
  });

  it('a comment by someone else quoting the mark does not count as sent', async () => {
    const p = project(APPROVAL);
    const op = `owner-message:approval:approval:${p.head}`;
    p.github.issueCommentsOf.set(Number(PIECE), [{ id: 1, author: OWNER, authorType: 'User', viaApp: null, body: `cito <!-- ai-workflows:message {"op":"${op}"} -->`, createdAt: '2026-09-24T09:00:00Z', updatedAt: '2026-09-24T09:00:00Z' }]);
    // The first comment of a run is the `start` message; the failure hits the approval message.
    p.github.failures.set('commentOnIssue', { when: 'before', skip: 1 });
    await runAgentCli(['run', PIECE], p.deps());
    await runAgentCli(['run', PIECE], p.deps());
    expect(agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:approval'))).toHaveLength(1);
  });

  it('a crash after sending: the next run does not send it again', async () => {
    const p = project(APPROVAL);
    // The first comment of a run is the `start` message; the failure hits the approval message.
    p.github.failures.set('commentOnIssue', { when: 'after', skip: 1 });
    await runAgentCli(['run', PIECE], p.deps());
    await runAgentCli(['run', PIECE], p.deps());
    expect(agentMessages(p.github).filter((comment) => comment.body.includes('owner-message:approval'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// finish honours remove-folder: false

describe('finish', () => {
  it('keeps the folder (and its branch) when cleanup recorded remove-folder: false', async () => {
    const main = repository({ '.ai-workflows/pipeline.yml': RECIPE(HOLD_AFTER('x')), 'hold.mjs': HOLD_SCRIPT });
    git(main, 'switch', '-q', 'main');
    git(main, 'branch', '-q', '-D', 'piece');
    const parent = mkdtempSync(join(tmpdir(), 'aiw-wt-'));
    folders.push(parent);
    const folder = join(parent, 'feat-13');
    git(main, 'worktree', 'add', '-q', '-b', BRANCH, folder);
    write(folder, 'src/x.ts', 'x\n');
    const head = commit(folder, 'la pieza');
    const remote = fakeRemote();
    const store = createGitStore({ port: remote.port() });
    await store.append(PIECE, { stage: 'cleanup', outcome: 'passed', at: 1, runId: 'r', pipeline: 'p', evidence: { judged: { sha: head, snapshot: 's', fingerprint: 'f' }, block: { branch: BRANCH, headSha: head, mergeSha: 'f'.repeat(40), folder, removeFolder: false } } });
    await store.saveStatus({ piece: PIECE, state: 'done' }, undefined);
    const github = new FakeGitHub();
    const output = await runAgentCli(['finish', PIECE], { cwd: main, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [] });
    expect(output.ok).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// sync refuses every history that is not a clean update

function synced() {
  const p = project(RECIPE(HOLD_AFTER('x').slice(0, 2).concat(['    phase: merge', '    nature: recompute', '    gate:', '      run: node hold.mjs'])));
  const origin = mkdtempSync(join(tmpdir(), 'aiw-origin-'));
  folders.push(origin);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  git(p.root, 'remote', 'add', 'origin', origin);
  git(p.root, 'push', '-q', 'origin', 'main', BRANCH);
  const other = mkdtempSync(join(tmpdir(), 'aiw-other-'));
  folders.push(other);
  execFileSync('git', ['clone', '-q', origin, other]);
  for (const [key, value] of [['user.email', 'o@example.com'], ['user.name', 'Otro'], ['commit.gpgsign', 'false']]) git(other, 'config', key as string, value as string);
  const baseMoves = (file: string) => {
    git(other, 'switch', '-q', 'main');
    write(other, file, `${file}\n`);
    commit(other, `base ${file}`);
    git(other, 'push', '-q', 'origin', 'main');
    git(other, 'switch', '-q', BRANCH);
  };
  return { ...p, other, baseMoves };
}

const journalCleanUpdates = async (s: ReturnType<typeof synced>) =>
  (await createGitStore({ port: s.remote.port() }).journal(PIECE)).filter((entry) => entry.stage === '@clean-update');

describe('sync', () => {
  it('a chain of two updates whose second is not clean moves nothing and records nothing', async () => {
    const s = synced();
    s.baseMoves('docs/uno.md');
    git(s.other, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    s.baseMoves('docs/dos.md');
    git(s.other, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    write(s.other, 'src/colado.ts', 'colado\n');
    git(s.other, 'add', '-A');
    git(s.other, 'commit', '-q', '--amend', '--no-edit');
    git(s.other, 'push', '-q', 'origin', BRANCH);
    const before = git(s.root, 'rev-parse', 'HEAD');
    expect((await runAgentCli(['sync', PIECE], s.deps())).ok).toBe(false);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(before);
    expect(await journalCleanUpdates(s)).toHaveLength(0);
  });

  it('a force push on GitHub (the local head is not in the new history) moves nothing', async () => {
    const s = synced();
    git(s.other, 'switch', '-q', BRANCH);
    git(s.other, 'reset', '-q', '--hard', 'main');
    write(s.other, 'src/otro.ts', 'reescrito\n');
    commit(s.other, 'historia reescrita');
    git(s.other, 'push', '-q', '--force', 'origin', BRANCH);
    const before = git(s.root, 'rev-parse', 'HEAD');
    expect((await runAgentCli(['sync', PIECE], s.deps())).ok).toBe(false);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(before);
    expect(await journalCleanUpdates(s)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('doctor', () => {
  it('fails on an invalid recipe', async () => {
    const p = project(`${RECIPE(HOLD_AFTER('x'))}rara: 1\n`);
    expect((await runAgentCli(['doctor'], p.deps())).ok).toBe(false);
  });

  it('warns about the owner logged in, whatever the case of the login', async () => {
    const p = project(RECIPE(HOLD_AFTER('x').slice(0, 2).concat(['    phase: merge', '    nature: recompute', '    gate:', '      run: node hold.mjs'])));
    const output = await runAgentCli(['doctor'], p.deps({ ghAccounts: async () => ['otra', OWNER.toUpperCase()] }));
    expect(output.text).toMatch(/aprobar por ti|approve for you/);
  });
});
