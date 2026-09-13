import { describe, expect, it } from 'vitest';

import { parseRun, type RawRun, type RunRequest } from '../src/index.js';

// First adversarial review of part 3 (13-sep-2026). Every case below was reproduced against
// the code: false relays and false successes the earlier tests did not catch.

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');
const run = (output: string, exitCode: number | null = 0): RawRun => ({ output, exitCode });

const req = (over: Partial<RunRequest>): RunRequest => ({
  provider: 'claude',
  model: 'claude-opus-5',
  cwd: 'C:/GitHub/ai-workflows',
  prompt: 'x',
  mode: 'build',
  ...over,
});

describe('a word that merely appears in a message never relays the work', () => {
  // The builder sees the output of the project's own tests, and a failing test's text ends
  // up in the CLI's error. Matching "quota" or "401" anywhere in it relayed work on a red
  // test. Only the CLI's own phrasing, at the start of its message, counts.
  const notQuotaNorAuth = [
    'missing closing quotation mark',
    'enforces quotas per tenant: expected 3 received 2',
    'expected 200 to be 429',
    'tests/api.test.ts:429:12',
    'build failed at version 1.429.0',
    'memory usage limit exceeded (OOMKilled)',
    'gh: HTTP 429 - API rate limit exceeded',
    'npm ERR! 429 Too Many Requests',
    'expected 401 to be 200',
    'should return 401 Unauthorized for anonymous users',
    'remote: Unauthorized. Permission to org/repo.git denied',
    'gh: HTTP 401: Bad credentials',
    'redirect to /login when the user is not logged in',
    'EACCES: unauthorized write to /etc/hosts',
  ];

  for (const message of notQuotaNorAuth) {
    it(`codex: "${message}" is a plain failure`, () => {
      const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message } });

      expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output, 1)).status).toBe('failed');
    });

    it(`claude: "${message}" is a plain failure`, () => {
      const output = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 's',
        result: message,
      });

      expect(parseRun(req({}), run(output, 1)).status).toBe('failed');
    });
  }

  it('antigravity: a reviewer verdict that talks about rate limits is not a quota', () => {
    const output = JSON.stringify({
      status: 'CANCELLED',
      conversation_id: 'c',
      response: 'VERDICT:REVISE - the rate limit handler in api.ts swallows 429s',
    });

    expect(parseRun(req({ provider: 'antigravity', model: 'gemini-3.8-flash-high' }), run(output, 1)).status).not.toBe('quota');
  });

  it('claude: a model that says it added quota checks is not out of quota', () => {
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      session_id: 's',
      result: 'I added quota checks; 3 tests still fail',
    });

    expect(parseRun(req({}), run(output, 1)).status).not.toBe('quota');
  });
});

describe('opencode: the run is finished only if its LAST step stopped', () => {
  const opencode = req({ provider: 'opencode', model: 'deepseek/deepseek-flash' });
  const ev = (type: string, part: Record<string, unknown>, session = 'ses_main') => ({ type, sessionID: session, part });

  it('is incomplete when a stop is followed by more steps that never stopped', () => {
    const output = jsonl(
      ev('step_finish', { type: 'step-finish', reason: 'stop' }),
      ev('step_start', { type: 'step-start' }),
      ev('step_finish', { type: 'step-finish', reason: 'tool-calls' }),
    );

    expect(parseRun(opencode, run(output, null)).status).toBe('incomplete');
  });

  it('is incomplete when a stop is followed by text and then the process died', () => {
    const output = jsonl(
      ev('step_finish', { type: 'step-finish', reason: 'stop' }),
      ev('text', { type: 'text', text: 'half' }),
    );

    expect(parseRun(opencode, run(output, null)).status).toBe('incomplete');
  });

  it('ignores a stop from another session mixed into the stream', () => {
    const output = jsonl(
      ev('step_start', { type: 'step-start' }),
      ev('step_finish', { type: 'step-finish', reason: 'tool-calls' }),
      ev('step_finish', { type: 'step-finish', reason: 'stop' }, 'ses_child'),
    );

    expect(parseRun(opencode, run(output, null)).status).toBe('incomplete');
  });
});

describe('the model that did the work is the one that counts', () => {
  it('claude: fails when another model did most of the work, naming it', () => {
    // The owner picked Opus. If the CLI moved the work to Sonnet and Opus only touched a
    // few tokens, the run he authorised did not happen.
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 's',
      modelUsage: { 'claude-opus-5': { outputTokens: 12 }, 'claude-sonnet-5': { outputTokens: 40000 } },
    });

    const report = parseRun(req({}), run(output));

    expect(report.status).toBe('failed');
    expect(report.reason).toContain('claude-sonnet-5');
  });

  it('claude: accepts a small auxiliary model next to the chosen one doing the work', () => {
    // Claude Code runs a small model for background chores. What the owner chose must be
    // the model that did the main work; the auxiliary does not invalidate the run.
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 's',
      modelUsage: { 'claude-haiku-4-5': { outputTokens: 5 }, 'claude-opus-5': { outputTokens: 40000 } },
    });

    expect(parseRun(req({}), run(output)).status).toBe('success');
  });

  it('muse: fails when the configured model changes during the run', () => {
    const output = jsonl(
      { type: 'stream', kind: 'session', session_id: 'm-1' },
      { type: 'run.model.configured', model: 'muse-spark-1.3-contributor' },
      { type: 'run.model.configured', model: 'otro-modelo' },
      { type: 'run.terminal.completed' },
    );

    expect(parseRun(req({ provider: 'muse', model: 'muse-spark-1.3-contributor' }), run(output)).status).toBe('failed');
  });
});

describe('the last word decides, and a failure anywhere is not success', () => {
  it('muse: a completion followed by a frozen proposal is incomplete', () => {
    const output = jsonl(
      { type: 'stream', kind: 'session', session_id: 'm-1' },
      { type: 'run.model.configured', model: 'muse-spark-1.3-contributor' },
      { type: 'run.terminal.completed' },
      { type: 'task.lifecycle.proposed', task_kind: 'tool.bash' },
    );

    expect(parseRun(req({ provider: 'muse', model: 'muse-spark-1.3-contributor' }), run(output, null)).status).toBe('incomplete');
  });

  it('codex: a stream with a failed turn is not success even if a completed turn follows', () => {
    const output = jsonl(
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'turn.failed', error: { message: 'boom' } },
      { type: 'turn.completed', usage: {} },
    );

    expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output)).status).not.toBe('success');
  });

  it('codex: an empty session id is not an identity', () => {
    // Two different runs with an empty session would count as "the same execution" for the
    // identity gates, which is how an empty string turns into self-approval.
    const output = jsonl(
      { type: 'thread.started', thread_id: '' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: {} },
    );

    expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output)).identity).toBeUndefined();
  });

  it('claude: a warning line before the JSON does not lose the result', () => {
    const output =
      'Warning: something noisy\n' +
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'OK',
        session_id: 'c-9',
        modelUsage: { 'claude-opus-5': { outputTokens: 10 } },
      });

    const report = parseRun(req({}), run(output));

    expect(report.status).toBe('success');
    expect(report.identity?.session).toBe('c-9');
  });
});
