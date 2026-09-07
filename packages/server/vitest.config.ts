import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one PostgreSQL database and one seeded branch, so
    // they run in a single file-thread rather than racing each other.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
