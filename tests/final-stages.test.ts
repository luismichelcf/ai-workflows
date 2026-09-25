import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../src/index.js';

import {
  AGENT,
  BRANCH,
  FakeGitHub,
  OWNER,
  PIECE,
  pieceRepository,
  runFinal,
} from './final-fixtures.js';
import { commit, git, removeRepositories, write } from './git-fixtures.js';

// PLAN-13-R4 §3.1–§3.5, §3.7 and §3.8 next to the agent: preview, browser QA, the owner's two ways
// of approving, the independent review, the checks after the merge and the cleanup. Each case says
// its motive, the state it leaves and the effects it did not produce, with its positive control.

afterEach(() => {
  delete process.env['QA_SCENARIO'];
  delete process.env['AIW_UNLISTED_SECRET'];
  removeRepositories();
});

/** `rows` are pre-merge stages; the merge holds, so a pass ends blocked at `hold`. */
const preMerge = (rows: readonly string[]) => [
  ...rows,
  '  - id: hold',
  '    summary: "Espera en la fusión"',
  `    after: ${stageId(rows)}`,
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/hold@1',
];

function stageId(rows: readonly string[]): string {
  const last = [...rows].reverse().find((row) => /^ {2}- id: /.test(row));
  return (last ?? '').replace(/^ {2}- id: /, '');
}

const passedTo = (stage: string) => ({ outcome: 'ran', status: { state: 'blocked:rejected', stage } });

// ---------------------------------------------------------------------------------------------
// preview-deployment (§3.4)

const PREVIEW = [
  '  - id: preview',
  '    summary: "La vista previa está lista"',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/preview-deployment@1',
  '      with: { environment: Preview, creator: "vercel[bot]", url-pattern: "*.vercel.app" }',
  '    server: { require-check: Vercel }',
];

describe('preview-deployment', () => {
  it('passes with the newest successful deployment of this exact SHA, recording its address', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    github.deploymentsOf.push(
      { id: 30, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'failure', url: null },
      { id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'https://p13.vercel.app' },
    );

    const run = await runFinal(root, github, preMerge(PREVIEW));

    expect(run.outcome).toMatchObject(passedTo('hold'));
    expect(run.entryOf('preview')?.evidence).toMatchObject({ block: { deployment: 31, url: 'https://p13.vercel.app', sha: head } });
  });

  const refusals: [string, (head: string) => Record<string, unknown>[], RegExp][] = [
    ['no deployment', () => [], /aún no está lista/],
    ['another SHA', () => [{ id: 31, sha: '9'.repeat(40), environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'https://p.vercel.app' }], /aún no está lista/],
    ['another environment', (head) => [{ id: 31, sha: head, environment: 'Production', creator: 'vercel[bot]', state: 'success', url: 'https://p.vercel.app' }], /aún no está lista/],
    ['another creator', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'otro', state: 'success', url: 'https://p.vercel.app' }], /aún no está lista/],
    ['still pending', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'pending', url: null }], /aún no está lista/],
    ['without a status', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]' }], /aún no está lista/],
    ['failed', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'failure', url: null }], /failure/],
    ['not https', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'http://p.vercel.app' }], /https/],
    ['outside the pattern', (head) => [{ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'https://p.otro.app' }], /vercel\.app/],
  ];
  for (const [what, deployments, reason] of refusals) {
    it(`refuses ${what}, saying why`, async () => {
      const { root, head } = pieceRepository();
      const github = new FakeGitHub();
      github.deploymentsOf.push(...(deployments(head) as never[]));
      const run = await runFinal(root, github, preMerge(PREVIEW));
      expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'preview', reason: expect.stringMatching(reason) } });
    });
  }

  it('a failed read is technical, never a refusal', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();
    github.readErrors.set('deployments', 1);
    expect((await runFinal(root, github, preMerge(PREVIEW))).outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'preview' } });
  });
});

// ---------------------------------------------------------------------------------------------
// browser-qa (§3.5)

/**
 * The project's browser suite, played by a Node script committed in the piece. It writes one
 * report per criterion in the folder the engine hands it, shaped by QA_SCENARIO (passed through
 * `pass-env`), and records the names of the variables it received.
 */
const QA_SCRIPT = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.AI_WORKFLOWS_REPORT_DIR;
const criteria = JSON.parse(process.env.AI_WORKFLOWS_CRITERIA);
const scenario = process.env.QA_SCENARIO ?? 'ok';
// Nothing of the engine's own environment may reach the project's suite, only its pass-env.
if (process.env.AIW_UNLISTED_SECRET !== undefined || process.env.GH_TOKEN !== undefined) process.exit(4);
if (process.env.AI_WORKFLOWS_PREVIEW_URL !== 'https://p13.vercel.app' || process.env.AI_WORKFLOWS_PIECE !== '13' || !/^[0-9a-f]{40}$/.test(process.env.AI_WORKFLOWS_SHA ?? '')) process.exit(5);
mkdirSync(dir, { recursive: true });
const report = (id, value) => writeFileSync(join(dir, id + '.json'), typeof value === 'string' ? value : JSON.stringify(value));
for (const id of criteria) {
  if (scenario === 'missing' && id === criteria[0]) continue;
  if (scenario === 'failed' && id === criteria[0]) { report(id, { status: 'failed', assertions: 2 }); continue; }
  if (scenario === 'empty' && id === criteria[0]) { report(id, { status: 'passed', assertions: 0 }); continue; }
  if (scenario === 'garbage' && id === criteria[0]) { report(id, '{ not json'); continue; }
  report(id, { status: 'passed', assertions: 3, evidence: { env: Object.keys(process.env).sort(), url: process.env.AI_WORKFLOWS_PREVIEW_URL, piece: process.env.AI_WORKFLOWS_PIECE, sha: process.env.AI_WORKFLOWS_SHA } });
}
if (scenario === 'extra') report('CA-99', { status: 'passed', assertions: 1 });
if (scenario === 'intree') writeFileSync('escrito-en-el-arbol.txt', 'x');
process.exit(scenario === 'exit' ? 3 : 0);
`;

const QA = [
  '  - id: qa',
  '    summary: "Pruebas de navegador"',
  '    after: preview',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/browser-qa@1',
  '      with:',
  '        command: "node qa.mjs"',
  '        preview-stage: preview',
  '        criteria: { file: "docs/plans/PLAN-{piece}.md", section: "Casos de aceptación", id-prefix: "CA-" }',
  '        pass-env: [QA_SCENARIO]',
  '    server: { require-check: qa }',
];

function qaSetup(scenario?: string) {
  const { root, head } = pieceRepository({ 'src/algo.ts': 'export const algo = 2;\n', 'qa.mjs': QA_SCRIPT });
  const github = new FakeGitHub();
  github.deploymentsOf.push({ id: 31, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'https://p13.vercel.app' });
  github.addPullRequest({ number: 7, headSha: head, isDraft: true, body: `Refs #13\n<!-- ai-workflows:op open-pr:${BRANCH}:${head} -->` });
  github.branches.set(BRANCH, head);
  if (scenario !== undefined) process.env['QA_SCENARIO'] = scenario;
  process.env['AIW_UNLISTED_SECRET'] = 'no debe llegar';
  return { root, head, github };
}

describe('browser-qa', () => {
  it('passes when every criterion passed once, with the preview address and nothing else from the environment', async () => {
    const { root, head, github } = qaSetup();
    const before = git(root, 'status', '--porcelain');

    const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));

    expect(run.outcome).toMatchObject(passedTo('hold'));
    const evidence = run.entryOf('qa')?.evidence as { block: { pr: number; url: string; criteria: Record<string, string> } };
    expect(evidence.block.pr).toBe(7);
    expect(evidence.block.url).toBe('https://p13.vercel.app');
    expect(Object.keys(evidence.block.criteria).sort()).toEqual(['CA-01', 'CA-02']);
    expect(git(root, 'status', '--porcelain')).toBe(before);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('the command sees the preview, the piece and the SHA, its pass-env, and no other variable of the engine', async () => {
    // The script exits 4 if a variable of the engine that was not passed reaches it, and 5 if the
    // preview, piece or SHA are missing; a pass proves both. The tree stays clean.
    const { root, github } = qaSetup('ok');
    process.env['GH_TOKEN'] = 'ghs_no_debe_llegar';
    try {
      const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));
      expect(run.outcome).toMatchObject(passedTo('hold'));
    } finally {
      delete process.env['GH_TOKEN'];
    }
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  const refusals: [string, RegExp][] = [
    ['missing', /CA-01/],
    ['extra', /CA-99/],
    ['failed', /CA-01/],
    ['empty', /CA-01/],
    ['garbage', /CA-01/],
    ['exit', /3/],
  ];
  for (const [scenario, reason] of refusals) {
    it(`refuses the scenario "${scenario}", naming what is wrong`, async () => {
      const { root, github } = qaSetup(scenario);
      const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));
      expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'qa', reason: expect.stringMatching(reason) } });
    });
  }

  it('a command that writes inside the tree is technical (the seal sees it)', async () => {
    const { root, github } = qaSetup('intree');
    const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'qa' } });
  });

  it('a pull request whose head moved during the run is refused', async () => {
    const { root, github } = qaSetup();
    let reads = 0;
    github.onDetail = (pr) => {
      reads += 1;
      if (reads >= 2) Object.assign(pr, { headSha: '9'.repeat(40) });
    };
    const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'qa' } });
  });

  it('without criteria in the plan it is refused', async () => {
    const { root, github } = qaSetup();
    write(root, 'docs/plans/PLAN-13.md', '# Plan\n\n## Casos de aceptación\n\nnada con identificador\n');
    const head = commit(root, 'sin criterios');
    github.deploymentsOf.push({ id: 32, sha: head, environment: 'Preview', creator: 'vercel[bot]', state: 'success', url: 'https://p13.vercel.app' });
    const pr = github.prs[0];
    if (pr !== undefined) Object.assign(pr, { headSha: head });
    github.branches.set(BRANCH, head);
    const run = await runFinal(root, github, preMerge([...PREVIEW, ...QA]));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'qa', reason: expect.stringMatching(/CA-/) } });
  });
});

// ---------------------------------------------------------------------------------------------
// approval-review and approval-comment next to the agent (§3.2, §3.3)

const APPROVAL_REVIEW = [
  '  - id: approval',
  '    summary: "El dueño aprueba"',
  '    nature: attest',
  '    needs-human: true',
  '    valid-while: same-fingerprint',
  '    gate:',
  '      uses: ai-workflows/approval-review@1',
  '    server: attestation',
];

describe('approval-review next to the agent', () => {
  it('opens the pull request as the agents, waits for the button, and tells the owner where', async () => {
    const { root } = pieceRepository();
    const github = new FakeGitHub();

    const run = await runFinal(root, github, preMerge(APPROVAL_REVIEW));

    expect(run.outcome).toMatchObject({
      status: { state: 'waiting:decision', stage: 'approval', reason: expect.stringMatching(/Approve.*pull\/100/) },
    });
    expect(github.prs).toHaveLength(1);
    expect(github.prs[0]?.author).toBe(AGENT);
  });

  it('passes once the owner approved this version', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    const store = createMemoryStore();
    const first = await runFinal(root, github, preMerge(APPROVAL_REVIEW), { store });
    github.reviewsOf.set(100, [{ author: OWNER, authorType: 'User', state: 'APPROVED', commitId: head, submittedAt: '2026-09-24T12:00:00Z' }]);

    const second = await first.again();

    expect(second.outcome).toMatchObject(passedTo('hold'));
    expect(second.entryOf('approval')?.evidence).toMatchObject({ block: { pr: 100, reviewedCommit: head } });
  });
});

describe('approval-comment next to the agent (the fallback of R21)', () => {
  const APPROVAL_COMMENT = [
    '  - id: approval',
    '    summary: "El dueño aprueba por comentario"',
    '    nature: attest',
    '    needs-human: true',
    '    gate:',
    '      uses: ai-workflows/approval-comment@1',
    '      with: { command: /visto-bueno }',
    '    server: attestation',
  ];

  it('waits saying exactly what to write, and passes with the owner\'s comment for the head', async () => {
    const { root, head } = pieceRepository();
    const github = new FakeGitHub();
    const store = createMemoryStore();
    const first = await runFinal(root, github, preMerge(APPROVAL_COMMENT), { store });
    expect(first.outcome).toMatchObject({
      status: { state: 'waiting:decision', stage: 'approval', reason: expect.stringContaining(`/visto-bueno ${head.slice(0, 7)}`) },
    });

    github.issueCommentsOf.set(100, [{ id: 1, author: OWNER, authorType: 'User', viaApp: null, body: `/visto-bueno ${head.slice(0, 7)}`, createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00Z' }]);
    expect((await first.again()).outcome).toMatchObject(passedTo('hold'));
  });
});

// ---------------------------------------------------------------------------------------------
// independent-review next to the agent (§2.2, §3.1)

const REVIEW = [
  '  - id: review',
  '    summary: "Revisores independientes aprueban"',
  '    nature: attest',
  '    gate:',
  '      uses: ai-workflows/independent-review@1',
  '      with: { angles: [seguridad, arquitectura] }',
  '    server: attestation',
];

function event(body: Record<string, unknown>, at: string) {
  return {
    id: Math.floor(Math.random() * 1e9),
    author: AGENT,
    authorType: 'Bot' as const,
    viaApp: 'mi-motor',
    body: `Evento.\n<!-- ai-workflows:event ${JSON.stringify(body)} -->`,
    createdAt: at,
    updatedAt: at,
  };
}

function builder(start: string, result: string, session = 'ses_builder') {
  return {
    version: 1, type: 'builder', op: `b-${session}`, piece: PIECE, sha: start,
    identity: { provider: 'opencode', model: 'deepseek/deepseek-flash', effort: 'high', session },
    result, source: 'provider-cli',
  };
}

function verdict(sha: string, angle: string, over: Record<string, unknown> = {}) {
  return {
    version: 1, type: 'verdict', op: `v-${angle}-${String(over['approved'] ?? true)}`, piece: PIECE, sha,
    identity: { provider: 'claude', model: 'claude-opus-5', effort: 'high', session: `ses_${angle}` },
    angle, approved: true, workspace: { before: 'w', after: 'w' }, source: 'provider-cli',
    ...over,
  };
}

describe('independent-review next to the agent', () => {
  function reviewed(verdicts: Record<string, unknown>[], builders?: Record<string, unknown>[]) {
    const { root, head } = pieceRepository();
    const base = git(root, 'merge-base', 'main', 'HEAD');
    const github = new FakeGitHub();
    const tree = git(root, 'rev-parse', `${head}^{tree}`);
    const events = [
      ...(builders ?? [builder(base, tree)]).map((item, index) => event(item, `2026-09-24T09:0${index}:00Z`)),
      ...verdicts.map((item, index) => event(item, `2026-09-24T10:0${index}:00Z`)),
    ];
    github.issueCommentsOf.set(Number(PIECE), events);
    return { root, head, base, github };
  }

  it('passes with a fresh approving verdict per angle, from another session and family than the builder', async () => {
    const setup = reviewed([]);
    setup.github.issueCommentsOf.get(Number(PIECE))?.push(
      event(verdict(setup.head, 'seguridad'), '2026-09-24T10:00:00Z'),
      event(verdict(setup.head, 'arquitectura'), '2026-09-24T10:01:00Z'),
    );
    const run = await runFinal(setup.root, setup.github, preMerge(REVIEW));
    expect(run.outcome).toMatchObject(passedTo('hold'));
    expect(run.entryOf('review')?.evidence).toMatchObject({ block: { verdicts: expect.arrayContaining([expect.objectContaining({ angle: 'seguridad', sha: setup.head })]) } });
  });

  it('refuses without a builder that changed something', async () => {
    const setup = reviewed([], []);
    const events = setup.github.issueCommentsOf.get(Number(PIECE)) ?? [];
    const baseTree = git(setup.root, 'rev-parse', `${setup.base}^{tree}`);
    events.push(event(builder(setup.base, baseTree), '2026-09-24T09:00:00Z'));
    events.push(event(verdict(setup.head, 'seguridad'), '2026-09-24T10:00:00Z'), event(verdict(setup.head, 'arquitectura'), '2026-09-24T10:01:00Z'));
    const run = await runFinal(setup.root, setup.github, preMerge(REVIEW));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'review', reason: expect.stringMatching(/quién construyó/) } });
  });

  it('refuses a reviewer that is the same session as any builder, even under another model (R18)', async () => {
    const setup = reviewed([]);
    const events = setup.github.issueCommentsOf.get(Number(PIECE)) ?? [];
    events.push(event(builder(setup.base, '7'.repeat(40), 'ses_seguridad'), '2026-09-24T09:05:00Z'));
    events.push(event(verdict(setup.head, 'seguridad', { identity: { provider: 'opencode', model: 'otro-modelo', effort: 'high', session: 'ses_seguridad' } }), '2026-09-24T10:00:00Z'));
    events.push(event(verdict(setup.head, 'arquitectura'), '2026-09-24T10:01:00Z'));
    const run = await runFinal(setup.root, setup.github, preMerge(REVIEW));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'review' } });
  });

  it('refuses a reviewer of the builder family when forbid-same-family (the default)', async () => {
    const setup = reviewed([]);
    const events = setup.github.issueCommentsOf.get(Number(PIECE)) ?? [];
    events.push(event(verdict(setup.head, 'seguridad', { identity: { provider: 'deepseek', model: 'deepseek-pro', effort: 'high', session: 'ses_x' } }), '2026-09-24T10:00:00Z'));
    events.push(event(verdict(setup.head, 'arquitectura'), '2026-09-24T10:01:00Z'));
    const run = await runFinal(setup.root, setup.github, preMerge(REVIEW));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'review', reason: expect.stringMatching(/familia/) } });
  });

  it('refuses an angle nobody covered, and a REVISE that decides, with its text', async () => {
    const missing = reviewed([]);
    missing.github.issueCommentsOf.get(Number(PIECE))?.push(event(verdict(missing.head, 'seguridad'), '2026-09-24T10:00:00Z'));
    expect((await runFinal(missing.root, missing.github, preMerge(REVIEW))).outcome).toMatchObject({
      status: { state: 'blocked:rejected', stage: 'review', reason: expect.stringMatching(/arquitectura/) },
    });

    const revise = reviewed([]);
    const list = revise.github.issueCommentsOf.get(Number(PIECE)) ?? [];
    list.push(event(verdict(revise.head, 'seguridad'), '2026-09-24T10:00:00Z'));
    list.push(event(verdict(revise.head, 'arquitectura'), '2026-09-24T10:01:00Z'));
    list.push(event(verdict(revise.head, 'seguridad', { approved: false }), '2026-09-24T10:02:00Z'));
    expect((await runFinal(revise.root, revise.github, preMerge(REVIEW))).outcome).toMatchObject({
      status: { state: 'blocked:rejected', stage: 'review' },
    });
  });

  it('a verdict of an older version does not count under same-sha', async () => {
    const setup = reviewed([]);
    const list = setup.github.issueCommentsOf.get(Number(PIECE)) ?? [];
    list.push(event(verdict(setup.base, 'seguridad'), '2026-09-24T10:00:00Z'));
    list.push(event(verdict(setup.head, 'arquitectura'), '2026-09-24T10:01:00Z'));
    const run = await runFinal(setup.root, setup.github, preMerge(REVIEW));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'review', reason: expect.stringMatching(/seguridad/) } });
  });

  it('an unreadable issue is technical, never a pass without builder', async () => {
    const setup = reviewed([]);
    setup.github.readErrors.set('issueComments', 5);
    expect((await runFinal(setup.root, setup.github, preMerge(REVIEW))).outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'review' } });
  });
});

// ---------------------------------------------------------------------------------------------
// post-merge and cleanup (§3.7, §3.8)

const MERGED_AT = 'f'.repeat(40);

const AFTER_MERGE = (postWith: string, cleanupWith = '      with: { merge-stage: merge }') => [
  '  - id: merge',
  '    summary: "Se fusiona"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  '  - id: after',
  '    summary: "Lo publicado queda en verde"',
  '    after: merge',
  '    phase: post-merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/post-merge@1',
  postWith,
  '    server: local-only',
  '  - id: cleanup',
  '    summary: "Limpieza"',
  '    after: after',
  '    phase: post-merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/cleanup@1',
  cleanupWith,
  '    server: local-only',
];

function merged() {
  const { root, head } = pieceRepository();
  const github = new FakeGitHub();
  github.onDetail = (pr, reads) => {
    if (reads >= 2 && pr.autoMerge && pr.state === 'OPEN') github.merge(pr, MERGED_AT);
  };
  return { root, head, github };
}

describe('post-merge', () => {
  it('passes when every named check of the merge commit is green and production is deployed', async () => {
    const { root, github } = merged();
    github.checkRunsOf.set(`${MERGED_AT}|deploy`, [{ id: 1, status: 'completed', conclusion: 'success', app: 'github-actions', url: null }]);
    github.deploymentsOf.push({ id: 40, sha: MERGED_AT, environment: 'Production', creator: 'vercel[bot]', state: 'success', url: 'https://x.app' });

    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge, checks: [deploy], deployment: { environment: Production } }'));

    expect(run.outcome).toMatchObject({ outcome: 'ran', status: { state: 'done' } });
    expect(run.entryOf('after')?.evidence).toMatchObject({ block: { mergeSha: MERGED_AT } });
  });

  const refusals: [string, (github: FakeGitHub) => void, RegExp][] = [
    ['a check still running', (g) => g.checkRunsOf.set(`${MERGED_AT}|deploy`, [{ id: 1, status: 'in_progress', conclusion: null, app: 'a', url: null }]), /todavía corre/],
    ['a failed check', (g) => g.checkRunsOf.set(`${MERGED_AT}|deploy`, [{ id: 1, status: 'completed', conclusion: 'failure', app: 'a', url: null }]), /failure/],
    ['a missing check', () => undefined, /deploy/],
  ];
  for (const [what, setup, reason] of refusals) {
    it(`refuses ${what}`, async () => {
      const { root, github } = merged();
      setup(github);
      const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge, checks: [deploy] }'));
      expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after', reason: expect.stringMatching(reason) } });
    });
  }

  it('refuses a production deployment of another commit', async () => {
    const { root, github } = merged();
    github.deploymentsOf.push({ id: 40, sha: '9'.repeat(40), environment: 'Production', creator: 'vercel[bot]', state: 'success', url: 'https://x.app' });
    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge, deployment: { environment: Production } }'));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'after' } });
  });
});

describe('cleanup', () => {
  it('deletes the remote branch only at the merged head, and records what finish needs', async () => {
    const { root, head, github } = merged();
    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge }'));

    expect(run.outcome).toMatchObject({ status: { state: 'done' } });
    expect(github.branches.has(BRANCH)).toBe(false);
    expect(github.calls.deleteBranch).toBe(1);
    expect(run.entryOf('cleanup')?.evidence).toMatchObject({
      block: { branch: BRANCH, headSha: head, mergeSha: MERGED_AT, folder: expect.any(String), removeFolder: true },
    });
  });

  it('a remote branch moved to another tip is not deleted, and it says so', async () => {
    const { root, github } = merged();
    github.onDetail = (pr, reads) => {
      if (reads >= 2 && pr.autoMerge && pr.state === 'OPEN') {
        github.merge(pr, MERGED_AT);
        github.humanPush(BRANCH, '9'.repeat(40));
      }
    };
    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge }'));
    expect(run.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'cleanup' } });
    expect(github.branches.get(BRANCH)).toBe('9'.repeat(40));
  });

  it('a branch already gone is skipped', async () => {
    const { root, github } = merged();
    github.onDetail = (pr, reads) => {
      if (reads >= 2 && pr.autoMerge && pr.state === 'OPEN') {
        github.merge(pr, MERGED_AT);
        github.humanPush(BRANCH, undefined);
      }
    };
    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge }'));
    expect(run.outcome).toMatchObject({ status: { state: 'done' } });
    expect(github.calls.deleteBranch).toBe(0);
  });

  it('after deleting, a crash and someone recreating the branch at the same tip: it is not deleted again', async () => {
    const { root, head, github } = merged();
    github.failures.set('deleteBranch', { when: 'after' });
    const store = createMemoryStore();
    const first = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge }'), { store });
    expect(first.outcome).toMatchObject({ status: { state: 'blocked:technical', stage: 'cleanup' } });
    github.humanPush(BRANCH, head);

    const second = await first.again();

    expect(second.outcome).toMatchObject({ status: { state: 'done' } });
    expect(github.calls.deleteBranch).toBe(1);
    expect(github.branches.get(BRANCH)).toBe(head);
  });

  it('with delete-branch: false it leaves the branch alone', async () => {
    const { root, github } = merged();
    const run = await runFinal(root, github, AFTER_MERGE('      with: { merge-stage: merge }', '      with: { merge-stage: merge, delete-branch: false }'));
    expect(run.outcome).toMatchObject({ status: { state: 'done' } });
    expect(github.calls.deleteBranch).toBe(0);
  });
});
