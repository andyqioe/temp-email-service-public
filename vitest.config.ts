import { defineConfig } from 'vitest/config';

const e2e = {
  // One deployed stage and real SES: run files one at a time.
  fileParallelism: false,
  sequence: { concurrent: false },
  testTimeout: 20 * 60_000,
  hookTimeout: 20 * 60_000,
  globalSetup: ['test/e2e/global-setup.ts'],
};

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], exclude: ['test/e2e/autopause.test.ts'], ...e2e } },
      // Pauses receiving for the whole stage, so it runs separately, after the rest.
      { test: { name: 'e2e-autopause', include: ['test/e2e/autopause.test.ts'], ...e2e } },
    ],
  },
});
