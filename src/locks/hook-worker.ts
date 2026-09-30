// PLAN-13-R6 §4 and §15: the deciding process of the editor hook.
//
// A disk read that blocks the thread that decides (a recipe that is a FIFO nobody writes) cannot be
// abandoned inside a worker *thread*: Node joins the worker on exit, so `process.exit` hangs and the
// hook misses Claude Code's 30 s cut. The decision therefore runs in a separate *process*: the
// parent relays the request, watches the clock and exits cleanly even while the child is stuck on
// the read. This module is both the child entry and the helper the main thread uses to start it.

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runHook, type HookKind, type HookResult, type RunHookOptions } from './hook-cli.js';
import type { HookClient } from './install.js';

/** How the child names itself on its own command line, so the module knows it is the entry. */
const CHILD_FLAG = '--child';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Everything the parent passes to the child: the kind of hook and the client, as plain argv. */
interface ChildRequest {
  readonly kind: HookKind;
  readonly client: HookClient;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isResult(value: unknown): value is HookResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.stdout === 'string' &&
    typeof record.stderr === 'string' &&
    typeof record.exitCode === 'number'
  );
}

/**
 * The child entry. It reads the request from the inherited stdin, decides and writes the answer as
 * one JSON line, then exits. The parent reads that line; a crash or an unreadable answer is a
 * rejection there, never a silent wait.
 */
async function childMain({ kind, client }: ChildRequest): Promise<void> {
  const stdin = await readAllStdin();
  const projectDir = process.env.AI_WORKFLOWS_PROJECT_DIR ?? process.cwd();
  const options: RunHookOptions =
    client === 'claude'
      ? { projectDir, cwd: process.cwd(), stdin }
      : { client, cwd: process.cwd(), stdin };
  const result = await runHook(kind, options);
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[2] === CHILD_FLAG) {
  const kind = process.argv[3] as HookKind;
  const client = (process.argv[4] as HookClient | undefined) ?? 'claude';
  childMain({ kind, client }).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${reasonOf(error)}\n`);
      process.exit(2);
    },
  );
}

export interface HookProcess {
  /** The answer of the deciding process, or a rejection when it could not be read. */
  readonly result: Promise<HookResult>;
  /** Ends the deciding process if it is still running; safe to call more than once. */
  cancel(): void;
}

/**
 * Starts the deciding process with the hook's own stdin inherited, so the child reads the request
 * while the parent is free to watch the clock and answer. The parent never reads stdin itself, so a
 * client that never closes stdin cannot keep it from answering (§15 P6).
 */
export function spawnHookProcess(kind: HookKind, client: HookClient): HookProcess {
  const entry = fileURLToPath(new URL('./hook-worker.js', import.meta.url));
  const child: ChildProcess = spawn(process.execPath, [entry, CHILD_FLAG, kind, client], {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const result = new Promise<HookResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `el proceso del gancho terminó con código ${code ?? 'desconocido'}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!isResult(parsed)) throw new Error('no contestó un resultado legible');
          resolve(parsed);
        } catch (error) {
          reject(new Error(`el proceso del gancho no contestó un resultado legible (${reasonOf(error)})`));
        }
      });
    });
  });
  return {
    result,
    cancel(): void {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    },
  };
}
