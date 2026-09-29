import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildHooksConfig, mergeHooksConfig, parseRecipe, runHook, runJudge, type JudgeGitHub } from '../src/index.js';

import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// Review of the flock with mutants, part 5: behaviours that no test watched, so a change that
// breaks them would pass unnoticed. Each case pins one of them.

afterEach(removeRepositories);

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const HOOK_RECIPE = lines(
  'version: 1',
  'locale: es',
  'owner: duena',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  'hooks:',
  '  papers: ["docs"]',
  'stages:',
  '  - id: merge',
  '    summary: "Se une"',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
);

const denies = (output: { stdout: string }) => output.stdout !== '' && (JSON.parse(output.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'deny';

describe('the hook as installed, not only the pure decision (E11, H5)', () => {
  it('with a broken recipe, a shell command that comments on GitHub is refused by the editor hook', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': 'version: 1\nnada: 1\n', 'src/a.mjs': 'a\n' });
    git(root, 'switch', '-q', '-C', 'feat/13-x');
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr comment 5 -b hola' }, cwd: root });
    expect(denies(await runHook('editor', { projectDir: root, cwd: root, stdin }))).toBe(true);
  });

  it('a pre-commit whose git fails is a refusal (exit 1), never a pass', async () => {
    const root = repository({ '.ai-workflows/pipeline.yml': HOOK_RECIPE, 'src/a.mjs': 'a\n' });
    git(root, 'switch', '-q', '-C', 'arreglo');
    write(root, 'src/b.mjs', 'b\n');
    git(root, 'add', 'src/b.mjs');
    const output = await runHook('pre-commit', { projectDir: root, cwd: root, stdin: '', gitPath: join(root, 'no-existe-git') } as never);
    expect(output.exitCode).toBe(1);
  });
});

describe('the paper folders are read as the lock reads them (S2–S4)', () => {
  for (const [name, value] of [
    ['the root itself', '"."'],
    ['a folder that climbs back to the root', '"docs/.."'],
    ['a climb in the middle that leaves the root', '"a/../../fuera"'],
    ['a drive-relative Windows path', '"C:docs"'],
  ] as const) {
    it(`refuses ${name}`, () => {
      const text = HOOK_RECIPE.replace('papers: ["docs"]', `papers: [${value}]`);
      expect(parseRecipe(text, 'pipeline.yml').ok).toBe(false);
    });
  }

  it('accepts a clean nested folder', () => {
    expect(parseRecipe(HOOK_RECIPE.replace('papers: ["docs"]', 'papers: ["docs/planes"]'), 'pipeline.yml').ok).toBe(true);
  });
});

describe('the owner keeps only the timeout of our hook (I3, I4)', () => {
  const ours = buildHooksConfig('claude', 'node');

  it('a timeout the owner set on our hook survives a reinstall, over ours', () => {
    const first = mergeHooksConfig(undefined, ours) as { hooks: { PreToolUse: { hooks: Record<string, unknown>[] }[] } };
    const handler = first.hooks.PreToolUse[0]?.hooks[0];
    if (handler === undefined) throw new Error('no handler');
    handler['timeout'] = 60;
    const again = mergeHooksConfig(first, ours) as { hooks: { PreToolUse: { hooks: { timeout?: number }[] }[] } };
    expect(again.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(60);
  });
});

describe('the judgement from the issue, one pull request at a time (J6, J8, J9)', () => {
  const RECIPE = lines(
    'version: 1',
    'locale: es',
    'owner: duena',
    'agent-account: "agentes[bot]"',
    'kinds:',
    '  names: [behavior, docs]',
    '  default: behavior',
    'classify:',
    '  visible: ["app/**"]',
    'pieces:',
    '  branch: ["*/{piece}-*"]',
    '  declared-kind: { file: "docs/plans/PLAN-{piece}.md", line: "Tipo de cambio" }',
    'stages:',
    '  - id: approval',
    '    summary: "La dueña aprueba"',
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

  function world() {
    const root = repository({ '.ai-workflows/pipeline.yml': RECIPE, 'app/page.tsx': 'uno\n' });
    write(root, 'app/page.tsx', 'dos\n');
    write(root, 'docs/plans/PLAN-13.md', 'Tipo de cambio: comportamiento\n');
    const good = commit(root, 'buena');
    git(root, 'switch', '-q', '-c', 'rota', 'main');
    write(root, 'docs/plans/PLAN-13.md/dentro.md', 'Tipo de cambio: comportamiento\n');
    const broken = commit(root, 'el plan es una carpeta');
    git(root, 'switch', '-q', 'main');
    const main = git(root, 'rev-parse', 'HEAD');
    return { root, good, broken, main };
  }

  const baseGitHub = (w: ReturnType<typeof world>, over: Partial<JudgeGitHub>, published: { sha: string; state: string }[]) =>
    ({
      defaultBranch: async () => 'main',
      branchHead: async () => w.main,
      openPullRequestsWithHead: async () => [],
      mergeQueue: async () => [],
      comments: async () => [],
      issueComments: async () => [],
      reviews: async () => [],
      checkRuns: async () => [],
      statuses: async () => [],
      workflowRun: async () => ({ path: '.github/workflows/ai-workflows.yml', event: 'pull_request_target', headBranch: 'main' }),
      forcePushedHeads: async () => [],
      publishStatus: async (sha: string, status: { state: string }) => {
        published.push({ sha, state: status.state });
      },
      upsertTraceComment: async () => {},
      ...over,
    }) as unknown as JudgeGitHub;

  const judge = (w: ReturnType<typeof world>, github: JudgeGitHub) =>
    runJudge({
      eventName: 'issue_comment',
      event: { action: 'created', issue: { number: 13 }, comment: { body: 'x\n\n<!-- ai-workflows:event {} -->' } },
      mode: 'on',
      context: 'ai-workflows',
      repository: 'duena/proyecto',
      workflowRef: 'duena/proyecto/.github/workflows/ai-workflows.yml@refs/heads/main',
      actionRef: 'a'.repeat(40),
      runId: 1,
      serverUrl: 'https://github.com',
      alsoProtect: [],
      root: w.root,
    }, { github, fetchObjects: async () => {} });

  it('one pull request of the piece that makes the engine throw gets its error; the other gets its verdict', async () => {
    const w = world();
    const published: { sha: string; state: string }[] = [];
    const github = baseGitHub(w, {
      openPullRequests: async () => [
        { number: 7, headRef: 'feat/13-a', headSha: w.good, baseRef: 'main' },
        { number: 8, headRef: 'fix/13-b', headSha: w.broken, baseRef: 'main' },
      ],
      pullRequest: async (n: number) => ({ number: n, state: 'open', headSha: n === 7 ? w.good : w.broken, headRef: n === 7 ? 'feat/13-a' : 'fix/13-b', baseRef: 'main', headRepo: 'duena/proyecto' }),
    } as Partial<JudgeGitHub>, published);
    await judge(w, github).catch(() => undefined);
    expect(published).toEqual(expect.arrayContaining([
      { sha: w.broken, state: 'error' },
      expect.objectContaining({ sha: w.good }),
    ]));
    expect(published.find((entry) => entry.sha === w.good)?.state).not.toBe('error');
  });

  it('the live head is judged, not the head the list reported', async () => {
    const w = world();
    const published: { sha: string; state: string }[] = [];
    const github = baseGitHub(w, {
      openPullRequests: async () => [{ number: 7, headRef: 'feat/13-a', headSha: 'f'.repeat(40), baseRef: 'main' }],
      pullRequest: async (n: number) => ({ number: n, state: 'open', headSha: w.good, headRef: 'feat/13-a', baseRef: 'main', headRepo: 'duena/proyecto' }),
    } as Partial<JudgeGitHub>, published);
    await judge(w, github);
    expect(published.map((entry) => entry.sha)).toEqual([w.good]);
  });

  it('a head that moves before publishing gets no verdict', async () => {
    const w = world();
    const published: { sha: string; state: string }[] = [];
    let reads = 0;
    const github = baseGitHub(w, {
      openPullRequests: async () => [{ number: 7, headRef: 'feat/13-a', headSha: w.good, baseRef: 'main' }],
      pullRequest: async (n: number) => {
        reads += 1;
        return { number: n, state: 'open', headSha: reads === 1 ? w.good : 'c'.repeat(40), headRef: 'feat/13-a', baseRef: 'main', headRepo: 'duena/proyecto' };
      },
    } as Partial<JudgeGitHub>, published);
    await judge(w, github);
    expect(published.filter((entry) => entry.sha === w.good && entry.state !== 'error')).toEqual([]);
  });
});
