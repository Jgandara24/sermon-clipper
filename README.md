# Sermon Clipper

Standalone Phase 1-7 foundation for a church-focused long-video-to-short-clips product.

This repository is intentionally separate from Pulpit Engine. It does not import Pulpit Engine code, connect to Pulpit Engine databases, reuse Railway services, or require live provider credentials.

## Current Scope

Implemented:

- Next.js App Router, TypeScript, Tailwind
- Prisma schema and ordered migrations for the Phase 1-2 data model
- Local Postgres dev path via Docker Compose
- Email OTP auth with hashed one-time codes, DB-backed opaque session tokens, SendGrid delivery
  support, rate limiting, and auth operational events; a development-only login button remains
  available outside production for local fixtures
- Workspace role-permission enforcement for upload/import, clip editing, exports, approval
  requests, project cancellation, brand-template management, billing pages, and guarded navigation
- Short-lived HMAC-signed upload, source-video, thumbnail, and export download URLs; S3/R2 mode
  redirects signed media links to presigned object URLs, while legacy session media routes redirect
  to signed URLs
- Approval notifications can send reviewer links by SendGrid email and/or Twilio SMS, with
  notification attempts recorded for sent/skipped/failed delivery
- Review links expire, can be revoked when approved content changes, and write audit events for
  request, view, notification, revocation, and decision activity
- Onboarding, dashboard, project detail, settings, and billing routes
- Real video upload to the configured storage provider, FINALIZE + PROBE processing
  jobs (real ffprobe/ffmpeg metadata, thumbnail, and audio extraction), a DB-polling job queue
  and worker, live processing-status UI, and cancel (with usage-ledger release)
- Real transcription via a self-hosted whisper.cpp `TranscriptionProvider` (word-level timestamps,
  filler detection) when `WHISPER_MODEL_PATH` is configured; an SRT upload path that skips ASR
  entirely and re-runs the TRANSCRIBE stage; a read-only, searchable transcript viewer with
  Postgres full-text search indexing ready for later phases
- AI clip generation: real chunking/boundary-refinement/dedup over the transcript, scored by a
  real `ClaudeAnalysisProvider` (Haiku classification pass + Sonnet scoring/rationale pass) when
  `ANTHROPIC_API_KEY` is configured, or a real deterministic `HeuristicAnalysisProvider` (pacing,
  hook cues, emotional-language density, topic overlap — clearly labeled non-AI) by default;
  ranked clip list UI with score breakdowns and like/dislike
- Usage ledger reserve/settle/release primitives with an atomic, idempotent balance mutation
- Plan-aware usage enforcement: upload links carry signed plan byte limits, FINALIZE reserves
  estimated processing minutes from real ffprobe duration before transcription/analysis can run,
  insufficient balances stop the pipeline with a billing error, and project failures/cancels
  refund reserved processing minutes
- Production observability foundation: workspace-scoped operational events record uploads, billing
  ledger mutations, processing/transcription/analysis/export outcomes, approval notification
  delivery, and stale-worker recovery, with an owner/admin Operations page at
  `/app/settings/operations`
- Editor MVP (`/app/clips/:id/editor`): transcript-based script editor (click-to-delete words,
  filler-word chips, extend before/after), 4 original caption presets with live style overrides,
  center/face/manual layout with a manual crop box, a DOM/CSS preview (real video playback,
  caption overlay, word-skip over deletions, safe-zone guide), and versioned autosave + explicit
  save with optimistic-concurrency conflict detection
- Real export rendering (`/app/clips/:id/editor` → Export, `/app/exports` history): a real
  multi-pass FFmpeg pipeline (frame-accurate sub-range extraction + concat for word-deletes, crop
  resolved from layout mode, scale-to-fill 1080×1920, `.ass` caption burn-in via libass matching
  the editor's presets/overrides, `loudnorm` audio, x264/AAC encode); a separate `export_jobs`
  queue (own DB table, same worker process) with automatic retry-twice-then-fail and a
  reuses-the-same-job "try again"; session-authenticated download links with a 7-day expiry and
  re-sign action
- Phase 7 church-intelligence backbone: sermon candidate filtering that avoids obvious
  worship/announcement/offering windows where possible, scripture reference detection and
  normalization (`scripture_references`), sermon-specific scoring categories
  (`biblical_usefulness`, `theological_clarity`, `pastoral_tone`, `scripture_relevance`), and
  scripture badges surfaced in clip review
- Brand templates (`/app/templates`) for church identity, caption defaults, colors, and lower-third
  text; templates can be applied in the editor, previewed as lower-thirds, stored in editor state,
  and burned into exports via ASS overlay events
- Approval workflow: clip cards can send a clip for review, creating a phone-friendly
  `/review/:token` link where an approver can approve or request changes without entering the full
  editor; export is blocked until the clip is approved
- Seeded demo workspace, source video, project, stub job, usage ledger, and sample clip
- Unit tests for workspace scoping, draft project creation, ffprobe parsing, ledger math, the
  whisper.cpp output parser, SRT parsing, filler detection, transcript chunking/dedup, the
  heuristic clip scorer, editor state/word helpers, caption-line derivation, export crop
  resolution, kept-range/timeline mapping, ASS subtitle generation, and the export filename
  builder; a separate real-database integration suite for the ledger (`npm run test:integration`)
- CI workflow for lint, typecheck, tests, Prisma validation, and build

Stubbed by design:

- URL import (yt-dlp fetch adapter not wired up yet — pasting a link creates a draft record only)
- Real transcription when no local whisper.cpp model is configured (fails clearly with
  `TRANSCRIBE_PROVIDER_UNAVAILABLE` rather than faking a transcript — see DECISIONS.md)
- Real AI-scored clip analysis when no `ANTHROPIC_API_KEY` is configured (falls back to the
  heuristic scorer rather than faking an LLM verdict — see DECISIONS.md)
- Face-tracking layout mode (falls back to the same center crop as "center" mode — no per-frame
  face detection yet, per guide §14's own Phase 8 deferral)
- Per-word karaoke caption animation (all presets burn in at the line level — see DECISIONS.md)
- Stripe checkout/customer portal and publishing providers
- Google OAuth
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

`npm run worker` polls the database for queued processing jobs (FINALIZE, PROBE, ...) and export
jobs (a separate table/queue it polls in the same loop), running both with real ffmpeg/ffprobe.
Uploading a video also kicks off a few inline processing attempts right after project creation,
so a real upload usually finishes without the worker running — but the worker is the durable
path and is required for anything the inline kick doesn't finish, and it's required for exports.
The worker records heartbeats while a job is running, retries transient failures with delayed
`RETRYING` state, and periodically recovers stale running jobs if a worker dies. Tune
`WORKER_POLL_INTERVAL_MS`, `WORKER_HEARTBEAT_INTERVAL_MS`, `WORKER_STALE_JOB_TIMEOUT_MS`,
`WORKER_RECOVERY_INTERVAL_MS`, and `WORKER_ID` in production.

Open [http://localhost:3000](http://localhost:3000). Use `demo@sermonclipper.local` on the dev login screen.

## Verification

```sh
npm run verify
```

This runs Prisma validation, ESLint, TypeScript, Vitest, and the production Next build. It does not require external provider credentials, a running Postgres, or a running worker.

A separate integration suite exercises the usage ledger against a real, migrated Postgres
database (reserve/settle/release, idempotency, the balance-never-negative invariant), worker
reliability (delayed retries, heartbeats, stale-job recovery), operational event persistence, and
the Phase 6/7 reviewed-brand-export workflow (approved clip + brand lower-third + word delete →
real 1080×1920 MP4 rendered by FFmpeg/libass). If `.data/models/ggml-tiny.en.bin` exists, it also proves
upload-video-only ASR by running a spoken sermon MP4 through whisper.cpp and generating ranked
scripture-aware clips without an SRT override. It's intentionally not part of `verify`/CI — run it
manually once Postgres is up:

```sh
npm run test:integration
```

A Playwright browser test covers the Phase 6/7 reviewed export path through the UI: a ranked
sermon clip with scripture is opened in the editor, a brand template is applied, export is blocked
until approval, the phone review link approves the clip, and the approved clip exports/downloads as
an MP4. Install the browser once with `npx playwright install chromium`, then run:

```sh
npm run test:e2e
```

## Production Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Phase 8 production runbook covering required
environment variables, database migrations, web and worker processes, S3/R2 storage, domain/secrets,
health checks, and smoke testing.

## Notes

- `.env.example` contains only local development placeholders.
- Stripe checkout/customer portal and publishing providers are intentionally absent — see
  DECISIONS.md for what's stubbed and why. Minute-balance enforcement is real: uploads are capped
  by workspace plan, and processing reserves estimated minutes after video duration is known. Video
  upload/probing (Phase 2), transcription (Phase 3), AI clip generation (Phase 4), the clip editor
  (Phase 5), and export rendering (Phase 6) are all real.
- The editor's video preview streams the original source file directly (with HTTP Range support)
  rather than a separate low-res proxy — no extra render step needed for a real, scrubbable
  preview. Crop/caption rendering in the browser is a DOM/CSS approximation; the FFmpeg export
  render is the actual source of truth, per guide §12, and uses the same pure crop/caption-line
  helpers as the preview so the two can't silently drift apart.
- Exports need the ffmpeg binary built with libass (`ffmpeg -filters | grep subtitles`) for
  caption burn-in; Homebrew's `ffmpeg` on macOS includes it by default.
- Transcription needs a local whisper.cpp setup: install the `whisper-cli` binary (e.g.
  `brew install whisper-cpp`) and download a ggml model (see whisper.cpp's
  `models/download-ggml-model.sh`, or fetch one directly from
  `https://huggingface.co/ggerganov/whisper.cpp`), then set `WHISPER_MODEL_PATH` to its path in
  `.env`. Without it, TRANSCRIBE jobs fail clearly with `TRANSCRIBE_PROVIDER_UNAVAILABLE` instead
  of faking a transcript. Uploading an SRT file always works regardless, since it skips ASR.
- Clip scoring needs a real `ANTHROPIC_API_KEY` in `.env` for AI-scored clips (`claude-haiku-4-5`
  classification + `claude-sonnet-5` scoring/rationale). Without it, ANALYZE jobs still succeed —
  they use the deterministic heuristic scorer instead, which is clearly labeled `heuristic-v1`
  in the UI and never presented as AI-scored.
- Storage supports `STORAGE_PROVIDER=local` for development and `STORAGE_PROVIDER=s3` for AWS S3,
  Cloudflare R2, or another S3-compatible object store. Browser-facing upload/media access goes
  through expiring signed URLs using `MEDIA_URL_SECRET`; when S3/R2 is active, signed media links
  redirect to presigned object URLs. Workers download objects to temp files for ffmpeg/whisper and
  upload derived thumbnails/audio/exports back to object storage.
- Email OTP uses SendGrid (`SENDGRID_API_KEY` plus `AUTH_EMAIL_FROM` or
  `NOTIFICATIONS_FROM_EMAIL`) in production. Local development logs the OTP and records skipped
  delivery when SendGrid is not configured.
- Approval notifications use SendGrid (`SENDGRID_API_KEY`, `NOTIFICATIONS_FROM_EMAIL`) and Twilio
  Messaging (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_FROM`) when configured.
  Local development records skipped notification attempts instead of pretending delivery happened.
- The reserved `POST /api/integrations/pulpit-engine/webhook` endpoint returns HTTP 501.
- `GET /api/health` is the production readiness endpoint. It checks required environment variables,
  database connectivity, Prisma migration state, and storage configuration.
