import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: {
    environment: "node", fileParallelism: false,
    include: [
      "tests/p2-complete-message/*.test.ts", "tests/p2-complete-message-stage2/*.test.ts",
      "tests/p2-complete-message-stage3/*.test.ts", "tests/chunking.test.ts",
      "tests/analysis-scoring.test.ts", "tests/reanalysis-policy.test.ts", "tests/transcription-fallback-hold.test.ts",
    ],
  },
});
