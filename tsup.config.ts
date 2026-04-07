import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as const,
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
      stripInternal: true,
    },
  },
};

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    ...shared,
    clean: true,
  },
  {
    entry: { server: "src/server.ts" },
    ...shared,
  },
  {
    entry: { protocol: "src/protocol.ts" },
    ...shared,
  },
]);
