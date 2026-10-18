import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: { environment: "node", fileParallelism: false, include: [
    "tests/p2-prepared-requests/*.test.ts", "tests/p2-complete-message-stage2/work.test.ts",
    "tests/p2-adapter-readiness/*.test.ts",
  ] },
});
