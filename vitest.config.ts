import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxForks: "100%",
    // Give timing-sensitive integration tests room on slower CI runners
    // (GitHub Actions ubuntu-latest is noticeably slower than dev machines).
    testTimeout: 20000,
    hookTimeout: 20000,
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
