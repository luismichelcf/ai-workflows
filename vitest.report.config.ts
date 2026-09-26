import { defineConfig } from 'vitest/config';

// PLAN-13-R5 §3.1: `pnpm test:github:report` runs the whole GitHub suite and writes its report. It
// needs credentials and a logged-in `gh`, so it never runs in the public CI; it fails — never
// skips — without AI_WORKFLOWS_GITHUB_TEST_REPO.
export default defineConfig({
  test: {
    include: ['tests/github/report.task.ts'],
    environment: 'node',
    testTimeout: 8 * 60 * 60_000,
    fileParallelism: false,
  },
});
