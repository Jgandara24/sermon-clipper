import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: { environment: "node", fileParallelism: false, include: [
    "tests/p2-complete-message-stage4/*.test.ts", "tests/edit-state-conflict.test.ts",
    "tests/export-edit-version.test.ts", "tests/export-continuous-range.test.ts",
    "tests/render-output-qc.test.ts", "tests/delivery-eligibility.test.ts",
    "tests/approval.test.ts", "tests/transcription-fallback-hold.test.ts",
    "tests/reanalysis-policy.test.ts", "tests/caption-timeline-parity.test.ts",
    "tests/p2-complete-message-stage3/handler.test.ts",
  ] },
});
