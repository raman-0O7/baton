import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The Postgres integration suites share one database; running their files
    // in parallel triggers serializable (40001) conflicts on account setup.
    // Run this package's test files sequentially for deterministic isolation.
    fileParallelism: false,
  },
});
