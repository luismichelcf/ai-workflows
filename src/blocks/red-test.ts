import type { Gate, GateResult } from '../contract.js';
import { isGreenRun, isRedEvidence, parseTestRun } from '../commands.js';
import type { BlockDefinition, EngineBlockDeps } from './definition.js';
import type { BlockManifest } from './manifest.js';
import {
  existingFiles,
  filesMatching,
  hashBlobs,
  hashFiles,
  refuseDryRun,
  runTests,
  type TestGroupResult,
} from './test-run.js';

// PLAN-13-R2 §3.4: `red-test@1` is a historical record. It runs the project's tests over the
// test files of the change and only passes when a test failed by its own assertion — never a
// suite that already passes, never one that broke by import or environment, never one that
// could not run. What it observed (the files, the failing tests and their assertions) is kept
// as evidence, sealed by the engine with the snapshot it judged. `valid-while: forever` is
// deliberate: with `same-sha` the red test would run again after the implementation and could
// no longer fail.

const MINUTES_MS = 60_000;

export const manifest: BlockManifest = {
  name: 'red-test',
  kind: 'module',
  natures: ['recompute', 'execution-record'],
  validWhile: ['forever'],
  inputs: {
    command: { type: 'command', required: true, requireTests: true },
    tests: { type: 'glob-list', default: ['**/*.test.ts', '**/*.test.tsx'] },
    'timeout-minutes': { type: 'integer', min: 1, max: 120, default: 30 },
  },
};

function isSpanish(locale: string): boolean {
  return locale.toLowerCase().startsWith('es');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** The files of the change, in the order the facts list them. */
function changeFiles(context: { readonly change: unknown }): string[] {
  const change = context.change;
  if (typeof change !== 'object' || change === null) return [];
  return asStringList((change as Record<string, unknown>)['files']);
}

function noTestsReason(spanish: boolean): string {
  return spanish
    ? 'La pieza no trae pruebas: sin una prueba que falle por su aserción no hay autorización para construir.'
    : 'This change brings no tests: without a test that fails by its assertion there is no authorization to build.';
}

function greenReason(spanish: boolean): string {
  return spanish
    ? 'La prueba pasó: no está roja.'
    : 'The test passed: it is not red.';
}

function brokenReason(spanish: boolean): string {
  return spanish
    ? 'La prueba falló por importación o entorno, no por su aserción.'
    : 'The test failed by import or environment, not by its assertion.';
}

/** Turns a run into evidence, or into the motive that keeps the piece from being authorized. */
async function readRedRun(
  root: string,
  tests: readonly string[],
  run: TestGroupResult,
  spanish: boolean,
): Promise<GateResult> {
  if (run.kind === 'technical') throw new Error(run.reason);

  const summary = parseTestRun({
    output: run.output,
    exitCode: run.code,
    ...(run.truncated ? { truncated: true } : {}),
  });

  if (isRedEvidence(summary)) {
    return {
      ok: true,
      evidence: {
        files: await hashFiles(root, tests),
        // The blob id git will give each test, so build-verify compares history by git's own
        // idea of the content (line-ending conversion included) and not by raw bytes.
        blobs: await hashBlobs(root, tests),
        failures: [...summary.failures],
        assertions: [...summary.assertions],
      },
    };
  }
  if (isGreenRun(summary)) return { ok: false, reason: greenReason(spanish) };
  return { ok: false, reason: brokenReason(spanish) };
}

function createGate(
  command: string,
  tests: readonly string[],
  timeoutMinutes: number,
  deps: EngineBlockDeps,
): Gate {
  const timeoutMs = timeoutMinutes * MINUTES_MS;

  return async (context): Promise<GateResult> => {
    await refuseDryRun(context, 'red-test');
    const spanish = isSpanish(context.locale);

    const files = existingFiles(deps.root, filesMatching(tests, changeFiles(context)));
    if (files.length === 0) return { ok: false, reason: noTestsReason(spanish) };

    const run = await runTests({
      command,
      root: deps.root,
      tests: files,
      timeoutMs,
      piece: context.piece,
      signal: context.signal,
    });
    return readRedRun(deps.root, files, run, spanish);
  };
}

export const redTestBlock: BlockDefinition = {
  manifest,
  create(inputs, deps) {
    const command = asString(inputs['command']) ?? '';
    const tests = asStringList(inputs['tests']);
    const timeoutMinutes =
      typeof inputs['timeoutMinutes'] === 'number' ? inputs['timeoutMinutes'] : 30;
    return createGate(command, tests, timeoutMinutes, deps);
  },
};
