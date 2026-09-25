import { randomUUID } from 'node:crypto';

import type { GlobalSetupContext } from 'vitest/node';

import { createGhSandboxPort, createSandbox, type Sandbox } from './sandbox.js';

// PLAN-13-R5 §2.2: the whole GitHub suite shares one run. This setup takes the lock once, before
// any file, and hands the run identifier to the files with `provide`; the teardown restores,
// verifies and releases the lock. If the cleanup is not clean it fails and leaves the lock in
// place, so the orchestrator has to reconcile it with `pnpm test:github:recover`.
//
// Without AI_WORKFLOWS_GITHUB_TEST_REPO there is nothing to lock: the files themselves fail with
// the clear "set the variable" assertion, so this setup stays out of the way.

declare module 'vitest' {
  interface ProvidedContext {
    sandboxRun: string;
    sandboxRepository: string;
  }
}

const REPOSITORY = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';

export default async function setup(context: GlobalSetupContext): Promise<() => Promise<void>> {
  if (REPOSITORY === '') return async () => {};
  const run = `r-${randomUUID().slice(0, 8)}`;
  const sandbox: Sandbox = createSandbox({ port: createGhSandboxPort(REPOSITORY), run });
  await sandbox.acquire();
  context.provide('sandboxRun', run);
  context.provide('sandboxRepository', REPOSITORY);
  return async () => {
    const result = await sandbox.restore();
    if (!result.ok) {
      throw new Error(`la limpieza de la suite no quedó limpia; el candado sigue puesto:\n${result.problems.join('\n')}`);
    }
  };
}
