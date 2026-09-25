import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PLAN-13-R5 §2.6 (review of the flock, part 5): the first step of action.yml decides the target
// and publishes the initial status BEFORE the judge runs. The two new triggers must get through it:
// the review signal (a workflow_run of a pull_request_review) and a comment on the piece's issue.
// This test runs that step's own bash, as written in action.yml, with a fake `gh` on the PATH
// that answers from a table and logs every call.

const ACTION = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8')) as { runs: { steps: { id?: string; run?: string }[] } };
const DECIDE = ACTION.runs.steps.find((step) => step.id === 'decide')?.run ?? '';

const HEAD = 'c'.repeat(40);
const MERGE = 'b'.repeat(40);
const SIGNAL = '.github/workflows/ai-workflows-review-signal.yml';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE_GH = [
  '#!/usr/bin/env bash',
  'printf "%s\\n" "$*" >> "$FAKE_LOG"',
  'case "$*" in',
  '  "api repos/o/r --jq .default_branch") echo main ;;',
  `  "api repos/o/r/pulls/7") echo '{"state":"open","base":{"ref":"main"},"head":{"sha":"${HEAD}"}}' ;;`,
  `  "api repos/o/r/pulls/9") echo '{"state":"closed","base":{"ref":"main"},"head":{"sha":"${HEAD}"}}' ;;`,
  `  "api repos/o/r/pulls/10") echo '{"base":{"ref":"main"},"head":{"sha":"${HEAD}"}}' ;;`,
  '  "api repos/o/r/pulls/13") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
  '  "api repos/o/r/statuses/"*) echo "{}" ;;',
  '  *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;',
  'esac',
  '',
].join('\n');

// This machine may have no `jq` (the GitHub runners do). When it is missing, a tiny stand-in
// answers the only shape the step uses: `jq -r '<path> // empty' [file]`, a path of `.key` and
// `[n]` steps read from a file or stdin. Anything else makes the stand-in fail loudly.
const HAS_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
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

function decide(eventName: string, event: unknown, mode = 'on') {
  const dir = mkdtempSync(join(tmpdir(), 'aiw-decide-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
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
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  const result = spawnSync('bash', [posix(join(dir, 'decide.sh'))], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.platform === 'win32' ? posix(bin) : bin}${process.platform === 'win32' ? ':' : ':'}${process.env['PATH'] ?? ''}`,
      FAKE_LOG: posix(join(dir, 'gh.log')),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: posix(join(dir, 'event.json')),
      GITHUB_OUTPUT: posix(join(dir, 'output')),
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ai-workflows.yml@refs/heads/main',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1',
      INPUT_TASK: 'judge',
      INPUT_MODE: mode,
      INPUT_CONTEXT: 'ai-workflows',
      GH_TOKEN: 'x',
    },
  });
  const outputs = Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const calls = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);
  return { code: result.status, stderr: result.stderr, stdout: result.stdout, outputs, calls, statuses: calls.filter((call) => call.startsWith('api repos/o/r/statuses/')) };
}

const signal = (over: Record<string, unknown> = {}) => ({
  workflow_run: { event: 'pull_request_review', path: `${SIGNAL}@refs/heads/main`, head_sha: MERGE, repository: { full_name: 'o/r' }, pull_requests: [{ number: 7 }], ...over },
});

describe('the review signal gets through the first step of the action', () => {
  it('re-reads the pull request of the signal and publishes pending on its live head, never on the merge commit', () => {
    const run = decide('workflow_run', signal());
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', publish: 'true', sha: HEAD });
    expect(run.calls).toContain('api repos/o/r/pulls/7');
    expect(run.statuses).toHaveLength(1);
    expect(run.statuses[0]).toContain(`statuses/${HEAD}`);
    expect(run.calls.join('\n')).not.toContain(MERGE);
  });

  for (const [name, over] of [
    ['another repository', { repository: { full_name: 'otro/r' } }],
    ['another workflow path', { path: '.github/workflows/otra.yml@refs/heads/main' }],
    ['no pull request number (a fork)', { pull_requests: [] }],
    ['a closed pull request', { pull_requests: [{ number: 9 }] }],
    ['a pull request whose state GitHub does not say', { pull_requests: [{ number: 10 }] }],
  ] as const) {
    it(`a signal with ${name} stops quietly and publishes nothing`, () => {
      const run = decide('workflow_run', signal(over));
      expect(run.code, run.stderr).toBe(0);
      expect(run.outputs).toMatchObject({ continue: 'false', publish: 'false' });
      expect(run.statuses).toEqual([]);
    });
  }
});

describe('a comment on the piece issue gets through the first step of the action', () => {
  const comment = (action: string, body: string) => ({ action, issue: { number: 13 }, comment: { body } });

  it('a new event comment continues to the judge without an initial status (the judge publishes per pull request)', () => {
    const run = decide('issue_comment', comment('created', 'Veredicto\n\n<!-- ai-workflows:event {} -->'));
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', publish: 'false', sha: '' });
    expect(run.calls).not.toContain('api repos/o/r/pulls/13');
    expect(run.statuses).toEqual([]);
  });

  for (const action of ['edited', 'deleted']) {
    it(`an ${action} comment continues to the judge too, with or without the mark`, () => {
      const run = decide('issue_comment', comment(action, 'ya no dice nada'));
      expect(run.code, run.stderr).toBe(0);
      expect(run.outputs).toMatchObject({ continue: 'true', publish: 'false' });
    });
  }

  it('a new comment without the mark stops quietly', () => {
    const run = decide('issue_comment', comment('created', 'hola'));
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'false', publish: 'false' });
    expect(run.statuses).toEqual([]);
  });

  it('with the engine off it stops quietly and publishes nothing', () => {
    const run = decide('issue_comment', comment('created', 'Veredicto\n\n<!-- ai-workflows:event {} -->'), 'off');
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'false' });
    expect(run.statuses).toEqual([]);
  });

  it('a comment on a pull request still re-reads that pull request as before', () => {
    const run = decide('issue_comment', { action: 'created', issue: { number: 7, pull_request: { url: 'x' } }, comment: { body: '/approve abc' } });
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toMatchObject({ continue: 'true', sha: HEAD });
  });
});
