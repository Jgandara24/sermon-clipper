# Production Deployment Runbook

This runbook is the repeatable Phase 8 deployment path for Sermon Clipper. It assumes one web
process and at least one separate worker process pointed at the same Postgres database and S3/R2
bucket.

## Required Services

- PostgreSQL 17-compatible database with a fresh database/schema for Sermon Clipper.
- S3-compatible object storage bucket. Cloudflare R2 works with `STORAGE_S3_REGION=auto` and the
  account-specific `STORAGE_S3_ENDPOINT`.
- A public HTTPS domain used by `NEXT_PUBLIC_APP_URL`.
- Resend credentials for email OTP sign-in.
- Stripe account with one Paid recurring Price plus a webhook endpoint for
  `/api/stripe/webhook`.
- Resend notification email or Twilio SMS credentials for production approval notifications.
- `ffmpeg`/`ffprobe` available on worker hosts, with libass enabled for caption burn-in.
- An ElevenLabs API key for primary base Scribe v2 transcription.
- Optional `whisper-cli` plus a local ggml model for the local transcription fallback.
- API access for each provider in the active analysis routing policy.

## Required Environment

Set these for both web and worker processes unless noted otherwise:

```sh
NODE_ENV=production
DATABASE_URL=postgresql://...
NEXT_PUBLIC_APP_URL=https://clips.example.org
MEDIA_URL_SECRET=<long-random-secret-at-least-32-characters>
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<stable-32-byte-base64-key>
SERMON_CLIPPER_COMMIT_SHA=<deployed-git-sha>

RESEND_API_KEY=re_...
AUTH_EMAIL_FROM=auth@example.org
AUTH_EMAIL_FROM_NAME=Sermon Clipper

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PAID=price_...

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
# Set this when an active stage uses Google Gemini.
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
# Optional local fallback:
# WHISPER_MODEL_PATH=/models/ggml-base.en.bin
# WHISPER_CPP_BINARY=whisper-cli
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
YTDLP_PATH=yt-dlp
YOUTUBE_API_KEY=<youtube-data-api-v3-key>
```

URL import and channel auto-import (see [Auto-Import](#auto-import-youtube-channels)):

```sh
YTDLP_METADATA_TIMEOUT_MS=30000
YTDLP_DOWNLOAD_TIMEOUT_MS=1200000
CHANNEL_POLL_INTERVAL_MS=3600000
CHANNEL_IMPORT_DAILY_LIMIT=10
```

## Railway Service Configuration

The repo carries per-service config-as-code (Railway's schema has no multi-service file):

- **Web** — `railway.json`: Nixpacks build, `npm run start`, migrations applied once per release
  via `preDeployCommand: npm run db:migrate:deploy`, deploy-time healthcheck on `/api/health`
  (new deploys receive no traffic until it passes), restart on failure.
- **Worker** — `railway.worker.json`: builds `Dockerfile.worker` (ffmpeg + the optional
  whisper.cpp fallback) and restarts on failure. The current Railway template keeps
  `requiredMountPath: /models` so the local fallback stays ready and does not download its model
  on every deploy.

Human actions in the Railway dashboard (once per environment):

1. Create two services from this repo. In each service's settings set **Config-as-code file
   path**: web → `railway.json`, worker → `railway.worker.json`.
2. The current Railway template requires a persistent volume mounted at `/models` to keep the
   optional local fallback ready. Set `WHISPER_MODEL_PATH=/models/ggml-base.en.bin` if you want that
   fallback. The image entrypoint downloads the model to the
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
| `ELEVENLABS_API_KEY`, `WHISPER_MODEL_PATH`, `ANTHROPIC_API_KEY` | ✅ (web readiness reporting only) | ✅ (worker job-time enforcement) |
| `ANALYSIS_ALLOW_HEURISTIC` (emergency only) | — | ✅ |
| `NEXT_PUBLIC_APP_URL`, `MEDIA_URL_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | ✅ | — |
| `RESEND_API_KEY`, `AUTH_EMAIL_*`, `NOTIFICATIONS_*`, `TWILIO_*` | ✅ | — |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | ✅ | — |
| `WORKER_ID`, `WORKER_*` tuning, `WORKER_CLEANUP_INTERVAL_MS`, `EXPORT_FILE_RETENTION_GRACE_MS` | — | ✅ |
| `WHISPER_CPP_BINARY`, `FFMPEG_PATH`, `FFPROBE_PATH` | — | defaulted in the image |
| `SENTRY_DSN` (optional but recommended) | ✅ | ✅ |

### Worker sizing

A worker processes **one job at a time** (throughput scales by adding worker services/replicas,
each with its own stable `WORKER_ID`). Size each worker instance for the heaviest single job:

- **CPU: 2 vCPU minimum, 4 recommended.** Scribe transcription is remote, but ffmpeg extraction
  and export remain CPU-bound. The optional whisper.cpp fallback also scales with worker cores.
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

- Create one recurring monthly Stripe Price for Paid.
- Set `STRIPE_PRICE_PAID` to that Price ID.
- Production readiness requires `STRIPE_SECRET_KEY` to start with `sk_`, `STRIPE_WEBHOOK_SECRET`
  to start with `whsec_`, and the Paid Price ID to start with `price_`.
- Configure a Stripe webhook endpoint at `https://clips.example.org/api/stripe/webhook`.
- Subscribe the endpoint to `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed` (dunning visibility as warning billing events), and `charge.refunded`.
- The app uses Checkout Sessions for subscription starts, the Stripe Customer Portal for
  self-service changes/cancellation, and signed webhooks to update workspace access.

## Analysis Routing

The active policy selects one provider and model for Stage A and one for Stage B. The command makes
one audited version active. It refuses a model without a current price or provider key. It also
refuses a heuristic or OpenAI stage: production heuristic analysis stays behind the visible
`ANALYSIS_ALLOW_HEURISTIC` incident override, and no OpenAI adapter is installed yet. Heuristic
stages remain usable in draft policies for shadow evaluation only.

```sh
npm run set:analysis-routing -- \
  --create-draft \
  --name "Gemini A and Claude B" \
  --stage-a-provider google \
  --stage-a-model gemini-3.1-flash-lite \
  --stage-b-provider anthropic \
  --stage-b-model claude-sonnet-5
```

Run a paid shadow evaluation before promotion. This command does not change customer clips.

```sh
npm run evaluate:analysis-routing -- --project-id <uuid> --policy-version <integer>
```

Store only the output counts, timestamps, usage, and human review. Do not store transcript text in
an evaluation report. Promote the tested version only after a human accepts the result.

```sh
npm run set:analysis-routing -- --activate-version <integer>
```

`/api/health` includes an `analysis_routing` check in production: the active policy must have an
installed adapter, a configured provider key, and a currently effective price for each stage. It
catches a deploy whose keys do not match the active route, and a price window that lapses with no
successor row — both would otherwise fail every ANALYZE job at run time.

The check reports **degraded**, never failed, and this is deliberate. Railway health-checks
`/api/health` (`railway.json`), and that route answers 503 on a failing readiness status. A
failing severity here would take the whole web service down — login, existing clips, and the
billing page included — for a fault that only stops new ANALYZE jobs on the worker, which has no
health check at all. Because prices are effective-dated rows, an end-dated price with no
successor would arm that outage on a timestamp, with no deploy and nobody watching.

`npm run smoke:production` is where an undeployable routing policy hard-fails: it fails the run
when the check is not `ok`, and also when the check is absent, which means the deployment predates
it. Treat a degraded `analysis_routing` as release-blocking even though the service stays up.

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

The Postgres database holds workspaces, retained usage history, Stripe billing state,
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
- Set `ELEVENLABS_API_KEY` on production workers. Base Scribe v2 is then selected automatically.
  Keyterms are not sent unless a project's processing configuration explicitly supplies them.
- Production workers still require `ffmpeg` and `ffprobe`. `whisper-cli` and
  `WHISPER_MODEL_PATH` are required only when Scribe is not configured. Keep them available when
  the deployment needs a local privacy or outage fallback.
- Configure `ANTHROPIC_API_KEY` on the production worker for clip scoring. The web readiness check
  reports its own environment only; it cannot prove that the worker has a valid credential.
- Production ANALYZE jobs fail closed when the key is missing, rejected, or Claude fails. Local
  development and tests can use labeled `heuristic-v1` output automatically.
- `ANALYSIS_ALLOW_HEURISTIC` is the worker-owned incident override. Its safe default is unset or
  `false`. Set the exact string `true` only during a time-bounded Claude incident. Confirm a warning
  `analysis_heuristic_emergency_override` event and provenance `provider=heuristic`,
  `modelVersions=[heuristic-v1]`, `selectionReason=production_emergency_override`. Disable it by
  unsetting it or setting `false`, restart the worker, and verify the next ANALYZE job uses Claude.
  The web readiness check continues to fail without a valid `ANTHROPIC_API_KEY`; the override does
  not make a deployment launch-ready.
- Verify the policy before enablement and after rollback with
  `npm test -- --run tests/analysis-provider-selection.test.ts` and confirm the worker event in
  `/app/settings/operations`. Rollback is to unset `ANALYSIS_ALLOW_HEURISTIC`, restart the worker,
  and run one Claude-backed ANALYZE job.
- Monitor `/app/settings/operations` for `worker`, `processing`, `transcription`, `analysis`,
  `export`, and `channel_import` events.
- If a worker dies mid-job, another worker will recover stale `RUNNING` jobs after
  `WORKER_STALE_JOB_TIMEOUT_MS`.
- Workers run the retention reaper: every `WORKER_CLEANUP_INTERVAL_MS` (default hourly) they
  enqueue `CLEANUP` jobs that delete exported MP4s `EXPORT_FILE_RETENTION_GRACE_MS` (default 30
  days) after the download link expired and purge expired projects' source media from storage.
  Database records (projects, clips, transcripts, ledger, audit events) are kept. Watch for
  `retention_cleanup` events in `/app/settings/operations`.
- Workers need local disk space for temporary ffmpeg/whisper files.

## Auto-Import (YouTube Channels)

Workspaces can register a public YouTube channel at `/app/settings/imports` (gated on the
`MANAGE_OPERATIONS` permission). The worker polls every registered channel each
`CHANNEL_POLL_INTERVAL_MS` (default 60 minutes) and turns uploads published *after registration*
into draft projects through the same URL-import pipeline a manual paste uses — there is no bulk
backfill; old videos can still be pasted manually.

Environment:

- `YOUTUBE_API_KEY` — YouTube Data API v3 key, set on **both** web and worker: the web process
  resolves the channel at registration time, the worker polls uploads. Mint it in a Google Cloud
  project with only the YouTube Data API v3 enabled and restrict the key to that API. Without it,
  channel registration fails at the form and polls fail with a clear key error.
- `YTDLP_PATH` — worker; defaults to `yt-dlp` on `PATH` (installed by `Dockerfile.worker`).
  Production workers fail startup when the binary is missing, same as ffmpeg/ffprobe.
- `YTDLP_METADATA_TIMEOUT_MS` / `YTDLP_DOWNLOAD_TIMEOUT_MS` — worker; hard timeouts for the
  yt-dlp metadata probe (default 30s) and video download (default 20 min).
- `CHANNEL_POLL_INTERVAL_MS` — worker; polling cadence (default 60 min). Each poll costs 1
  YouTube quota unit per registered channel (`playlistItems.list` only, never `search.list`).
- `CHANNEL_IMPORT_DAILY_LIMIT` — worker; auto-imports a workspace may gain per rolling 24h
  (default 10). Over-cap uploads are recorded as `skipped_cap` and retried on a later poll —
  pacing, not rejection.

Runbook:

- **Register a channel:** `/app/settings/imports` → paste an `@handle`, a `UC...` channel id, or
  a youtube.com channel URL. Registration resolves the channel synchronously, so a bad handle or
  a missing/invalid `YOUTUBE_API_KEY` fails right at the form instead of creating a silently
  broken source.
- **Read poll failures:** each source's last poll error (`lastPollErrorAt`/
  `lastPollErrorMessage`) is shown on `/app/settings/imports`, and the worker records
  `channel_import` events (`channel_poll_ran`, `channel_import_created`,
  `channel_import_skipped_cap`, `channel_poll_failed`) in `/app/settings/operations`. Poll
  failures are warning severity and self-heal on the next cycle — investigate only when they
  persist across polls (revoked key, exhausted quota, deleted channel).
- **Cap deferrals:** `channel_import_skipped_cap` warnings mean the workspace hit
  `CHANNEL_IMPORT_DAILY_LIMIT`; deferred uploads import automatically once the rolling 24h
  window has room. Raise the limit if deferrals are routine for a legitimate workload.
- **Pause a channel:** disable it from `/app/settings/imports`; disabled sources are skipped by
  the poller until re-enabled.

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
6. Confirm the worker completed transcription with base Scribe v2 and clip scoring with Claude, then
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

- Every paid-provider and local-compute stage records a `processing_cost_fact`. The worker rebuilds
  recent UTC days in `daily_cost_rollups` each hour. `COST_ROLLUP_LOOKBACK_DAYS` defaults to 7, so
  late events and retries are reconciled. Each periodic worker block has its own failure boundary;
  a rollup failure records `worker_periodic_block_failed` and does not stop publication, cleanup,
  channel import, or queue work.
- `/app/settings/operations` reads the durable 30-day totals. It shows known cost, retries,
  failures, and unpriced facts by stage/provider/model. Unpriced facts are never treated as known
  zero. Provider invoices remain the source of truth.
- To rebuild and print one project report, run:

  ```sh
  npm run report:project-cost -- --project-id <uuid>
  ```

- Deployment-wide known totals, from psql:

  ```sql
  SELECT stage, provider, model,
         sum(total_cost_usd) AS known_usd,
         sum(event_count) AS facts,
         sum(unpriced_event_count) AS unpriced_facts
  FROM daily_cost_rollups
  WHERE day >= current_date - 29
  GROUP BY stage, provider, model
  ORDER BY stage, provider, model;
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
| `worker-image` | `Dockerfile.worker` builds on Linux — catches lockfile drift (macOS installs can drop platform-specific optional deps and break `npm ci` only in the image) and Dockerfile regressions |

All four must be **required status checks** — the `integration` job is the only place billing
and ledger correctness are exercised in CI, so without branch protection a broken money path can
merge green. Human actions (GitHub settings, once):

1. Push this repository to GitHub and confirm all four jobs pass. **Done** — pushed to
   `Jgandara24/sermon-clipper` (private) 2026-07-16 night; `verify`/`integration`/`worker-image`
   passed first try, `e2e` needed one fix (a hardcoded 10s assertion timeout too tight for a cold
   CI `next dev` compile on the first-ever hit to an API route — see git history on `main` the
   same night) — all four green as of run `29557146876`.
2. Enable branch protection requiring `verify`, `integration`, `e2e`, `worker-image`. **Done** —
   private-repo free-tier accounts can't use branch protection (classic *and* rulesets both
   403'd), so the repo was made **public** 2026-07-16 night rather than pay for GitHub Pro. The
   protection then applied successfully with all four required checks. The repository-visibility
   policy below supersedes the earlier open-ended instruction to revisit this choice later.
   Command used (kept here for re-applying after a visibility change or repository recreation):

   ```sh
   gh api repos/<owner>/<repo>/branches/main/protection --method PUT --input - <<'EOF'
   {
     "required_status_checks": {
       "strict": true,
       "contexts": ["verify", "integration", "e2e", "worker-image"]
     },
     "enforce_admins": true,
     "required_pull_request_reviews": null,
     "restrictions": null
   }
   EOF
   ```

   Verify: `gh api repos/<owner>/<repo>/branches/main/protection --jq
   '.required_status_checks.contexts'` should list all four.

### Repository visibility policy

This policy was verified and recorded on 2026-08-11. It does not change a GitHub setting at P0.

- Keep `Jgandara24/sermon-clipper` public through P0–P4.
- Make the repository private before the first P5 commit lands. P5 is the named trigger because
  it is the first phase that implements the proprietary Selector and Review Agent policies.
- Public history cannot be retracted. A later visibility change does not remove indexed copies,
  archives, or existing public forks. Therefore, do not commit protected material while the
  repository is public.
- Protected material includes the external private `CTO.md`; margin, revenue, scale, acquisition,
  and price-positioning material; and the private implementation plan's full P5 Selector policy
  and P6 Review Agent design. The P0.2 public plan copy replaces those sections with pointers to
  the private planning copy.
- The existing `$49` proxy comparison in `DECISIONS.md` is already public history. Do not amplify
  it with the private margin, scale, acquisition, or editorial-policy material.
- P0–P4 code, technical architecture, editorial invariants, provider unit costs, technical stage
  costs, cost gates, migrations, tests, and sandbox evidence can be committed normally.

State verified on 2026-08-11:

- Visibility: `PUBLIC` (`isPrivate=false`).
- Required checks: `verify`, `integration`, `e2e`, `worker-image`.
- Strict status checks: enabled.
- Administrator enforcement: enabled.
- Force pushes: blocked.
- Branch deletion: blocked.

Before P5:

1. Activate a paid GitHub plan that supports rules on private repositories.
2. Save the current protection response, then run
   `gh repo edit Jgandara24/sermon-clipper --visibility private`.
3. Reapply the protection payload above.
4. Verify visibility, all four required contexts, strict mode, administrator enforcement, blocked
   force pushes, and blocked deletion.
5. Open one pull request and prove that all four checks run and remain required before any P5
   policy commit lands.

GitHub Actions standard runners are free and unlimited for public repositories. The current paid
plan assumption for P5 is GitHub Pro at about $4 per month with 3,000 included Actions minutes.
Recheck GitHub features and pricing when the trigger fires. If private Actions minutes become a
constraint, reduce unnecessary draft-pull-request runs. Do not restore public visibility after
proprietary policy enters history.

References: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
and [GitHub pricing](https://github.com/pricing).

## Monitoring & Alerting

- **Error monitoring (Sentry, errors only):** set `SENTRY_DSN` on both web and worker. The web
  process reports server request errors through `src/instrumentation.ts`; the worker reports
  unexpected job/loop errors (expected failures stay in operational events). With `SENTRY_DSN`
  unset, monitoring is fully disabled — safe for local dev and CI. Human action: create a Sentry
  project, copy its DSN into both services, and configure alert rules (notify on any new issue).
  Optional: wire source-map upload later via `withSentryConfig` + `SENTRY_AUTH_TOKEN`; not
  required for readable server-side stack traces.
- **Operator alert emails:** set `OPERATIONS_ALERT_EMAIL` (both services) to email the operator
  whenever an error-severity operational event is recorded, throttled to one email per
  category:eventType per `ALERTS_THROTTLE_MS` (default 30 min). Handled API 5xx responses are
  also reported to Sentry via `apiError`, so "gracefully failed" routes are visible too.
- **Uptime monitoring:** point an external pinger (UptimeRobot, Better Stack, or similar — human
  action) at `https://<domain>/api/health` with a 60s interval, alerting on non-200 or on the
  word `"fail"` in the body. `/api/health` already covers DB, storage, providers, migrations, and
  worker heartbeat, so one probe watches the whole system — including the worker, which has no
  HTTP surface of its own.

## Incident Response

Where to look, in order: `curl -fsS <url>/api/health` (readiness + per-check status + commit),
`/app/settings/operations` as owner/admin (upload/processing/transcription/analysis/export/
approval/billing/worker/channel_import event feed with severities), Sentry (if configured), then
platform logs
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
   startup readiness gate: missing ffmpeg/ffprobe, missing transcription provider configuration,
   or missing `WORKER_ID`).
2. A worker that died mid-job self-heals: another worker (or the restarted one) recovers stale
   `RUNNING` jobs after `WORKER_STALE_JOB_TIMEOUT_MS` (default 15 min) — watch for
   `stale_jobs_recovered` worker events in `/app/settings/operations`.
3. Terminal job failures release reserved minutes and mark the project failed; the affected
   church re-runs the upload once the cause is fixed. Exports have a retry endpoint from the UI.

**Stripe webhooks failing** (payments succeed but Paid access does not update)

1. Stripe Dashboard → Developers → Webhooks → check the endpoint's recent delivery attempts and
   error responses.
2. Common causes: rotated `STRIPE_WEBHOOK_SECRET` not updated in the environment, or the web
   process rejecting with 4xx (check web logs for signature errors).
3. After fixing config, resend the failed events from the Stripe dashboard — handlers are
   idempotent through `stripe_webhook_events`, so resending is safe.
4. Verify workspace access in `/app/settings/billing` and `billing` events in
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

1. Check Resend activity feed / Twilio logs for bounces, suppressions, or auth failures.
2. Approval notification attempts are persisted — check `approval` events in operations for the
   recorded error.
3. OTP requests are rate-limited (3 per 15 minutes per email) — "no email" may just be the limit;
   the login surface says so explicitly.

## Automatic Publishing Kill Switch

`AUTOMATIC_PUBLISHING_ENABLED` is the global publication authority. Only the exact string `true`
permits automatic publication. Missing, `false`, malformed, uppercase, or padded values disable
publication before the publisher reads or claims a due row. The global switch takes precedence
over the Meta token, the workspace Page ID, and the workspace auto-post flag.

Keep the switch false through P1 and P2 sandbox preparation. Before one controlled sandbox
publication, pin one manual render, pass render QC, record the exact human `ACCEPT`, and verify all
other eligibility inputs. Set the switch to `true` only for that controlled publication. Set it to
`false` immediately after a failure or any identity mismatch.

The deployment readiness response reports whether the switch is enabled or disabled. Disabled is
a safe ready state. The worker records `automatic_publishing_disabled` once for each process-level
disabled period. Stale `IN_PROGRESS` post reconciliation continues while new publication is
disabled.

The switch cannot cancel a Meta request that is already in flight. Before a deploy or rollback,
inspect `IN_PROGRESS` scheduled posts. To disable safely, set the switch to `false` or remove it.
Do not roll back code that removes this guard unless the Meta token is removed first or every
workspace auto-post flag is disabled.

### Wave 1 database deployment

Wave 1 is expand-first. Use this order:

1. Set `AUTOMATIC_PUBLISHING_ENABLED=false` on web and worker services.
2. Run `npm run audit:schedule-collisions` and `npm run audit:legacy-exports` against production.
   Stop if the collision audit exits nonzero. Save both outputs as deployment evidence.
3. Drain workers. Inspect all `IN_PROGRESS` scheduled posts.
4. Deploy migrations `20260812122900_agentic_editor_wave_1_enums` and
   `20260812123000_agentic_editor_wave_1` in order. The split is required because PostgreSQL must
   commit the new `missed` enum value before the next migration uses it in an index predicate.
5. Deploy the compatible web and worker builds. Resume workers.
6. Keep `AUTOMATIC_PUBLISHING_ENABLED=false` through all of P1. A successful migration or smoke
   test does not authorize publication.

Do not hand-edit the generated transcript search vector. The Wave 1 migration deliberately omits
Prisma's invalid `transcripts_search_vector_idx` drop and generated-column default rewrite. Roll
application code back if necessary, but leave the additive schema in place. Remove an index only
through a new forward migration.

## Rollback

- Stop new workers first so they do not claim jobs during rollback.
- Roll back the web process to the previous image/build.
- Do not roll back database migrations unless a migration-specific rollback has been written and
  tested. The app is designed around forward-only Prisma migrations.
- Restart workers after the web process is stable.
