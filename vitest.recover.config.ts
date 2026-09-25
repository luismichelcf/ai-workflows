import { defineConfig } from 'vitest/config';

// PLAN-13-R5 §2.2: `pnpm test:github:recover` runs only the recovery of an abandoned run. It
// needs credentials and a logged-in `gh`, so it never runs in the public CI; it fails — never
// skips — without AI_WORKFLOWS_GITHUB_TEST_REPO.
export default defineConfig({
  test: {
    include: ['tests/github/recover.task.ts'],
    environment: 'node',
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
