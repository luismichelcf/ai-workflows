import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { HookResult } from '../src/index.js';

// PLAN-13-R6 §15, «Cuarta revisión del delta»: «la salida del gancho no puede cambiar su código por
// una falla al matar el árbol». Today `finishHook` lives inside `bin.ts`: when the kill step
// (`afterWrite`, the `cancel()` of the deciding process) rejects, `void after.then(exit)` leaves an
// unhandled rejection and Node ends with code 1; when it throws, the exception escapes the write
// callback and Node ends with code 1 too. Claude Code reads a hook that exits 1 as an error and lets
// the tool through, so the deny JSON already written would not count.
//
// Interface these tests fix (for the builder):
//  - A new module `src/locks/hook-finish.ts` exports
//      `finishHook(result: HookResult, afterWrite?: () => void | Promise<void>, io?: HookFinishIO): void`
//    and the type
//      `HookFinishIO = { stdout: { write(text: string, done: () => void): unknown };
//                        stderr: { write(text: string, done: () => void): unknown };
//                        exit(code: number): void }`,
//    whose default is `process.stdout`, `process.stderr` and `process.exit`.
//  - It writes `result.stdout`, then `result.stderr` (each only when not empty, waiting for the
//    write to be flushed), then runs `afterWrite` and calls `exit` EXACTLY ONCE with
//    `result.exitCode` — after a returned promise settles, whether it resolves or rejects, and
//    also when `afterWrite` throws. A failing `afterWrite` never changes the code and never leaves
//    an unhandled rejection or an uncaught exception.
//  - `src/bin.ts` uses this module (no `finishHook` of its own), so the process the client runs
//    has exactly this behaviour.

interface Recorded {
  readonly events: string[];
  readonly exits: number[];
  readonly exited: Promise<number>;
}

interface FinishModule {
  finishHook(
    result: HookResult,
    afterWrite?: () => void | Promise<void>,
    io?: {
      stdout: { write(text: string, done: () => void): unknown };
      stderr: { write(text: string, done: () => void): unknown };
      exit(code: number): void;
    },
  ): void;
}

/** The module under test, loaded per test so each test fails on its own while it does not exist. */
const load = async (): Promise<FinishModule> => (await import('../src/locks/hook-finish.js')) as unknown as FinishModule;

/** Fake streams (the write callback runs on a later tick, like a real pipe) and a recorded exit. */
function fakeIo(): { io: Parameters<FinishModule['finishHook']>[2] & object; recorded: Recorded } {
  const events: string[] = [];
  const exits: number[] = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const stream = (name: string) => ({
    write(text: string, done: () => void): boolean {
      events.push(`${name}:${text}`);
      setImmediate(done);
      return true;
    },
  });
  return {
    io: {
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      exit(code: number): void {
        events.push(`exit:${code}`);
        exits.push(code);
        resolveExit(code);
      },
    },
    recorded: { events, exits, exited },
  };
}

const DENY: HookResult = {
  exitCode: 0,
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })}\n`,
  stderr: '',
};
const GIT_REFUSAL: HookResult = { exitCode: 1, stdout: '', stderr: 'rechazado\n' };

/** Waits for the exit, or fails after `ms` with what was recorded (a finish that never exits). */
async function exitWithin(recorded: Recorded, ms = 2_000): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no exit within ${ms} ms; recorded: ${recorded.events.join(' | ')}`)), ms);
  });
  try {
    return await Promise.race([recorded.exited, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets pending ticks run, so a second exit (or an unhandled rejection) would show. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('fourth delta: the hook exit code survives a failing kill step', () => {
  it('afterWrite returns a rejected promise: the deny JSON is written and the process exits 0, once', async () => {
    const { finishHook } = await load();
    const { io, recorded } = fakeIo();
    finishHook(DENY, () => Promise.reject(new Error('taskkill falló')), io);
    expect(await exitWithin(recorded)).toBe(0);
    await settle();
    expect(recorded.exits).toEqual([0]);
    expect(recorded.events[0]).toBe(`stdout:${DENY.stdout}`);
  });

  it('afterWrite throws synchronously: the process still exits 0, once', async () => {
    const { finishHook } = await load();
    const { io, recorded } = fakeIo();
    finishHook(DENY, () => {
      throw new Error('kill lanzó');
    }, io);
    expect(await exitWithin(recorded)).toBe(0);
    await settle();
    expect(recorded.exits).toEqual([0]);
  });

  it('a git hook refusal (exit 1) with a rejecting afterWrite exits 1, the answer\'s code', async () => {
    const { finishHook } = await load();
    const { io, recorded } = fakeIo();
    finishHook(GIT_REFUSAL, () => Promise.reject(new Error('taskkill falló')), io);
    expect(await exitWithin(recorded)).toBe(1);
    await settle();
    expect(recorded.exits).toEqual([1]);
    expect(recorded.events[0]).toBe(`stderr:${GIT_REFUSAL.stderr}`);
  });

  it('a resolving afterWrite runs after the answer is written, and the exit waits for it', async () => {
    const { finishHook } = await load();
    const { io, recorded } = fakeIo();
    let release: () => void = () => {};
    finishHook(DENY, () => {
      recorded.events.push('afterWrite');
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    }, io);
    await settle();
    expect(recorded.events).toEqual([`stdout:${DENY.stdout}`, 'afterWrite']);
    expect(recorded.exits).toEqual([]);
    release();
    expect(await exitWithin(recorded)).toBe(0);
    expect(recorded.exits).toEqual([0]);
  });

  it('without afterWrite: stdout, then stderr, then exit with the answer\'s code', async () => {
    const { finishHook } = await load();
    const { io, recorded } = fakeIo();
    finishHook({ exitCode: 2, stdout: 'a', stderr: 'b' }, undefined, io);
    expect(await exitWithin(recorded)).toBe(2);
    expect(recorded.events).toEqual(['stdout:a', 'stderr:b', 'exit:2']);
  });

  it('src/bin.ts uses the shared finishHook and keeps no copy of its own', () => {
    const bin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin.ts'), 'utf8');
    expect(bin).not.toMatch(/function\s+finishHook\s*\(/);
    expect(bin).toMatch(/['"]\.\/locks\/hook-finish\.js['"]/);
  });
});

// PLAN-13-R6 §15, «Quinta revisión del delta»: when the client closes its end of the pipe, writing
// the answer fails with EPIPE. A real `process.stdout` then calls the write callback with the error
// AND emits 'error' on a later tick; with no 'error' listener, Node turns that event into an
// uncaught exception and the process ends with code 1, whatever the answer's code was.
//
// Interface fixed here (for the builder):
//  - Each stream of `HookFinishIO` may also carry `on(event: 'error', listener: (error: Error) => void)`
//    (`process.stdout` and `process.stderr` do). `finishHook` subscribes to 'error' on a stream that
//    has `on` BEFORE writing to it, so an 'error' event is never unhandled.
//  - A write that fails — the callback receives an error, the stream emits 'error' (with or without
//    calling the callback), or `write` throws synchronously — still ends in `exit` called EXACTLY
//    ONCE with `result.exitCode`. `finishHook` itself never throws.
//
// The fake below models Node: an 'error' event with no listener is recorded as `unhandled` (the real
// process would crash with code 1) instead of being thrown into the test runner.

interface BrokenIo {
  io: Parameters<FinishModule['finishHook']>[2] & object;
  recorded: Recorded;
  unhandled: Error[];
}

/** An io whose stdout fails with EPIPE the way `mode` says; stderr and exit are the recorded fakes. */
function brokenStdoutIo(mode: 'callback-and-event' | 'event-only' | 'throws'): BrokenIo {
  const { io, recorded } = fakeIo();
  const unhandled: Error[] = [];
  const emitter = new EventEmitter();
  const epipe = (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const stdout = {
    on(event: string, listener: (error: Error) => void): unknown {
      emitter.on(event, listener);
      return stdout;
    },
    write(text: string, done: (error?: Error | null) => void): boolean {
      recorded.events.push(`stdout:${text}`);
      if (mode === 'throws') throw epipe();
      const error = epipe();
      setImmediate(() => {
        if (mode === 'callback-and-event') done(error);
        if (emitter.listenerCount('error') === 0) unhandled.push(error);
        else emitter.emit('error', error);
      });
      return false;
    },
  };
  return { io: { ...io, stdout } as unknown as BrokenIo['io'], recorded, unhandled };
}

const GIT_REFUSAL_ON_STDOUT: HookResult = { exitCode: 1, stdout: 'rechazado\n', stderr: '' };

describe('fifth delta: the hook exit code survives a broken stdout (EPIPE)', () => {
  it("stdout calls back with EPIPE and emits 'error': the error is handled and exit is called once with the answer's code", async () => {
    const { finishHook } = await load();
    const { io, recorded, unhandled } = brokenStdoutIo('callback-and-event');
    finishHook(DENY, undefined, io);
    expect(await exitWithin(recorded)).toBe(0);
    await settle();
    expect(unhandled).toEqual([]);
    expect(recorded.exits).toEqual([0]);
  });

  it("stdout emits 'error' without calling back: the error is handled and exit is still called once with the answer's code", async () => {
    const { finishHook } = await load();
    const { io, recorded, unhandled } = brokenStdoutIo('event-only');
    finishHook({ exitCode: 2, stdout: 'a', stderr: '' }, undefined, io);
    expect(await exitWithin(recorded)).toBe(2);
    await settle();
    expect(unhandled).toEqual([]);
    expect(recorded.exits).toEqual([2]);
  });

  it("stdout.write throws EPIPE synchronously: finishHook does not throw and exit is called once with the answer's code", async () => {
    const { finishHook } = await load();
    const { io, recorded } = brokenStdoutIo('throws');
    expect(() => finishHook(GIT_REFUSAL_ON_STDOUT, undefined, io)).not.toThrow();
    expect(await exitWithin(recorded)).toBe(1);
    await settle();
    expect(recorded.exits).toEqual([1]);
  });
});
