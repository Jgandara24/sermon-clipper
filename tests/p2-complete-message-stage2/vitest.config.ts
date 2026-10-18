import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/p2-complete-message/*.test.ts", "tests/p2-complete-message-stage2/*.test.ts"],
    fileParallelism: false,
  },
});
