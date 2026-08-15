import path from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts on purpose: these tests need a live DATABASE_URL and are
// NOT part of `npm run verify` / CI, which stay database-free. Run with `npm run test:integration`
// against a real Postgres (e.g. after `docker compose up -d && npm run db:migrate`).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // One shared database, one shared job queue. `claimNextJob` takes the globally oldest
    // QUEUED/RETRYING row — it is not scoped to a project — so parallel test files steal each
    // other's jobs: the thief runs the job under its own fakes, and the owner then finds no
    // `processing_job_succeeded` event and no downloaded file. Production wants that global
    // claim, so serialize the files instead. Costs ~20s; buys a deterministic suite.
    fileParallelism: false,
  },
});
