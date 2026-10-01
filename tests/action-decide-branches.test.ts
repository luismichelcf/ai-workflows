import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { BRANCHES, branchWorld, recipe } from './judge-branches-fixtures.js';
import { removeRepositories } from './git-fixtures.js';

// PLAN-13-R6 §1.2 (R27): the first step of action.yml decides, before the engine is built, which
// pull requests get the in-progress «juzgando». It now knows the working branches through a new
// action input, `branches`, and it does not publish «juzgando» for `closed` or for an `edited`
// that takes the pull request out of those branches: there the judge decides whether any pull
// request with that head is left, so that nothing at all is published when none is.
//
// Interface fixed here:
//   - action.yml input `branches` (optional, default ''), a list split by commas or newlines with
//     the spaces around each name ignored, like `also-protect`; empty = only the principal.
//   - The decide step receives it as `INPUT_BRANCHES: ${{ inputs.branches }}`; the judge step as
//     `AI_WORKFLOWS_BRANCHES: ${{ inputs.branches }}`, which the `judge` command passes on as
//     `JudgeInput.branches`.
//   - A pull request into a branch of the list goes on as a pull request into the principal does
//     today; one into any other branch stops quietly (nothing published), except `edited` out of
//     the list, which goes on to the judge without publishing anything. `closed` goes on to the
//     judge without publishing anything.
//
// The step's own bash runs here as written in action.yml, with a fake `gh` on the PATH that answers
// from a table and logs every call (the same harness as action-decide.test.ts).

const ACTION = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8')) as {
  inputs?: Record<string, { default?: unknown }>;
  runs: { steps: { id?: string; name?: string; run?: string; env?: Record<string, string> }[] };
};
const DECIDE_STEP = ACTION.runs.steps.find((step) => step.id === 'decide');
const DECIDE = DECIDE_STEP?.run ?? '';

const HEAD = 'c'.repeat(40);

afterEach(removeRepositories);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HAS_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
// The same stand-in as action-decide.test.ts: only `jq -r '<path> // empty' [file]`.
const JQ_SHIM = String.raw`const fs = require("fs");
const args = process.argv.slice(2).filter((a) => a !== "-r");
const [expr, file] = args;
const m = /^(\.[A-Za-z_]\w*(?:\[\d+\]|\.[A-Za-z_]\w*)*)(?: \/\/ empty)?$/.exec(expr || "");
if (!m || args.length > 2) { console.error("jq stand-in: unsupported " + args.join(" ")); process.exit(3); }
const text = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
let value = JSON.parse(text);
for (const step of m[1].match(/\.[A-Za-z_]\w*|\[\d+\]/g)) {
  if (value === null || value === undefined) break;
  value = step.startsWith("[") ? value[Number(step.slice(1, -1))] : value[step.slice(1)];
}
if (value === null || value === undefined || value === false) { if (!/\/\/ empty$/.test(expr)) console.log("null"); process.exit(0); }
console.log(typeof value === "string" ? value : JSON.stringify(value));
`;

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

/** A pull request as `gh api repos/o/r/pulls/<n>` answers it. */
const livePr = (base: string, head = HEAD, state = 'open') => JSON.stringify({ state, base: { ref: base }, head: { sha: head } });

/**
 * Runs the decide step. `answers` maps a bash `case` pattern of the gh arguments to its stdout;
 * the default branch and the statuses always answer.
 */
function decide(
  eventName: string,
  event: unknown,
  options: { branches?: string; mode?: string; answers?: Readonly<Record<string, string>> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-decide-branches-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const rows = Object.entries(options.answers ?? {}).map(([pattern, stdout]) => `  ${pattern}) echo '${stdout}' ;;`);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$FAKE_LOG"',
    'case "$*" in',
    '  "api repos/o/r --jq .default_branch") echo main ;;',
    '  "api repos/o/r/statuses/"*) echo "{}" ;;',
    ...rows,
    '  *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  if (!HAS_JQ) {
    writeFileSync(join(bin, 'jq-shim.cjs'), JQ_SHIM);
    writeFileSync(join(bin, 'jq'), `#!/usr/bin/env bash\nexec "${process.execPath.replace(/\\/g, '/')}" "$(dirname "$0")/jq-shim.cjs" "$@"\n`);
    chmodSync(join(bin, 'jq'), 0o755);
  }
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event));
  writeFileSync(join(dir, 'decide.sh'), DECIDE);
  writeFileSync(join(dir, 'output'), '');
  writeFileSync(join(dir, 'gh.log'), '');
  const result = spawnSync('bash', [posix(join(dir, 'decide.sh'))], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.platform === 'win32' ? posix(bin) : bin}:${process.env['PATH'] ?? ''}`,
      FAKE_LOG: posix(join(dir, 'gh.log')),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: posix(join(dir, 'event.json')),
      GITHUB_OUTPUT: posix(join(dir, 'output')),
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ai-workflows.yml@refs/heads/main',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1',
      INPUT_TASK: 'judge',
      INPUT_MODE: options.mode ?? 'on',
      INPUT_CONTEXT: 'ai-workflows',
      INPUT_BRANCHES: options.branches ?? '',
      GH_TOKEN: 'x',
    },
  });
  const outputs = Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const calls = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);
  return { code: result.status, stderr: result.stderr, outputs, calls, statuses: calls.filter((call) => call.startsWith('api repos/o/r/statuses/')) };
}

/** A `pull_request_target` payload. */
const prEvent = (action: string, base: string, extra: Record<string, unknown> = {}) => ({
  action,
  number: 7,
  pull_request: { number: 7, state: action === 'closed' ? 'closed' : 'open', head: { sha: HEAD, ref: 'feat/13-algo', repo: { full_name: 'o/r' } }, base: { ref: base, sha: 'd'.repeat(40) } },
  ...extra,
});

describe('§1.2: the action carries the branches to both steps', () => {
  it('has an optional input `branches`, empty by default', () => {
    expect(ACTION.inputs?.['branches']).toBeDefined();
    expect(ACTION.inputs?.['branches']?.default ?? '').toBe('');
  });

  it('the decide step receives it as INPUT_BRANCHES, and the judge as AI_WORKFLOWS_BRANCHES', () => {
    expect(DECIDE_STEP?.env?.['INPUT_BRANCHES']).toMatch(/^\$\{\{\s*inputs\.branches\s*\}\}$/);
    const judge = ACTION.runs.steps.find((step) => step.name === 'Juzgar');
    expect(judge?.env?.['AI_WORKFLOWS_BRANCHES']).toMatch(/^\$\{\{\s*inputs\.branches\s*\}\}$/);
  });

  it('the judge command passes AI_WORKFLOWS_BRANCHES on to the judge', () => {
    const cli = readFileSync(new URL('../src/judge/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/branches:\s*splitList\(env\('AI_WORKFLOWS_BRANCHES'\)\)/);
  });
});

describe('§1.2 and §1.5 (1, 2): a pull request into a branch of the input gets «juzgando»; any other stops', () => {
  it('opened into staging, with the input «staging, main»: goes on and publishes pending on its head', () => {
    const run = decide('pull_request_target', prEvent('opened', 'staging'), { branches: 'staging, main' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', publish: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
    expect(run.statuses[0]).toContain(`statuses/${HEAD}`);
    expect(run.statuses[0]).toContain('state=pending');
  });

  it('the input may also come one name per line', () => {
    const run = decide('pull_request_target', prEvent('opened', 'staging'), { branches: 'staging\nmain\n' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
  });

  // Guards: green today, they must stay green.
  it('opened into develop, outside the input: stops quietly, nothing published', () => {
    const run = decide('pull_request_target', prEvent('opened', 'develop'), { branches: 'staging,main' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'false', publish: 'false' });
    expect(run.statuses).toEqual([]);
  });

  it('with an empty input only the principal counts: into staging stops quietly', () => {
    const run = decide('pull_request_target', prEvent('opened', 'staging'), { branches: '' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'false' });
    expect(run.statuses).toEqual([]);
  });

  it('a dispatch for a pull request into staging re-reads it and publishes pending on its live head', () => {
    const run = decide('workflow_dispatch', { inputs: { pr: '7' } }, { branches: 'staging,main', answers: { '"api repos/o/r/pulls/7"': livePr('staging') } });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
  });

  it('a comment on a pull request into staging re-reads it and publishes pending on its live head', () => {
    const run = decide(
      'issue_comment',
      { action: 'created', issue: { number: 7, pull_request: { url: 'x' } }, comment: { body: '/approve abc' } },
      { branches: 'staging,main', answers: { '"api repos/o/r/pulls/7"': livePr('staging') } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
  });

  // The filter of the open pull requests of a SHA needs the real jq (the GitHub runners have it);
  // the same search is tested on Windows through the judge (judge-branches.test.ts, §1.4).
  it.runIf(HAS_JQ)('a workflow_run of a pull request finds the open pull request into staging and publishes pending', () => {
    const pulls = JSON.stringify([[{ state: 'open', head: { sha: HEAD }, base: { ref: 'staging' } }]]);
    const run = decide(
      'workflow_run',
      { workflow_run: { event: 'pull_request', head_sha: HEAD, path: '.github/workflows/ai-workflows-red-test.yml', repository: { full_name: 'o/r' }, pull_requests: [] } },
      { branches: 'staging,main', answers: { [`"api repos/o/r/commits/${HEAD}/pulls"*`]: pulls } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
  });
});

describe('§1.2 and §1.5 (13, 15): closed, and edited out of the input, go on to the judge without «juzgando»', () => {
  it('closed into staging: goes on, nothing published', () => {
    const run = decide('pull_request_target', prEvent('closed', 'staging'), { branches: 'staging,main' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true' });
    expect(run.statuses).toEqual([]);
  });

  it('closed into main, with an empty input: goes on, nothing published', () => {
    const run = decide('pull_request_target', prEvent('closed', 'main'), { branches: '' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true' });
    expect(run.statuses).toEqual([]);
  });

  it('edited out of the input (staging → develop): goes on, nothing published', () => {
    const run = decide('pull_request_target', prEvent('edited', 'develop', { changes: { base: { ref: { from: 'staging' } } } }), { branches: 'staging,main' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true' });
    expect(run.statuses).toEqual([]);
  });

  it('edited back into staging: «juzgando» as for any pull request into the input', () => {
    const run = decide('pull_request_target', prEvent('edited', 'staging', { changes: { base: { ref: { from: 'develop' } } } }), { branches: 'staging,main' });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
    expect(run.statuses).toHaveLength(1);
  });
});

// PLAN-13-R6 §15 (the flock of slice 6): `closed` and `edited` out of the input respect the switch.
// With the engine off (`off`, or no value) nothing is judged: the step publishes nothing and does
// not go on to build the engine.
describe('flock 6: closed, and edited out of the input, with the engine off', () => {
  for (const mode of ['off', '', ' OFF ']) {
    it(`closed into staging, mode «${mode}»: stops, nothing published`, () => {
      const run = decide('pull_request_target', prEvent('closed', 'staging'), { branches: 'staging,main', mode });
      expect(run.code, run.stderr).toBe(0);
      expect(run.outputs).toMatchObject({ continue: 'false' });
      expect(run.statuses).toEqual([]);
    });

    it(`edited out of the input (staging → develop), mode «${mode}»: stops, nothing published`, () => {
      const run = decide('pull_request_target', prEvent('edited', 'develop', { changes: { base: { ref: { from: 'staging' } } } }), { branches: 'staging,main', mode });
      expect(run.code, run.stderr).toBe(0);
      expect(run.outputs).toMatchObject({ continue: 'false' });
      expect(run.statuses).toEqual([]);
    });
  }

  // Controls: with the engine on or in advisory, they still go on to the judge without publishing.
  for (const mode of ['on', 'advisory']) {
    it(`closed into staging, mode «${mode}»: goes on, nothing published`, () => {
      const run = decide('pull_request_target', prEvent('closed', 'staging'), { branches: 'staging,main', mode });
      expect(run.code, run.stderr).toBe(0);
      expect(run.outputs).toMatchObject({ continue: 'true' });
      expect(run.statuses).toEqual([]);
    });
  }
});

describe('§1.5 (15) through the whole action: the only pull request with that head is closed', () => {
  it('neither the decide step nor the judge publishes anything, not even «juzgando»', async () => {
    const w = branchWorld({ mainRecipe: recipe(['todo-verde'], BRANCHES) });
    const staging = w.commitOn(w.main, { 'README.md': 'staging\n' }, 'staging');
    w.setBranch('staging', staging);
    const head = w.commitOn(w.main, { 'app/page.tsx': 'export const page = 2;\n' }, 'pieza 13');
    w.pr(7, { head, headRef: 'feat/13-algo', baseRef: 'main', state: 'closed' });
    w.checks(head, 'failure', 'todo-verde');
    const event = w.prEvent(7, 'closed');

    const step = decide('pull_request_target', event, { branches: 'staging,main' });
    expect(step.code, step.stderr).toBe(0);
    expect(step.statuses).toEqual([]);
    expect(step.outputs).toMatchObject({ continue: 'true' });

    await w.judge('pull_request_target', event);
    expect(w.github.published).toEqual([]);
  });
});
