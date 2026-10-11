import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Every persistence test opens real SQLite files under tests/.tmp; keep
    // files isolated per test file but run them serially to keep timings stable
    // on small machines (the deployment target is a Raspberry Pi).
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
