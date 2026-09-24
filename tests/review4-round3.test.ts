import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRecipe,
  compileRecipe,
  createEngine,
  createMemoryStore,
  describeChangeFromCommits,
  engineBlock,
  gitProjectFiles,
  parseRecipe,
  renderEventComment,
  type BlockDefinition,
  type IssueComment,
  type JudgeGitHub,
  type PieceEvent,
  type ServerAttestContext,
} from '../src/index.js';

import { AGENT, OWNER } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R4, flock round 3: (1) an effect that failed inside an optional stage leaves it in doubt
// and blocks the piece on the very first run, never `done`; (2) on the server a builder whose
// commit cannot be fetched still excludes its session and family from reviewing, and only a
// definite "object not found" lets an event be ignored — any other fetch failure is technical;
// (3) credential names are compared without regard to case, as Windows does.

afterEach(() => removeRepositories());

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// ---------------------------------------------------------------------------------------------
// (1)

describe('an effect that failed inside an optional stage', () => {
  it('blocks the piece on the first run, and the effect is never left behind a done piece', async () => {
    const parsed = parseRecipe(lines(
      'version: 1',
      'locale: es',
      'stages:',
      '  - id: sweep',
      '    summary: "Opcional con un efecto"',
      '    required: false',
      '    nature: recompute',
      '    gate:',
      '      uses: ai-workflows/effect@1',
      '    server: local-only',
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
    const effect: BlockDefinition = {
      manifest: { name: 'effect', kind: 'module', natures: ['recompute'], server: ['require-check'], inputs: {} },
      create: () => async (context) => {
        await context.runEffect('comment:x', async () => {
          throw new Error('timeout tras publicar');
        });
        return { ok: true };
      },
    };
    const done: BlockDefinition = { manifest: { name: 'done', kind: 'module', natures: ['recompute'], server: [], inputs: {} }, create: () => () => ({ ok: true }) };
    const store = createMemoryStore();
    const compiled = await compileRecipe(parsed.recipe, { root, baseRef: 'main', declared: () => ({}), store, extraBlocks: { 'ai-workflows/effect@1': effect, 'ai-workflows/done@1': done } });
    const engine = createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, sleep: async () => undefined });

    const first = await engine.run('42');

    expect(first).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep', reason: expect.stringMatching(/timeout tras publicar/) } });
  });
});

// ---------------------------------------------------------------------------------------------
// (2)

function serverSetup(fetch: (shas: string[]) => Promise<void>) {
  const root = repository({ 'src/algo.ts': 'export const algo = 1;\n' });
  const trusted = git(root, 'rev-parse', 'main');
  write(root, 'src/algo.ts', 'export const algo = 2;\n');
  const head = commit(root, 'la pieza');
  const tree = git(root, 'rev-parse', `${head}^{tree}`);
  const parsed = parseRecipe(lines('version: 1', 'locale: es', `owner: ${OWNER}`, `agent-account: "${AGENT}"`, 'pieces: { branch: ["*/{piece}-*"] }', 'stages:', '  - id: merge', '    summary: "x"', '    phase: merge', '    nature: recompute', '    gate:', '      uses: ai-workflows/github-merge@1'), 'r.yml');
  if (!parsed.ok) throw new Error('fixture');
  const event = (body: Record<string, unknown>, minute: number): IssueComment => ({
    id: minute, author: AGENT, authorType: 'Bot', viaApp: 'mi-motor', body: renderEventComment(body as unknown as PieceEvent, 'es'),
    createdAt: `2026-09-24T10:0${minute}:00Z`, updatedAt: `2026-09-24T10:0${minute}:00Z`,
  });
  return { root, trusted, head, tree, recipe: parsed.recipe, event, fetch };
}

async function attestWith(s: ReturnType<typeof serverSetup>, comments: IssueComment[]) {
  const github = { issueComments: async () => comments, reviews: async () => [], forcePushedHeads: async () => [] } as unknown as JudgeGitHub;
  const facts = await describeChangeFromCommits({ root: s.root, base: s.trusted, head: s.head, recipe: s.recipe, piece: '13' });
  const context = {
    facts, files: gitProjectFiles(s.root, s.head), locale: 'es', piece: '13', recipe: s.recipe, root: s.root, head: s.head, trusted: s.trusted,
    needsHuman: false, validWhile: 'same-sha', owner: OWNER, pullRequest: 7, github, stage: 'review', fetchObjects: s.fetch,
  } as ServerAttestContext;
  return engineBlock('ai-workflows/independent-review@1')?.server?.attestation?.({ angles: ['seguridad'], forbidSameFamily: true }, context);
}

const LOST = '9'.repeat(40);

describe('on the server, a builder whose commit cannot be fetched', () => {
  it('still excludes its session: a reviewer who built an earlier, vanished version cannot approve', async () => {
    const s = serverSetup(async (shas) => {
      if (shas.includes(LOST)) throw new Error(`fatal: remote error: upload-pack: not our ref ${LOST}`);
    });
    const outcome = await attestWith(s, [
      s.event({ version: 1, type: 'builder', op: 'b1', piece: '13', sha: LOST, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_claude' }, result: s.tree, source: 'provider-cli' }, 1),
      s.event({ version: 1, type: 'builder', op: 'b2', piece: '13', sha: s.trusted, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_ds' }, result: s.tree, source: 'provider-cli' }, 2),
      s.event({ version: 1, type: 'verdict', op: 'v', piece: '13', sha: s.head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_claude' }, angle: 'seguridad', approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 3),
    ]);
    expect(outcome).toMatchObject({ outcome: 'rejected' });
  });

  it('and its family: with forbid-same-family, a reviewer of that family cannot approve either', async () => {
    const s = serverSetup(async (shas) => {
      if (shas.includes(LOST)) throw new Error(`fatal: remote error: upload-pack: not our ref ${LOST}`);
    });
    const outcome = await attestWith(s, [
      s.event({ version: 1, type: 'builder', op: 'b1', piece: '13', sha: LOST, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_a' }, result: s.tree, source: 'provider-cli' }, 1),
      s.event({ version: 1, type: 'builder', op: 'b2', piece: '13', sha: s.trusted, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_ds' }, result: s.tree, source: 'provider-cli' }, 2),
      s.event({ version: 1, type: 'verdict', op: 'v', piece: '13', sha: s.head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_b' }, angle: 'seguridad', approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 3),
    ]);
    expect(outcome).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/familia/) });
  });

  it('a fetch that fails for another reason (the network, a 5xx) is technical, never an ignored event', async () => {
    const s = serverSetup(async (shas) => {
      if (shas.includes(LOST)) throw new Error('fatal: unable to access https://github.com/: Could not resolve host');
    });
    const outcome = await attestWith(s, [
      s.event({ version: 1, type: 'builder', op: 'b1', piece: '13', sha: LOST, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_ds' }, result: s.tree, source: 'provider-cli' }, 1),
      s.event({ version: 1, type: 'verdict', op: 'v', piece: '13', sha: s.head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_v' }, angle: 'seguridad', approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 2),
    ]);
    expect(outcome).toMatchObject({ outcome: 'technical' });
  });
});

// ---------------------------------------------------------------------------------------------
// (3)

describe('credential names are compared without regard to case', () => {
  for (const name of ['gh_token', 'Gh_Token', 'github_token', 'ai_workflows_app_key_file']) {
    it(`pass-env refuses ${name}`, async () => {
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
      const result = await checkRecipe(text, '.ai-workflows/pipeline.yml', { root: mkdtempSync(join(tmpdir(), 'aiw-case-')) });
      expect(result.ok).toBe(false);
    });
  }
});
