import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitStore,
  runAgentCli,
  type AgentCliDeps,
  type Invocation,
  type RawRun,
} from '../src/index.js';

import { AGENT, BRANCH, FakeGitHub, OWNER, PIECE } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';
import { fakeRemote } from './remote.js';

// PLAN-13-R4 §4, §6, §3.8 and §8: the command line next to the agent reads the recipe. `run`
// refuses before touching anything when the recipe, the branch or the credentials are wrong; the
// control commands never depend on the recipe, so a broken one can still be stopped; two sessions
// on one piece never both work (CN-12); messages go out once and only while they are still true;
// `finish` retires the folder and the local branch after `done`, from anywhere and repeatably;
// `sync` brings a clean update with the base and records it. GitHub and the providers are the
// external edges (fakes); git and the state store's logic are real.

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  removeRepositories();
});

const RECIPE = (stages: readonly string[], extra: readonly string[] = []) => `${[
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  `agent-account: "${AGENT}"`,
  'pieces: { branch: ["*/{piece}-*"] }',
  ...extra,
  'stages:',
  ...stages,
].join('\n')}\n`;

const HOLD_MERGE = [
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node hold.mjs',
];

const HOLD_SCRIPT = "process.stdout.write(JSON.stringify({ ok: false, reason: 'se detiene aquí' }));\n";

/** A project on `feat/13-algo` with the recipe committed, and everything the CLI talks to. */
function project(recipe = RECIPE(HOLD_MERGE), files: Readonly<Record<string, string>> = {}) {
  const root = repository({ '.ai-workflows/pipeline.yml': recipe, 'hold.mjs': HOLD_SCRIPT, 'src/algo.ts': 'export const a = 1;\n', ...files });
  git(root, 'switch', '-q', '-c', BRANCH);
  git(root, 'branch', '-q', '-D', 'piece');
  write(root, 'src/algo.ts', 'export const a = 2;\n');
  const head = commit(root, 'la pieza');
  const remote = fakeRemote();
  const github = new FakeGitHub();
  const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    cwd: root,
    env: {},
    github,
    remote: github,
    statePort: remote.port(),
    repository: 'duena/proyecto',
    ghAccounts: async () => [],
    ...over,
  });
  return { root, head, remote, github, deps };
}

describe('run refuses before touching anything', () => {
  it('an invalid recipe: file, line, column and reason, and no state written', async () => {
    const p = project(`${RECIPE(HOLD_MERGE)}rara: 1\n`);
    const output = await runAgentCli(['run', PIECE], p.deps());
    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/\.ai-workflows\/pipeline\.yml:\d+:\d+:/);
    expect(p.remote.commits).toBe(0);
  });

  it('a piece that is not the one of the current branch', async () => {
    const p = project();
    const output = await runAgentCli(['run', '14'], p.deps());
    expect(output).toEqual({ ok: false, text: expect.stringMatching(/13/) });
    expect(p.remote.commits).toBe(0);
  });

  it('with agent-account and without the app credentials, naming the variables', async () => {
    const p = project();
    const output = await runAgentCli(['run', PIECE], p.deps({ github: undefined, remote: undefined }));
    expect(output).toEqual({ ok: false, text: expect.stringMatching(/AI_WORKFLOWS_APP_ID/) });
    expect(p.remote.commits).toBe(0);
  });

  it('positive: a valid recipe on the piece branch runs', async () => {
    const p = project();
    const output = await runAgentCli(['run', PIECE], p.deps());
    expect(output.text).toMatch(/se detiene aquí/);
    expect(p.remote.commits).toBeGreaterThan(0);
  });
});

describe('the control commands never depend on the recipe', () => {
  it('stop, status and resume work with a broken recipe, in English, saying the recipe is broken', async () => {
    const p = project();
    await runAgentCli(['run', PIECE], p.deps());
    write(p.root, '.ai-workflows/pipeline.yml', 'version: [roto\n');

    const stop = await runAgentCli(['stop', PIECE, 'lo', 'freno'], p.deps());
    expect(stop.ok).toBe(true);
    expect(stop.text).toMatch(/recipe/i);

    const status = await runAgentCli(['status'], p.deps());
    expect(status.text).toMatch(/on hold/);

    expect((await runAgentCli(['resume', PIECE], p.deps())).ok).toBe(true);
  });

  it('status shows no control characters from a stored reason or piece name', async () => {
    const p = project();
    const store = createGitStore({ port: p.remote.port() });
    await store.saveStatus({ piece: '13', state: 'blocked:rejected', stage: 'merge', reason: 'malo \u001b[31mrojo\u001b[0m\u0007' }, undefined);
    const status = await runAgentCli(['status', PIECE], p.deps());
    expect(status.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(status.text).toContain('rojo');
  });
});

describe('CN-12: two sessions on the same piece', () => {
  it('only one works; the other says another session holds it and writes nothing of its own', async () => {
    const slow = "setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 1500);\n";
    const p = project(RECIPE([
      '  - id: slow',
      '    summary: "Algo lento"',
      '    nature: recompute',
      '    gate:',
      '      run: node slow.mjs',
      '    server: { require-check: slow }',
      ...HOLD_MERGE.map((row) => (row === '    phase: merge' ? '    after: slow\n    phase: merge' : row)).flatMap((row) => row.split('\n')),
    ]), { 'slow.mjs': slow });

    const [a, b] = await Promise.all([
      runAgentCli(['run', PIECE], p.deps({ statePort: p.remote.port() })),
      runAgentCli(['run', PIECE], p.deps({ statePort: p.remote.port() })),
    ]);

    const busy = [a, b].filter((output) => /otra sesión/.test(output.text));
    expect(busy).toHaveLength(1);
    const journal = await createGitStore({ port: p.remote.port() }).journal(PIECE);
    expect(journal.filter((entry) => entry.stage === 'slow' && entry.outcome === 'passed')).toHaveLength(1);
  });
});

describe('messages to the owner (§6)', () => {
  const APPROVAL = [
    '  - id: approval',
    '    summary: "El dueño aprueba"',
    '    nature: attest',
    '    needs-human: true',
    '    gate:',
    '      uses: ai-workflows/approval-review@1',
    '    server: attestation',
  ];
  const MESSAGES = ['messages: { summary: { file: "docs/plans/PLAN-{piece}.md", section: "En tres líneas" } }'];
  const PLAN = '# Plan\n\n## En tres líneas\n\nQué pasa hoy: algo.\nQué cambia: otra cosa.\nPor qué importa: por eso.\n';
  const recipe = RECIPE([...APPROVAL, ...HOLD_MERGE.map((row) => (row === '    phase: merge' ? '    after: approval\n    phase: merge' : row)).flatMap((row) => row.split('\n'))], MESSAGES);

  const messagesOf = (github: FakeGitHub) =>
    (github.issueCommentsOf.get(Number(PIECE)) ?? []).filter((comment) => comment.body.includes('ai-workflows:message'));

  it('waiting for the approval sends one message with the three lines, and a second run does not repeat it', async () => {
    const p = project(recipe, { 'docs/plans/PLAN-13.md': PLAN });
    await runAgentCli(['run', PIECE], p.deps());
    await runAgentCli(['run', PIECE], p.deps());
    const sent = messagesOf(p.github).filter((comment) => comment.body.includes('owner-message:approval'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.split('\n')[0]).toMatch(/Qué pasa hoy: algo\./);
    expect(sent[0]?.author).toBe(AGENT);
  });

  it('a message whose moment has passed is not sent: another run advanced the piece meanwhile', async () => {
    const p = project(recipe, { 'docs/plans/PLAN-13.md': PLAN });
    const output = await runAgentCli(['run', PIECE], p.deps({
      beforeMessages: async () => {
        // Between A's end and A's message, the owner approves and run B moves the piece on.
        const head = git(p.root, 'rev-parse', 'HEAD');
        p.github.reviewsOf.set(100, [{ author: OWNER, authorType: 'User', state: 'APPROVED', commitId: head, submittedAt: '2026-09-24T12:00:00Z' }]);
        await runAgentCli(['run', PIECE], p.deps({ statePort: p.remote.port() }));
      },
    }));
    expect(messagesOf(p.github).filter((comment) => comment.body.includes('owner-message:approval'))).toHaveLength(0);
    expect(output.text).toMatch(/ya no corresponde|no longer/);
  });

  it('without messages: in the recipe, nothing is sent', async () => {
    const p = project(RECIPE([...APPROVAL, ...HOLD_MERGE.map((row) => (row === '    phase: merge' ? '    after: approval\n    phase: merge' : row)).flatMap((row) => row.split('\n'))]));
    await runAgentCli(['run', PIECE], p.deps());
    expect(messagesOf(p.github)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// finish (§3.8)

/** A main copy with the piece checked out in a linked worktree, and the piece left `done`. */
async function finished(options: { dirty?: boolean } = {}) {
  const main = repository({ '.ai-workflows/pipeline.yml': RECIPE(HOLD_MERGE), 'hold.mjs': HOLD_SCRIPT });
  git(main, 'switch', '-q', 'main');
  git(main, 'branch', '-q', '-D', 'piece');
  const parent = mkdtempSync(join(tmpdir(), 'aiw-wt-'));
  folders.push(parent);
  const folder = join(parent, 'feat-13');
  git(main, 'worktree', 'add', '-q', '-b', BRANCH, folder);
  write(folder, 'src/x.ts', 'x\n');
  const head = commit(folder, 'la pieza');
  if (options.dirty === true) write(folder, 'src/x.ts', 'sin guardar\n');

  const remote = fakeRemote();
  const store = createGitStore({ port: remote.port() });
  await store.append(PIECE, {
    stage: 'cleanup',
    outcome: 'passed',
    at: 1,
    runId: 'r',
    pipeline: 'p',
    evidence: { judged: { sha: head, snapshot: 's', fingerprint: 'f' }, block: { branch: BRANCH, headSha: head, mergeSha: 'f'.repeat(40), folder, removeFolder: true } },
  });
  await store.saveStatus({ piece: PIECE, state: 'done' }, undefined);
  const github = new FakeGitHub();
  const deps = (cwd: string, over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    cwd, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [], ...over,
  });
  return { main, folder, head, remote, store, deps };
}

describe('finish', () => {
  it('from the main copy: removes the worktree and the local branch of the finished piece', async () => {
    const f = await finished();
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(true);
    expect(existsSync(f.folder)).toBe(false);
    expect(git(f.main, 'branch', '--list', BRANCH)).toBe('');
  });

  it('repeated after a crash between the folder and the branch, it finishes what was left', async () => {
    const f = await finished();
    git(f.main, 'worktree', 'remove', f.folder);
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(true);
    expect(git(f.main, 'branch', '--list', BRANCH)).toBe('');
  });

  it('when the folder is gone, only the registry entry of this piece is repaired, never another', async () => {
    const f = await finished();
    const other = join(mkdtempSync(join(tmpdir(), 'aiw-wt-')), 'otra');
    folders.push(other);
    git(f.main, 'worktree', 'add', '-q', '-b', 'feat/14-otra', other);
    rmSync(f.folder, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });

    await runAgentCli(['finish', PIECE], f.deps(f.main));

    const list = git(f.main, 'worktree', 'list', '--porcelain');
    expect(list).toContain('otra');
    expect(list).not.toContain('feat-13');
  });

  it('a folder with unsaved changes is kept, and the command fails saying how to finish', async () => {
    const f = await finished({ dirty: true });
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(false);
    expect(existsSync(f.folder)).toBe(true);
    expect(output.text).toMatch(/sin guardar|unsaved/);
  });

  it('a local branch at another tip is kept', async () => {
    const f = await finished();
    git(f.folder, 'commit', '-q', '--allow-empty', '-m', 'otro');
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(false);
    expect(git(f.main, 'branch', '--list', BRANCH)).not.toBe('');
  });

  it('touches nothing while another session holds the piece', async () => {
    const f = await finished();
    await f.store.reserve(PIECE, 'otra-sesion', 15 * 60_000);
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(false);
    expect(existsSync(f.folder)).toBe(true);
  });

  it('touches nothing when the piece is not done', async () => {
    const f = await finished();
    const current = await f.store.loadStatus(PIECE);
    await f.store.saveStatus({ piece: PIECE, state: 'blocked:rejected', stage: 'merge', reason: 'x' }, current?.version);
    const output = await runAgentCli(['finish', PIECE], f.deps(f.main));
    expect(output.ok).toBe(false);
    expect(existsSync(f.folder)).toBe(true);
  });

  it('run on a piece whose folder was retired refuses, saying so', async () => {
    const f = await finished();
    await runAgentCli(['finish', PIECE], f.deps(f.main));
    git(f.main, 'switch', '-q', '-c', BRANCH);
    const output = await runAgentCli(['run', PIECE], f.deps(f.main));
    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/cerrada|closed|retir/);
  });
});

// ---------------------------------------------------------------------------------------------
// sync (§8)

/** A piece whose branch lives in a bare origin; `update` merges main into it there, as GitHub's button does. */
function synced() {
  const p = project();
  const origin = mkdtempSync(join(tmpdir(), 'aiw-origin-'));
  folders.push(origin);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(p.root, 'remote', 'add', 'origin', origin);
  git(p.root, 'push', '-q', 'origin', 'main', BRANCH);
  const other = mkdtempSync(join(tmpdir(), 'aiw-other-'));
  folders.push(other);
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 'o@example.com');
  git(other, 'config', 'user.name', 'Otro');
  git(other, 'config', 'commit.gpgsign', 'false');
  const update = (extra?: string) => {
    git(other, 'switch', '-q', 'main');
    write(other, 'docs/nuevo.md', 'de la base\n');
    commit(other, 'la base avanza');
    git(other, 'push', '-q', 'origin', 'main');
    git(other, 'switch', '-q', BRANCH);
    git(other, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    if (extra !== undefined) {
      write(other, extra, 'colado\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '--amend', '--no-edit');
    }
    git(other, 'push', '-q', 'origin', BRANCH);
    return git(other, 'rev-parse', 'HEAD');
  };
  return { ...p, origin, update };
}

describe('sync', () => {
  it('fast-forwards to a clean update with the base and records it before moving', async () => {
    const s = synced();
    const target = s.update();
    const output = await runAgentCli(['sync', PIECE], s.deps());
    expect(output.ok).toBe(true);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(target);
    const journal = await createGitStore({ port: s.remote.port() }).journal(PIECE);
    expect(journal.filter((entry) => entry.stage === '@clean-update')).toHaveLength(1);
  });

  it('a merge with something slipped in is not a clean update: nothing moves, nothing is recorded', async () => {
    const s = synced();
    s.update('src/colado.ts');
    const before = git(s.root, 'rev-parse', 'HEAD');
    const output = await runAgentCli(['sync', PIECE], s.deps());
    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/actualización limpia/);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(before);
    const journal = await createGitStore({ port: s.remote.port() }).journal(PIECE);
    expect(journal.filter((entry) => entry.stage === '@clean-update')).toHaveLength(0);
  });

  it('refuses unsaved changes, another piece\'s branch, and a piece another session holds', async () => {
    const dirty = synced();
    dirty.update();
    write(dirty.root, 'src/algo.ts', 'sin guardar\n');
    expect((await runAgentCli(['sync', PIECE], dirty.deps())).ok).toBe(false);

    const wrong = synced();
    wrong.update();
    expect((await runAgentCli(['sync', '14'], wrong.deps())).ok).toBe(false);

    const held = synced();
    held.update();
    await createGitStore({ port: held.remote.port() }).reserve(PIECE, 'otra-sesion', 15 * 60_000);
    const before = git(held.root, 'rev-parse', 'HEAD');
    expect((await runAgentCli(['sync', PIECE], held.deps())).ok).toBe(false);
    expect(git(held.root, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('repeated after the records were written but before moving, it finishes without duplicating them', async () => {
    const s = synced();
    const target = s.update();
    await runAgentCli(['sync', PIECE], s.deps({ beforeFastForward: async () => { throw new Error('se cortó la luz'); } }));
    const output = await runAgentCli(['sync', PIECE], s.deps());
    expect(output.ok).toBe(true);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(target);
    const journal = await createGitStore({ port: s.remote.port() }).journal(PIECE);
    expect(journal.filter((entry) => entry.stage === '@clean-update')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// build and review publish observed events (§2)

function claudeRun(text: string, session = 'ses_rev', touches?: string) {
  return {
    run: async (invocation: Invocation): Promise<RawRun> => {
      if (touches !== undefined) write(invocation.cwd, touches, 'escrito\n');
      return {
        exitCode: 0,
        output: JSON.stringify({
          type: 'result', subtype: 'success', is_error: false, session_id: session, result: text,
          modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } },
        }),
      };
    },
  };
}

describe('build and review', () => {
  it('review publishes an observed verdict of the head on the piece issue', async () => {
    const p = project(undefined, { 'docs/review.md': 'Revisa.\n' });
    const output = await runAgentCli(
      ['review', PIECE, '--angle', 'seguridad', '--provider', 'claude', '--model', 'claude-opus-5-5', '--prompt', 'docs/review.md'],
      p.deps({ providers: claudeRun('Bien.\nVERDICT:APPROVED') }),
    );
    expect(output.ok).toBe(true);
    const events = (p.github.issueCommentsOf.get(Number(PIECE)) ?? []).filter((comment) => comment.body.includes('ai-workflows:event'));
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain(`"sha":"${p.head}"`);
    expect(events[0]?.body).toContain('"session":"ses_rev"');
    expect(events[0]?.body).toContain('"angle":"seguridad"');
  });

  it('a reviewer that writes in the tree publishes a verdict that does not approve', async () => {
    const p = project(undefined, { 'docs/review.md': 'Revisa.\n' });
    await runAgentCli(
      ['review', PIECE, '--angle', 'seguridad', '--provider', 'claude', '--model', 'claude-opus-5-5', '--prompt', 'docs/review.md'],
      p.deps({ providers: claudeRun('Bien.\nVERDICT:APPROVED', 'ses_rev', 'src/escrito.ts') }),
    );
    const body = (p.github.issueCommentsOf.get(Number(PIECE)) ?? []).map((comment) => comment.body).join('\n');
    expect(body).not.toMatch(/"approved":true/);
  });

  it('review refuses unsaved changes and publishes nothing', async () => {
    const p = project(undefined, { 'docs/review.md': 'Revisa.\n' });
    write(p.root, 'src/algo.ts', 'sin guardar\n');
    const output = await runAgentCli(
      ['review', PIECE, '--angle', 'seguridad', '--provider', 'claude', '--model', 'claude-opus-5-5', '--prompt', 'docs/review.md'],
      p.deps({ providers: claudeRun('Bien.\nVERDICT:APPROVED') }),
    );
    expect(output.ok).toBe(false);
    expect(p.github.issueCommentsOf.get(Number(PIECE)) ?? []).toHaveLength(0);
  });

  it('build publishes the builder with the head it started from and the tree it left', async () => {
    const p = project(undefined, { 'docs/build.md': 'Construye.\n' });
    const output = await runAgentCli(
      ['build', PIECE, '--provider', 'claude', '--model', 'claude-opus-5-5', '--prompt', 'docs/build.md'],
      p.deps({ providers: claudeRun('Hecho.', 'ses_build', 'src/nuevo.ts') }),
    );
    expect(output.ok).toBe(true);
    const body = (p.github.issueCommentsOf.get(Number(PIECE)) ?? []).map((comment) => comment.body).join('\n');
    expect(body).toContain('"type":"builder"');
    expect(body).toContain(`"sha":"${p.head}"`);
    expect(body).toContain('"session":"ses_build"');
    expect(body).not.toContain(`"result":"${git(p.root, 'rev-parse', `${p.head}^{tree}`)}"`);
  });
});

describe('doctor', () => {
  it('warns when the account that approves is logged in where the agents run', async () => {
    const p = project();
    const output = await runAgentCli(['doctor'], p.deps({ ghAccounts: async () => [OWNER] }));
    expect(output.text).toMatch(/aprobar por ti|approve for you/);
  });
});
