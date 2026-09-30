// PLAN-13-R6 §4: the deciding thread of the editor hook.
//
// The main thread runs the whole decision in a Worker so that a disk read that blocks the thread
// — an unreadable recipe, a FIFO nobody writes — cannot stop the watchdog from answering in time.
// This module is both the worker entry (when Node runs it on a worker thread) and the helper the
// main thread uses to start one; nothing here decides anything itself.

import { Worker, parentPort, workerData } from 'node:worker_threads';

import { runHook, type HookKind, type HookResult, type RunHookOptions } from './hook-cli.js';

interface WorkerRequest {
  readonly kind: HookKind;
  readonly options: RunHookOptions;
}

interface WorkerAnswer {
  readonly result?: HookResult;
  readonly error?: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The worker entry. On the main thread `parentPort` is null and this is only an imported helper.
const port = parentPort;
if (port !== null) {
  const request = workerData as WorkerRequest;
  runHook(request.kind, request.options).then(
    (result) => port.postMessage({ result } satisfies WorkerAnswer),
    (error) => port.postMessage({ error: reasonOf(error) } satisfies WorkerAnswer),
  );
}

/**
 * Runs one hook decision on a worker thread and answers with its result. The options travel as
 * plain data (no runner functions), exactly what the compiled `hook` command builds. A worker that
 * ends without answering — a load failure, a native crash — is a rejection, never a silent wait.
 */
export function runHookInWorker(kind: HookKind, options: RunHookOptions): Promise<HookResult> {
  const worker = new Worker(new URL('./hook-worker.js', import.meta.url), {
    workerData: { kind, options } satisfies WorkerRequest,
  });
  return new Promise<HookResult>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };
    worker.once('message', (message: WorkerAnswer) => {
      if (typeof message.error === 'string') {
        finish(() => reject(new Error(message.error)));
        return;
      }
      if (message.result !== undefined) {
        finish(() => resolve(message.result as HookResult));
        return;
      }
      finish(() => reject(new Error('el subproceso del gancho no contestó')));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => finish(() => reject(new Error(`el subproceso del gancho terminó sin contestar (${code ?? 0})`))));
  });
}
