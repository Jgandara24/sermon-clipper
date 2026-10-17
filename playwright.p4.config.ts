import { defineConfig, devices } from "@playwright/test";

if (process.env.P4_BROWSER_TEST !== "1" || !process.env.P4_BROWSER_ROOT) {
  throw new Error("P4 browser tests require an isolated database and P4_BROWSER_ROOT.");
}
export default defineConfig({
  testDir: "./tests/e2e", testMatch: ["p4-proxy-preview.spec.ts", "p4-upload-controls.spec.ts"], workers: 1,
  timeout: 120000, expect: { timeout: 20000 },
  outputDir: `${process.env.P4_BROWSER_ROOT}/browser-results`,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3219", trace: "off" },
  webServer: { command: "npx next dev --port 3219", url: "http://127.0.0.1:3219", reuseExistingServer: false,
    timeout: 180000, stdout: "pipe", stderr: "pipe" },
});
