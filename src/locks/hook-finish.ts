// PLAN-13-R6 §15, «Cuarta revisión del delta»: the hook writes its answer and ends the process
// explicitly, with the streams flushed first, whatever handle is still open. Claude Code cuts a hook
// that keeps running and lets the tool through, so the process must not linger on a worker or on a
// pipe a grandchild holds. The answer's exit code is final: a failing kill step (`afterWrite`) never
// changes it and never leaves an unhandled rejection or an uncaught exception.

import type { HookResult } from './hook-cli.js';

/**
 * The output seam of `finishHook`, so the behaviour is tested without touching the real streams. Its
 * default is `process.stdout`, `process.stderr` and `process.exit`.
 */
export interface HookFinishIO {
  readonly stdout: { write(text: string, done: () => void): unknown };
  readonly stderr: { write(text: string, done: () => void): unknown };
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
 * returned promise settles, whether it resolves or rejects, and also when `afterWrite` throws. The
 * cleanup of the deciding process may take a bounded moment; the answer is already written, so this
 * only delays the explicit exit, never the answer the client reads.
 */
export function finishHook(
  result: HookResult,
  afterWrite?: () => void | Promise<void>,
  io: HookFinishIO = defaultIo,
): void {
  const write = (stream: HookFinishIO['stdout'], text: string, next: () => void): void => {
    if (text.length === 0) {
      next();
      return;
    }
    stream.write(text, next);
  };
  write(io.stdout, result.stdout, () => {
    write(io.stderr, result.stderr, () => {
      const exit = (): void => io.exit(result.exitCode);
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
