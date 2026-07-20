import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests hit a real Postgres instance and share fixture data — run test
    // files sequentially to avoid racing on the same connection pool / rows.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
