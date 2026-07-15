import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Runs before every suite — clears env that must not leak into tests (e.g. a
    // developer's DEMO_OUTPUT_DIR set for live demos).
    setupFiles: ['./test/setup.ts'],
    // Several suites hit one shared dev Postgres, and the WF3 enrollment passes
    // scan ALL clients — so running test files in parallel lets one suite's
    // fixtures leak into another's global scan (and racing cleanups orphan rows).
    // Serialize files; the suites are small, so the cost is negligible.
    fileParallelism: false,
  },
});
