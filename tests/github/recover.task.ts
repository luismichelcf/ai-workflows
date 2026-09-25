import { expect, it } from 'vitest';

import { createGhSandboxPort, recoverSandbox } from './sandbox.js';

// PLAN-13-R5 §2.2: the only way to release somebody else's lock. The orchestrator runs it on
// purpose (`pnpm test:github:recover`) after an abandoned run, with the owner's `gh` session.

const REPOSITORY = process.env['AI_WORKFLOWS_GITHUB_TEST_REPO'] ?? '';

it('reconciles and releases the lock of an abandoned run', async () => {
  expect(REPOSITORY, 'set AI_WORKFLOWS_GITHUB_TEST_REPO=<owner>/<repo>').toMatch(/^[\w.-]+\/[\w.-]+$/);
  const recovered = await recoverSandbox({ port: createGhSandboxPort(REPOSITORY) });
  expect(recovered.ok, recovered.problems.join('\n')).toBe(true);
  process.stdout.write(`${recovered.note ?? 'la corrida abandonada quedó conciliada y el candado se soltó'}\n`);
});
