import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    // Serialize test files to avoid cross-file TCP port races on slower CI
    // runners. Each test file already uses a unique hardcoded port block, so
    // within-file tests run sequentially via beforeEach/afterEach cleanup;
    // maxWorkers: 1 just prevents two files binding overlapping ports at the
    // same instant during fork handoff. Local full run stays under ~45s.
    maxWorkers: 1,
    minWorkers: 1,
    // Give timing-sensitive integration tests room on slower CI runners
    // (GitHub Actions ubuntu-latest is noticeably slower than dev machines).
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "tests/**",
        "dist/**",
      ],
      // Stress tests are excluded from the default run, so they shouldn't
      // affect coverage counts either.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
});
