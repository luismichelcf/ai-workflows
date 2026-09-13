import { describe, expect, it } from 'vitest';

import { parseRun, type RawRun, type RunRequest } from '../src/index.js';

// Reading what a run actually did. Every fixture below is the SHAPE of a real output:
// opencode and codex from runs captured on 12-sep-2026 while building this engine; claude,
// antigravity and muse from the formats documented and verified in the project's
// `docs/agents/orquestacion.md` and `docs/agents/muse-code.md`.
//
// Two honest limits, written here so nobody mistakes them for verified facts:
//   - The wording of quota and sign-in errors is representative, not captured. The rule
//     that matters is the opposite direction: anything NOT clearly recognised must never be
//     read as a quota, because a quota silently hands the work to another model.
//   - For muse, the event TYPES are documented; the field names inside them are not. They
//     must be checked against a real JSONL before muse is used as a builder.

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

describe('exit code 0 is not success, for any CLI', () => {
  it('codex: a clean exit with no terminal event is incomplete', () => {
    const output = jsonl({ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' });

    expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output, 0)).status).toBe('incomplete');
  });

  it('opencode: a clean exit whose last step was a tool call is incomplete', () => {
    const output = jsonl(
      { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
      { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'tool-calls' } },
    );

    expect(parseRun(req({ provider: 'opencode', model: 'deepseek/deepseek-flash' }), run(output, 0)).status).toBe('incomplete');
  });

  it('claude: a clean exit with an error result is not success', () => {
    const output = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's-1', result: 'algo fallo' });

    expect(parseRun(req({}), run(output, 0)).status).not.toBe('success');
  });

  it('any CLI: empty output is incomplete, never success', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
      expect(parseRun(req({ provider }), run('', 0)).status).toBe('incomplete');
    }
  });

  it('any CLI: output that is not what it should be is incomplete, not a crash', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
      expect(() => parseRun(req({ provider }), run('<html>502 Bad Gateway</html>', 1))).not.toThrow();
    }
  });
});

describe('codex', () => {
  const codex = req({ provider: 'codex', model: 'gpt-6-astra' });
  const done = jsonl(
    { type: 'thread.started', thread_id: '01a0941e-b8e8-7470-9ddc-462f860dbb73' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Primer mensaje.' } },
    { type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: 'VERDICT:APPROVED' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  );

  it('reads a finished turn as success', () => {
    expect(parseRun(codex, run(done)).status).toBe('success');
  });

  it('takes the session from the thread it started', () => {
    expect(parseRun(codex, run(done)).identity?.session).toBe('01a0941e-b8e8-7470-9ddc-462f860dbb73');
  });

  it('keeps the LAST agent message as the final text', () => {
    expect(parseRun(codex, run(done)).text).toBe('VERDICT:APPROVED');
  });

  it('names the provider in the identity', () => {
    expect(parseRun(codex, run(done)).identity?.provider).toBe('codex');
  });

  it('reads a failed turn as a failure', () => {
    const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: 'el modelo no respondio' } });

    expect(parseRun(codex, run(output, 1)).status).toBe('failed');
  });

  it('recognises an explicit usage limit as quota', () => {
    const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } });

    expect(parseRun(codex, run(output, 1)).status).toBe('quota');
  });
});

describe('opencode', () => {
  const opencode = req({ provider: 'opencode', model: 'deepseek/deepseek-flash' });
  const done = jsonl(
    { type: 'step_start', sessionID: 'ses_f6901e076ffeXB17B5DJGHYRyG', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'ses_f6901e076ffeXB17B5DJGHYRyG', part: { type: 'text', text: 'Revisando.' } },
    { type: 'step_finish', sessionID: 'ses_f6901e076ffeXB17B5DJGHYRyG', part: { type: 'step-finish', reason: 'tool-calls' } },
    { type: 'text', sessionID: 'ses_f6901e076ffeXB17B5DJGHYRyG', part: { type: 'text', text: 'Listo: 172/172.' } },
    { type: 'step_finish', sessionID: 'ses_f6901e076ffeXB17B5DJGHYRyG', part: { type: 'step-finish', reason: 'stop' } },
  );

  it('reads a final stop as success', () => {
    expect(parseRun(opencode, run(done)).status).toBe('success');
  });

  it('takes the session from its events', () => {
    expect(parseRun(opencode, run(done)).identity?.session).toBe('ses_f6901e076ffeXB17B5DJGHYRyG');
  });

  it('keeps the last text as the final message', () => {
    expect(parseRun(opencode, run(done)).text).toBe('Listo: 172/172.');
  });

  it('does not claim to know the model when the CLI did not report it', () => {
    const report = parseRun(opencode, run(done));

    expect(report.modelConfirmed).toBe(false);
    expect(report.identity?.model).toBe('deepseek/deepseek-flash');
  });
});

describe('claude', () => {
  const ok = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'OK',
    session_id: 'c-session-1',
    modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 2 } },
  });

  it('reads a successful result as success', () => {
    expect(parseRun(req({}), run(ok)).status).toBe('success');
  });

  it('takes the session and the final text', () => {
    const report = parseRun(req({}), run(ok));

    expect(report.identity?.session).toBe('c-session-1');
    expect(report.text).toBe('OK');
  });

  it('confirms the model from what it actually used', () => {
    const report = parseRun(req({}), run(ok));

    expect(report.modelConfirmed).toBe(true);
    expect(report.identity?.model).toBe('claude-opus-5');
  });

  it('fails when the model it used is not the one asked for, naming both', () => {
    // Never switch to an alias silently: the owner picked a model, and a run on a different
    // one is not the run he authorised.
    const other = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 's', modelUsage: { 'claude-sonnet-5': {} } });

    const report = parseRun(req({}), run(other));

    expect(report.status).toBe('failed');
    expect(report.reason).toContain('claude-opus-5');
    expect(report.reason).toContain('claude-sonnet-5');
  });

  it('recognises an explicit rate limit as quota', () => {
    const limited = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', result: 'Claude AI usage limit reached' });

    expect(parseRun(req({}), run(limited, 1)).status).toBe('quota');
  });

  it('recognises an explicit sign-in problem as auth', () => {
    const noAuth = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', result: 'Invalid API key · Please run /login' });

    expect(parseRun(req({}), run(noAuth, 1)).status).toBe('auth');
  });
});

describe('antigravity', () => {
  const agy = req({ provider: 'antigravity', model: 'gemini-3.8-flash-high' });

  it('reads SUCCESS with a response as success', () => {
    const output = JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-1', response: 'VERDICT:REVISE' });

    const report = parseRun(agy, run(output));

    expect(report.status).toBe('success');
    expect(report.identity?.session).toBe('conv-1');
    expect(report.text).toBe('VERDICT:REVISE');
  });

  it('does not read SUCCESS with an empty response as success', () => {
    // Measured in this house: a headless run reported SUCCESS and had done nothing.
    const output = JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-1', response: '' });

    expect(parseRun(agy, run(output)).status).not.toBe('success');
  });

  it('reads any other status as not success', () => {
    const output = JSON.stringify({ status: 'ERROR', conversation_id: 'conv-1', response: 'x' });

    expect(parseRun(agy, run(output, 1)).status).not.toBe('success');
  });
});

describe('muse', () => {
  const muse = req({ provider: 'muse', model: 'muse-spark-1.3-contributor' });

  it('reads a completed terminal turn as success, with the model it confirmed', () => {
    const output = jsonl(
      { type: 'stream', kind: 'session', session_id: 'm-uuid-1' },
      { type: 'run.model.configured', model: 'muse-spark-1.3-contributor' },
      { type: 'run.terminal.completed' },
    );

    const report = parseRun(muse, run(output));

    expect(report.status).toBe('success');
    expect(report.modelConfirmed).toBe(true);
  });

  it('reads a turn frozen on an approval as incomplete, saying so', () => {
    // Documented: with a compound shell command, muse waits for a human approval that never
    // comes in exec mode. The stream just stops, and the last event is the proposal.
    const output = jsonl(
      { type: 'stream', kind: 'session', session_id: 'm-uuid-1' },
      { type: 'run.model.configured', model: 'muse-spark-1.3-contributor' },
      { type: 'task.lifecycle.proposed', task_kind: 'tool.bash' },
    );

    const report = parseRun(muse, run(output, null));

    expect(report.status).toBe('incomplete');
    expect((report.reason ?? '').length).toBeGreaterThan(10);
  });

  it('fails when the model it configured is not the one asked for', () => {
    const output = jsonl(
      { type: 'stream', kind: 'session', session_id: 'm-uuid-1' },
      { type: 'run.model.configured', model: 'otro-modelo' },
      { type: 'run.terminal.completed' },
    );

    expect(parseRun(muse, run(output)).status).toBe('failed');
  });
});

describe('never mistaking an unknown failure for a quota', () => {
  const unknownFailures = [
    'timeout after 600000ms',
    'ECONNRESET',
    'Segmentation fault',
    'the model returned an empty response',
  ];

  for (const message of unknownFailures) {
    it(`codex: "${message}" is not a quota`, () => {
      const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message } });

      expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output, 1)).status).not.toBe('quota');
    });
  }
});

describe('never mistaking a failure that merely mentions logging in for a sign-in problem', () => {
  // Found while building this slice: the sign-in check matched the bare word "login", so a
  // build that failed on a login FORM test would read as "not signed in" and hand the work
  // to the relay on its own. `auth` relays exactly like `quota` does, so it deserves the
  // same caution: only a message that clearly says the CLI is not signed in counts.
  const aboutLoginButNotSignedOut = [
    'e2e: the login form test failed',
    '3 authentication tests failed',
    'could not find the Login button on the page',
    'refactor the login flow before merging',
  ];

  for (const message of aboutLoginButNotSignedOut) {
    it(`codex: "${message}" is not a sign-in problem`, () => {
      const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message } });

      expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output, 1)).status).not.toBe('auth');
    });
  }

  it('still recognises a CLI that is genuinely not signed in', () => {
    for (const message of ['Not logged in. Run `codex login`.', 'Invalid API key · Please run /login', '401 Unauthorized']) {
      const output = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message } });

      expect(parseRun(req({ provider: 'codex', model: 'gpt-6-astra' }), run(output, 1)).status, message).toBe('auth');
    }
  });
});
