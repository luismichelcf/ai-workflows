import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  EffectNeedsReconciliation,
  createEngine,
  createMemoryStore,
  parseTestRun,
  requireDifferentBuilder,
  requireFreshVerdicts,
  requireSameFiles,
  requireSections,
  requireSources,
  runJudge,
  type ExecutionIdentity,
  type JudgeGitHub,
  type PullRequestComment,
  type Verdict,
} from '../src/index.js';

import { runBlock } from './block-harness.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';
import { chain, pipeline, recorder, stage } from './helpers.js';

// The thirteen attempts to get around the process. These are not a trial run: they are the
// engine's permanent suite, and every change re-attempts all of them. If one ever passes,
// the engine is broken, not the rule.
//
// Rewritten after the review of 13-sep-2026, which found four cases passing without
// testing what they claimed: CN-11 carried its own rejection logic, the count of thirteen
// was derived from the list it was checking, CN-13 accepted any error, and CN-06 simulated
// no interruption at all.
//
// Each case REGISTERS itself when it actually runs. The final check compares what ran
// against the thirteen, so skipping or deleting a case fails the suite instead of quietly
// shrinking it.

/** Cases that cannot run yet, and what each is waiting for. */
export const NOT_YET_EXECUTABLE: Record<string, string> = {
  'CN-07': 'needs the editor hooks installed in a project (slice 4)',
};

const ALL = Array.from({ length: 13 }, (_, index) => `CN-${String(index + 1).padStart(2, '0')}`);
const executed = new Set<string>();
const ran = (name: string) => beforeAll(() => executed.add(name));

const SHA_A = '9f420f5c1a2b3d4e5f60718293a4b5c6d7e8f901';
const SHA_B = 'd9bbf4f0e1d2c3b4a59687766554433221100ffe';

const builder: ExecutionIdentity = { provider: 'deepseek', model: 'deepseek-flash', session: 's-1' };
const reviewer: ExecutionIdentity = { provider: 'claude', model: 'claude-opus-5', session: 's-2' };

const verdict = (over: Partial<Verdict> = {}): Verdict => ({ by: reviewer, sha: SHA_B, approved: true, ...over });

const sources = (...urls: string[]) => urls.map((url) => `- [x](${url})\n`).join('');
const fiveGood = sources('https://productive.io/a', 'https://scoro.com/b', 'https://runn.io/c', 'https://ruddr.io/d', 'https://forecast.app/e');

describe('CN-01 · advancing without the benchmark', () => {
  ran('CN-01');

  it('is refused, naming what is missing', () => {
    const result = requireSections('## Decisiones\n\ntexto\n', ['Benchmark', 'Decisiones']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('Benchmark');
  });

  it('is refused when the sources are all the same vendor', () => {
    const five = sources('https://productive.io/a', 'https://productive.io/b', 'https://docs.productive.io/c', 'https://productive.io?d', 'https://productive.io#e');

    expect(requireSources(five, { min: 5 }).ok).toBe(false);
  });

  it('positive control: a real benchmark advances', () => {
    expect(requireSources(fiveGood, { min: 5 }).ok).toBe(true);
  });
});

describe('CN-02 · the builder approving its own work', () => {
  ran('CN-02');

  it('is refused by execution identity, even published from the same account', () => {
    expect(requireDifferentBuilder([verdict({ by: builder })], builder).ok).toBe(false);
  });

  it('is refused when the builder resumes its session under another model label', () => {
    expect(requireDifferentBuilder([verdict({ by: { ...builder, model: 'deepseek-flash-20260913' } })], builder).ok).toBe(false);
  });

  it('positive control: a verdict from another family advances', () => {
    expect(requireDifferentBuilder([verdict()], builder, { differentProvider: true }).ok).toBe(true);
  });
});

describe('CN-03 · using the review of A after the code became B', () => {
  ran('CN-03');

  it('is refused, naming both versions', () => {
    const result = requireFreshVerdicts([verdict({ sha: SHA_A })], SHA_B);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(SHA_A.slice(0, 7));
    expect(result.ok === false && result.reason).toContain(SHA_B.slice(0, 7));
  });

  it('positive control: once B is reviewed, it advances', () => {
    expect(requireFreshVerdicts([verdict({ sha: SHA_B })], SHA_B).ok).toBe(true);
  });
});

describe('CN-04 · declaring all green with a test of the zone in red', () => {
  ran('CN-04');

  it('is caught by reading the run, not the exit code', () => {
    const parsed = parseTestRun({ output: 'FAIL tests/nomina.test.ts > el bono\nAssertionError: expected 800 to be 1000\nTests  1 failed | 170 passed (171)', exitCode: 0 });

    expect(parsed.failed).toBe(1);
  });

  it('is caught when the suite never ran at all', () => {
    expect(parseTestRun({ output: '', exitCode: 0 }).brokenEnvironment).toBe(true);
  });

  it('is caught with colours in the output, which is how Windows prints it', () => {
    const coloured = '[31m[1m[7m FAIL [27m[22m[39m t/a.test.ts > algo\n[2m      Tests [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m1 passed[39m[22m[90m (2)[39m';

    expect(parseTestRun({ output: coloured, exitCode: 1 }).failed).toBe(1);
  });

  it('positive control: a genuine green run is accepted', () => {
    const parsed = parseTestRun({ output: 'Tests  171 passed (171)', exitCode: 0 });

    expect(parsed.failed).toBe(0);
    expect(parsed.brokenEnvironment).toBe(false);
  });
});

describe('CN-06 · interrupting mid-write and resuming', () => {
  ran('CN-06');

  it('a controller that dies mid-run is resumed by another without duplicating work', async () => {
    // A real interruption: the first controller's store fails while recording, as a remote
    // store does on a network cut. A second controller, a new engine over the same data,
    // picks the piece up.
    const store = createMemoryStore();
    const seen = recorder();
    let failOnce = true;
    const flaky: typeof store = {
      ...store,
      append: async (piece, entry) => {
        if (failOnce && entry.stage === 'build') {
          failOnce = false;
          throw new Error('corte de red al escribir el diario');
        }
        return store.append(piece, entry);
      },
    };
    const config = pipeline(chain(stage('spec', { gate: seen.gateFor('spec') }), stage('build', { gate: seen.gateFor('build') })));

    const first = await createEngine({ config, store: flaky, runId: 'A' }).run('997');
    expect(first.outcome === 'ran' && first.status.state).not.toBe('done');

    const second = await createEngine({ config, store, runId: 'B', leaseMs: 30_000 }).run('997');

    expect(second.outcome === 'ran' && second.status.state).toBe('done');
    expect(seen.seen.filter((name) => name === 'spec')).toHaveLength(1);
    expect((await store.journal('997')).filter((entry) => entry.stage === 'build' && entry.outcome === 'passed')).toHaveLength(1);
  });

  it('positive control: with no interruption it finishes in one run', async () => {
    const store = createMemoryStore();
    const config = pipeline(chain(stage('spec'), stage('build')));

    const result = await createEngine({ config, store }).run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });
});

describe('CN-09 · crossing a module boundary', () => {
  ran('CN-09');

  // The engine knows no module rules: the project's own boundary check runs as a command@1
  // stage (PLAN-13-R2 §3.6). Here that check forbids anything under app/ from importing lib/db.
  const BOUNDARIES = [
    'import { readdirSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>',
    '  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);',
    'const offenders = walk("app").filter((file) => /from ["\'].*lib\\/db/.test(readFileSync(file, "utf8")));',
    'if (offenders.length > 0) { console.error(`app no puede importar lib/db: ${offenders.join(", ")}`); process.exit(1); }',
    '',
  ].join('\n');

  const STAGE = [
    '    nature: recompute',
    '    gate:',
    '      uses: ai-workflows/command@1',
    '      with: { command: "node boundaries.mjs" }',
  ];

  afterEach(removeRepositories);

  it('is refused by the project boundary check, naming the file that crossed', async () => {
    const root = repository({ 'boundaries.mjs': BOUNDARIES, 'lib/db/client.ts': 'export const db = 1;\n', 'app/page.ts': 'export const page = 1;\n' });
    write(root, 'app/page.ts', 'import { db } from "../lib/db/client";\nexport const page = db;\n');
    commit(root, 'crosses the boundary');
    const result = await runBlock(root, STAGE);
    expect(result.outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'check', reason: expect.stringMatching(/app[\\/]page\.ts/) } });
  });

  it('positive control: a change that respects the boundary advances', async () => {
    const root = repository({ 'boundaries.mjs': BOUNDARIES, 'lib/db/client.ts': 'export const db = 1;\n', 'app/page.ts': 'export const page = 1;\n' });
    write(root, 'app/page.ts', 'export const page = 2;\n');
    commit(root, 'stays inside');
    expect((await runBlock(root, STAGE)).outcome).toMatchObject({ status: { state: 'blocked:rejected', stage: 'merge' } });
  });
});

describe('CN-10 · a piece that grows past what it declared', () => {
  ran('CN-10');

  const conditional = (seen: ReturnType<typeof recorder>) =>
    pipeline(
      chain(
        stage('spec'),
        stage('flock', {
          appliesWhen: (context) => (context.change as { files: string[] }).files.some((file) => file.startsWith('lib/calc')),
          gate: seen.gateFor('flock'),
        }),
      ),
    );

  it('re-runs the stage the wider change now demands', async () => {
    const files = { current: ['app/ui/boton.tsx'] };
    const store = createMemoryStore();
    const seen = recorder();
    const engine = createEngine({ config: conditional(seen), store, describeChange: () => ({ files: files.current }) });

    await engine.run('997');
    expect(seen.seen).not.toContain('flock');

    files.current = [...files.current, 'lib/calc/nomina.ts'];
    await engine.run('997');

    expect(seen.seen).toContain('flock');
  });

  it('positive control: a change that stays within scope does not add stages', async () => {
    const store = createMemoryStore();
    const seen = recorder();
    const engine = createEngine({ config: conditional(seen), store, describeChange: () => ({ files: ['app/ui/boton.tsx'] }) });

    await engine.run('997');
    await engine.run('997');

    expect(seen.seen).not.toContain('flock');
  });
});

describe('CN-11 · a builder that edits the test it was given', () => {
  ran('CN-11');

  // The red-test stage records the hash of each test file as evidence; the build stage
  // recomputes it from disk and compares with requireSameFiles. The rejection lives in the
  // engine's gate, not in this test.
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  const run = async (duringBuild: (file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-cn11-'));
    dirs.push(dir);
    const testFile = join(dir, 'nomina.test.ts');
    writeFileSync(testFile, "expect(bono(100)).toBe(1000);\n");

    const config = pipeline(
      chain(
        stage('red-test', { nature: 'execution-record', gate: () => ({ ok: true, evidence: { files: { 'nomina.test.ts': hash(testFile) } } }) }),
        stage('build', {
          nature: 'execution-record',
          gate: (context) => {
            duringBuild(testFile);
            const red = context.journal.find((entry) => entry.stage === 'red-test');
            const recorded = (red?.evidence as { files: Record<string, string> }).files;
            return requireSameFiles(recorded, { 'nomina.test.ts': hash(testFile) });
          },
        }),
      ),
    );
    return createEngine({ config, store: createMemoryStore() }).run('997');
  };

  it('is refused when the test file no longer matches what was seen red, naming the file', async () => {
    const result = await run((file) => writeFileSync(file, "expect(bono(100)).toBe(800);\n"));

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:rejected');
    expect(result.outcome === 'ran' && result.status.reason).toContain('nomina.test.ts');
  });

  it('positive control: a builder that leaves the test alone advances', async () => {
    const result = await run(() => undefined);

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });

  it('declared limit: an edit put back byte for byte is NOT detected, and the suite says so', async () => {
    // The spec declares this limit: comparing the file detects a change the engine observes,
    // not that no write ever happened. This test pins the limit so nobody reads more into
    // CN-11 than it gives.
    const result = await run((file) => {
      const original = readFileSync(file);
      writeFileSync(file, 'cambiado');
      writeFileSync(file, original);
    });

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });
});

describe('CN-12 · two controllers racing for one piece', () => {
  ran('CN-12');

  it('gives it to exactly one, and the loser writes nothing', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'otro', 60_000);

    const result = await createEngine({ config: pipeline(chain(stage('spec'))), store, runId: 'mio' }).run('997');

    expect(result.outcome).toBe('busy');
    expect(await store.journal('997')).toEqual([]);
  });

  it('positive control: a single controller takes it and works', async () => {
    const result = await createEngine({ config: pipeline(chain(stage('spec'))), store: createMemoryStore(), runId: 'mio' }).run('997');

    expect(result.outcome).toBe('ran');
  });
});

describe('CN-13 · dying after an external effect and resuming', () => {
  ran('CN-13');

  it('does not do it twice', async () => {
    const store = createMemoryStore();
    let opened = 0;

    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 1234 };
    });
    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 5678 };
    });

    expect(opened).toBe(1);
  });

  it('refuses to guess when the effect was left in doubt, and never runs it again', async () => {
    const store = createMemoryStore();
    await store
      .runEffect('997', 'open-pr', async () => {
        throw new Error('la red se cayo');
      })
      .catch(() => undefined);
    let secondCalls = 0;

    await expect(
      store.runEffect('997', 'open-pr', async () => {
        secondCalls += 1;
        return { pr: 1 };
      }),
    ).rejects.toBeInstanceOf(EffectNeedsReconciliation);
    expect(secondCalls).toBe(0);
  });

  it('positive control: with no interruption it happens exactly once', async () => {
    const store = createMemoryStore();
    let opened = 0;

    await store.runEffect('997', 'open-pr', async () => {
      opened += 1;
      return { pr: 1234 };
    });

    expect(opened).toBe(1);
  });
});

// CN-05 and CN-08 run against the judge (PLAN-13-R3 §3): the server check that a pull request
// cannot skip. The repository is real; GitHub is a minimal fake port (its external edge). The
// full set of judge cases lives in tests/judge-core.test.ts and on GitHub in tests/github/.

const JUDGE_RECIPE = [
  'version: 1',
  'locale: es',
  'owner: duena',
  'classify:',
  '  visible: ["app/**"]',
  'kinds:',
  '  names: [behavior, docs]',
  '  default: behavior',
  'pieces:',
  '  branch: ["*/{piece}-*"]',
  '  exclude-branches: ["libre/*"]',
  'stages:',
  '  - id: owner-approval',
  '    summary: "La dueña aprueba lo que se ve"',
  '    nature: attest',
  '    needs-human: true',
  '    applies-if: { touches-any: [visible] }',
  '    gate:',
  '      uses: ai-workflows/approval-comment@1',
  '      with: { command: /visto-bueno }',
  '    server: attestation',
  '  - id: merge',
  '    summary: "Se une"',
  '    after: owner-approval',
  '    phase: merge',
  '    nature: recompute',
  '    gate:',
  '      uses: ai-workflows/github-merge@1',
  '',
].join('\n');

async function judgeOnce(branch: string, comments: (head: string) => PullRequestComment[]) {
  const root = repository({ '.ai-workflows/pipeline.yml': JUDGE_RECIPE, 'app/page.tsx': 'uno\n' });
  write(root, 'app/page.tsx', 'dos\n');
  const head = commit(root, 'visible');
  git(root, 'switch', '-q', 'main');
  const main = git(root, 'rev-parse', 'HEAD');
  const url = 'https://github.com/duena/proyecto/actions/runs/1';
  const published: { sha: string; state: string; description: string }[] = [];
  const statuses = [{ context: 'ai-workflows', state: 'pending', targetUrl: url, createdAt: '2026-09-23T12:00:00Z' }];
  const pr = { number: 7, state: 'open', headSha: head, headRef: branch, baseRef: 'main', headRepo: 'duena/proyecto' };
  const github: JudgeGitHub = {
    defaultBranch: async () => 'main',
    branchHead: async () => main,
    pullRequest: async () => pr,
    openPullRequestsWithHead: async () => [7],
    mergeQueue: async () => [],
    comments: async () => comments(head),
    checkRuns: async () => [],
    statuses: async () => statuses,
    workflowRun: async () => ({ path: '.github/workflows/ai-workflows.yml', event: 'pull_request_target', headBranch: branch }),
    forcePushedHeads: async () => [],
    publishStatus: async (sha, status) => {
      published.push({ sha, state: status.state, description: status.description });
    },
    upsertTraceComment: async () => {},
  };
  await runJudge({
    eventName: 'pull_request_target',
    event: { pull_request: { number: 7, head: { sha: head, ref: branch, repo: { full_name: 'duena/proyecto' } }, base: { sha: main, ref: 'main' } } },
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
  return { head, published };
}

const signOff = (head: string): PullRequestComment[] => [
  { body: `/visto-bueno ${head.slice(0, 7)}`, author: 'duena', authorType: 'User', performedViaApp: false, edited: false },
];

describe('CN-05 closing without the owner sign-off', () => {
  ran('CN-05');

  it('the judge leaves a visible change pending without the sign-off, saying what to write', async () => {
    const { head, published } = await judgeOnce('feat/13-boton', () => []);
    expect(published).toEqual([{ sha: head, state: 'pending', description: expect.stringContaining(`/visto-bueno ${head.slice(0, 7)}`) }]);
  });

  it('positive control: with the sign-off of the owner for this head, it passes', async () => {
    const { published } = await judgeOnce('feat/13-boton', signOff);
    expect(published.map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('CN-08 merging from a free folder', () => {
  ran('CN-08');

  it('the judge rejects a pull request from a libre/ branch, even with the sign-off', async () => {
    const { published } = await judgeOnce('libre/prueba', signOff);
    expect(published).toEqual([expect.objectContaining({ state: 'failure', description: expect.stringMatching(/pieza/) })]);
  });

  it('positive control: the same change from a branch with a piece passes', async () => {
    const { published } = await judgeOnce('feat/13-boton', signOff);
    expect(published.map((entry) => entry.state)).toEqual(['success']);
  });
});

describe('the report of the thirteen', () => {
  it('declares a reason for each pending case', () => {
    for (const [name, waiting] of Object.entries(NOT_YET_EXECUTABLE)) {
      expect(waiting.length, `${name} has no reason`).toBeGreaterThan(10);
    }
  });

  it('has exactly one pending case', () => {
    expect(Object.keys(NOT_YET_EXECUTABLE)).toHaveLength(1);
  });
});

afterAll(() => {
  // Registered by the cases that actually ran, not derived from the list being checked. A
  // skipped or deleted case leaves a hole here and fails the suite.
  const accounted = new Set([...executed, ...Object.keys(NOT_YET_EXECUTABLE)]);
  const missing = ALL.filter((name) => !accounted.has(name));
  if (missing.length > 0) {
    throw new Error(`Casos que no corrieron ni estan declarados pendientes: ${missing.join(', ')}`);
  }
});
