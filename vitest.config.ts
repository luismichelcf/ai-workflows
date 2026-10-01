import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Many tests drive real git repositories and real processes; under a full parallel run on
    // Windows one can take several seconds, so the default 5 s limit flakes. The limit still
    // bounds a hang.
    testTimeout: 30_000,
    // tests/github/ needs credentials and runs only through `pnpm test:github`; tests/package/
    // compiles and packs the engine and runs through vitest.package.config.ts.
    exclude: ['tests/github/**', 'tests/package/**', 'node_modules/**'],
  },
});
