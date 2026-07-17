# Review Request: `prelaunch-revisions` branch

You (Codex) are the independent second reviewer. This branch was implemented by another AI agent
(Claude) working through `docs/PRELAUNCH_REVISIONS.md` — a pre-launch hardening checklist derived
from an acquisition-oriented CTO review. Your job is adversarial verification before this merges
to `main` and the product launches to real churches: find what the implementer missed, broke, or
overstated. Do not rubber-stamp.

## Scope

- **Diff under review:** `git diff main...prelaunch-revisions` (19 commits, `22bfe48..0f22333`).
  Read `git log --oneline main..prelaunch-revisions` first for the commit map.
- **Context docs (read before judging):** `docs/PRELAUNCH_REVISIONS.md` (what each change was
  supposed to do, and the completion claims to verify), `DECISIONS.md` entries dated 2026-07-16
  (deliberate tradeoffs — see "Do not flag" below), `docs/DEPLOYMENT.md` (heavily edited; check
  it against the code, not just for prose quality).
- **Out of scope:** pre-existing code not touched by the diff, except where a change interacts
  with it incorrectly; product features deferred in the checklist (R5–R7 items are post-launch).

## How to verify (all must pass before you trust any claim)

```sh
npm ci
docker compose up -d          # Postgres 17 for integration tests
DATABASE_URL="postgresql://sermon_clipper:sermon_clipper@localhost:5432/sermon_clipper?schema=public" npx prisma migrate deploy
npm run verify                # prisma validate/generate, lint, typecheck, unit tests, build
npm run test:integration     # 48 tests, real Postgres
npm run worker:build          # tsc --noEmit + esbuild bundle
docker build -f Dockerfile.worker -t review-worker .   # if Docker daemon available (slow: whisper compile)
```

The implementer claims all of these pass. If any fails on your machine, that alone is a finding.

## Priority review axes (highest risk first)

1. **Money paths** — `src/lib/usage-ledger.ts` (`revokeMinutesForRefundedInvoice`),
   `src/lib/billing/stripe.ts` (new `invoice.payment_failed` and `charge.refunded` handlers).
   Attack the refund clawback: can any interleaving make a balance negative? Can two *different*
   Stripe events for the same invoice double-claw despite the marker-note idempotency? Is
   matching on `note: { contains: marker }` collision-safe? Does the `FOR UPDATE` row lock
   actually serialize against `applyLedgerMutation`'s conditional UPDATE (different lock
   acquisition paths)? Is `charge.invoice` extraction correct for current Stripe API shapes?

2. **Retention reaper** — `src/lib/retention.ts`, `src/lib/jobs/handlers/cleanup.ts`, the wiring
   in `src/worker/run-jobs.ts` and the guard in `src/lib/jobs/runner.ts`. The one unforgivable
   bug class here is deleting media that should live: hunt for any path where a non-expired
   project's source video, audio, thumbnail, SRT override, or un-expired export can be removed.
   Check the shared-source-video guard (`shouldPurgeSourceMedia`) against edge cases: project
   with `sourceVideoId = null`, source video referenced by zero projects, expiry exactly at
   `now`. Check the orphan sweep can't race an export job that is *about to* set `outputFileId`.
   Confirm a failed CLEANUP job can no longer mark a healthy project FAILED or release
   reservations (runner guard), and that stale-job recovery of a CLEANUP job is harmless.

3. **Rate limits** — `src/lib/rate-limit.ts` and the two wired routes. Try to bypass: does the
   idempotent-re-request exemption in `src/app/api/clips/[id]/exports/route.ts` reopen the
   unlimited-render loophole (e.g. can a client mint unlimited *new* idempotency keys some other
   way — edit-version bumps, unicode filename variants)? Is the presign limiter countable-evadable
   (does every mint reliably write the `upload_presigned` event it counts, including when the
   event write fails — `recordOperationalEventSafely` swallows errors)? Confirm 429 responses
   don't leak information across workspaces.

4. **Worker image & deploy config** — `Dockerfile.worker`, `railway.json`,
   `railway.worker.json`, `scripts/worker-entrypoint.sh`. Validate `railway.json` fields against
   Railway's actual schema (https://backboard.railway.app/railway.schema.json). Check the
   entrypoint shell for injection/quoting bugs and failure modes (empty `WHISPER_MODEL_PATH`,
   path with spaces, `curl` partial writes, `sha256sum` absent). Verify the runtime stage
   contains everything the bundled worker `require()`s at runtime (`--packages=external` means
   every node_modules import must exist in the `--omit=dev` layer — check for any devDependency
   import reachable from `src/worker/run-jobs.ts`, including `@sentry/node` and the Prisma
   client copy).

5. **Sentry gating** — `src/instrumentation.ts`, `src/lib/observability/error-reporting.ts`.
   Confirm the no-DSN path truly loads nothing and cannot throw, that `onRequestError` matches
   Next 16's actual signature (check `node_modules/next/dist/docs/.../instrumentation.md`), and
   that no PII/transcript content is attached to captured events.

6. **Spend telemetry** — `src/lib/analysis/usage.ts`, `claude-provider.ts` changes, the
   operations page. Check the pricing math (Haiku $1/$5, Sonnet $3/$15 per MTok; cache write
   1.25×, read 0.1×), the metadata JSON round-trip (`readUsageFromMetadata` against what Prisma
   actually returns for JSONB), and that a mutable `lastUsage` on a possibly-shared provider
   instance can't cross-contaminate concurrent ANALYZE jobs (check how `getAnalysisProvider`
   caches instances and whether the worker ever runs two analyses concurrently).

7. **Tests judge themselves** — for the new test files (`retention-cleanup`, `rate-limits`,
   Stripe additions, ledger races, `claude-provider`, `analysis-usage`, `retention`): do the
   assertions actually pin behavior, or would they pass against a broken implementation? Flag
   any test that shares global DB state in a way that will flake when integration files run in
   parallel (shared dev database, vitest default parallelism).

8. **Docs vs reality** — every operational claim in `docs/DEPLOYMENT.md`'s new sections
   (backup/restore SQL against the real schema, the deployment-wide spend SQL, env-var table,
   webhook event list, CI gate names matching `.github/workflows/ci.yml` job ids exactly —
   branch protection matches on check names).

## Do not flag (documented, deliberate — see DECISIONS.md 2026-07-16 entries)

- Count-then-insert rate limiting being race-*tolerant* rather than race-proof ("limit ± one").
- Partial refunds recording an event without clawing back minutes.
- The zero-delta REFUND ledger row used as an audit/idempotency marker.
- `typescript`/`playwright` copies in the worker image via *production* transitive edges.
- Spend rollup being per-workspace in the UI (global figure is operator SQL by design).
- Spent minutes not re-collected on refund (clawback floors at current balance).
- DB-polling queue architecture generally (pre-existing; labeled temporary elsewhere).

## Report format

Return findings ranked most-severe first. For each: **severity** (blocker / major / minor / nit),
**file:line**, one-sentence defect statement, a **concrete failure scenario** (inputs/state →
wrong outcome — no hypotheticals you can't trace through the code), and a suggested fix. Separate
section for **claims you verified as true** (so passing areas are explicit, not silent) and one
for **test-suite gaps** worth adding. If you find nothing at blocker/major level, say so plainly
— but only after actually running the verification commands above.
