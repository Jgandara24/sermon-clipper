# Pre-Launch Revision Goal (R1–R4)

> **Goal prompt for an autonomous Claude loop.** Work this document top to bottom until every
> checkbox is either `[x]` (done, verified, committed) or `[~]` (blocked on a human/dashboard
> action, recorded in the "Human actions required" section at the bottom). This file is the
> single source of truth for progress — update it as you go and include it in each commit.

## Mission

Sermon Clipper (this repo) passed a CTO acquisition-readiness review. Phases 1–7 are built and
verified locally; Phase 8 (production launch) is gated on the revision requests below. Your job:
implement every pre-launch revision (R1–R4) so the only remaining launch work is human/dashboard
actions and the live evidence collection described in `docs/PHASE8_COMPLETION_AUDIT.md`.

## Operating rules

1. **One sub-item per iteration.** Pick the next unchecked item, implement it completely, verify
   it, commit it, tick it. Do not batch unrelated items into one commit.
2. **Verification gate.** `npm run verify` must pass before every commit. If the item touches
   DB-backed logic, also run `npm run test:integration` (requires `docker compose up -d`). If it
   touches the browser workflow, run `npm run test:e2e`.
3. **Honesty rule (inherited from the implementation guide).** Never fake a green path, never
   stub something and mark it done, never write launch evidence you didn't produce. If an item
   can't be completed from code alone, do the code/docs half, mark it `[~]`, and add the human
   action to the bottom section.
4. **Read before writing.** This is Next.js 16 with breaking changes — read the relevant guide in
   `node_modules/next/dist/docs/` before writing Next.js code. Match existing patterns: business
   logic in `src/lib/*`, thin route handlers, Zod validation, `requireApiWorkspace` +
   `assertWorkspaceScope` on every data route, operational events via
   `src/lib/observability/operational-events.ts`, decimal money, tests for business-critical logic.
5. **Record decisions.** Any non-obvious tradeoff gets a dated entry in `DECISIONS.md`
   (Decision / Why / Tradeoff / Status), matching the existing format.
6. **Commit discipline.** Conventional, descriptive one-line commit messages matching the repo's
   existing style (e.g. "Require worker heartbeat for launch readiness"). Commit locally only —
   **never push** unless the human explicitly asks.
7. **Do not deploy, create cloud resources, or spend money.** Railway/Sentry/Stripe/Anthropic
   dashboard work is human territory — document it precisely instead.
8. **Stop condition.** When every box is `[x]` or `[~]`, write a final summary section
   "## Loop result" at the bottom of this file (what shipped, what's blocked on humans, suggested
   next command), commit it, and stop the loop.

---

## R1 — Data protection & disaster recovery (launch blocker)

- [x] **R1.1 Backups & Restore runbook.** Add a "Backups & Restore" section to
  `docs/DEPLOYMENT.md`: Railway Postgres backup/PITR configuration steps, backup cadence,
  retention, explicit RPO/RTO targets, and a step-by-step restore drill (including how to verify a
  restore succeeded against the usage ledger). Add a matching launch-evidence expectation note if
  appropriate. The dashboard clicks themselves are human actions — document them exactly.
- [x] **R1.2 Object-storage durability.** Document S3/R2 bucket versioning (or replication) for
  `src/` and `exports/` prefixes in `docs/DEPLOYMENT.md`, plus lifecycle rules beyond the existing
  `tmp/` note. Include R2-specific and S3-specific instructions since both are supported.
- [ ] **R1.3 Retention reaper (CLEANUP job).** Implement a real handler for
  `ProcessingJobType.CLEANUP` wired into `src/lib/jobs/handlers/index.ts` and the worker loop:
  delete expired `ExportedFile` objects past `downloadExpiresAt` grace, purge expired projects per
  `Project.expiresAt`, and remove the corresponding storage objects via the `StorageProvider`
  interface (both local-disk and S3 paths). Must: be idempotent, emit operational events, respect
  workspace scoping, never delete non-expired data, and have unit + integration tests. Schedule it
  from the worker on an interval (follow the stale-recovery pattern in
  `src/lib/worker/reliability.ts`). Record the retention policy choice in `DECISIONS.md`.
- [ ] **R1.4 Incident-response page.** Add an "Incident Response" section to `docs/DEPLOYMENT.md`:
  severity levels, first-response steps for the top failure modes (DB down, worker stalled/stale
  jobs, Stripe webhooks failing, storage unreachable, provider outage → heuristic fallback), and
  where to look (`/api/health`, `/app/settings/operations`, worker logs).

## R2 — Deploy configuration completeness (launch blocker)

- [ ] **R2.1 Version the deploy files.** `railway.json`, `Dockerfile.worker`,
  `scripts/worker-entrypoint.sh`, `.dockerignore` are currently untracked. Commit them — but only
  after R2.2–R2.6 are applied so the first tracked version is the corrected one.
- [ ] **R2.2 Complete `railway.json`.** Worker service currently declares only builder +
  dockerfile. Add restart policy and healthcheck config supported by the Railway schema; document
  (in `docs/DEPLOYMENT.md`) the required persistent volume mounted at the `WHISPER_MODEL_PATH`
  directory (without it the ~142MB model re-downloads every deploy) and the full per-service env
  var list. Anything the schema can't express goes in the runbook as an explicit dashboard step.
- [ ] **R2.3 Slim the worker image.** `Dockerfile.worker` runs `npm ci` with full devDependencies
  (playwright, eslint, vitest, typescript ship to production). Restructure: full install → build
  steps → production layer with `npm ci --omit=dev`. Keep the ffmpeg `subtitles` filter check and
  pinned whisper.cpp build.
- [ ] **R2.4 Typecheck/compile the worker at build time.** The worker ships raw TS run by `tsx`
  with zero build-time type enforcement. Minimum: add `tsc --noEmit` to the Docker build.
  Preferred: compile/bundle the worker (tsc or esbuild) and run compiled JS via `node`, removing
  `tsx` from production dependencies in `package.json` (it can stay a devDependency for local
  `npm run worker`). Ensure Prisma client generation still works and `npm run verify` still passes.
  Record the approach in `DECISIONS.md`.
- [ ] **R2.5 Harden `scripts/worker-entrypoint.sh`.** Add SHA-256 checksum verification of the
  downloaded whisper model (known checksum for the default `ggml-base.en.bin`, overridable via
  `WHISPER_MODEL_SHA256` for custom `WHISPER_MODEL_URL`) and a bounded retry (e.g. 3 attempts,
  backoff) on download failure. Keep the atomic `.tmp` + `mv` pattern. Fail loudly on checksum
  mismatch.
- [ ] **R2.6 Fix `.env.example` secret hygiene.** `MEDIA_URL_SECRET` is left uncommented with a
  known placeholder value — a copy-paste deploy ships a guessable secret. Comment it out like the
  other secrets and note the ≥32-char production requirement.
- [ ] **R2.7 Worker resource sizing.** Document memory/CPU/scratch-disk requirements for the
  worker (whisper.cpp base.en + 3-pass ffmpeg renders, temp files in `os.tmpdir()`) in
  `docs/DEPLOYMENT.md`, with a recommended Railway instance size.

## R3 — Cost & abuse controls (launch blocker — margin protection)

- [ ] **R3.1 Rate limits / daily caps on expensive routes.** Add per-workspace limits on:
  `POST /api/clips/[id]/exports`, `POST /api/uploads/presign`, and analysis enqueueing. Close the
  unlimited-render loophole: the export idempotency key varies by filename
  (`export:{clipId}:v{version}:{filename}`), so renaming spawns unbounded ffmpeg jobs — cap
  concurrent/daily export jobs per workspace. Follow the existing OTP rate-limit pattern
  (DB-backed counting, no new infra). Enforce in `src/lib/*`, return the repo's standard apiError
  shape, emit operational events on rejection, and test both allow and reject paths.
- [ ] **R3.2 Provider spend telemetry.** Track Anthropic usage per ANALYZE job (tokens/estimated
  cost in job or operational-event metadata) and surface a per-workspace and global rollup in
  `/app/settings/operations`. Document the COGS model vs the ~3–4¢/min target and where to set
  Anthropic console spend alerts in `docs/DEPLOYMENT.md` (console config itself = human action).
- [ ] **R3.3 External error monitoring hooks.** Add Sentry (`@sentry/nextjs`) for web + worker,
  gated on `SENTRY_DSN` env (no-op when absent so local dev and CI are unaffected), wired into the
  worker's error paths and Next.js error handling. Update `.env.example` and `docs/DEPLOYMENT.md`
  (including an uptime-monitor recommendation pointed at `/api/health`). Account creation/DSN =
  human action.

## R4 — CI gaps on money paths (pre-launch)

- [ ] **R4.1 Branch protection documentation.** In-repo you cannot set GitHub branch protection —
  add a short "CI gates" note to `docs/DEPLOYMENT.md` listing the three required checks (`verify`,
  `integration`, `e2e`) and mark the GitHub settings click as a human action. If `gh api` can
  *read* current protection, check and report actual status.
- [ ] **R4.2 Stripe failure-path tests.** Add integration tests for `invoice.payment_failed`
  (dunning → plan state), `customer.subscription.deleted` (downgrade to free without destroying
  granted balance history), and refund handling. If a handler for any of these doesn't exist in
  `src/lib/billing/stripe.ts`, implement it (webhook events are already idempotent via
  `stripe_webhook_events`) — don't test-around a missing handler.
- [ ] **R4.3 Ledger concurrency test.** Add an integration test where two concurrent
  `reserveMinutesForJob` calls race one balance; assert exactly one wins when funds cover only one
  and the balance never goes negative (the in-UPDATE guard in `src/lib/usage-ledger.ts` is the
  mechanism under test).
- [ ] **R4.4 Claude provider unit tests + model config.** Move the hardcoded model IDs in
  `src/lib/analysis/claude-provider.ts` to env-overridable config
  (`ANALYSIS_MODEL_SCORING`, `ANALYSIS_MODEL_CLASSIFY`, defaults unchanged; update
  `.env.example`). Add unit tests with a mocked Anthropic SDK covering: both stages happy path,
  malformed/unparseable model output, candidate rejection in stage A, and the max-25 cap.

---

## Human actions required

> Append here as you work. Anything needing a dashboard, account, credential, or spend decision.

- **R1.1** Railway dashboard: enable scheduled daily volume backups on the Postgres service
  (≥7 daily snapshots retained), trigger one manual backup, and confirm it appears — see
  "Backups & Restore → Configure platform backups" in `docs/DEPLOYMENT.md`.
- **R1.1** Run the restore drill once before launch (restore latest backup into a scratch DB,
  run the verification queries, record the result) — see "Backups & Restore → Restore drill".
- **R1.2** Configure bucket durability: S3 → enable versioning + lifecycle rules; R2 → set up the
  daily `src/` replication job with a separate credential + lifecycle rules — see
  "Backups & Restore → Object storage durability" in `docs/DEPLOYMENT.md`.

## Loop result

> Written by the loop when it stops.
