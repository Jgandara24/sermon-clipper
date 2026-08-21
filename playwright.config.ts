import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import path from "node:path";

// CI builds the app in its own step and serves that build. Next's own testing guide recommends
// running end-to-end tests against production code, and a built server answers immediately
// instead of compiling the first route on demand — which is the step that has been timing out.
// Locally `next dev` stays the default, so nothing about the everyday loop changes.
const isCI = Boolean(process.env.CI);

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
    command: isCI ? "npm run start" : "npm run dev",
    url: "http://127.0.0.1:3000",
    // Never inherit a stray server in CI: the run must exercise the build this job just made.
    reuseExistingServer: !isCI,
    // A cold Turbopack start has to compile the first route before the URL answers, which a
    // shared CI runner does not always manage inside two minutes. Left where PR #49 set it; a
    // built server does not need it, and local `next dev` still does.
    timeout: 300_000,
    // Playwright discards the server's output by default, so a startup failure arrives as a bare
    // "timed out waiting from config.webServer" with nothing to read. This has now happened on
    // `main` as well as here, on commits that passed on their own branch minutes earlier, so the
    // next occurrence needs to say what the server was doing.
    stdout: "pipe",
    stderr: "pipe",
    env: {
      STORAGE_LOCAL_ROOT: path.join(process.cwd(), ".data", "e2e-storage"),
      WHISPER_MODEL_PATH: "",
      // A built server runs as production, where signed media URLs refuse to fall back to a
      // development secret. This one is generated per run and never leaves the process tree, so
      // the URLs it signs are worthless the moment the run ends.
      MEDIA_URL_SECRET: randomBytes(32).toString("hex"),
      // The SRT route drains pending jobs in-process, so ANALYZE runs inside this server. With no
      // provider key configured, production refuses the heuristic analyzer and the job retries
      // forever. `next dev` allows it, which is the only reason the suite passes today.
      ANALYSIS_ALLOW_HEURISTIC: "true",
    },
  },
});
