# Sermon Clipper

Standalone Phase 1-2 foundation for a church-focused long-video-to-short-clips product.

This repository is intentionally separate from Pulpit Engine. It does not import Pulpit Engine code, connect to Pulpit Engine databases, reuse Railway services, or require live provider credentials.

## Current Scope

Implemented:

- Next.js App Router, TypeScript, Tailwind
- Prisma schema and ordered migrations for the Phase 1-2 data model
- Local Postgres dev path via Docker Compose
- Development-only cookie auth
- Onboarding, dashboard, project detail, settings, and billing routes
- Real video upload (presigned-style direct upload to local disk), FINALIZE + PROBE processing
  jobs (real ffprobe/ffmpeg metadata, thumbnail, and audio extraction), a DB-polling job queue
  and worker, live processing-status UI, and cancel (with usage-ledger release)
- Usage ledger reserve/settle/release primitives with an atomic, idempotent balance mutation
- Seeded demo workspace, source video, project, stub job, usage ledger, and sample clip
- Unit tests for workspace scoping, draft project creation, ffprobe parsing, and ledger math;
  a separate real-database integration suite for the ledger (`npm run test:integration`)
- CI workflow for lint, typecheck, tests, Prisma validation, and build

Stubbed by design:

- URL import (yt-dlp fetch adapter not wired up yet — pasting a link creates a draft record only)
- Provider calls for ASR, AI analysis, rendering, billing, and publishing
- Production OTP or Google OAuth
- Pulpit Engine bridge

## Local Setup

1. Install dependencies:

```sh
npm ci
```

2. Create a local env file:

```sh
cp .env.example .env
```

3. Start Postgres.

Preferred path:

```sh
docker compose up -d
```

If Docker is not available, run any local PostgreSQL 17-compatible service and set `DATABASE_URL` to a fresh database that belongs only to this product.

4. Apply migrations and seed:

```sh
npm run db:migrate
npm run db:seed
```

5. Start the app and the job worker (two terminals):

```sh
npm run dev
npm run worker
```

`npm run worker` polls the database for queued processing jobs (FINALIZE, PROBE) and runs them
with real ffmpeg/ffprobe. Uploading a video also kicks off a few inline processing attempts
right after project creation, so a real upload usually finishes without the worker running — but
the worker is the durable path and is required for anything the inline kick doesn't finish.

Open [http://localhost:3000](http://localhost:3000). Use `demo@sermonclipper.local` on the dev login screen.

## Verification

```sh
npm run verify
```

This runs Prisma validation, ESLint, TypeScript, Vitest, and the production Next build. It does not require external provider credentials, a running Postgres, or a running worker.

A separate integration suite exercises the usage ledger against a real, migrated Postgres
database (reserve/settle/release, idempotency, the balance-never-negative invariant). It's
intentionally not part of `verify`/CI — run it manually once Postgres is up:

```sh
npm run test:integration
```

## Notes

- `.env.example` contains only local development placeholders.
- Real ASR, AI analysis, rendering, billing, and publishing providers are intentionally absent —
  see DECISIONS.md for what's stubbed and why. Video upload and probing are real as of Phase 2.
- The local-disk storage provider under `STORAGE_LOCAL_ROOT` (default `.data/storage`) stands in
  for S3/R2 until a cloud bucket is wired up; swap the `StorageProvider` implementation, not its
  callers.
- The reserved `POST /api/integrations/pulpit-engine/webhook` endpoint returns HTTP 501.
