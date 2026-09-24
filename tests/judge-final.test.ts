import { afterEach, describe, expect, it } from 'vitest';

import {
  annotationFor,
  describeChangeFromCommits,
  engineBlock,
  gitProjectFiles,
  parseRecipe,
  type IssueComment,
  type JudgeGitHub,
  type PullRequestReview,
  type Recipe,
  type ServerAttestContext,
  type ValidWhile,
} from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R4 §7: what the judge gains. The server parts of `independent-review`,
// `approval-review` and `sandboxed-review` read the same published events and reviews as the
// engine next to the agent, with the same decision functions; on the server
// `same-fingerprint-or-clean-update` only accepts the head (the judge never reads the store where
// clean updates are recorded). The trace notes become warnings.

afterEach(() => removeRepositories());

const AGENT = 'mi-motor[bot]';

function recipe(): Recipe {
  const parsed = parseRecipe(`${[
    'version: 1',
    'locale: es',
    'owner: duena',
    `agent-account: "${AGENT}"`,
    'pieces: { branch: ["*/{piece}-*"] }',
    'stages:',
    '  - id: merge',
    '    summary: "Se une"',
    '    phase: merge',
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/github-merge@1',
  ].join('\n')}\n`, 'receta.yml');
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
  return parsed.recipe;
}

interface Setup {
  readonly root: string;
  readonly trusted: string;
  readonly base: string;
  readonly head: string;
  readonly headTree: string;
  readonly comments: IssueComment[];
  readonly reviews: PullRequestReview[];
  context(validWhile: ValidWhile, needsHuman?: boolean): Promise<ServerAttestContext>;
}

function setup(): Setup {
  const root = repository({ 'src/algo.ts': 'export const algo = 1;\n' });
  const trusted = git(root, 'rev-parse', 'main');
  write(root, 'src/algo.ts', 'export const algo = 2;\n');
  const head = commit(root, 'la pieza');
  const headTree = git(root, 'rev-parse', `${head}^{tree}`);
  const comments: IssueComment[] = [];
  const reviews: PullRequestReview[] = [];
  const github = {
    issueComments: async (n: number) => {
      if (n !== 13) throw new Error(`wrong issue ${n}`);
      return [...comments];
    },
    reviews: async (n: number) => {
      if (n !== 7) throw new Error(`wrong pull request ${n}`);
      return [...reviews];
    },
    forcePushedHeads: async () => [],
  } as unknown as JudgeGitHub;
  const theRecipe = recipe();
  return {
    root,
    trusted,
    base: trusted,
    head,
    headTree,
    comments,
    reviews,
    async context(validWhile, needsHuman = true) {
      const facts = await describeChangeFromCommits({ root, base: trusted, head, recipe: theRecipe, piece: '13' });
      return {
        facts,
        files: gitProjectFiles(root, head),
        locale: 'es',
        piece: '13',
        recipe: theRecipe,
        root,
        head,
        trusted,
        needsHuman,
        validWhile,
        owner: 'duena',
        pullRequest: 7,
        github,
        fetchObjects: async () => undefined,
      };
    },
  };
}

const at = (minute: number) => `2026-09-24T10:${String(minute).padStart(2, '0')}:00Z`;

function event(body: Record<string, unknown>, minute: number, over: Partial<IssueComment> = {}): IssueComment {
  return {
    id: minute,
    author: AGENT,
    authorType: 'Bot',
    viaApp: 'mi-motor',
    body: `Evento.\n<!-- ai-workflows:event ${JSON.stringify(body)} -->`,
    createdAt: at(minute),
    updatedAt: at(minute),
    ...over,
  };
}

const builder = (sha: string, result: string, session = 'ses_builder') => ({
  version: 1, type: 'builder', op: `b-${session}`, piece: '13', sha,
  identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session },
  result, source: 'provider-cli',
});

const verdict = (sha: string, angle: string, over: Record<string, unknown> = {}) => ({
  version: 1, type: 'verdict', op: `v-${angle}-${String(over['approved'] ?? true)}`, piece: '13', sha,
  identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: `ses_${angle}` },
  angle, approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli',
  ...over,
});

describe('independent-review on the server', () => {
  const attest = engineBlock('ai-workflows/independent-review@1')?.server?.attestation;
  const inputs = { angles: ['seguridad', 'arquitectura'], forbidSameFamily: true };

  it('exists (the slice-3 answer "arrives in slice 4" is gone)', () => {
    expect(attest).toBeTypeOf('function');
  });

  it('passes with the published events of the head, and waits for nothing it does not need', async () => {
    const s = setup();
    s.comments.push(event(builder(s.base, s.headTree), 1), event(verdict(s.head, 'seguridad'), 2), event(verdict(s.head, 'arquitectura'), 3));
    expect(await attest?.(inputs, await s.context('same-sha'))).toMatchObject({ outcome: 'passed' });
  });

  it('is rejected without the verdict of an angle, or with a deciding REVISE', async () => {
    const s = setup();
    s.comments.push(event(builder(s.base, s.headTree), 1), event(verdict(s.head, 'seguridad'), 2));
    expect(await attest?.(inputs, await s.context('same-sha'))).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/arquitectura/) });

    s.comments.push(event(verdict(s.head, 'arquitectura'), 3), event(verdict(s.head, 'seguridad', { approved: false }), 4));
    expect(await attest?.(inputs, await s.context('same-sha'))).toMatchObject({ outcome: 'rejected' });
  });

  it('is rejected when the reviewer is the builder session, or when no builder changed anything', async () => {
    const same = setup();
    same.comments.push(
      event(builder(same.base, same.headTree, 'ses_seguridad'), 1),
      event(verdict(same.head, 'seguridad', { identity: { provider: 'opencode', model: 'otro', effort: 'high', session: 'ses_seguridad' } }), 2),
      event(verdict(same.head, 'arquitectura'), 3),
    );
    expect(await attest?.(inputs, await same.context('same-sha'))).toMatchObject({ outcome: 'rejected' });

    const idle = setup();
    const baseTree = git(idle.root, 'rev-parse', `${idle.base}^{tree}`);
    idle.comments.push(event(builder(idle.base, baseTree), 1), event(verdict(idle.head, 'seguridad'), 2), event(verdict(idle.head, 'arquitectura'), 3));
    expect(await attest?.(inputs, await idle.context('same-sha'))).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/quién construyó/) });
  });

  it('events that are edited, or from another account, do not count', async () => {
    const s = setup();
    s.comments.push(
      event(builder(s.base, s.headTree), 1),
      event(verdict(s.head, 'seguridad'), 2, { updatedAt: at(9) }),
      event(verdict(s.head, 'arquitectura'), 3, { author: 'duena', authorType: 'User', viaApp: null }),
    );
    expect(await attest?.(inputs, await s.context('same-sha'))).toMatchObject({ outcome: 'rejected' });
  });

  it('on the server same-fingerprint-or-clean-update accepts only the head', async () => {
    const s = setup();
    write(s.root, 'README.md', 'otra cosa\n');
    git(s.root, 'switch', '-q', 'main');
    const moved = commit(s.root, 'main se mueve');
    git(s.root, 'switch', '-q', 'piece');
    git(s.root, 'merge', '-q', '--no-ff', '--no-edit', moved);
    const old = s.head;
    s.comments.push(event(builder(s.base, s.headTree), 1), event(verdict(old, 'seguridad'), 2), event(verdict(old, 'arquitectura'), 3));
    const context = await s.context('same-fingerprint-or-clean-update');
    const newHead = git(s.root, 'rev-parse', 'HEAD');
    const facts = await describeChangeFromCommits({ root: s.root, base: moved, head: newHead, recipe: context.recipe, piece: '13' });
    expect(await attest?.(inputs, { ...context, head: newHead, trusted: moved, facts })).toMatchObject({ outcome: 'rejected' });
  });

  it('an unreadable issue is technical', async () => {
    const s = setup();
    const context = await s.context('same-sha');
    const broken = { ...context, github: { ...context.github, issueComments: async () => { throw new Error('gh no respondió'); } } as unknown as JudgeGitHub };
    expect(await attest?.(inputs, broken)).toEqual({ outcome: 'technical', reason: expect.stringMatching(/gh no respondió/) });
  });
});

describe('sandboxed-review on the server', () => {
  const attest = engineBlock('ai-workflows/sandboxed-review@1')?.server?.attestation;

  it('finds the verdict its block published for this stage and head', async () => {
    const s = setup();
    s.comments.push(event(builder(s.base, s.headTree), 1), event(verdict(s.head, 'correctitud', { stage: 'review', op: `verdict:review:${s.head}` }), 2));
    const inputs = { reviewer: { provider: 'claude', model: 'claude-opus-5' }, prompt: 'p.md', angle: 'correctitud', forbidSameFamily: true, timeoutMinutes: 30 };
    const context = { ...(await s.context('same-sha')), stage: 'review' } as ServerAttestContext;
    expect(await attest?.(inputs, context)).toMatchObject({ outcome: 'passed' });
  });

  it('a verdict of another stage does not count', async () => {
    const s = setup();
    s.comments.push(event(builder(s.base, s.headTree), 1), event(verdict(s.head, 'correctitud', { stage: 'otra', op: `verdict:otra:${s.head}` }), 2));
    const inputs = { reviewer: { provider: 'claude', model: 'claude-opus-5' }, prompt: 'p.md', angle: 'correctitud', forbidSameFamily: true, timeoutMinutes: 30 };
    const context = { ...(await s.context('same-sha')), stage: 'review' } as ServerAttestContext;
    expect(await attest?.(inputs, context)).toMatchObject({ outcome: 'rejected' });
  });
});

describe('approval-review on the server', () => {
  const attest = engineBlock('ai-workflows/approval-review@1')?.server?.attestation;

  it('passes with the owner\'s approval of the head and waits without it', async () => {
    const s = setup();
    expect(await attest?.({}, await s.context('same-sha'))).toMatchObject({ outcome: 'waiting', reason: expect.stringMatching(/Approve/) });
    s.reviews.push({ author: 'duena', authorType: 'User', state: 'APPROVED', commitId: s.head, submittedAt: at(5) });
    expect(await attest?.({}, await s.context('same-sha'))).toMatchObject({ outcome: 'passed' });
  });

  it('under same-fingerprint accepts an earlier commit with the same own changes', async () => {
    const s = setup();
    const earlier = s.head;
    const empty = commit(s.root, 'vacío encima');
    const context = await s.context('same-fingerprint');
    const facts = await describeChangeFromCommits({ root: s.root, base: s.trusted, head: empty, recipe: context.recipe, piece: '13' });
    s.reviews.push({ author: 'duena', authorType: 'User', state: 'APPROVED', commitId: earlier, submittedAt: at(5) });
    expect(await attest?.({}, { ...context, head: empty, facts })).toMatchObject({ outcome: 'passed' });
  });
});

describe('the trace notes (§7)', () => {
  it('are warnings, escaped so a note cannot start a second command', () => {
    expect(annotationFor('un estado imitado\n::error::falso')).toBe('::warning::un estado imitado%0A::error::falso');
  });
});
