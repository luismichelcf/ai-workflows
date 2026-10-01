// PLAN-13-R6 §15, «Cuarta revisión del delta»: the hook writes its answer and ends the process
// explicitly, with the streams flushed first, whatever handle is still open. Claude Code cuts a hook
// that keeps running and lets the tool through, so the process must not linger on a worker or on a
// pipe a grandchild holds. The answer's exit code is final: a failing kill step (`afterWrite`) never
// changes it and never leaves an unhandled rejection or an uncaught exception.
//
// PLAN-13-R6 §15, «Quinta revisión del delta»: a write that fails — the client closed the pipe
// (EPIPE) — must not change the answer's code either. Each stream is subscribed to 'error' before it
// is written, so an 'error' event is never unhandled, and any of a callback error, an 'error' event
// or a synchronous throw still ends in exactly one `exit(result.exitCode)`.

import type { HookResult } from './hook-cli.js';

/** A stream of `finishHook`: writes text and may report an error, as `process.stdout` does. */
export interface HookFinishStream {
  write(text: string, done: (error?: unknown) => void): unknown;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * The output seam of `finishHook`, so the behaviour is tested without touching the real streams. Its
 * default is `process.stdout`, `process.stderr` and `process.exit`.
 */
export interface HookFinishIO {
  readonly stdout: HookFinishStream;
  readonly stderr: HookFinishStream;
  exit(code: number): void;
}

const defaultIo: HookFinishIO = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
};

/**
 * Writes `result.stdout`, then `result.stderr` (each only when not empty, waiting for the write to
 * be flushed), then runs `afterWrite` and calls `exit` EXACTLY ONCE with `result.exitCode` — after a
 * returned promise settles, whether it resolves or rejects, and also when `afterWrite` throws, when
 * a write fails or when `exit` itself throws. `finishHook` never throws. The cleanup of the deciding
 * process may take a bounded moment; the answer is already written, so this only delays the explicit
 * exit, never the answer the client reads.
 */
export function finishHook(
  result: HookResult,
  afterWrite?: () => void | Promise<void>,
  io: HookFinishIO = defaultIo,
): void {
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    try {
      io.exit(result.exitCode);
    } catch {
      // The answer is already written; a failing exit must not become an uncaught exception.
    }
  };

  // Subscribe to 'error' BEFORE writing, so the event always has a listener. A stream may report a
  // failed write through the callback, through 'error', or by throwing; all three paths run `next`
  // at most once.
  const write = (stream: HookFinishStream, text: string, next: () => void): void => {
    if (text.length === 0) {
      next();
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      next();
    };
    stream.on?.('error', settle);
    try {
      stream.write(text, () => settle());
    } catch {
      settle();
    }
  };

  write(io.stdout, result.stdout, () => {
    write(io.stderr, result.stderr, () => {
      let after: void | Promise<void>;
      try {
        after = afterWrite?.();
      } catch {
        exit();
        return;
      }
      if (after instanceof Promise) {
        void after.then(exit, exit);
      } else {
        exit();
      }
    });
  });
}
