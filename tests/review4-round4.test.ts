import { afterEach, describe, expect, it } from 'vitest';

import {
  compileRecipe,
  createEngine,
  createMemoryStore,
  describeChangeFromCommits,
  engineBlock,
  gitProjectFiles,
  parseRecipe,
  renderEventComment,
  type IssueComment,
  type JudgeGitHub,
  type PieceEvent,
  type ServerAttestContext,
  type Store,
} from '../src/index.js';

import { AGENT, OWNER } from './final-fixtures.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R4, flock round 4: (1) a PROJECT module block whose effect failed in an optional stage
// stays blocked on every later run — without `reconcile`, with a `reconcile` that fails, and when
// the store fails while settling it; (2) on the server, a verdict whose commit cannot be fetched and
// that is newer than the one deciding its angle makes the review technical, never a pass.

afterEach(() => removeRepositories());

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

// ---------------------------------------------------------------------------------------------
// (1)

const MODULE_EFFECT = (reconcile: 'none' | 'throws' | 'didNotHappen') => [
  'export default async (context) => {',
  "  await context.runEffect('comment:x', async () => { throw new Error('timeout tras publicar'); });",
  '  return { ok: true };',
  '};',
  ...(reconcile === 'throws' ? ["export const reconcile = async () => { throw new Error('no se pudo leer GitHub'); };"] : []),
  ...(reconcile === 'didNotHappen' ? ['export const reconcile = async () => ({ didNotHappen: true });'] : []),
].join('\n');

async function projectModuleRun(reconcile: 'none' | 'throws' | 'didNotHappen', store: Store) {
  const root = repository();
  write(root, '.ai-workflows/blocks/efecto/block.yml', lines('kind: module', 'natures: [recompute]', 'main: index.mjs'));
  write(root, '.ai-workflows/blocks/efecto/index.mjs', MODULE_EFFECT(reconcile));
  commit(root, 'bloque del proyecto');
  const parsed = parseRecipe(lines(
    'version: 1', 'locale: es', 'stages:',
    '  - id: sweep', '    summary: "Opcional con un efecto del proyecto"', '    required: false', '    nature: recompute',
    '    gate:', '      uses: ./.ai-workflows/blocks/efecto', '    server: local-only',
    '  - id: merge', '    summary: "Se une"', '    after: sweep', '    phase: merge', '    nature: recompute',
    '    gate:', '      uses: ai-workflows/done@1',
  ), 'receta.yml');
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
  const done = { manifest: { name: 'done', kind: 'module' as const, natures: ['recompute' as const], server: [], inputs: {} }, create: () => () => ({ ok: true as const }) };
  const compiled = await compileRecipe(parsed.recipe, { root, baseRef: 'main', declared: () => ({}), store, extraBlocks: { 'ai-workflows/done@1': done } });
  return createEngine({ config: compiled.config, store, describeChange: compiled.describeChange, sleep: async () => undefined });
}

describe('a project module block whose effect failed in an optional stage', () => {
  for (const reconcile of ['none', 'throws'] as const) {
    it(`stays blocked on the next run (reconcile: ${reconcile}), never done`, async () => {
      const store = createMemoryStore();
      const engine = await projectModuleRun(reconcile, store);
      expect(await engine.run('42')).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep' } });
      expect(await engine.run('42')).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep', reason: expect.stringMatching(/comment:x/) } });
    });
  }

  it('stays blocked when the store fails while settling it', async () => {
    const base = createMemoryStore();
    const store: Store = { ...base, reconcileEffect: async () => { throw new Error('el almacén no respondió'); } };
    const engine = await projectModuleRun('didNotHappen', store);
    await engine.run('42');
    expect(await engine.run('42')).toMatchObject({ status: { state: 'blocked:technical', stage: 'sweep' } });
  });
});

// ---------------------------------------------------------------------------------------------
// (2)

const LOST = '9'.repeat(40);

async function serverReview(block: 'independent-review' | 'sandboxed-review', lostIsNewer: boolean) {
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
  const stage = block === 'sandboxed-review' ? { stage: 'review' } : {};
  const angle = block === 'sandboxed-review' ? 'correctitud' : 'seguridad';
  const approved = event({ version: 1, type: 'verdict', op: `verdict:review:${head}`, piece: '13', sha: head, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_v' }, ...stage, angle, approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, 2);
  const unreadable = event({ version: 1, type: 'verdict', op: `verdict:review:${LOST}`, piece: '13', sha: LOST, identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: 'ses_w' }, ...stage, angle, approved: false, workspace: { before: 'w', after: 'w' }, source: 'provider-cli' }, lostIsNewer ? 3 : 1);
  const comments = [
    event({ version: 1, type: 'builder', op: 'b', piece: '13', sha: trusted, identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session: 'ses_b' }, result: tree, source: 'provider-cli' }, 0),
    approved,
    unreadable,
  ];
  const github = { issueComments: async () => comments, reviews: async () => [], forcePushedHeads: async () => [] } as unknown as JudgeGitHub;
  const facts = await describeChangeFromCommits({ root, base: trusted, head, recipe: parsed.recipe, piece: '13' });
  const context = {
    facts, files: gitProjectFiles(root, head), locale: 'es', piece: '13', recipe: parsed.recipe, root, head, trusted, needsHuman: false,
    validWhile: 'same-fingerprint', owner: OWNER, pullRequest: 7, github, stage: 'review',
    fetchObjects: async (shas: string[]) => {
      if (shas.includes(LOST)) throw new Error(`fatal: remote error: upload-pack: not our ref ${LOST}`);
    },
  } as ServerAttestContext;
  const inputs = block === 'sandboxed-review'
    ? { reviewer: { provider: 'claude', model: 'claude-opus-5' }, prompt: 'p.md', angle, forbidSameFamily: true, timeoutMinutes: 30 }
    : { angles: [angle], forbidSameFamily: true };
  return engineBlock(`ai-workflows/${block}@1`)?.server?.attestation?.(inputs, context);
}

describe('on the server, an unreadable verdict newer than the deciding one', () => {
  for (const block of ['independent-review', 'sandboxed-review'] as const) {
    it(`${block}: is technical, never a pass`, async () => {
      expect(await serverReview(block, true)).toMatchObject({ outcome: 'technical' });
    });
    it(`${block}: positive control, an older unreadable verdict does not stop the pass`, async () => {
      expect(await serverReview(block, false)).toMatchObject({ outcome: 'passed' });
    });
  }
});
