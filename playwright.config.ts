import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Mobile specs describe touch gestures a desktop pointer cannot produce.
      testIgnore: /.*\.mobile\.spec\.ts/,
    },
    {
      // Chromium under the hood, so CI's existing `playwright install chromium` covers it.
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /.*\.mobile\.spec\.ts/,
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      STORAGE_LOCAL_ROOT: path.join(process.cwd(), ".data", "e2e-storage"),
      WHISPER_MODEL_PATH: "",
    },
  },
});
