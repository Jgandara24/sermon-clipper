# Production Deployment Runbook

This runbook is the repeatable Phase 8 deployment path for Sermon Clipper. It assumes one web
process and at least one separate worker process pointed at the same Postgres database and S3/R2
bucket.

## Required Services

- PostgreSQL 17-compatible database with a fresh database/schema for Sermon Clipper.
- S3-compatible object storage bucket. Cloudflare R2 works with `STORAGE_S3_REGION=auto` and the
  account-specific `STORAGE_S3_ENDPOINT`.
- A public HTTPS domain used by `NEXT_PUBLIC_APP_URL`.
- SendGrid and/or Twilio credentials if approval notifications must be delivered in production.
- `ffmpeg`/`ffprobe` available on worker hosts, with libass enabled for caption burn-in.
- `whisper-cli` plus a local ggml model on worker hosts if self-hosted ASR is required.

## Required Environment

Set these for both web and worker processes unless noted otherwise:

```sh
NODE_ENV=production
DATABASE_URL=postgresql://...
NEXT_PUBLIC_APP_URL=https://clips.example.org
MEDIA_URL_SECRET=<long-random-secret>
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<stable-32-byte-base64-key>

STORAGE_PROVIDER=s3
STORAGE_S3_BUCKET=sermon-clipper-production
STORAGE_S3_REGION=auto
STORAGE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_S3_ACCESS_KEY_ID=...
STORAGE_S3_SECRET_ACCESS_KEY=...
STORAGE_S3_FORCE_PATH_STYLE=true

WORKER_ID=worker-1
WORKER_POLL_INTERVAL_MS=2000
WORKER_HEARTBEAT_INTERVAL_MS=30000
WORKER_STALE_JOB_TIMEOUT_MS=900000
WORKER_RECOVERY_INTERVAL_MS=60000
```

Optional provider credentials:

```sh
SENDGRID_API_KEY=SG...
NOTIFICATIONS_FROM_EMAIL=clips@example.org
NOTIFICATIONS_FROM_NAME=Sermon Clipper
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_FROM=+15555550100
ANTHROPIC_API_KEY=sk-ant-...
WHISPER_MODEL_PATH=/models/ggml-base.en.bin
WHISPER_CPP_BINARY=whisper-cli
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

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

5. Start at least one worker process separately from the web process.

```sh
npm run worker:prod
```

6. Verify runtime readiness.

```sh
curl -fsS https://clips.example.org/api/health
```

The health endpoint returns HTTP 200 for `ok` or `degraded` and HTTP 503 for failed critical checks.
Production readiness fails if `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `MEDIA_URL_SECRET`, S3 storage
configuration, database connectivity, migrations, or storage configuration are broken. A missing
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is reported as degraded because single-instance deployments can
still run, but rolling or multi-instance deployments should set it.

## Storage Bucket

- Create a private bucket. Do not make objects public.
- Grant the runtime access key permission to read, write, list, and delete objects in that bucket.
- Use lifecycle rules for temporary objects under `tmp/` if the provider supports prefix-based
  expiry.
- Keep browser access routed through Sermon Clipper signed URLs. The app redirects signed media
  requests to presigned object URLs when S3/R2 is active.

## Worker Operations

- Run workers in the same region as object storage when possible.
- Give each process a stable `WORKER_ID`.
- Monitor `/app/settings/operations` for `worker`, `processing`, `transcription`, `analysis`, and
  `export` events.
- If a worker dies mid-job, another worker will recover stale `RUNNING` jobs after
  `WORKER_STALE_JOB_TIMEOUT_MS`.
- Workers need local disk space for temporary ffmpeg/whisper files.

## Smoke Test

After deploy:

1. Sign in with email OTP.
2. Upload a short sermon video.
3. Confirm `/app/settings/operations` shows upload and processing events.
4. Generate clips, apply a brand template, and request approval with a real email or SMS recipient.
5. Approve from the `/review/:token` link.
6. Export and download the MP4.
7. Confirm billing ledger entries and operational events are present.

## Rollback

- Stop new workers first so they do not claim jobs during rollback.
- Roll back the web process to the previous image/build.
- Do not roll back database migrations unless a migration-specific rollback has been written and
  tested. The app is designed around forward-only Prisma migrations.
- Restart workers after the web process is stable.

