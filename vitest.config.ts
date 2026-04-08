import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    maxForks: "100%",
  },
});
