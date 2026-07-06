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
  },
});
