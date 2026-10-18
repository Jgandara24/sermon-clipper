import { defineConfig } from "vitest/config";

// This config loads no application setup, environment files, or application aliases.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/p2-complete-message/*.test.ts"],
    fileParallelism: false,
  },
});
