import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runJudge, type JudgeGitHub } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R5 §2.6: two events that did not wake the judge. The owner's "Approve" arrives as a
// pull_request_review, whose workflow would run the YAML of the pull request; a minimal signal
// workflow listens to it and the judge follows through workflow_run, whose YAML is always the
// default branch's. A new builder or verdict event arrives as a comment on the piece's ISSUE, not
// on the pull request; the judge now judges the open pull requests of that piece.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'agent-account: "agentes[bot]"',
  'classify:',
  '  visible: ["app/**"]',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'stages:',
  '  - id: approval',
  '    summary: "La dueña aprueba con el botón"',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/approval-review@1',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

interface Pr { number: number; head: string; branch: string; base?: string }

function setup(prs: (heads: { visible: string; other: string }) => Pr[]) {
  const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'app/page.tsx': 'uno\n' });
  write(root, 'app/page.tsx', 'dos\n');
  const visible = commit(root, 'visible');
  write(root, 'app/page.tsx', 'tres\n');
  const other = commit(root, 'otra');
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const list = prs({ visible, other });
  const published: { sha: string; state: string }[] = [];
  const asked: string[] = [];
  const url = 'https://github.com/duena/proyecto/actions/runs/1';
  const github: JudgeGitHub = {
    defaultBranch: async () => 'main',
    branchHead: async () => main,
    pullRequest: async (n) => {
      const pr = list.find((item) => item.number === n);
      if (pr === undefined) throw new Error(`no PR ${n}`);
      return { number: n, state: 'open', headSha: pr.head, headRef: pr.branch, baseRef: pr.base ?? 'main', headRepo: 'duena/proyecto' };
    },
    openPullRequestsWithHead: async (sha) => {
      asked.push(`head:${sha}`);
      return list.filter((pr) => pr.head === sha).map((pr) => pr.number);
    },
    openPullRequests: async () => {
      asked.push('open');
      return list.map((pr) => ({ number: pr.number, headRef: pr.branch, headSha: pr.head, baseRef: pr.base ?? 'main' }));
    },
    mergeQueue: async () => [],
    comments: async () => [],
    issueComments: async () => [],
    reviews: async () => [],
    checkRuns: async () => [],
    statuses: async () => [{ context: 'ai-workflows', state: 'pending', targetUrl: url, createdAt: '2026-09-25T12:00:00Z' }],
    workflowRun: async () => ({ path: '.github/workflows/ai-workflows.yml', event: 'workflow_run', headBranch: 'main' }),
    forcePushedHeads: async () => [],
    publishStatus: async (sha, status) => {
      published.push({ sha, state: status.state });
    },
    upsertTraceComment: async () => {},
  } as JudgeGitHub;
  const judge = (eventName: string, event: unknown) =>
    runJudge({
      eventName,
      event,
      mode: 'on',
      context: 'ai-workflows',
      repository: 'duena/proyecto',
      workflowRef: 'duena/proyecto/.github/workflows/ai-workflows.yml@refs/heads/main',
      actionRef: 'a'.repeat(40),
      runId: 1,
      serverUrl: 'https://github.com',
      alsoProtect: [],
      root,
    }, { github, fetchObjects: async () => {} });
  return { visible, other, published, asked, judge };
}

const EVENT_COMMENT = 'Veredicto de correctitud: aprobado\n\n<!-- ai-workflows:event {"type":"verdict"} -->';

const SIGNAL_PATH = '.github/workflows/ai-workflows-review-signal.yml';
const MERGE_SHA = 'b'.repeat(40);
const signal = (over: Record<string, unknown> = {}) => ({
  workflow_run: {
    event: 'pull_request_review',
    path: SIGNAL_PATH,
    name: 'ai-workflows review signal',
    head_sha: MERGE_SHA,
    repository: { full_name: 'duena/proyecto' },
    pull_requests: [{ number: 7 }],
    ...over,
  },
});

describe('the owner button wakes the judge through the signal workflow', () => {
  it('re-reads the pull request named by the signal and judges its live head, not the merge commit of the event', async () => {
    const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
    await t.judge('workflow_run', signal());
    expect(t.asked).not.toContain(`head:${MERGE_SHA}`);
    expect(t.published.map((entry) => entry.sha)).toEqual([t.visible]);
  });

  it('accepts the signal path with a ref suffix, as GitHub reports it', async () => {
    const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
    await t.judge('workflow_run', signal({ path: `${SIGNAL_PATH}@refs/heads/main` }));
    expect(t.published.map((entry) => entry.sha)).toEqual([t.visible]);
  });

  for (const [name, over] of [
    ['another repository', { repository: { full_name: 'otro/proyecto' } }],
    ['another workflow path', { path: '.github/workflows/otra.yml' }],
    ['another event', { event: 'push' }],
  ] as const) {
    it(`a signal from ${name} judges nothing`, async () => {
      const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
      await t.judge('workflow_run', signal(over));
      expect(t.published).toEqual([]);
    });
  }

  it('a signal without a pull request number (a fork) judges nothing', async () => {
    const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
    await t.judge('workflow_run', signal({ pull_requests: [] }));
    expect(t.published).toEqual([]);
  });
});

describe('an event on the piece issue wakes the judge for that piece', () => {
  it('judges every open pull request into main whose branch names the piece, each on its own head, and no other', async () => {
    const t = setup((h) => [
      { number: 7, head: h.visible, branch: 'feat/13-boton' },
      { number: 10, head: h.other, branch: 'fix/13-segunda' },
      { number: 8, head: h.other, branch: 'feat/14-otra' },
      { number: 9, head: h.other, branch: 'feat/13-hacia-otra', base: 'develop' },
    ]);
    await t.judge('issue_comment', { action: 'created', issue: { number: 13 }, comment: { body: EVENT_COMMENT } });
    expect(t.published.map((entry) => entry.sha).sort()).toEqual([t.visible, t.other].sort());
  });

  it('a new comment on an issue without the event mark changes nothing', async () => {
    const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
    await t.judge('issue_comment', { action: 'created', issue: { number: 13 }, comment: { body: 'hola, ¿cómo va?' } });
    expect(t.published).toEqual([]);
    expect(t.asked).not.toContain('open');
  });

  for (const action of ['edited', 'deleted']) {
    it(`an ${action} comment on the piece issue judges again, even without the mark`, async () => {
      const t = setup((h) => [{ number: 7, head: h.visible, branch: 'feat/13-boton' }]);
      await t.judge('issue_comment', { action, issue: { number: 13 }, comment: { body: 'ya no dice nada' } });
      expect(t.published.map((entry) => entry.sha)).toEqual([t.visible]);
    });
  }

  it('a piece with no open pull request publishes nothing', async () => {
    const t = setup((h) => [{ number: 8, head: h.other, branch: 'feat/14-otra' }]);
    await t.judge('issue_comment', { action: 'created', issue: { number: 13 }, comment: { body: EVENT_COMMENT } });
    expect(t.published).toEqual([]);
  });
});

describe('the templates carry both triggers', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const judge = parse(read('templates/ai-workflows.yml')) as Record<string, any>;
  const signalOf = () => parse(read('templates/ai-workflows-review-signal.yml')) as Record<string, any>;

  it('the signal listens to submitted and dismissed reviews, with no permissions and nothing that reads the pull request', () => {
    const signal = signalOf();
    expect(signal['name']).toBe('ai-workflows review signal');
    expect(signal['on']).toEqual({ pull_request_review: { types: ['submitted', 'dismissed'] } });
    expect(signal['permissions']).toEqual({});
    const text = read('templates/ai-workflows-review-signal.yml');
    expect(text).not.toMatch(/actions\/checkout|secrets\.|github\.token|\$\{\{/);
  });

  it('the judge follows the signal and protects it as one of its own files', () => {
    expect(judge['on']['workflow_run']['workflows']).toContain('ai-workflows review signal');
    const step = (judge['jobs']['judge']['steps'] as Record<string, any>[]).find((item) => String(item['uses'] ?? '').startsWith('luismichelcf/ai-workflows@'));
    expect(String(step?.['with']?.['also-protect'])).toContain('.github/workflows/ai-workflows-review-signal.yml');
  });

  it('the judge lets through issue comments that carry the event mark, and every edit or deletion', () => {
    const condition = String(judge['jobs']['judge']['if']);
    expect(condition).toContain('ai-workflows:event');
    expect(condition).toContain('github.event.issue.pull_request');
    expect(condition).toMatch(/github\.event\.action != 'created'/);
  });
});

const PLAN_RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'kinds:',
  '  names: [behavior, visual-only]',
  '  default: behavior',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  declared-kind: { file: "docs/plans/PLAN-{piece}.md", line: "Tipo de cambio" }',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

describe('SV-03c: an exception inside the engine makes only that pull request technical', () => {
  it('a plan path that is a folder makes the judge publish error for that head, naming what failed', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': PLAN_RECIPE, 'app/page.tsx': 'uno\n' });
    write(root, 'docs/plans/PLAN-13.md/dentro.md', 'Tipo de cambio: comportamiento\n');
    const head = commit(root, 'el plan es una carpeta');
    git(root, 'switch', '-q', 'main');
    const main = git(root, 'rev-parse', 'HEAD');
    const published: { sha: string; state: string; description: string }[] = [];
    const github = {
      defaultBranch: async () => 'main',
      branchHead: async () => main,
      pullRequest: async () => ({ number: 7, state: 'open', headSha: head, headRef: 'feat/13-boton', baseRef: 'main', headRepo: 'duena/proyecto' }),
      openPullRequestsWithHead: async () => [7],
      openPullRequests: async () => [],
      mergeQueue: async () => [],
      comments: async () => [],
      issueComments: async () => [],
      reviews: async () => [],
      checkRuns: async () => [],
      statuses: async () => [],
      workflowRun: async () => ({ path: '.github/workflows/ai-workflows.yml', event: 'pull_request_target', headBranch: 'feat/13-boton' }),
      forcePushedHeads: async () => [],
      publishStatus: async (sha: string, status: { state: string; description: string }) => {
        published.push({ sha, state: status.state, description: status.description });
      },
      upsertTraceComment: async () => {},
    } as unknown as JudgeGitHub;
    await runJudge({
      eventName: 'pull_request_target',
      event: { pull_request: { number: 7, head: { sha: head, ref: 'feat/13-boton', repo: { full_name: 'duena/proyecto' } }, base: { sha: main, ref: 'main' } } },
      mode: 'on',
      context: 'ai-workflows',
      repository: 'duena/proyecto',
      workflowRef: 'duena/proyecto/.github/workflows/ai-workflows.yml@refs/heads/main',
      actionRef: 'a'.repeat(40),
      runId: 1,
      serverUrl: 'https://github.com',
      alsoProtect: [],
      root,
    }, { github, fetchObjects: async () => {} });
    expect(published.filter((entry) => entry.state !== 'pending')).toEqual([{ sha: head, state: 'error', description: expect.stringMatching(/PLAN-13.md|cat-file|blob|tree/) }]);
  });
});
