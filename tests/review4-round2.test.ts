import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRecipe,
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
  type AgentCliDeps,
  type BlockDefinition,
  type IssueComment,
  type JudgeGitHub,
  type PieceEvent,
  type Recipe,
  type ServerAttestContext,
  type Store,
} from '../src/index.js';

import { AGENT, BRANCH, FakeGitHub, MERGE_STAGES, OWNER, PIECE, pieceRepository, runFinal } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';
import { fakeRemote } from './remote.js';

// PLAN-13-R4, flock round 2: (1) `run` never writes the store when the piece's issue cannot be
// read — a park, a quarantine or another session's live run are never overwritten, and a dry run
// leaves no trace; (2) a store that fails while settling an effect in doubt still blocks an
// optional stage; (3) an effect that failed is named as such, not as a store failure; (4) `sync`
// stops when it loses the piece; (5) the approval order an owner is told must be a plain command
// that is not the judge's own; (6) a published event whose commit cannot be fetched is ignored,
// never a permanent technical block; (7) the project's browser suite can never be handed the
// agents' credentials.

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  removeRepositories();
});

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// ---------------------------------------------------------------------------------------------
// (1) run never writes the store before it holds the piece

const SANDBOXED_RECIPE = lines(
  'version: 1',
  'locale: es',
  `owner: ${OWNER}`,
  `agent-account: "${AGENT}"`,
  'pieces: { branch: ["*/{piece}-*"] }',
  'stages:',
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
  '  - id: merge',
  '    summary: "Se une"',
  '    after: review',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      run: node hold.mjs',
);

function cliProject() {
  const root = repository({
    '.ai-workflows/pipeline.yml': SANDBOXED_RECIPE,
    'hold.mjs': "process.stdout.write(JSON.stringify({ ok: false, reason: 'se detiene aquí' }));\n",
    'docs/review.md': 'Revisa.\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  git(root, 'switch', '-q', '-c', BRANCH);
  git(root, 'branch', '-q', '-D', 'piece');
  write(root, 'src/a.ts', 'export const a = 2;\n');
  commit(root, 'la pieza');
  const remote = fakeRemote();
  const github = new FakeGitHub();
  github.readErrors.set('issueComments', 100);
  const deps = (over: Partial<AgentCliDeps> = {}): AgentCliDeps => ({
    cwd: root, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [], ...over,
  });
  return { root, remote, github, deps };
}

describe('run with an unreadable issue writes nothing to the store', () => {
  it('a parked piece stays parked, with its diagnosis', async () => {
    const p = cliProject();
    const store = createGitStore({ port: p.remote.port() });
    await store.saveStatus({ piece: PIECE, state: 'parked', reason: 'lo paró la dueña', previous: { state: 'blocked:rejected', reason: 'antes' } }, undefined);
    const before = await store.loadStatus(PIECE);

    const output = await runAgentCli(['run', PIECE], p.deps());

    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/issue/);
    expect((await store.loadStatus(PIECE))?.status).toEqual(before?.status);
  });

  it('a quarantined piece keeps its quarantine', async () => {
    const p = cliProject();
    const store = createGitStore({ port: p.remote.port() });
    const quarantine = { host: 'aqui', platform: 'posix', pgid: 7 };
    await store.saveStatus({ piece: PIECE, state: 'blocked:technical', stage: 'review', reason: 'procesos', quarantine }, undefined);
    await runAgentCli(['run', PIECE], p.deps());
    expect((await store.loadStatus(PIECE))?.status.quarantine).toEqual(quarantine);
  });

  it('a piece the store never saw is not created, and a dry run leaves no trace', async () => {
    const p = cliProject();
    await runAgentCli(['run', PIECE], p.deps());
    await runAgentCli(['run', PIECE, '--dry-run'], p.deps());
    expect(p.remote.commits).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// (2) and (3) in the engine

function oneEffect(options: { reconcile?: BlockDefinition['reconcile']; effect: () => Promise<never> }): BlockDefinition {
  return {
    manifest: { name: 'effect', kind: 'module', natures: ['recompute'], server: ['require-check'], inputs: {} },
    create: () => async (context) => {
      await context.runEffect('op-z', options.effect);
      return { ok: true };
    },
    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
  } as BlockDefinition;
}

async function engineOver(block: BlockDefinition, store: Store, required: boolean) {
  const parsed = parseRecipe(lines(
    'version: 1',
    'locale: es',
    'stages:',
    '  - id: sweep',
    '    summary: "Un efecto"',
    ...(required ? [] : ['    required: false']),
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/effect@1',
    `    server: ${required ? '{ require-check: x }' : 'local-only'}`,
    '  - id: merge',
    '    summary: "Se une"',
    '    after: sweep',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/done@1',
  ), 'receta.yml');
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
  const root = repository();
  write(root, 'x.txt', 'x\n');
  commit(root, 'c');
  const done: BlockDefinition = { manifest: { name: 'done', kind: 'module', natures: ['recompute'], server: [], inputs: {} }, create: () => () => ({ ok: true }) };
  const compiled = await compileRecipe(parsed.recipe, { root, baseRef: 'main', declared: () => ({}), store, extraBlocks: { 'ai-workflows/effect@1': block, 'ai-workflows/done@1': done } });
  return createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, sleep: async () => undefined });
}

describe('settling an effect in doubt', () => {
  it('a store that fails while settling it still blocks an optional stage, never lets it through', async () => {
    const base = createMemoryStore();
    const store: Store = { ...base, reconcileEffect: async () => { throw new Error('el almacén no respondió'); } };
    const block = oneEffect({
      effect: async () => { throw new Error('se cortó la red'); },
      reconcile: async () => ({ didNotHappen: true }),
    });
    const engine = await engineOver(block, store, false);
    await engine.run('42');
    const second = await engine.run('42');
    expect(second).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep' } });
  });
});

describe('an effect that failed is named as such', () => {
  it('the reason carries the effect\'s own failure and never calls it a store failure', async () => {
    const block = oneEffect({ effect: async () => { throw new Error('GitHub respondió 502'); } });
    const engine = await engineOver(block, createMemoryStore(), true);
    const outcome = await engine.run('42');
    expect(outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep', reason: expect.stringMatching(/GitHub respondió 502/) } });
    expect(outcome.outcome === 'ran' ? outcome.status.reason : '').not.toMatch(/store failed|almacén/);
  });
});

// ---------------------------------------------------------------------------------------------
// (4) sync stops when it loses the piece

describe('sync', () => {
  it('stops before moving the head when another session took the piece meanwhile, and says so', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': SANDBOXED_RECIPE, 'hold.mjs': 'x\n', 'src/a.ts': 'export const a = 1;\n' });
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
    git(other, 'switch', '-q', 'main');
    write(other, 'docs/nuevo.md', 'base\n');
    commit(other, 'base');
    git(other, 'push', '-q', 'origin', 'main');
    git(other, 'switch', '-q', BRANCH);
    git(other, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    git(other, 'push', '-q', 'origin', BRANCH);

    const remote = fakeRemote();
    const github = new FakeGitHub();
    const before = git(root, 'rev-parse', 'HEAD');
    const output = await runAgentCli(['sync', PIECE], {
      cwd: root, env: {}, github, remote: github, statePort: remote.port(), repository: 'duena/proyecto', ghAccounts: async () => [],
      beforeFastForward: async () => {
        // Another session takes the piece: its lease replaces ours on the piece's own ref.
        remote.put(`pieces/${PIECE}`, 'lease.json', JSON.stringify({ runId: 'otra-sesion', expiresAt: Date.now() + 15 * 60_000 }));
      },
    });

    expect(output.ok).toBe(false);
    expect(output.text).toMatch(/otra sesión|another session/i);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// (5) the approval order is a plain command and never the judge's own

describe('approval-comment command', () => {
  const recipe = (command: string) => lines(
    'version: 1',
    'locale: es',
    `owner: ${OWNER}`,
    'stages:',
    '  - id: approval',
    '    summary: "La dueña aprueba"',
    '    nature: attest',
    '    needs-human: true',
    '    gate:',
    '      uses: ai-workflows/approval-comment@1',
    `      with: { command: "${command}" }`,
    '    server: attestation',
    '  - id: merge',
    '    summary: "Se une"',
    '    after: approval',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
  );

  for (const bad of ['/approve-judge-change', 'approve', '/Approve', '/ok <!-- x -->', '/ok ya', '/']) {
    it(`refuses the command ${JSON.stringify(bad)}`, async () => {
      const result = await checkRecipe(recipe(bad), '.ai-workflows/pipeline.yml', { root: mkdtempSync(join(tmpdir(), 'aiw-cmd-')) });
      expect(result.ok, bad).toBe(false);
    });
  }

  it('positive: /visto-bueno and /ok are fine', async () => {
    for (const good of ['/visto-bueno', '/ok']) {
      const result = await checkRecipe(recipe(good), '.ai-workflows/pipeline.yml', { root: mkdtempSync(join(tmpdir(), 'aiw-cmd-')) });
      expect(result.ok, good).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// (6) an event whose commit cannot be fetched is ignored on the server

describe('independent-review on the server with an unfetchable event commit', () => {
  it('ignores that event instead of blocking forever, and still decides with the rest', async () => {
    const root = repository({ 'src/algo.ts': 'export const algo = 1;\n' });
    const trusted = git(root, 'rev-parse', 'main');
    write(root, 'src/algo.ts', 'export const algo = 2;\n');
    const head = commit(root, 'la pieza');
    const tree = git(root, 'rev-parse', `${head}^{tree}`);
    const parsed = parseRecipe(lines('version: 1', 'locale: es', `owner: ${OWNER}`, `agent-account: "${AGENT}"`, 'pieces: { branch: ["*/{piece}-*"] }', 'stages:', '  - id: merge', '    summary: "x"', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/github-merge@1'), 'r.yml');
    if (!parsed.ok) throw new Error('fixture');
    const recipe: Recipe = parsed.recipe;
    const lost = '9'.repeat(40);
    const event = (body: Record<string, unknown>, minute: number): IssueComment => ({
      id: minute, author: AGENT, authorType: 'Bot', viaApp: 'mi-motor', body: renderEventComment(body as unknown as PieceEvent, 'es'),
      createdAt: `2026-09-24T10:0${minute}:00Z`, updatedAt: `2026-09-24T10:0${minute}:00Z`,
    });
    const comments = [
      event({ version: 1, type: 'builder', op: 'b', piece: '13', sha: trusted, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_b' }, result: tree, source: 'provider-cli' }, 1),
      event({ version: 1, type: 'builder', op: 'b2', piece: '13', sha: lost, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_b2' }, result: tree, source: 'provider-cli' }, 2),
      event({ version: 1, type: 'verdict', op: 'v', piece: '13', sha: head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_v' }, angle: 'seguridad', approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 3),
    ];
    const github = { issueComments: async () => comments, reviews: async () => [], forcePushedHeads: async () => [] } as unknown as JudgeGitHub;
    const facts = await describeChangeFromCommits({ root, base: trusted, head, recipe, piece: '13' });
    const context: ServerAttestContext = {
      facts, files: gitProjectFiles(root, head), locale: 'es', piece: '13', recipe, root, head, trusted, needsHuman: false,
      validWhile: 'same-sha', owner: OWNER, pullRequest: 7, github, stage: 'review',
      fetchObjects: async (shas: string[]) => {
        if (shas.includes(lost)) throw new Error(`fatal: remote error: upload-pack: not our ref ${lost}`);
      },
    } as ServerAttestContext;
    const attest = engineBlock('ai-workflows/independent-review@1')?.server?.attestation;
    expect(await attest?.({ angles: ['seguridad'], forbidSameFamily: true }, context)).toMatchObject({ outcome: 'passed' });
  });
});

// ---------------------------------------------------------------------------------------------
// (7) the agents' credentials never reach the project's browser suite

describe('browser-qa pass-env', () => {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'AI_WORKFLOWS_APP_ID', 'AI_WORKFLOWS_APP_KEY_FILE']) {
    it(`refuses to pass ${name}`, async () => {
      const text = lines(
        'version: 1',
        'locale: es',
        'stages:',
        '  - id: preview',
        '    summary: "Vista previa"',
        '    nature: recompute',
        '    gate:',
        '      uses: ai-workflows/preview-deployment@1',
        '      with: { environment: Preview }',
        '    server: { require-check: p }',
        '  - id: qa',
        '    summary: "QA"',
        '    after: preview',
        '    nature: recompute',
        '    gate:',
        '      uses: ai-workflows/browser-qa@1',
        '      with:',
        '        command: "node qa.mjs"',
        '        preview-stage: preview',
        '        criteria: { file: "docs/plans/PLAN-{piece}.md", section: "Casos", id-prefix: "CA-" }',
        `        pass-env: [${name}]`,
        '    server: { require-check: qa }',
        '  - id: merge',
        '    summary: "Se une"',
        '    after: qa',
        '    phase: merge',
        '    nature: recompute',
        '    gate:',
        '      uses: ai-workflows/github-merge@1',
      );
      const result = await checkRecipe(text, '.ai-workflows/pipeline.yml', { root: mkdtempSync(join(tmpdir(), 'aiw-env-')) });
      expect(result.ok).toBe(false);
    });
  }
});

void pieceRepository;
void runFinal;
void MERGE_STAGES;
