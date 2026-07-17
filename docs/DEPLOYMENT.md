# Production Deployment Runbook

This runbook is the repeatable Phase 8 deployment path for Sermon Clipper. It assumes one web
process and at least one separate worker process pointed at the same Postgres database and S3/R2
bucket.

## Required Services

- PostgreSQL 17-compatible database with a fresh database/schema for Sermon Clipper.
- S3-compatible object storage bucket. Cloudflare R2 works with `STORAGE_S3_REGION=auto` and the
  account-specific `STORAGE_S3_ENDPOINT`.
- A public HTTPS domain used by `NEXT_PUBLIC_APP_URL`.
- SendGrid credentials for email OTP sign-in.
- Stripe account with Starter and Pro recurring Prices plus a webhook endpoint for
  `/api/stripe/webhook`.
- SendGrid notification email or Twilio SMS credentials for production approval notifications.
- `ffmpeg`/`ffprobe` available on worker hosts, with libass enabled for caption burn-in.
- `whisper-cli` plus a local ggml model on every worker host for sermon transcription.
- Anthropic API access for Claude-backed sermon clip classification and scoring.

## Required Environment

Set these for both web and worker processes unless noted otherwise:

```sh
NODE_ENV=production
DATABASE_URL=postgresql://...
NEXT_PUBLIC_APP_URL=https://clips.example.org
MEDIA_URL_SECRET=<long-random-secret-at-least-32-characters>
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<stable-32-byte-base64-key>
SERMON_CLIPPER_COMMIT_SHA=<deployed-git-sha>

SENDGRID_API_KEY=SG...
AUTH_EMAIL_FROM=auth@example.org
AUTH_EMAIL_FROM_NAME=Sermon Clipper

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...

STORAGE_PROVIDER=s3
STORAGE_S3_BUCKET=sermon-clipper-production
STORAGE_S3_REGION=auto
STORAGE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_S3_FORCE_PATH_STYLE=true

WORKER_ID=worker-1
WORKER_POLL_INTERVAL_MS=2000
WORKER_PROCESS_HEARTBEAT_INTERVAL_MS=30000
WORKER_HEARTBEAT_MAX_AGE_MS=900000
WORKER_HEARTBEAT_INTERVAL_MS=30000
WORKER_STALE_JOB_TIMEOUT_MS=900000
WORKER_RECOVERY_INTERVAL_MS=60000

ANTHROPIC_API_KEY=sk-ant-...
WHISPER_MODEL_PATH=/models/ggml-base.en.bin
WHISPER_CPP_BINARY=whisper-cli
```

Optional provider credentials:

```sh
NOTIFICATIONS_FROM_EMAIL=clips@example.org
NOTIFICATIONS_FROM_NAME=Sermon Clipper
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_FROM=+15555550100
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

## Railway Service Configuration

The repo carries per-service config-as-code (Railway's schema has no multi-service file):

- **Web** — `railway.json`: Nixpacks build, `npm run start`, migrations applied once per release
  via `preDeployCommand: npm run db:migrate:deploy`, deploy-time healthcheck on `/api/health`
  (new deploys receive no traffic until it passes), restart on failure.
- **Worker** — `railway.worker.json`: builds `Dockerfile.worker` (ffmpeg + whisper.cpp),
  restart on failure. `requiredMountPath: /models` makes Railway refuse to deploy the worker
  until a persistent volume is mounted at `/models` — without it the whisper model would
  re-download on every deploy and the readiness gate would race the download.

Human actions in the Railway dashboard (once per environment):

1. Create two services from this repo. In each service's settings set **Config-as-code file
   path**: web → `railway.json`, worker → `railway.worker.json`.
2. Attach a persistent volume to the worker service mounted at `/models`; set
   `WHISPER_MODEL_PATH=/models/ggml-base.en.bin`. The image entrypoint downloads the model to the
   volume on first boot (3 attempts with backoff), verifies its SHA-256 against the pinned
   upstream checksum, and re-verifies the on-disk copy on every boot — a corrupted volume copy is
   deleted and re-downloaded. When overriding `WHISPER_MODEL_URL`, also set
   `WHISPER_MODEL_SHA256` so the custom model can be integrity-checked; without it the entrypoint
   warns and skips verification.
3. Set the environment variables below (Railway shared variables + per-service references keep
   them in one place). `SERMON_CLIPPER_COMMIT_SHA` can be omitted on Railway — `/api/health`
   falls back to the platform-provided `RAILWAY_GIT_COMMIT_SHA`.

Which service consumes which variables:

| Variables | Web | Worker |
| --- | --- | --- |
| `NODE_ENV`, `DATABASE_URL`, `STORAGE_PROVIDER` + `STORAGE_S3_*` | ✅ | ✅ |
| `WHISPER_MODEL_PATH`, `ANTHROPIC_API_KEY` | ✅ (readiness reporting) | ✅ (does the work) |
| `NEXT_PUBLIC_APP_URL`, `MEDIA_URL_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | ✅ | — |
| `SENDGRID_API_KEY`, `AUTH_EMAIL_*`, `NOTIFICATIONS_*`, `TWILIO_*` | ✅ | — |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | ✅ | — |
| `WORKER_ID`, `WORKER_*` tuning, `WORKER_CLEANUP_INTERVAL_MS`, `EXPORT_FILE_RETENTION_GRACE_MS` | — | ✅ |
| `WHISPER_CPP_BINARY`, `FFMPEG_PATH`, `FFPROBE_PATH` | — | defaulted in the image |
| `SENTRY_DSN` (optional but recommended) | ✅ | ✅ |

### Worker sizing

A worker processes **one job at a time** (throughput scales by adding worker services/replicas,
each with its own stable `WORKER_ID`). Size each worker instance for the heaviest single job:

- **CPU: 2 vCPU minimum, 4 recommended.** whisper.cpp transcription and the 3-pass ffmpeg export
  render are both CPU-bound and scale with cores; on shared/undersized CPU a 45-minute sermon's
  transcription can exceed the 15-minute stale-job timeout and get requeued mid-run.
- **Memory: 4 GB minimum.** The base.en model is ~148 MB on disk plus whisper compute buffers;
  ffmpeg 1080×1920 x264 encoding runs alongside Node. 2 GB instances will OOM on long sources.
- **Scratch disk: 15–20 GB.** Jobs download the full source video to `os.tmpdir()` (uploads are
  capped at 5 GB), plus the extracted 16 kHz WAV (~115 MB per source hour) and per-pass render
  intermediates. Temp files are cleaned per job, but budget for the largest source plus
  intermediates concurrently.
- **Volume: 1 GB** mounted at `/models` is ample for the default model.
- **Sunday load:** churches upload in a burst after services. Queue depth, not job speed, is the
  lever — add worker replicas ahead of Sunday/Monday if `processing` events show jobs waiting in
  QUEUED for more than a few minutes.

## Release Steps

1. Install dependencies.

```sh
npm ci
```

2. Build the web bundle and generate Prisma Client.

```sh
npm run build
```

3. Apply database migrations exactly once per release before starting new workers.

```sh
npm run db:migrate:deploy
```

4. Start the web process.

```sh
npm run start
```

5. Build and start at least one worker process separately from the web process. The worker ships
   as a compiled bundle: `worker:build` typechecks (`tsc --noEmit`) and bundles to
   `dist/worker/run-jobs.cjs`; `worker:prod` runs it with plain `node`. The Railway worker image
   does both at image build time.

```sh
npm run worker:build
npm run worker:prod
```

6. Verify runtime readiness.

```sh
curl -fsS https://clips.example.org/api/health
npm run smoke:production -- --base-url https://clips.example.org --commit-sha <deployed-git-sha>
```

The health endpoint returns HTTP 200 for `ok` or `degraded` and HTTP 503 for failed critical checks.
Production readiness fails if `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `MEDIA_URL_SECRET`, auth email
delivery config, approval notification config, Stripe billing config, S3 storage configuration,
provider-backed transcription/analysis config, database connectivity, migrations, or storage
configuration are broken. Production readiness also fails if no worker process has written a recent
database heartbeat to `worker_heartbeats`. Missing
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` or deployment commit metadata is reported as degraded because
single-instance deployments can still run, but rolling or multi-instance deployments should set the
encryption key and Phase 8 launch evidence should tie `/api/health` to the deployed commit. The
health endpoint reads commit metadata
from `SERMON_CLIPPER_COMMIT_SHA` first, then common provider variables such as
`VERCEL_GIT_COMMIT_SHA` or `RAILWAY_GIT_COMMIT_SHA`.

`npm run smoke:production` checks the deployed app's health payload, including the required
production readiness checks for auth email, approval notifications, Stripe, S3 storage,
transcription, analysis, database, migrations, and storage initialization. It also checks the login/OTP surface,
unauthenticated app redirect, invalid join-token handling, invalid review-token handling,
signed-media rejection, signed-upload rejection, storage-shim auth rejection, and Stripe webhook signature enforcement. When `--commit-sha` or
`SMOKE_COMMIT_SHA` is set, it also verifies that `/api/health` reports matching deployment commit
metadata. It exits non-zero on hard failures and reports degraded readiness as a warning. Final
Phase 8 launch evidence is stricter: automated health and smoke evidence must both be `ok`, not
degraded or warning.

## Stripe Billing

- Create recurring monthly Stripe Prices for the Starter and Pro plans.
- Set `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO` to those Price IDs.
- Production readiness requires `STRIPE_SECRET_KEY` to start with `sk_`, `STRIPE_WEBHOOK_SECRET`
  to start with `whsec_`, and both plan IDs to start with `price_`.
- Configure a Stripe webhook endpoint at `https://clips.example.org/api/stripe/webhook`.
- Subscribe the endpoint to `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed` (dunning visibility as warning billing events), and `charge.refunded`
  (a fully refunded charge claws back that invoice's granted minutes, floored at the current
  balance so it never goes negative; partial refunds only record an event).
- The app uses Checkout Sessions for subscription starts, the Stripe Customer Portal for
  self-service changes/cancellation, and signed webhooks to update workspace plan state and grant
  included minutes once an invoice is paid.

## Storage Bucket

- Create a private bucket. Do not make objects public.
- Grant the runtime access key permission to read, write, list, and delete objects in that bucket.
- Leave `STORAGE_S3_ENDPOINT` unset for AWS S3, or set it to an HTTPS S3-compatible endpoint for
  R2/MinIO-compatible production storage.
- Configure versioning/replication and lifecycle rules per "Backups & Restore → Object storage
  durability" — at minimum, prefix-based expiry for temporary objects under `tmp/`.
- Keep browser access routed through Sermon Clipper signed URLs. The app redirects signed media
  requests to presigned object URLs when S3/R2 is active.

## Backups & Restore

The Postgres database holds workspaces, minute balances, the usage ledger, Stripe billing state,
and approval audit trails. Losing it loses money-relevant data, so backups are a launch
requirement, not an optimization.

### Recovery targets

- **RPO (max acceptable data loss): 24 hours** via daily platform snapshots, plus a pre-release
  logical backup so a bad release never risks more than the current day.
- **RTO (max acceptable downtime to restore): 1 hour** from deciding to restore to a verified
  database serving traffic.
- Revisit both targets before onboarding paying churches; daily snapshots are the launch floor,
  not the end state.

### Configure platform backups (human action — Railway dashboard)

1. Open the Postgres service in the Railway project and attach/confirm its volume.
2. Enable scheduled volume backups: daily cadence, minimum 7 daily snapshots retained (plus
   monthly retention if available on the plan).
3. Trigger one manual backup immediately and confirm it appears in the backup list before
   collecting launch evidence.

### Logical backups (defense in depth)

Platform snapshots alone tie recovery to one vendor. Take a logical backup before every release,
and keep at least the last 4 in private object storage (separate bucket or `backups/` prefix,
never the public-facing media bucket):

```sh
pg_dump "$DATABASE_URL" --format=custom --no-owner --file "sermon-clipper-$(date +%Y%m%d-%H%M%S).dump"
```

Restore a logical backup into an empty database with:

```sh
pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" sermon-clipper-<timestamp>.dump
```

### Restore drill (run once before launch, then quarterly)

Do not trust an unexercised backup. The drill restores into a scratch database, never production:

1. Create a fresh empty Postgres database (locally via `docker compose up -d` or a temporary
   Railway instance).
2. Restore the most recent backup into it (`pg_restore` above, or the platform's
   restore-to-new-service flow for volume snapshots).
3. Verify the restore against money-relevant invariants:

```sh
psql "$RESTORE_DATABASE_URL" -c "SELECT count(*) FROM workspaces;"
psql "$RESTORE_DATABASE_URL" -c "SELECT count(*) FROM usage_ledger;"
psql "$RESTORE_DATABASE_URL" -c "SELECT id, minute_balance FROM workspaces ORDER BY created_at LIMIT 5;"
psql "$RESTORE_DATABASE_URL" -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"
```

   Row counts must be plausible for the backup time, no query may error, and the applied-migration
   count must match the deployed release.
4. Point a local app at the restored database (`DATABASE_URL=$RESTORE_DATABASE_URL npm run dev`)
   and confirm sign-in plus one workspace dashboard load.
5. Record the drill date, backup timestamp, and verification output alongside the launch evidence
   notes.

### Production restore procedure

1. Stop all workers first (same ordering as Rollback) so no jobs mutate state mid-restore.
2. Put the web process into maintenance (scale to zero or block at the platform level).
3. Restore the chosen snapshot/dump into a **new** database instance; never restore over the only
   copy of the damaged one.
4. Run the drill verification queries above against the restored instance.
5. Point `DATABASE_URL` for web and workers at the restored instance, redeploy, and confirm
   `/api/health` reports `ok` including `worker_heartbeat`.
6. Reconcile Stripe: replay any webhook events delivered after the backup timestamp from the
   Stripe dashboard (Developers → Webhooks → resend). `stripe_webhook_events` idempotency makes
   replays safe; `invoice.paid` re-grants are deduplicated by invoice ID.

### Object storage durability

The bucket's prefixes have very different recovery value. Protect them accordingly:

| Prefix | Contents | Recoverability |
| --- | --- | --- |
| `src/{workspaceId}/` | Original uploaded sermon videos | **Irreplaceable** — churches may keep no other copy; every clip, transcript, and export derives from these |
| `exports/{workspaceId}/` | Rendered MP4s | Re-derivable from `src/` + database edit state, but each re-render costs worker CPU |
| `audio/{workspaceId}/`, `thumbs/{workspaceId}/` | Extracted audio, thumbnails | Cheaply re-derivable from `src/` |
| `tmp/{workspaceId}/` | In-flight uploads | Disposable |

**AWS S3 (human action — AWS console/CLI):**

- Enable bucket versioning so accidental deletes/overwrites of `src/` objects are recoverable.
- Lifecycle rules: expire noncurrent versions after 30 days; abort incomplete multipart uploads
  after 7 days; expire `tmp/` objects after 7 days.

**Cloudflare R2 (human action — Cloudflare dashboard + a scheduled job):**

- R2 has no S3-style bucket versioning. Replicate the `src/` prefix instead: run a daily sync to
  a second bucket with any S3-compatible tool, for example:

  ```sh
  rclone sync r2-prod:sermon-clipper-production/src r2-backup:sermon-clipper-backup/src
  ```

- Use a **separate credential** for the replication job and do not give the replication bucket's
  credentials to the app runtime — the runtime key can delete objects (needed for cleanup), and
  the whole point of the replica is surviving a compromised or misbehaving runtime credential.
- R2 lifecycle rules: delete `tmp/` objects after 7 days; abort incomplete multipart uploads
  after 7 days.

Storage recovery targets: with daily `src/` replication (R2) or versioning (S3), storage RPO for
originals is ≤24 hours on R2 and effectively zero for delete/overwrite mistakes on S3. Losing
`exports/`, `audio/`, or `thumbs/` alone is a degraded-service event, not a data-loss event —
they can be regenerated. Confirm one restored/replicated `src/` object plays back before
collecting launch evidence.

## Worker Operations

- Run workers in the same region as object storage when possible.
- Give each process a stable `WORKER_ID`; production workers fail startup when it is missing so
  job heartbeats and stale recovery are auditable.
- Each worker writes an idle process heartbeat to the `worker_heartbeats` table. `/api/health` fails
  production readiness when the latest heartbeat is older than `WORKER_HEARTBEAT_MAX_AGE_MS`
  (defaults to `WORKER_STALE_JOB_TIMEOUT_MS`), so run at least one `worker:prod` process before
  final smoke or launch evidence collection.
- Production workers also fail startup when `ffmpeg`, `ffprobe`, `WHISPER_CPP_BINARY`, or the
  readable model file at `WHISPER_MODEL_PATH` are missing. Set `FFMPEG_PATH`,
  `FFPROBE_PATH`, or `WHISPER_CPP_BINARY` if those binaries are not on `PATH`.
- Install `whisper-cli` and mount the same model file path referenced by `WHISPER_MODEL_PATH` on
  every worker. The readiness gate proves the path is configured; the launch workflow must still
  prove a real sermon was transcribed by the deployed worker.
- Configure `ANTHROPIC_API_KEY` for production clip scoring. The heuristic scorer remains useful
  for local development, but Phase 8 launch readiness requires Claude-backed analysis evidence.
- Monitor `/app/settings/operations` for `worker`, `processing`, `transcription`, `analysis`, and
  `export` events.
- If a worker dies mid-job, another worker will recover stale `RUNNING` jobs after
  `WORKER_STALE_JOB_TIMEOUT_MS`.
- Workers run the retention reaper: every `WORKER_CLEANUP_INTERVAL_MS` (default hourly) they
  enqueue `CLEANUP` jobs that delete exported MP4s `EXPORT_FILE_RETENTION_GRACE_MS` (default 30
  days) after the download link expired and purge expired projects' source media from storage.
  Database records (projects, clips, transcripts, ledger, audit events) are kept. Watch for
  `retention_cleanup` events in `/app/settings/operations`.
- Workers need local disk space for temporary ffmpeg/whisper files.

## Smoke Test

After deploy:

1. Run `npm run smoke:production -- --base-url https://clips.example.org --commit-sha <deployed-git-sha>`.
   To write the health and smoke results into `docs/phase8-launch-evidence.json`, run
   `npm run collect:launch-evidence -- --base-url https://clips.example.org`. The collector uses
   the evidence file's `commitSha` unless `--commit-sha` is supplied. For the final launch gate,
   run `npm run launch:phase8 -- --base-url https://clips.example.org` after every manual evidence
   item has been filled.
   Use `npm run record:launch-evidence -- --list` to see valid item keys, then
   `npm run record:launch-evidence -- --item <key> --evidence "<proof>"` to fill manual evidence
   items without editing JSON by hand.
   To verify the evidence file before the final gate, run
   `npm run verify:launch-evidence -- --file docs/phase8-launch-evidence.json --base-url https://clips.example.org`.
2. Sign in with email OTP.
3. Create a workspace or invite a second user from `/app/settings` and accept the `/join/:token`
   link after signing in as the invited email.
4. Upload a short sermon video.
5. Confirm `/app/settings/operations` shows upload and processing events.
6. Confirm the worker completed transcription with whisper.cpp and clip scoring with Claude, then
   generate clips, apply a brand template, and request approval with a real email or SMS recipient.
7. Approve from the `/review/:token` link.
8. Export and download the MP4.
9. Start or update a paid plan through Stripe Checkout/Portal, then confirm the webhook updated the
   workspace plan, billing ledger entries, and operational events.

Use [PHASE8_COMPLETION_AUDIT.md](PHASE8_COMPLETION_AUDIT.md) as the launch evidence checklist
before declaring Phase 8 complete. The automated smoke test is necessary but not sufficient because
the final Phase 8 criterion requires an authenticated, provider-backed church workflow on the live
deployment.

## Provider Spend & COGS

- Every Claude-scored ANALYZE job records its token usage and a list-price USD estimate in the
  job's `analysis` success event metadata. `/app/settings/operations` shows the per-workspace
  30-day rollup ("AI analysis spend"). The Anthropic invoice is the source of truth; the in-app
  figure exists to make cost drift visible early.
- Deployment-wide (all workspaces) estimate, from psql:

  ```sql
  SELECT count(*) AS jobs,
         sum((metadata->'usage'->>'estimatedCostUsd')::numeric) AS est_usd,
         sum((metadata->'usage'->>'totalInputTokens')::bigint) AS input_tokens
  FROM operational_events
  WHERE category = 'analysis' AND event_type = 'processing_job_succeeded'
    AND metadata->'usage' IS NOT NULL
    AND created_at > now() - interval '30 days';
  ```

- **COGS model:** per source-minute of sermon, the paid components are Claude analysis (Haiku
  classification + Sonnet scoring over transcript excerpts — the dominant API cost), worker CPU
  (whisper.cpp transcription ≈ real-time on 2 vCPU, plus per-export renders), storage
  (~1GB/hour of source video), and egress. The competitive target is well under ~3–4¢ per
  source-minute all-in; compare the operations rollup (analysis $) plus Railway/R2 line items
  against minutes processed (`usage_ledger`) monthly.
- **Human action — spend alerts:** in the Anthropic Console, set a monthly spend limit and
  email alerts on the workspace/key used by `ANTHROPIC_API_KEY`, sized from the rollup above
  with headroom. Set the equivalent budget alerts in Railway and the storage provider.

## CI Gates

GitHub Actions (`.github/workflows/ci.yml`) runs three jobs on every push to `main` and every
pull request:

| Check | What it gates |
| --- | --- |
| `verify` | Prisma validate/generate, lint, typecheck, unit tests, production build (DB-free) |
| `integration` | Billing, usage-ledger, rate-limit, retention, and workflow tests against real Postgres 17 + ffmpeg |
| `e2e` | The Playwright Phase 6/7 church workflow in Chromium |

All three must be **required status checks** — the `integration` job is the only place billing
and ledger correctness are exercised in CI, so without branch protection a broken money path can
merge green. Human actions (GitHub settings, once):

1. Push this repository to GitHub (no remote is configured at the time of writing) and confirm
   all three jobs pass.
2. Settings → Branches → add a branch protection rule for `main`: require status checks to pass
   before merging, and select `verify`, `integration`, and `e2e` as required checks.
3. Verify from a terminal: `gh api repos/<owner>/<repo>/branches/main/protection --jq
   '.required_status_checks.contexts'` should list all three.

## Monitoring & Alerting

- **Error monitoring (Sentry, errors only):** set `SENTRY_DSN` on both web and worker. The web
  process reports server request errors through `src/instrumentation.ts`; the worker reports
  unexpected job/loop errors (expected failures stay in operational events). With `SENTRY_DSN`
  unset, monitoring is fully disabled — safe for local dev and CI. Human action: create a Sentry
  project, copy its DSN into both services, and configure alert rules (notify on any new issue).
  Optional: wire source-map upload later via `withSentryConfig` + `SENTRY_AUTH_TOKEN`; not
  required for readable server-side stack traces.
- **Uptime monitoring:** point an external pinger (UptimeRobot, Better Stack, or similar — human
  action) at `https://<domain>/api/health` with a 60s interval, alerting on non-200 or on the
  word `"fail"` in the body. `/api/health` already covers DB, storage, providers, migrations, and
  worker heartbeat, so one probe watches the whole system — including the worker, which has no
  HTTP surface of its own.

## Incident Response

Where to look, in order: `curl -fsS <url>/api/health` (readiness + per-check status + commit),
`/app/settings/operations` as owner/admin (upload/processing/transcription/analysis/export/
approval/billing/worker event feed with severities), Sentry (if configured), then platform logs
for the web and worker services.

### Severity levels

- **SEV1 — service down or money wrong.** Web unreachable, database down, Stripe webhooks
  failing (plans/minutes not updating after payment), or data loss suspected. Act immediately;
  all hands.
- **SEV2 — degraded core workflow.** Workers not claiming jobs, storage unreachable, provider
  outage (transcription/analysis failing), exports failing. Act within hours.
- **SEV3 — annoyance.** Single stuck job, one failed notification, slow processing. Next
  business day.

Single-operator deployment: "who gets paged" is the operator; an external uptime monitor pointed
at `/api/health` is the pager (see Smoke Test / monitoring notes). Record every SEV1/SEV2 in a
short postmortem note (what broke, impact window, fix, prevention) alongside the launch evidence
notes.

### First response by failure mode

**Database down / unreachable** (`/api/health` returns 503, `database` check failed)

1. Check the database service status in the platform dashboard and its logs.
2. Do not restart workers into a down database — they will fail their readiness gates anyway.
3. If the instance is lost, follow "Backups & Restore → Production restore procedure". Web and
   workers recover on their own once `DATABASE_URL` responds; verify with `/api/health` and one
   authenticated dashboard load.

**Worker stalled / jobs stuck** (`worker_heartbeat` check failed, or QUEUED jobs not progressing)

1. Check worker process status and logs on the platform (crash loops usually mean a failed
   startup readiness gate: missing ffmpeg/whisper binary, unreadable `WHISPER_MODEL_PATH`, or
   missing `WORKER_ID`).
2. A worker that died mid-job self-heals: another worker (or the restarted one) recovers stale
   `RUNNING` jobs after `WORKER_STALE_JOB_TIMEOUT_MS` (default 15 min) — watch for
   `stale_jobs_recovered` worker events in `/app/settings/operations`.
3. Terminal job failures release reserved minutes and mark the project failed; the affected
   church re-runs the upload once the cause is fixed. Exports have a retry endpoint from the UI.

**Stripe webhooks failing** (payments succeed but plans/minutes don't update)

1. Stripe Dashboard → Developers → Webhooks → check the endpoint's recent delivery attempts and
   error responses.
2. Common causes: rotated `STRIPE_WEBHOOK_SECRET` not updated in the environment, or the web
   process rejecting with 4xx (check web logs for signature errors).
3. After fixing config, resend the failed events from the Stripe dashboard — handlers are
   idempotent (`stripe_webhook_events` dedupe; `invoice.paid` grants dedupe by invoice), so
   resending is always safe.
4. Verify: workspace plan and minute balance in `/app/settings/billing`, `billing` events in
   operations.

**Storage unreachable** (uploads fail, media 5xx, `storage` health check failed)

1. Check the provider status page (R2/S3) and verify `STORAGE_S3_*` credentials haven't expired
   or been rotated without a deploy.
2. Processing/export jobs that hit storage errors retry automatically (3 attempts with backoff)
   and then fail terminally with minutes released — after restoring storage, affected projects
   re-run and failed exports retry from the UI.
3. Signed URL errors with healthy storage usually mean `MEDIA_URL_SECRET` changed — old links
   die on rotation by design; new links work immediately.

**Provider outage — Anthropic or transcription** (`analysis`/`transcription` events failing)

1. Check the provider status page and the exact error in operations event metadata.
2. Jobs retry with backoff, then fail terminally. Production does not silently fall back to the
   heuristic scorer — failures stay visible instead of shipping degraded clip ranking.
3. Nothing is lost: once the provider recovers, re-run processing for affected projects. Reserved
   minutes were released on terminal failure.

**Email/SMS not delivering** (OTP or approval notifications missing)

1. Check SendGrid activity feed / Twilio logs for bounces, suppressions, or auth failures.
2. Approval notification attempts are persisted — check `approval` events in operations for the
   recorded error.
3. OTP requests are rate-limited (3 per 15 minutes per email) — "no email" may just be the limit;
   the login surface says so explicitly.

## Rollback

- Stop new workers first so they do not claim jobs during rollback.
- Roll back the web process to the previous image/build.
- Do not roll back database migrations unless a migration-specific rollback has been written and
  tested. The app is designed around forward-only Prisma migrations.
- Restart workers after the web process is stable.
