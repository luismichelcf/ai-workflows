import { defineConfig } from 'vitest/config';

// The tests that touch GitHub itself (PLAN-13-R2 §7, RC-09). They need credentials, so the
// public CI never runs them; `pnpm test:github` does, with AI_WORKFLOWS_GITHUB_TEST_REPO set.
// PLAN-13-R5 §2.2: one shared lock for the whole suite, taken once by the global setup, and the
// files run one after another because they share the test repository.
export default defineConfig({
  test: {
    include: ['tests/github/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    globalSetup: ['tests/github/global-setup.ts'],
    fileParallelism: false,
  },
});
