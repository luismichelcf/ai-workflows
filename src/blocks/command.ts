import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Gate,
  type GateContext,
  type GateResult,
} from '../contract.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import type { BlockManifest } from './manifest.js';
import { isGreenRun, parseTestRun } from '../commands.js';
import { resolveExecutable, type ExecutableEnvironment } from '../exec.js';
import {
  DEFAULT_PROCESS_GROUPS,
  DEFAULT_STDOUT_BYTES,
  TEST_STDOUT_BYTES,
} from '../process-group.js';
import { confirmEmptyGroup } from './confirm-empty.js';

// PLAN-13-R2 §3.6 (CN-04, CN-09): the engine's `command@1` runs a command of the project with a
// time limit. A command that cannot run is a technical block; one that runs and says no is an
// ordinary rejection, because there the red suite is the answer, not a breakdown. With
// `reader: vitest` the output is read too, so a red suite that exits 0 does not pass. The group
// is always terminated and confirmed empty before returning.

const MINUTES_MS = 60_000;

export const manifest: BlockManifest = {
  name: 'command',
  kind: 'module',
  natures: ['recompute'],
  inputs: {
    command: { type: 'command', required: true },
    'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
    reader: { type: 'string', enum: ['exit-code', 'vitest'], default: 'exit-code' },
  },
};

/** The real environment `resolveExecutable` needs, so the resolver stays a pure function. */
function executableEnvironment(): ExecutableEnvironment {
  const pathExt = process.env['PATHEXT'];
  return {
    platform: process.platform,
    path: process.env['PATH'] ?? process.env['Path'] ?? '',
    ...(pathExt !== undefined ? { pathExt } : {}),
    nodePath: process.execPath,
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function quoted(text: string, spanish: boolean): string {
  return spanish ? `«${text}»` : `"${text}"`;
}

/** Files of the change that are tests, in the order the facts list them. */
function testFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.filter(
    (file): file is string =>
      typeof file === 'string' && (file.endsWith('.test.ts') || file.endsWith('.test.tsx')),
  );
}

function changeFiles(context: GateContext): unknown {
  const change = context.change;
  if (typeof change !== 'object' || change === null) return [];
  return (change as Record<string, unknown>)['files'];
}

/** Splits the command into arguments; `{tests}` becomes one argument per test file. */
function expandedArguments(
  command: string,
  piece: string,
  tests: readonly string[],
): { readonly program: string; readonly args: string[] } {
  const tokens = command.split(' ').filter((token) => token.length > 0);
  const program = (tokens[0] ?? piece).replaceAll('{piece}', piece);
  const args: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token === '{tests}') {
      args.push(...tests);
      continue;
    }
    args.push(token.replaceAll('{piece}', piece));
  }
  return { program, args };
}

/** The output a person reads: standard output first, then standard error. */
function combinedOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((part) => part.length > 0).join('\n');
}

/** The last `count` lines of a text, which is where a failure lands. */
function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

function vitestReason(output: string, exitCode: number, spanish: boolean): string | undefined {
  const summary = parseTestRun({ output, exitCode });
  if (isGreenRun(summary)) return undefined;

  const head =
    summary.failures.length > 0
      ? spanish
        ? `La suite de pruebas no está en verde: ${summary.failures.map((name) => `«${name}»`).join(', ')}.`
        : `The test suite is not green: ${summary.failures.map((name) => `"${name}"`).join(', ')}.`
      : spanish
        ? 'No corrió ninguna prueba.'
        : 'No test ran.';
  const tail = lastLines(output, 20);
  return tail.length > 0 ? `${head}\n${tail}` : head;
}

function createGate(
  command: string,
  timeoutMinutes: number,
  reader: unknown,
  deps: EngineBlockDeps,
): Gate {
  const readVitest = reader === 'vitest';
  const timeoutMs = timeoutMinutes * MINUTES_MS;

  return async (context): Promise<GateResult> => {
    // A rehearsal must not launch anything. Going through `runEffect` makes the engine refuse
    // it with its own dry-run path, which reports the stage as not rehearsable.
    if (context.mode === 'dry-run') {
      await context.runEffect('command-stage', async () => null);
      throw new Error('a dry run must not launch a command block');
    }

    const spanish = isSpanish(context.locale);
    const { program, args } = expandedArguments(
      command,
      context.piece,
      testFiles(changeFiles(context)).filter((file) => existsSync(join(deps.root, file))),
    );
    const resolved = resolveExecutable(program, executableEnvironment());
    if (!resolved.ok) throw new Error(`could not start ${program}: ${resolved.reason}`);

    const group = DEFAULT_PROCESS_GROUPS.launch({
      command: resolved.command,
      args: [...resolved.prefixArgs, ...args],
      cwd: deps.root,
      stdin: '',
      ...(resolved.env === undefined ? {} : { env: resolved.env }),
      timeoutMs,
      // The JSON contract of a command block stays at 1 MiB; a suite report read with the
      // Vitest reader can be much larger, so that reading is given the room it needs.
      stdoutBytes: readVitest ? TEST_STDOUT_BYTES : DEFAULT_STDOUT_BYTES,
    });

    // Cancellation must be honoured at once: the wait races the signal, and on abort the group
    // is terminated and confirmed right there.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolve) => {
      if (context.signal.aborted) {
        resolve('aborted');
        return;
      }
      onAbort = () => resolve('aborted');
      context.signal.addEventListener('abort', onAbort, { once: true });
    });

    const confirmEmpty = (): Promise<void> =>
      confirmEmptyGroup(group, DEFAULT_PROCESS_GROUPS, program);

    try {
      const raced = await Promise.race([
        group.wait().then((exit) => ({ exit })),
        aborted.then(() => 'aborted' as const),
      ]);

      let code: number;
      let output: string;
      if (raced === 'aborted') {
        await confirmEmpty();
        const exit = await group.wait();
        if (exit.kind === 'technical') throw new Error(exit.reason);
        code = exit.code;
        output = combinedOutput(exit.stdout, exit.stderr);
      } else {
        const exit = raced.exit;
        if (exit.kind === 'technical') throw new Error(exit.reason);
        code = exit.code;
        output = combinedOutput(exit.stdout, exit.stderr);
      }

      if (code !== 0) {
        const head = spanish
          ? `${quoted(command, spanish)} terminó con código ${code}.`
          : `${quoted(command, spanish)} exited with code ${code}.`;
        const tail = lastLines(output, 20);
        return { ok: false, reason: tail.length > 0 ? `${head}\n${tail}` : head };
      }

      if (readVitest) {
        const reason = vitestReason(output, code, spanish);
        if (reason !== undefined) return { ok: false, reason };
      }

      return { ok: true, evidence: { exitCode: code } };
    } finally {
      if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
      await confirmEmpty();
    }
  };
}

export const commandBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const command = typeof inputs['command'] === 'string' ? inputs['command'] : '';
    const timeoutMinutes =
      typeof inputs['timeoutMinutes'] === 'number' ? inputs['timeoutMinutes'] : 30;
    return createGate(command, timeoutMinutes, inputs['reader'], deps);
  },
};
