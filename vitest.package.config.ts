import { defineConfig } from 'vitest/config';

// PLAN-13-R6 §9.4 test 8: what the published package holds, through a real `pnpm pack` of a copy
// of this repository. It compiles and packs, so it is slow and runs apart from `pnpm check`:
// `vitest run --config vitest.package.config.ts`.
export default defineConfig({
  test: {
    include: ['tests/package/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
});
