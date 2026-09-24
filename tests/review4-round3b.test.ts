import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createGitStore,
  createMemoryStore,
  describeChangeFromCommits,
  engineBlock,
  gitProjectFiles,
  parseRecipe,
  renderEventComment,
  runAgentCli,
  runGateCommand,
  type BlockDefinition,
  type IssueComment,
  type JudgeGitHub,
  type PieceEvent,
  type ServerAttestContext,
  type Store,
} from '../src/index.js';

import { AGENT, BRANCH, FakeGitHub, OWNER, PIECE } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';
import { fakeRemote } from './remote.js';

// PLAN-13-R4, flock round 3 (tests): what the fixes of round 2 left unpinned. A gate command never
// inherits the agents' credentials; sandboxed-review on the server ignores an event whose commit
// cannot be fetched; a store that fails while CONFIRMING an effect keeps an optional stage blocked;
// `sync` stops between two records when it loses the piece; `finish` recognises its folder however
// Windows spells it.

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  removeRepositories();
  delete process.env['GH_TOKEN'];
  delete process.env['AI_WORKFLOWS_APP_KEY_FILE'];
});

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

describe('a gate command never inherits the agents credentials', () => {
  it('GH_TOKEN and the app key file are not in its environment', async () => {
    process.env['GH_TOKEN'] = 'ghs_no_debe_llegar';
    process.env['AI_WORKFLOWS_APP_KEY_FILE'] = 'C:/llave.pem';
    const result = await runGateCommand({
      command: process.execPath,
      args: ['-e', 'process.exit(process.env.GH_TOKEN !== undefined || process.env.AI_WORKFLOWS_APP_KEY_FILE !== undefined ? 7 : 0)'],
      timeoutMs: 60_000,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('sandboxed-review on the server with an unfetchable event commit', () => {
  it('ignores that event and decides with its own verdict of the head', async () => {
    const root = repository({ 'src/algo.ts': 'export const algo = 1;\n' });
    const trusted = git(root, 'rev-parse', 'main');
    write(root, 'src/algo.ts', 'export const algo = 2;\n');
    const head = commit(root, 'la pieza');
    const tree = git(root, 'rev-parse', `${head}^{tree}`);
    const parsed = parseRecipe(lines('version: 1', 'locale: es', `owner: ${OWNER}`, `agent-account: "${AGENT}"`, 'pieces: { branch: ["*/{piece}-*"] }', 'stages:', '  - id: merge', '    summary: "x"', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/github-merge@1'), 'r.yml');
    if (!parsed.ok) throw new Error('fixture');
    const lost = '9'.repeat(40);
    const event = (body: Record<string, unknown>, minute: number): IssueComment => ({
      id: minute, author: AGENT, authorType: 'Bot', viaApp: 'mi-motor', body: renderEventComment(body as unknown as PieceEvent, 'es'),
      createdAt: `2026-09-24T10:0${minute}:00Z`, updatedAt: `2026-09-24T10:0${minute}:00Z`,
    });
    const comments = [
      event({ version: 1, type: 'builder', op: 'b', piece: '13', sha: trusted, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_b' }, result: tree, source: 'provider-cli' }, 1),
      event({ version: 1, type: 'verdict', op: `verdict:review:${lost}`, piece: '13', sha: lost, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_old' }, stage: 'review', angle: 'correctitud', approved: false, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 2),
      event({ version: 1, type: 'verdict', op: `verdict:review:${head}`, piece: '13', sha: head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_v' }, stage: 'review', angle: 'correctitud', approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 3),
    ];
    const github = { issueComments: async () => comments, reviews: async () => [], forcePushedHeads: async () => [] } as unknown as JudgeGitHub;
    const facts = await describeChangeFromCommits({ root, base: trusted, head, recipe: parsed.recipe, piece: '13' });
    const context = {
      facts, files: gitProjectFiles(root, head), locale: 'es', piece: '13', recipe: parsed.recipe, root, head, trusted, needsHuman: false,
      validWhile: 'same-sha', owner: OWNER, pullRequest: 7, github, stage: 'review',
      fetchObjects: async (shas: string[]) => {
        if (shas.includes(lost)) throw new Error(`fatal: remote error: upload-pack: not our ref ${lost}`);
      },
    } as ServerAttestContext;
    const attest = engineBlock('ai-workflows/sandboxed-review@1')?.server?.attestation;
    const inputs = { reviewer: { provider: 'claude', model: 'claude-opus-5' }, prompt: 'p.md', angle: 'correctitud', forbidSameFamily: true, timeoutMinutes: 30 };
    expect(await attest?.(inputs, context)).toMatchObject({ outcome: 'passed' });
  });
});

describe('a store that fails while confirming an effect in doubt', () => {
  it('keeps an optional stage blocked', async () => {
    const parsed = parseRecipe(lines(
      'version: 1', 'locale: es', 'stages:',
      '  - id: sweep', '    summary: "Opcional"', '    required: false', '    nature: recompute', '    gate:', '      uses: ai-workflows/effect@1', '    server: local-only',
      '  - id: merge', '    summary: "Se une"', '    after: sweep', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/done@1',
    ), 'receta.yml');
    if (!parsed.ok) throw new Error('fixture');
    const root = repository();
    write(root, 'x.txt', 'x\n');
    commit(root, 'c');
    const effect = {
      manifest: { name: 'effect', kind: 'module', natures: ['recompute'], server: ['require-check'], inputs: {} },
      create: () => async (context: { runEffect(id: string, fn: () => Promise<never>): Promise<unknown> }) => {
        await context.runEffect('op-c', async () => { throw new Error('se cortó'); });
        return { ok: true };
      },
      reconcile: async () => ({ confirmed: 1 }),
    } as unknown as BlockDefinition;
    const done: BlockDefinition = { manifest: { name: 'done', kind: 'module', natures: ['recompute'], server: [], inputs: {} }, create: () => () => ({ ok: true }) };
    const base = createMemoryStore();
    const store: Store = { ...base, reconcileEffect: async () => { throw new Error('el almacén no respondió'); } };
    const compiled = await compileRecipe(parsed.recipe, { root, baseRef: 'main', declared: () => ({}), store, extraBlocks: { 'ai-workflows/effect@1': effect, 'ai-workflows/done@1': done } });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, sleep: async () => undefined });
    await engine.run('42');
    expect(await engine.run('42')).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep' } });
  });
});

describe('sync between two records', () => {
  it('stops after the first record when another session took the piece, and never moves the head', async () => {
    const recipe = lines('version: 1', 'locale: es', `owner: ${OWNER}`, `agent-account: "${AGENT}"`, 'pieces: { branch: ["*/{piece}-*"] }', 'stages:', '  - id: merge', '    summary: "Se une"', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/github-merge@1');
    const root = repository({ '.ai-workflows/pipeline.yml': recipe, 'src/a.ts': 'export const a = 1;\n' });
    git(root, 'switch', '-q', '-c', BRANCH);
    git(root, 'branch', '-q', '-D', 'piece');
    write(root, 'src/a.ts', 'export const a = 2;\n');
    commit(root, 'la pieza');
    const origin = mkdtempSync(join(tmpdir(), 'aiw-origin-'));
    folders.push(origin);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-q', 'origin', 'main', BRANCH);
    const other = mkdtempSync(join(tmpdir(), 'aiw-other-'));
    folders.push(other);
    execFileSync('git', ['clone', '-q', origin, other]);
    for (const [key, value] of [['user.email', 'o@example.com'], ['user.name', 'Otro'], ['commit.gpgsign', 'false']] as const) git(other, 'config', key, value);
    for (const file of ['docs/uno.md', 'docs/dos.md']) {
      git(other, 'switch', '-q', 'main');
      write(other, file, 'base\n');
      commit(other, file);
      git(other, 'push', '-q', 'origin', 'main');
      git(other, 'switch', '-q', BRANCH);
      git(other, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    }
    git(other, 'push', '-q', 'origin', BRANCH);

    const remote = fakeRemote();
    const github = new FakeGitHub();
    const before = git(root, 'rev-parse', 'HEAD');
    const output = await runAgentCli(['sync', PIECE], {
      cwd: root, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [],
      beforeCleanUpdateRecord: async (index: number) => {
        if (index === 1) remote.put(`pieces/${PIECE}`, 'lease.json', JSON.stringify({ runId: 'otra-sesion', expiresAt: Date.now() + 15 * 60_000 }));
      },
    });

    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/otra sesión|another session/i);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    const records = (await createGitStore({ port: remote.port() }).journal(PIECE)).filter((entry) => entry.stage === '@clean-update');
    expect(records).toHaveLength(1);
  });
});

describe.skipIf(process.platform !== 'win32')('finish on Windows', () => {
  it('recognises its folder however its path is cased', async () => {
    const recipe = lines('version: 1', 'locale: es', 'stages:', '  - id: merge', '    summary: "Se une"', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/github-merge@1');
    const main = repository({ '.ai-workflows/pipeline.yml': recipe });
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
    const recorded = folder.replace(/feat-13$/, 'FEAT-13').toUpperCase();
    await store.append(PIECE, { stage: 'cleanup', outcome: 'passed', at: 1, runId: 'r', pipeline: 'p', evidence: { judged: { sha: head, snapshot: 's', fingerprint: 'f' }, block: { branch: BRANCH, headSha: head, mergeSha: 'f'.repeat(40), folder: recorded, removeFolder: true } } });
    await store.saveStatus({ piece: PIECE, state: 'done' }, undefined);
    const github = new FakeGitHub();
    const output = await runAgentCli(['finish', PIECE], { cwd: main, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [] });
    expect(output.ok).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });
});
