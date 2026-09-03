# Decisions

## 2026-07-06 - Phase 1 Uses Dev Cookie Auth

Decision: Phase 1 uses a clearly labeled development-only cookie session instead of wiring OTP or Google OAuth.

Why: The first goal is repository, schema, app shell, seeded workspace, and dashboard flow. Real auth would introduce provider setup and secrets before the foundation is proven.

Tradeoff: The UI can exercise login and workspace routing locally, but production auth remains unimplemented until a later phase.

Status: Superseded by the 2026-07-07 email OTP and DB session decision; dev cookie fallback remains
active outside production.

## 2026-07-07 - Phase 8 Auth Starts With Email OTP And DB Sessions

Decision: Phase 8 replaces the raw user-id session as the primary auth mechanism with a real email
OTP flow. `email_otp_challenges` stores hashed six-digit codes with expiry, consumed timestamps,
and attempt counts; `auth_sessions` stores hashed opaque session tokens with expiry/revocation.
`getCurrentUser()` now prefers the DB-backed session cookie and only falls back to the
development-only user-id cookie outside production. The login page requests and verifies email OTP
codes; dev login remains visible only in non-production environments for local fixtures.

Why: This moves the product from "any email can become a dev cookie" toward deployable auth while
keeping the existing local demo/test path intact. Storing only hashes for OTP codes and session
tokens avoids putting bearer secrets in the database. Server Actions handle validation and cookie
setting, matching the Next.js App Router auth guidance.

Tradeoff: Google OAuth is still absent. Email OTP now uses SendGrid when configured, rate-limits
repeated requests, records delivery status on the challenge, and emits auth operational events.
Local development still logs codes and records skipped delivery when SendGrid is not configured so
tests and fixtures do not pretend external email was sent.

Status: Active — email OTP authentication/session foundation and SendGrid delivery are real; Google
OAuth remains open.

## 2026-07-07 - Email OTP Delivery Is Provider-Backed And Rate-Limited

Decision: Email OTP requests are capped per email address inside a short rolling window, delivery
is attempted through SendGrid using `SENDGRID_API_KEY` plus `AUTH_EMAIL_FROM` or
`NOTIFICATIONS_FROM_EMAIL`, and each challenge records delivery status, provider, error, and sent
timestamp. Production readiness now fails when auth email delivery is not configured. Development
environments log the OTP code and mark delivery skipped instead of silently claiming an email was
sent.

Why: Phase 8 requires a real church user to sign in outside local development. A production OTP
flow that only prints codes to logs is not launch-ready, and an unbounded request endpoint invites
abuse. Recording delivery outcomes and auth operational events gives operators evidence when a
church cannot receive a sign-in code.

Tradeoff: OTP delivery is synchronous during the login Server Action and currently relies on
SendGrid only. A future hardening slice can move auth email into a durable notification queue, add
provider webhooks, or add Google OAuth as a second sign-in path.

Status: Active.

## 2026-07-07 - Workspace Roles Gate Phase 8 Mutation Boundaries

Decision: Phase 8 adds a central workspace permission matrix (`OWNER`, `ADMIN`, `EDITOR`,
`APPROVER`, `VIEWER`) and enforces it from the shared page/action/API auth helpers. Upload/import,
clip edits, SRT overrides, export enqueue/retry/re-sign, approval requests, project cancellation,
template management, billing, and guarded navigation now check explicit permissions instead of
treating every active workspace member as equivalent.

Why: Workspace scoping alone proves a user belongs to a church workspace, but it does not prove the
user should mutate billing, templates, exports, or approval state. A central matrix keeps the app
from drifting into per-route role logic and gives Phase 8 a production-safe authorization boundary
that can be audited and tested.

Tradeoff: Public review links remain token-authorized for now; the Phase 8 approval hardening
slice adds expiration, revocation, audit events, and notification delivery. Workspace member
invitation is now supported for new members, but role changes/removal for existing members remain a
future administration slice.

Status: Active — core role checks and member invitation are enforced; existing-member role changes
and removal remain open.

## 2026-07-07 - Workspace Invitations Enable Joining Existing Churches

Decision: Owners/admins can invite teammates by email from `/app/settings` into non-owner roles
(`ADMIN`, `EDITOR`, `APPROVER`, `VIEWER`). Invitations store a hashed token, target email, role,
expiry, delivery outcome, and status. `/join/:token` requires the invitee to sign in with the
invited email, preserves the join URL through OTP login, and creates or activates the workspace
membership on acceptance. Invitation delivery uses SendGrid when configured and logs skipped
development delivery honestly.

Why: Phase 8 completion requires a real church user to create or join a workspace. Existing
workspace membership records handled authorization but did not provide a production-safe path for a
new user to join an existing church workspace.

Tradeoff: Invitations can be accepted and audited, but existing-member role changes and removals
are still not exposed in the UI. Invite delivery is synchronous like the current OTP/approval
notification paths; a durable notification queue remains a future scaling improvement.

Status: Active.

## 2026-07-07 - Browser Media Access Uses Short-Lived Signed URLs

Decision: Upload URLs, source-video preview URLs, thumbnails, and export downloads now use
short-lived HMAC-signed URLs generated with `MEDIA_URL_SECRET`. The local-disk provider still backs
storage, but browser-facing access goes through `/api/media/signed` or a signed `/api/uploads/:id`
URL instead of stable raw storage/session routes. Existing session-authenticated media routes remain
as compatibility shims that authorize the user and redirect to a signed URL.

Why: Phase 8 requires uploads, source video access, thumbnails, exports, and downloads to use secure
short-lived URLs. This gives the app the same contract that a future S3/R2 presigner will expose
without blocking on bucket credentials, and it removes long-lived predictable media URLs from UI
and API responses.

Tradeoff: Export availability still uses the database `download_expires_at` window, while each
actual returned download URL has a much shorter cryptographic expiry. S3/R2 storage is available in
the next decision; local disk remains the default for development.

Status: Active — signed URL hardening is in place.

## 2026-07-07 - S3/R2 Storage Provider For Production Objects

Decision: `StorageProvider` now supports `STORAGE_PROVIDER=s3` using the AWS SDK S3 client and
multipart upload helper. The same provider works for AWS S3 and S3-compatible services such as
Cloudflare R2 via `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, and credentials. Worker and export
code no longer assumes storage keys are local filesystem paths: source media/audio are downloaded
to per-job temp directories for ffmpeg/whisper, and thumbnails, audio, SRT overrides, uploads, and
exports are written back through the provider. Signed media URLs redirect to S3/R2 presigned object
URLs when the provider supports them.

Why: Phase 8 requires production S3/R2-compatible storage, not just a local-disk stand-in. External
media tools still need local file paths, so the safest bridge is explicit temp-file materialization
at worker boundaries rather than leaking `absolutePath()` through business logic.

Tradeoff: Browser uploads still stream through the app's signed upload endpoint before landing in
S3/R2, rather than issuing browser-direct multipart S3 uploads. That is production-safe for moderate
traffic but not the final high-scale upload path. A future upload slice should add direct multipart
presigning/resume support.

Status: Active — object storage is supported; direct browser multipart uploads remain open.

## 2026-07-07 - Approval Notifications And Review Link Auditability

Decision: Clip approval requests now issue a fresh 14-day review token, clear any prior revocation,
and optionally notify a reviewer by SendGrid email and/or Twilio SMS. Notification attempts are
persisted as `approval_notifications` rows with `sent`, `failed`, or `skipped` status. Review links
store expiry, revocation, and last-viewed timestamps, and `clip_approval_audit_events` records
review requests, link views, notification outcomes, revocations, and final decisions. Editing an
approved clip revokes the prior review link and returns the approval state to draft.

Why: Phase 8 requires production-safe approval notifications plus review link expiration,
revocation, and auditability. Keeping delivery behind provider functions lets local development
record honest skipped attempts while production can send through real providers using environment
credentials.

Tradeoff: Notification sending is synchronous during the approval request API call. That is simple
and auditable, but high-volume production should move delivery to a durable background notification
queue with retry/backoff and provider webhooks.

Status: Active — provider-backed approval notifications and link auditability are in place;
background notification retry/webhook handling remains open.

## 2026-07-07 - DB Worker Heartbeats Recover Stale Jobs

Decision: Processing and export workers now stamp claimed jobs with `worker_id` and `heartbeat_at`
while work is running. Transient failures move to delayed `RETRYING`; the worker loop periodically
scans RUNNING processing/export jobs for stale heartbeats, clears dead worker claims, retries jobs
that still have attempts remaining, and marks exhausted jobs FAILED with explicit user-facing
timeout messages.

Why: Phase 8 needs failures to be observable and recoverable. A worker process can crash after
claiming a DB job but before writing a terminal state; without a heartbeat and stale recovery pass,
that job would remain RUNNING forever and the church would have no honest next step.

Tradeoff: This keeps the Postgres-polling queue instead of adding Redis/BullMQ now. Recovery is
coarse-grained and timeout-based (`WORKER_STALE_JOB_TIMEOUT_MS`, default 15 minutes), so a very slow
but healthy job must keep heartbeating. This is acceptable for MVP worker processes and still leaves
BullMQ/Redis as the future queue transport if volume demands it.

Status: Active.

## 2026-07-07 - Plan Limits Reserve Processing Minutes Before Analysis

Decision: Phase 8 adds an application-level plan catalog (`free`, `starter`, `pro`, `dev`) that
drives upload byte limits, video-duration limits, and included-minute display. Presigned upload URLs
now include the plan byte limit in the HMAC payload, so the upload endpoint enforces the same limit
the presign route approved. `FINALIZE` probes the real video duration, estimates processing minutes
with `ceil(duration_seconds / 60)`, reserves those minutes atomically against the workspace balance,
and stops with `INSUFFICIENT_MINUTES` or `PLAN_LIMIT_EXCEEDED` before downstream processing starts.
Project-level failure/cancel paths release processing reservations idempotently.

Why: Phase 8 requires churches to be billed or limited correctly according to their plan, with
overage prevention. The existing ledger primitives were correct but not connected to the pipeline:
checking only `minute_balance > 0` at upload time allowed a 90-minute sermon to enter processing
with one minute remaining. Reserving after ffprobe avoids charging invalid files while still gating
the expensive transcription/analysis stages.

Tradeoff: Stripe Checkout/customer portal and webhook-driven minute grants are now wired in a later
Phase 8 billing slice. Plan codes are still simple application-level strings rather than a fully
customized pricing catalog, and overages remain blocked rather than billed automatically.

Status: Active — usage limits and reservations are enforced; automatic overage billing remains
open.

## 2026-07-07 - Stripe Checkout Drives Paid Plan Billing

Decision: Phase 8 adds Stripe subscription billing with Checkout Sessions for paid plan starts,
Customer Portal sessions for self-service billing management, and signed webhook handling for
`checkout.session.completed`, subscription lifecycle events, and `invoice.paid`. Workspaces store
Stripe customer/subscription IDs, subscription status, price ID, and current period end. Paid
invoice events grant the plan's included minutes through an idempotent billing-period credit tied
to the Stripe invoice ID.

Why: The product already enforced plan limits and minute balances, but paid plan collection was
managed out-of-band. Phase 8 requires real churches to be billed or limited correctly according to
their plan. Stripe Checkout and Portal avoid custom payment UI, while signed webhooks make Stripe
the source of truth for subscription status and included-minute grants.

Tradeoff: This is subscription billing, not usage-based overage billing. If a church exhausts its
included minutes, the existing upload/processing gates still block overage instead of charging
extra automatically. Future billing work can add metered usage, invoice previews, and dunning UI.

Status: Active.

## 2026-07-07 - Operational Events Provide Production Observability

Decision: Phase 8 adds a workspace-scoped `operational_events` table plus
`recordOperationalEvent*` helpers. Upload presign/write/complete paths, processing and export job
success/failure/retry paths, stale-worker recovery, approval notification delivery, and usage-ledger
mutations now write durable events. Owners/admins can view the latest workspace events at
`/app/settings/operations`.

Why: Console logs are not enough for a real church workflow. Operators need a durable, queryable
feed that ties upload failures, billing-limit stops, transcription/analysis/export failures,
notification delivery, and worker recovery back to a workspace and relevant job/project/export IDs.
This table creates that cross-cutting incident trail without overloading domain records like
`usage_ledger` or `clip_approval_audit_events`.

Tradeoff: This is not a full external observability stack. There is no alert routing, tracing, log
shipping, or metrics dashboard yet; those can be added by forwarding `operational_events` or
emitting provider-specific telemetry later. For MVP production operation, the database-backed
event feed gives support staff a reliable first diagnostic surface.

Status: Active — durable workspace-level operational event feed is in place; external alerting and
metrics remain open.

## 2026-07-07 - Deployment Readiness Is Checked In App

Decision: Phase 8 adds `GET /api/health`, a deployment readiness helper, `worker:prod`, and
`docs/DEPLOYMENT.md`. The health endpoint verifies required environment variables, production S3
storage configuration, database connectivity, incomplete Prisma migrations, and storage-provider
construction. The deployment runbook documents required services, secrets, database migration order,
web and worker processes, storage bucket setup, smoke testing, and rollback guidance.

Why: Production readiness must be repeatable and externally verifiable. A runbook alone can drift;
a health endpoint gives the deployment platform and operators an executable check that the live
process has the critical configuration needed for the Phase 6/7 workflow.

Tradeoff: `/api/health` does not prove external providers such as SendGrid, Twilio, Anthropic, or
whisper.cpp will successfully complete a real job. Those are verified by the smoke test and
operational events after deployment. The endpoint intentionally avoids performing write operations
against storage or paid providers.

Status: Active.

## 2026-07-07 - Production Smoke Checks Are Executable

Decision: Phase 8 adds `npm run smoke:production`, an unauthenticated live-environment smoke
runner for deployed Sermon Clipper instances. It checks `/api/health`, the OTP login page, protected
app redirect behavior, invalid invite-token handling, signed-media rejection, and Stripe webhook
signature enforcement.

Why: The runbook previously described manual checks, but launch readiness should be repeatable by
operators and deployment platforms. These checks prove key production surfaces are reachable and
fail closed without requiring test user credentials or uploading church media.

Tradeoff: This is not a full authenticated workflow test. The manual smoke flow still verifies real
OTP delivery, workspace invite acceptance, upload/processing/export, approval notifications, and
Stripe Checkout/Portal behavior with live provider credentials. A future synthetic-user smoke test
can automate more once safe disposable accounts and media fixtures are available in production.

Status: Active.

## 2026-07-06 - No External Provider Calls In Foundation

Decision: Upload, URL import, transcription, AI analysis, rendering, storage, billing, and publishing are visible as stubs only.

Why: The goal explicitly forbids paid providers, Pulpit Engine infrastructure, and live credentials. The foundation must be runnable from a clean clone without external services beyond local Postgres.

Tradeoff: The dashboard is useful for project records and seeded data, but it does not process video yet.

Status: Superseded by later phases; specific provider and storage decisions below document the
current production behavior.

## 2026-07-06 - Postgres Is The Only Database Target

Decision: Prisma is configured for PostgreSQL only, with Docker Compose for the standard local path.

Why: The product spec requires a fresh Postgres instance and one canonical ordered migration path. Avoiding SQLite keeps the local schema close to the intended deployment target.

Tradeoff: Local setup requires Docker or a local Postgres service.

Status: Active.

## 2026-07-06 - Phase 2 Upload Is Real; URL Import Stays Stubbed

Decision: Direct file upload, FINALIZE (ffprobe metadata), and PROBE (thumbnail + audio extraction via ffmpeg) are real as of Phase 2. Pasting a URL still only records a draft with a WAITING job — the yt-dlp fetch adapter isn't implemented yet.

Why: ffmpeg/ffprobe are free, local, self-hosted binaries, not paid providers, so they don't violate the no-external-provider constraint (§1). yt-dlp is a separate, larger surface (extractor failures, geo-blocking, live-stream edge cases per guide §8) better sequenced as its own unit of work rather than rushed alongside the upload plumbing.

Tradeoff: The dashboard's "Or paste a link" form is honestly labeled as not-yet-functional. Churches can upload files today; link-based import is a follow-up within Phase 2 (or an early Phase 3 task) before the phase's URL-import surface is considered done.

Status: Superseded by the 2026-07-18 URL import decision — the yt-dlp fetch adapter is now real
and pasted URLs enqueue a working FINALIZE job.

## 2026-07-06 - Local-Disk StorageProvider Stands In For S3/R2

Decision: `src/lib/storage/` defines a `StorageProvider` interface with a `LocalDiskStorageProvider` implementation (root configurable via `STORAGE_LOCAL_ROOT`, default `.data/storage`, gitignored). The upload API returns a same-origin URL (`/api/uploads/:id`) as the "presigned" target instead of a real presigned S3/R2 URL, and does a single direct PUT rather than true chunked multipart.

Why: No cloud bucket is provisioned yet, and the spec forbids paid providers before the foundation is proven. Keeping the real interface (not a fake/no-op one) means swapping in an S3Provider later is a drop-in change for every caller (upload routes, FINALIZE/PROBE handlers, the `/api/storage/[...key]` read route).

Tradeoff: No true resumable/chunked upload yet (a dropped connection mid-upload must restart from zero), and the 5GB/3h caps in `src/lib/limits.ts` are enforced but not battle-tested against real multi-GB files. Revisit when a Marketplace storage integration (R2/S3/Supabase Storage) is wired up.

Status: Superseded for production by the 2026-07-07 S3/R2 provider decision; local disk remains
active for development.

## 2026-07-06 - DB-Polling Job Queue Instead Of BullMQ + Redis

Decision: `src/lib/jobs/queue.ts` implements the job queue as conditional-UPDATE claims against the existing `processing_jobs` Postgres table (QUEUED/RETRYING -> RUNNING only if still claimable), polled by `src/worker/run-jobs.ts` (`npm run worker`). No Redis/BullMQ dependency yet, though the guide's tech stack (§3) and job queue design (§18) call for Redis + BullMQ. Phase 8 hardening added worker IDs, heartbeats, delayed retry scheduling (`run_after`), max attempts, and stale-running-job recovery for both `processing_jobs` and `export_jobs`.

Why: Redis isn't provisioned locally and adds a second piece of local infrastructure (beyond Postgres) before it's earned its keep at MVP scale. Postgres already has the durable job state (`processing_jobs`); a conditional UPDATE is a well-understood, race-safe claim pattern that needs zero extra services. Per guide §26 ("prefer simple working implementations over premature generality") — the provider-interface carve-out in that same sentence names ASR/LLM/storage specifically, not the queue transport.

Tradeoff: Still no priority lanes, and polling (default every 2s, `WORKER_POLL_INTERVAL_MS`) adds latency BullMQ's pub/sub wake-up wouldn't have. The queue now has enough production safety for MVP operation: failed attempts move to `RETRYING` with backoff, active workers update `heartbeat_at`, and the worker periodically requeues or terminally fails stale jobs after `WORKER_STALE_JOB_TIMEOUT_MS`.

Status: Active — keep Postgres polling until queue volume, multi-region needs, or priority scheduling justify Redis/BullMQ.

## 2026-07-06 - No Ledger Reservation For FINALIZE/PROBE

Decision: The usage-ledger reserve/settle/release mechanism (`src/lib/usage-ledger.ts`) is fully built and tested (atomic balance update, idempotent by job id, `balance-never-negative` invariant verified against a real Postgres in `tests/integration/usage-ledger.integration.test.ts`), but FINALIZE and PROBE jobs don't actually reserve any minutes.

Why: The guide's own pipeline (§8 step 6) reserves minutes when the user confirms processing config for transcription — a Phase 3 concern — not at finalize/probe time, which the guide treats as free plumbing. Charging a made-up "intake fee" here would mean inventing pricing the spec doesn't define.

Tradeoff: `cancel` still calls `releaseReservationForJob` for every job on the project, which is a correct no-op today (nothing to release) and becomes load-bearing the moment Phase 3 reserves real transcription minutes.

Status: Superseded by the 2026-07-07 plan-limit reservation decision. FINALIZE now reserves
estimated processing minutes after ffprobe confirms the uploaded video duration.

## 2026-07-06 - Real-Database Tests Live Outside `verify`/CI

Decision: `vitest.config.ts` excludes `tests/integration/**`; those tests run separately via `npm run test:integration` against a real, migrated Postgres. `npm run verify` stays exactly as DB-free as it was before Phase 2.

Why: `verify`'s existing contract ("does not require external provider credentials") implicitly meant no live services at all, including Postgres — `prisma validate` only checks schema syntax. Introducing DB-backed tests into that path would silently break local verify for anyone without Postgres already running.

Tradeoff: Superseded for CI by the 2026-07-07 CI hardening decision. Local `verify` remains
database-free, while CI now provisions Postgres for integration and e2e jobs.

Status: Superseded for CI; active for local command separation.

## 2026-07-07 - CI Runs Production-Critical Integration And Browser Workflows

Decision: CI now keeps `npm run verify` as a DB-free job, but adds separate Postgres-backed
`integration` and `e2e` jobs. The integration job applies Prisma migrations and runs
`npm run test:integration`; the e2e job applies migrations, installs Chromium and ffmpeg, and runs
the Playwright Phase 6/7 browser workflow.

Why: Phase 8 requires end-to-end coverage for production-critical happy and failure paths.
Database invariants, worker reliability, Stripe billing reconciliation, workspace invitations,
approval hardening, real FFmpeg export rendering, and browser-level reviewed export behavior should
not depend on a developer remembering to run local-only commands.

Tradeoff: CI is slower and requires service containers plus media/browser dependencies. Keeping
these as separate jobs preserves the fast, DB-free `verify` contract while still blocking merges on
the launch-critical suites.

Status: Active.

## 2026-07-06 - Inline Processing Kick Alongside The Worker

Decision: `createProjectFromUploadAction` (`src/app/actions/projects.ts`) uses Next's `after()` to run a few `runOnePendingJob()` iterations immediately after project creation, in addition to the persistent `npm run worker` process.

Why: `npm run worker` is the real, scalable architecture (and the only thing that runs jobs at all in a deployed environment), but requiring a second terminal for every local demo is friction. `after()` is a real Vercel/Next.js primitive (not a hack) for post-response background work, so this doesn't compromise the production shape — it's additive, and the worker's conditional-UPDATE claim makes it safe to run both concurrently.

Tradeoff: Local dev "feels" synchronous even though the pipeline is genuinely async; don't rely on this timing for anything correctness-sensitive, only for demoability.

Status: Active.

## 2026-07-06 - workspaces.minute_balance Is Decimal, Not Int

Decision: Changed `Workspace.minuteBalance` from `Int` to `Decimal(10,2)` (migration `20260706065927_workspace_minute_balance_decimal`) to match `usage_ledger.minutes_delta`/`balance_after`, which were already `Decimal(10,2)`.

Why: The Phase 1 schema had workspace balance as an integer while every ledger row computing against it was decimal — an arithmetic type mismatch that would have broken the first real reservation. Since guide §8 cost estimates are ceil'd to whole minutes in practice, this costs nothing in UX (balances still display as whole numbers) while fixing the underlying type consistency.

Tradeoff: None — this was a straightforward bug fix caught before it shipped a real reservation.

Status: Active.

## 2026-07-06 - Real Local Transcription Via whisper.cpp, Not Stubbed

Decision: `src/lib/transcription/` defines a `TranscriptionProvider` interface with a real `WhisperCppTranscriptionProvider` (shells out to the self-hosted `whisper-cli` binary against a local ggml model) as the primary implementation, auto-selected when `WHISPER_MODEL_PATH` points at an existing file. When it isn't configured, `UnavailableTranscriptionProvider` makes the TRANSCRIBE job fail clearly with `TRANSCRIBE_PROVIDER_UNAVAILABLE` — no fake transcript is ever written.

Why: Guide §3 explicitly recommends "WhisperX (self-host)" — whisper.cpp is the same idea (local, free, no API key, no network call), so this isn't a paid-provider violation of §1's constraints. Per §26 ("keep the provider interfaces for ASR/LLM/storage"), the interface is what matters; a real implementation behind it is strictly better than a fake one as long as a clean clone without the model configured still fails honestly instead of pretending to succeed.

Tradeoff: A fresh clone without `WHISPER_MODEL_PATH` set (and the ~140MB model downloaded) gets no real transcription — only the SRT-upload path works out of the box. This is the same shape as Phase 2's "real when the local tool is present, otherwise honestly unavailable" pattern, not a new kind of gap.

Status: Active.

## 2026-07-06 - word_timestamps Modeled As JSONB, Not A Separate Table

Decision: `TranscriptSegment.words` is a `Json` column holding an array of `{word, startMs, endMs, confidence, isFiller, deleted}`, instead of a separate `word_timestamps` table.

Why: Guide §6 explicitly offers this as the MVP alternative ("choose one and document"). A separate table buys per-word querying/indexing this product doesn't need yet (captions in Phase 5 read a segment's full word list at once, never a single word in isolation).

Tradeoff: Can't index or query individual words at the DB level. Revisit if a future feature (e.g. cross-transcript word search) needs it — migrating jsonb rows into a real table is a mechanical follow-up, not a redesign.

Status: Active.

## 2026-07-06 - Transcript Search Is A Real tsvector, But The API Doesn't Use It Yet

Decision: The migration adds `transcripts.search_vector` as a Postgres `GENERATED ALWAYS AS (to_tsvector(...)) STORED` column with a GIN index (guide §6: "full_text tsvector-indexed"), but `GET /api/videos/:id/transcript?q=` currently filters segments with a plain case-insensitive `contains` match instead of querying the tsvector.

Why: Per-project transcript search at MVP scale (one video's segments) doesn't need full-text ranking — a substring filter is simpler and gives the same practical result for the TranscriptViewer's search box. The generated column costs nothing to maintain (it's automatic) and is already in place for when a real need appears (e.g. cross-project search in a later phase).

Tradeoff: `search_vector` is currently unused by any query. That's fine — it's infrastructure paid for once, not a dangling half-feature, since nothing depends on it being wired up yet.

Status: Active.

## 2026-07-06 - Whisper Segments Aren't Re-Chunked To Strict Sentence Boundaries

Decision: Guide §9 step 2 calls for "segments normalized to sentences (punctuation restore if provider lacks it)." whisper.cpp's base.en model already produces punctuated, mostly sentence-like segments (confirmed against a real fixture), so no additional sentence-boundary re-chunking pass was added.

Why: Avoids building a second text-segmentation layer on top of a model that's already fairly close to what's needed, for a benefit that's marginal at typical sermon speaking pace.

Tradeoff: Occasionally a whisper segment splits mid-sentence (observed once in testing: a single sentence spanned two segments). Downstream consumers (Phase 4 clip chunking, Phase 5 captions) should treat segment boundaries as approximate, not authoritative sentence boundaries. Revisit if this causes visible caption-splitting artifacts in Phase 5.

Status: Active.

## 2026-07-06 - Real AI Clip Scoring Via Claude API, With A Real (Non-LLM) Heuristic Fallback

Decision: `src/lib/analysis/` defines an `AnalysisProvider` interface with two implementations: `ClaudeAnalysisProvider` (real — Haiku Stage A classification, Sonnet Stage B scoring/rationale, via `@anthropic-ai/sdk` and `client.messages.parse()` with a Zod-defined JSON schema), auto-selected when `ANTHROPIC_API_KEY` is set; and `HeuristicAnalysisProvider` (also real, but non-LLM — genuinely computed from pacing, hook-word cues, an emotion lexicon, and word-frequency overlap with the full transcript), the default when it isn't. The heuristic provider's `modelVersion` is always `"heuristic-v1"` and its rationale text says outright that no AI scored it — never presented as if an LLM judged the content.

Why: Same reasoning as Phase 3's transcription provider — Claude API access needs a key this MVP can't ship with (§1's no-live-credentials constraint), but the chunking/dedup/ranking mechanism around it doesn't need to be fake to demonstrate correctly. A fresh clone still produces genuinely ranked, genuinely differentiated clips (verified: 7 ranked clips from a 130s multi-topic fixture, scores 59-77, correctly ordered) with zero external calls.

Tradeoff: The heuristic's subjective categories (hook_strength, clarity, emotional_impact, shareability, topic_relevance) are much cruder than an LLM's judgment — a keyword lexicon and word-frequency overlap, not comprehension. `speaker_energy` and `platform_fit` are computed identically regardless of provider (real signals — words/minute, duration vs. target length — not LLM-dependent either way), matching guide §11's own "(computed)" annotation on speaker_energy.

Status: Active.

## 2026-07-06 - Sermon-Specific Scoring Categories Deferred To Phase 7

Decision: Phase 4 scores clips only on the general rubric (hook_strength, clarity, emotional_impact, completeness, shareability, speaker_energy, topic_relevance, platform_fit) from guide §11. The sermon-mode categories it also describes (biblical_usefulness, theological_clarity, pastoral_tone, scripture_relevance) are not implemented yet.

Why: Guide §10 step 10 explicitly labels the sermon-specific pipeline additions (worship-set exclusion, scripture-reference extraction, invitation detectors) as "Phase 7," and §23 assigns "Church features" to Phase 7. Scoring theological accuracy also isn't something the heuristic fallback could do credibly at all (no keyword lexicon substitutes for judging whether a cut is theologically sound), so it's better sequenced alongside real scripture-reference verification in Phase 7 than half-built now.

Tradeoff: Phase 4's clip selection doesn't yet penalize a cut that's biblically or theologically awkward, or reward one that clearly teaches the text — it only sees general shareability/hook/clarity signals. Acceptable for the "≥5 sensible ranked clips" MVP bar; revisit when Phase 7 adds the sermon-mode rubric swap.

Status: Active — expected to be addressed in Phase 7.

## 2026-07-06 - Candidate Chunking Trusts Segment Boundaries, Not Punctuation

Decision: `buildCandidateWindows` (guide §10 step 1) no longer requires a candidate to start on a capitalized word or end on terminal punctuation. It only skips starting a candidate on an obvious mid-clause continuation word (and, but, so, because, ...); any segment boundary within the target duration is otherwise accepted as a valid clip edge.

Why: The original implementation required both a capital-letter start and a `.`/`!`/`?` end, on the assumption (from an earlier, short test fixture) that whisper.cpp reliably restores punctuation and capitalization. Testing against a real 130-second, multi-paragraph TTS fixture falsified that assumption: whisper returned fully lowercase text with **no punctuation at all**, so every single candidate was rejected and ANALYZE failed with `NO_CLIPS_FOUND` on a genuinely clippable sermon. Segment boundaries themselves already reflect whisper's own pause/VAD-based detection, which is a more reliable signal than text formatting ASR doesn't consistently produce.

Tradeoff: Occasionally accepts a candidate edge that's grammatically less clean than a punctuation-gated one would have been. Far preferable to catastrophic failure on real-world ASR output — confirmed by re-running the same fixture after the fix: 7 ranked clips instead of zero.

Status: Active.

## 2026-07-06 - Editor: Caption Tracks/Presets Live In Code, Not New Tables

Decision: Guide §6 describes `caption_tracks`, `caption_segments`, and `caption_style_presets` tables. Phase 5 doesn't create any of them. The 4 built-in presets (Clean, Bold Serif, Karaoke, Quiet) are a TypeScript constant (`src/lib/editor/caption-presets.ts`), and caption lines are derived on demand from `TranscriptSegment.words` + `ClipEdit.editorState` (`src/lib/editor/caption-lines.ts`) rather than persisted.

Why: Same MVP-alternative reasoning as Phase 3's word-timestamps-as-JSONB call. Caption content is fully determined by (surviving words) + (preset + overrides + text overrides already stored in `editor_state`) — persisting a derived, re-computable value in extra tables would just be cache invalidation risk for no benefit at this scale. `caption_style_presets.workspace_id` (custom per-workspace presets) is the one piece of the original schema this doesn't cover.

Tradeoff: If per-workspace custom caption presets become a real feature request, the built-ins need to move into an actual table (or a hybrid: built-ins stay in code, customs get a table) — revisit then, not preemptively.

Status: Active.

## 2026-07-06 - Editor MVP Simplifications: Extend, Manual Crop, Face Mode

Decision: Three deliberate simplifications in the Phase 5 editor: (1) "Extend before/after" widens the clip's `source.startMs`/`endMs` by a fixed 15s step in one continuous direction, rather than a transcript-picker modal for choosing an arbitrary pull-in range; (2) manual layout crop is four range sliders (x/y/w/h), not a drag-and-resize box on the video; (3) "face" layout mode only stores the chosen mode — no client-side face detection runs in the editor.

Why: All three are guide-sanctioned MVP cuts. §12 doesn't mandate a specific extend UI, just that "extend pulls additional transcript + video range" — a fixed-step button does that. §14 explicitly defers full face tracking to Phase 8 polish and treats manual crop as "user drag/zoom crop box stored normalized" — sliders write the identical normalized `{x,y,w,h}` the schema expects, just via a simpler input widget. Face detection is inherently a render-time (server-side) concern per §14's own architecture ("renderer consumes only the state document"), not an editor-time one.

Tradeoff: Extend can't pull in a non-adjacent range (e.g., skip 30s of announcements then grab the next 20s) — only continuous widening. Manual crop is less discoverable than a visual drag box. Face mode shows a center-crop stand-in in the editor preview with a label explaining tracking happens at export. All three are cosmetic/interaction-model gaps, not data-model gaps — the stored `editor_state` shape already matches the guide's schema, so a richer UI can replace any of these without a migration.

Status: Active.

## 2026-07-06 - Prisma Migrations Touching `Unsupported("tsvector")` Need Manual Cleanup

Decision: Every `prisma migrate dev` in this repo that generates a new migration alongside the `transcripts.search_vector` generated column produces two spurious lines (`DROP INDEX ...search_vector_idx` + `ALTER COLUMN search_vector DROP DEFAULT`) that fail to apply (`42601: column "search_vector" ... is a generated column`). Confirmed again in Phase 5 — same failure mode as anticipated, required hand-editing the generated `migration.sql` to delete those two lines before it would apply.

Why: Prisma's schema-diffing engine doesn't understand the raw-SQL `GENERATED ALWAYS AS (...) STORED` clause behind the `Unsupported("tsvector")` field (added by hand in Phase 3's migration, not by Prisma itself) — it sees an "implicit default" that doesn't match the Prisma schema and tries to "fix" it every time, even though nothing about that column actually changed.

Tradeoff: Every future migration must be generated with `--create-only`, inspected, and had those two lines stripped before `prisma migrate dev` (or `migrate deploy`) is run for real — a recurring manual step, not automatable away without dropping the generated-column search index entirely. Worth it: real Postgres full-text search infrastructure for a few extra seconds of migration authoring per phase that touches the schema.

Status: Active — expect this on every remaining phase that adds a migration.

## 2026-07-06 - Embedded `editorState.version` Must Not Feed The Dirty-Check

Decision: The client editor's "unsaved changes" indicator compares working state against last-saved state with the embedded `version` field zeroed out on both sides first, instead of comparing the raw objects.

Why: Caught in real browser testing. `editorState.version` (duplicated inside the JSON document per the guide's own example, alongside the authoritative `ClipEdit.version` column) gets stamped by the *server* on every save, but the client's local working copy never learns the new number unless it's explicitly synced back. A raw deep-equality check against the post-save response therefore never matched — the header showed "Unsaved changes" forever after the very first successful save, even with zero further edits.

Tradeoff: None — this is a pure bug fix. Worth noting for Phase 6+: any future comparison between a client-held editor state and a server-returned one needs the same version-field exclusion, or the same sync-after-save discipline.

Status: Active.

## 2026-07-06 - Export Rendering Is A Real Multi-Pass FFmpeg Pipeline

Decision: Phase 6 exports render for real: `src/lib/export/kept-ranges.ts` computes surviving sub-ranges from deleted-word spans, `src/lib/export/crop.ts` resolves the effective crop rect per layout mode, `src/lib/export/ass-generator.ts` emits a real `.ass` file from the same caption-line/style helpers the editor preview uses, and `src/lib/export/render.ts` runs three ffmpeg passes: (1) frame-accurate re-encode + extract of each kept sub-range, (2) concat-demuxer stitch of those segments, (3) one final pass applying crop → scale-to-fill → re-crop-to-exact-size → `subtitles=` burn-in → `loudnorm` → x264/AAC encode. Verified against two real clips from the Phase 3-5 fixture (one with a real word deletion + manual crop + Bold Serif captions, one on default center-crop/Clean-preset/auto-filler-removal): both produced real 1080×1920 MP4s with correctly styled burned-in captions (confirmed by extracting and viewing frames) and the expected shortened duration.

Why: Three simpler ffmpeg passes over one large `filter_complex` graph is much easier to get right and debug — each pass has one job, and intermediate files can be inspected independently while building it. The cost (one extra full encode) is negligible for clip-length (seconds-to-minutes) exports.

Tradeoff: Frame-accurate cuts are bounded by the source's frame rate (25fps fixture ⇒ up to ~40ms drift per cut boundary vs. the theoretical exact millisecond), consistent with guide §13's own "(±1 frame)" caption-drift allowance extended to cut boundaries. Two full ffmpeg encodes per export instead of one costs some render time, deemed acceptable at MVP scale.

Status: Active.

## 2026-07-07 - Phase 7 Starts With Deterministic Church Intelligence

Decision: Phase 7 now has a deterministic first slice before adding heavier AI/product workflow
surfaces: sermon candidate filtering removes obvious worship/announcement/offering windows when
other sermon windows remain; scripture references are detected and normalized into a first-class
`scripture_references` table; and sermon clips use church-specific scoring categories
(`biblical_usefulness`, `theological_clarity`, `pastoral_tone`, `scripture_relevance`) instead of
the generic hook/topic categories. The review UI surfaces normalized scripture badges on clip cards.

Why: These are core church-specific differentiators from guide §10/§11/§23 and can be made true
without waiting on new providers or approval UI. They also make the heuristic fallback more honest:
a no-key local run can demonstrate sermon-aware ranking and visible scripture handling instead of
showing generic creator scoring.

Tradeoff: This is not full scripture verification against a Bible text database and not full
music-vs-speech audio classification. The boundary filter is conservative text heuristics with a
fallback to the original candidates if everything is flagged, so it avoids catastrophic "no clips"
failures but will miss some service-section boundaries. LLM scoring still receives the existing
generic prompt, then the app overlays deterministic church rubric fields; prompt-native sermon
rubric scoring remains a follow-up.

Status: Active — brand templates, lower-thirds, approval state machine, and phone review links
landed in the next Phase 7 slice. Stronger scripture verification and audio-aware boundary
detection remain future hardening.

## 2026-07-07 - Brand Templates And Approval Links Are MVP-Depth, Not Full Collaboration

Decision: Phase 7 now persists `brand_templates` and `clip_approvals`. `/app/templates` manages a
workspace's church identity, caption preset, colors, and lower-third copy. The editor can apply a
template into `editor_state.brandTemplateId`, preview the lower-third, and export burns that
lower-third into the ASS subtitle file as a second style/event. Clip cards can create/reopen an
approval record and expose `/review/:token`; that public token page lets an approver approve or
request changes from a phone without loading the editor.

Why: The Phase 7 acceptance path requires reviewed, branded clips. This implementation makes that
workflow real without jumping ahead to full teams, threaded comments, or direct publishing. The
review token is opaque and tied to one clip approval, giving a simple URL that Phase 8 later
hardened with expiry, revocation, audit events, and optional notifications.

Tradeoff: This is not a full collaboration system. There are no threaded comments or role-specific
approval permissions beyond possession of an active token. Exports are approval-gated, and any
successful editor save after approval returns the approval to `DRAFT` so the clip must be reviewed
again before export. Lower-thirds are text-only ASS overlays, not logo/image assets or animated
brand packages. The model and editor state shape leave room for those upgrades.

Status: Active — adequate for the MVP review-and-branding path; production collaboration and asset
management remain Phase 8+/V1 hardening.

## 2026-07-06 - No Per-Word Karaoke Caption Animation At Render Time

Decision: All four caption presets — including "Karaoke" — burn in at the line level (one `Dialogue` event per caption line) rather than using ASS `\k` tags for a progressive per-word color wipe.

Why: `\k` timing requires getting libass's SecondaryColour/PrimaryColour wipe-direction semantics exactly right and is easy to get subtly wrong without extensive manual playback verification; the "Karaoke" preset's differentiation (pill background, uppercase, distinct highlight color, middle-screen position) still renders correctly and looks visually distinct without it.

Tradeoff: The "Karaoke" preset doesn't actually animate word-by-word like its name implies — it's a static styling variant for now. Revisit if a future pass wants true word-highlight timing; `CaptionLine.words` already carries per-word start/end timestamps, so the data needed is already there.

Status: Active — deferred, not abandoned.

## 2026-07-06 - Center/Face Crop Is Computed At Render Time, Not Read From Editor State

Decision: `resolveCropRect` (guide §14) only reads the stored `layout.crop` for `manual` mode. For `center` mode it computes a fresh center-crop rectangle from the source video's real width/height (crop the wider dimension to hit exactly 9:16). `face` mode uses the identical center-crop computation — there's no face-tracking implementation, so it falls back exactly the way guide §14 already describes low-confidence tracking falling back ("fall back to center when confidence low").

Why: The editor's default `layout.crop` is always `{x:0,y:0,w:1,h:1}` regardless of mode (Phase 5's preview achieves the "center" look via CSS `object-fit: cover`, not by writing real crop numbers into state) — reading it literally for center mode at render time would render the full uncropped source instead of a 9:16 center crop. Recomputing from real pixel dimensions at render time is also the only way the crop is correct across source videos of different resolutions/aspect ratios.

Tradeoff: If a workspace's source videos are ever letterboxed or have unusual aspect ratios, the computed center crop might not match user expectations as well as a manually placed one would — `manual` mode remains the escape hatch. Full per-frame face tracking is still Phase 8 polish, unchanged from the guide.

Status: Active.

## 2026-07-06 - `export_jobs` Is A Separate Queue From `processing_jobs`, Exports Are Free At MVP

Decision: `ExportJob`/`ExportedFile` are new tables (own idempotency key, own claim/retry logic in `src/lib/exports/queue.ts`), not `ProcessingJob` rows with `type=EXPORT` — matching guide §6's explicit separate schema. `src/worker/run-jobs.ts` polls both tables in the same loop rather than running a second worker process. Export jobs retry automatically up to 2 times on failure before landing in `FAILED` (guide §15 step 6); a user-triggered "try again" (`POST /api/exports/:id/retry`) resets and reuses the *same* job row rather than creating a new one. No `usage_ledger` row is written for exports and `ExportJob.minutesCharged` is always stored as `0` — the guide's own §15 step 2 says "MVP: exports free, processing minutes already paid," and `usage_ledger.job_id` only has an FK to `processing_jobs`, so wiring a real export charge would need a schema change anyway; better done when exports actually cost something.

Why: Exports are naturally per-clip (a project's several clips can each have independent, concurrent export histories) rather than per-project like the FINALIZE→PROBE→TRANSCRIBE→ANALYZE pipeline, so a distinct table with its own lifecycle fields (`filename`, `outputFileId`, `minutesCharged`) is a cleaner fit than overloading `ProcessingJob`. Retry-then-fail was verified for real: temporarily hid the source file, watched the job exhaust 3 attempts and land in `FAILED` with `RENDER_FAILED`, restored the file, called the retry endpoint, and watched the same job row succeed.

Tradeoff: The unused `EXPORT` value in the `ProcessingJobType` enum (from Phase 1's schema) is now dead — left in place rather than removed, since dropping an enum value is a more invasive migration than the value being unused is a problem. A workspace-level ledger audit trail for exports doesn't exist yet; add an `ADJUSTMENT`-kind row (or extend the FK) if/when exports gain a real cost.

Status: Active.

## 2026-07-06 - Export Download Links Are Session-Gated, Not Cryptographically Signed

Decision: `GET /api/exports/:id/download` is an authenticated, workspace-scoped route (same pattern as `/api/videos/:id/source` and `/api/storage/[...key]`) rather than a URL bearing an HMAC-signed token. `ExportedFile.downloadExpiresAt` is still a real stored 7-day expiry per guide §15 step 4/§17 — the download route checks it and returns `DOWNLOAD_LINK_EXPIRED` past that point — and `POST /api/exports/:id/resign` extends it by another 7 days, giving a real, testable implementation of guide §20's "auto re-sign" recovery path.

Why: A cryptographically signed URL exists to allow access *without* an active session (e.g., a link pasted into an email, or fetched by a background job) — meaningful for a real S3/CDN deployment, but this MVP's storage and auth are both dev-mode stand-ins (local disk, httpOnly cookie session) where every other file route already relies on session auth rather than tokens. Adding a second, parallel signing mechanism here would be inconsistent with the rest of the codebase for no real security benefit at this stage.

Tradeoff: A download link can't be shared with someone outside the workspace's session (arguably a feature, not a bug, for church-internal videos) and doesn't survive a session logout the way a true signed URL would. Revisit if exports need to support unauthenticated sharing (e.g., a public link a pastor can text to someone).

Status: Superseded by the 2026-07-07 signed media URL and S3/R2 provider decisions.

## 2026-07-06 - Export Idempotency Key Is Scoped To (Clip, Edit Version, Filename)

Decision: `POST /api/clips/:id/exports` derives its idempotency key as `export:${clipId}:v${currentEditVersion}:${filename}` rather than a fixed per-clip key, and the client doesn't supply it.

Why: Guide §15 step 2 requires "re-submitting the same job id must not double-charge" — but unlike `ProcessingJob` stages (at most one per project, ever), a clip's export is something a user legitimately wants to redo after further edits. A fixed `export:${clipId}` key would silently return a stale export forever after the first one. Scoping by edit version means a retried/double-clicked request against the *same* saved state returns the same job (true idempotency), while editing the clip further and re-exporting naturally mints a new job.

Tradeoff: Two exports of the same clip state with two different filenames create two separate render jobs rather than reusing one — an accepted minor inefficiency in exchange for keeping the idempotency key derivation simple and not requiring a client-supplied key.

Status: Superseded by the 2026-09-02 export-identity decision. The filename is no longer part of the key.

## 2026-07-16 - Retention Reaper Purges Media, Keeps The Record

Decision: `ProcessingJobType.CLEANUP` now has a real handler. The worker scans on
`WORKER_CLEANUP_INTERVAL_MS` (default hourly) and enqueues one CLEANUP job per project that has
retention work, with a daily-bucketed idempotency key (`cleanup:{projectId}:{yyyy-mm-dd}`). The
handler deletes exported MP4 objects `EXPORT_FILE_RETENTION_GRACE_MS` (default 30 days) after
`downloadExpiresAt` — any age once the project itself has expired — and purges an expired
project's source media (video, extracted audio, thumbnail, SRT override) from storage, but only
when every project referencing that source video has expired. Deleted `ExportedFile` rows rely on
`ExportJob.outputFileId`'s `SetNull` so export history survives. Orphaned exported-file rows (left
behind by clip/export-job cascade deletes) are swept directly in the scan since they no longer map
to a project. Database records — projects, clips, scores, transcripts, ledger, audit events — are
never deleted by the reaper; media objects are. A failed CLEANUP job is exempt from the runner's
"terminal failure marks the project FAILED and releases reservations" behavior, because cleanup is
maintenance on a possibly-healthy project.

Why: Phase 8 review flagged that `Project.expiresAt` and `ExportedFile.downloadExpiresAt` were set
but nothing ever deleted expired objects — unbounded storage cost growth and no automated deletion
path for retention policy. The "no marker column" design (re-scan predicates go false once keys
are nulled and rows deleted) avoids a schema migration entirely, and the daily idempotency bucket
lets a project be re-swept as new exports age out while same-day re-scans dedupe.

Tradeoff: This is media retention, not GDPR-complete erasure — transcripts and clip text remain
until a future data-subject-deletion feature removes rows. An expired project sharing its source
video with an active project re-matches the scan daily (one no-op job per day) until the last
referrer expires; bounded and harmless. Reliability integration tests switched their inert job
type from CLEANUP to PREVIEW_RENDER since CLEANUP now executes real work.

Status: Active.

## 2026-07-16 - The Production Worker Ships Compiled, Not tsx-Interpreted

Decision: `worker:prod` now runs `node --enable-source-maps dist/worker/run-jobs.cjs` instead of
`tsx src/worker/run-jobs.ts`. A new `worker:build` script runs `tsc --noEmit` (full type check of
the worker's import graph) then bundles the entrypoint with esbuild (`--bundle --platform=node
--packages=external`, so node_modules — including the native Prisma client — stay external and
only first-party `src/` code with its `@/` aliases is bundled). `tsx` moved from dependencies to
devDependencies; local development keeps `npm run worker` (tsx watch). `Dockerfile.worker` runs
`worker:build` in the full-deps builder stage and ships only `dist/`, the production
`node_modules`, and the generated Prisma client — no TypeScript source, no on-the-fly transpiler.

Why: Phase 8 review flagged that the worker shipped raw TS executed by tsx at runtime — no
build-time type enforcement (a type error would only surface in production), slower cold start,
and a dev-tool transpiler in the production dependency tree. Now a type error anywhere in the
worker graph fails the Docker build, and the runtime is plain Node with source maps for stack
traces. Verified by bundling locally and running the compiled worker against real Postgres (it
polled and wrote its `worker_heartbeats` row), and by building the image.

Exercising the image also surfaced a latent bug inherited from the first draft of
`Dockerfile.worker`: whisper.cpp built shared libraries, so the copied `whisper-cli` binary could
never execute in the runtime stage (exit 127, missing `libwhisper.so`) — every production
transcription would have failed at the readiness gate. The build now uses
`-DBUILD_SHARED_LIBS=OFF` for a self-contained static binary plus a build-time
`whisper-cli --help` canary, and the boot path was proven end-to-end in the container (entrypoint
→ readiness pass → poll loop → visible DB error on a bogus `DATABASE_URL`).

Tradeoff: One more build artifact and script to know about; `dist/` is gitignored and must be
rebuilt after source changes (bare-metal release steps updated accordingly). Launch/ops scripts
(`smoke:production`, launch-evidence) still run via tsx as a devDependency — they are
operator-side tools, not production processes.

Status: Active.

## 2026-07-16 - Expensive Routes Get DB-Counted Per-Workspace Rate Limits

Decision: `src/lib/rate-limit.ts` adds per-workspace caps enforced in the API routes: exports are
limited to `EXPORT_MAX_CONCURRENT_JOBS` (default 4) active renders and `EXPORT_DAILY_JOB_LIMIT`
(default 50) new jobs per rolling 24h; upload presigns are limited to
`UPLOAD_PRESIGN_HOURLY_LIMIT` (default 30) per rolling hour. Counting is DB-backed over existing
rows — active/recent `export_jobs` for exports, and the `upload_presigned` operational events the
presign route already emits for uploads — the same pattern as the email-OTP rate limit, with no
new infrastructure. Rejections return the standard apiError shape with code `RATE_LIMITED`,
HTTP 429, `retryable: true`, and record warning-severity operational events. Idempotent
re-requests of an existing export job bypass the check (they create no new render), which also
closes the unlimited-render loophole: only genuinely new (clip, version, filename) combinations
count against the caps.

Why: Phase 8 review flagged that only OTP was rate-limited while each export burns worker CPU and
each upload can trigger paid transcription/analysis; the export idempotency key varies by
filename, so renaming spawned unbounded render jobs. Uploads are the sole user-facing entry to
the ANALYZE pipeline (analysis chains worker-side from transcription), so capping presigns caps
provider spend.

Tradeoff: Conditional count-then-insert is race-tolerant, not race-proof — two simultaneous
requests at the boundary may both pass, so the effective cap is "limit, give or take one," which
is fine for abuse control. Limits are static env values, not plan-differentiated; move them into
`billing/plans.ts` when paid tiers should buy higher throughput.

Status: Active.

## 2026-07-16 - Stripe Dunning Is Observed, Refunds Claw Back Floored Minutes

Decision: `invoice.payment_failed` now records a warning-severity billing event for dunning
visibility and deliberately does not touch plan state — Stripe's `customer.subscription.updated`
(`past_due`, then `canceled` when dunning exhausts) remains the single authority on plan
transitions. `charge.refunded` on a fully refunded charge claws back that invoice's granted
minutes through `revokeMinutesForRefundedInvoice`: the clawback is floored at the workspace's
current balance (a row-locked read-then-update, so it can't race a concurrent reservation), the
REFUND ledger row doubles as a per-invoice idempotency marker on top of the webhook event dedupe,
and partial refunds only record an event — adjusting minutes for a partial refund is a manual
operator decision.

Why: Phase 8 review flagged that only the happy billing paths (checkout, subscription update,
idempotent invoice grant) were handled and tested. Failed payments were invisible to operators,
and a refunded church kept its granted minutes with no record. The floor preserves the system's
"no negative balances" invariant: minutes already spent on real processing are not re-collected.

Tradeoff: A church that spends all granted minutes and then gets a full refund keeps the value of
the spent minutes (clawback of 0) — acceptable generosity, consistent with the spec's refund
posture, and visible in the ledger either way. Proration and partial-refund minute math are
deliberately out of scope.

Status: Active.

## 2026-07-16 - Independent Review (Codex) Fixes: Refund Lock Ordering, Stale-Cleanup Side Effects, Fail-Closed Presign Counter, Linux Lockfile Gate

Decision: Four fixes from an adversarial second review of the pre-launch branch. (1) In
`revokeMinutesForRefundedInvoice`, the per-invoice idempotency check now runs *after* the
workspace `FOR UPDATE` row lock — checking before the lock let two concurrent refund events for
the same invoice (distinct Stripe event ids, so webhook dedupe does not apply) both pass the
check and double-claw; serializing on the lock first means the loser sees the winner's committed
REFUND row. (2) Stale-job recovery side effects (release reservations, mark project FAILED) moved
into `applyStaleFailureSideEffects`, which exempts CLEANUP jobs — the worker loop previously
applied them to every exhausted stale job, so a stale retention job could fail a healthy project.
(3) The `upload_presigned` operational event doubles as the presign rate-limit counter, so it is
now written with the strict (non-swallowing) recorder and the route fails closed with a 500 if
the counter cannot be persisted — previously a failing events table silently disabled the cap.
(4) The lockfile is regenerated from the node:24 Linux container (a macOS `npm install` had
dropped the `@emnapi/*` optional entries again, breaking `npm ci` only inside the Docker build),
and a fourth CI job (`worker-image`, buildx with GHA cache) now builds `Dockerfile.worker` on
every push/PR so lockfile drift and Dockerfile regressions cannot land silently.

Why: Each was a genuine hole the original implementation's tests missed: the refund race needed
two events past the marker check before either locked; the cleanup exemption existed in the
runner path but not the recovery path; fail-open rate limiting is invisible until the events
table degrades; and macOS-vs-Linux lockfile drift had already recurred once within this branch.

Tradeoff: Refund idempotency still keys on the marker-note convention rather than a dedicated
unique column (no migration); the lock-then-check ordering makes it race-proof, and a
`billing_period_credits.refund_ledger_id` unique column is the cleaner future shape if refund
handling grows. Regression tests added for the race and the recovery exemption; the fail-closed
presign write is enforced by code path (strict recorder + early return) — fault-injection
testing of a failing events table is left out as impractical in the integration harness.

Status: Active.

## 2026-07-18 - Transactional Email Provider Switch: SendGrid to Resend

Decision: Migrated all transactional email (auth OTP, workspace invitations, approval
notifications) from SendGrid to Resend. Consolidated the three previously-independent
`fetch("https://api.sendgrid.com/v3/mail/send", ...)` call sites into one shared helper
(`src/lib/notifications/email-provider.ts`) that wraps `api.resend.com/emails`; each call site
keeps its own subject/body/from-email-resolution logic. `SENDGRID_API_KEY` renamed to
`RESEND_API_KEY` throughout readiness checks, production-smoke required checks, launch-evidence
proof validators, and all related tests/docs.

Why: The SendGrid account hit a hard `401 Maximum credits exceeded` during tonight's launch-night
Phase F evidence collection, blocking production login entirely (no dev-login fallback under
`NODE_ENV=production`). Rather than just fix billing on that account, the operator is also
planning a much larger volume of *cold outbound* email in the near future (hundreds/day) —
a fundamentally different use case from transactional mail that risks damaging shared sender
reputation if run through the same provider/domain. Decided to move transactional mail onto
Resend now (generous recurring free tier, avoids the credit-exhaustion failure mode that just
happened, clean split from whatever cold-outbound tool gets picked later) rather than untangle
billing on an account already showing problems.

Tradeoff: Requires the operator to sign up for Resend and provide a fresh `RESEND_API_KEY` before
Phase F can resume — this could not be done autonomously (creating third-party accounts requires
operator identity/payment). Cold-outbound tooling itself (Instantly/Smartlead/etc., a separate
sending domain) is intentionally out of scope here and left as a future decision.

Status: Active. Code/tests/docs migrated and `npm run verify` green; production env vars and a
live send still need operator action (RESEND_API_KEY).

## 2026-07-18 - URL Import Is Real: yt-dlp Fetch Adapter Wired Into FINALIZE

Decision: Pasting a URL now imports the video for real, superseding "2026-07-06 - Phase 2 Upload
Is Real; URL Import Stays Stubbed." `src/lib/media/ytdlp.ts` provides a pure metadata parser
(`parseYtDlpMetadataJson`, mirroring `parseFfprobeOutput`) plus `fetchYtDlpMetadata` and
`downloadYtDlpVideo`, both taking an injectable subprocess-exec function and hard timeouts
(`YTDLP_METADATA_TIMEOUT_MS`/`YTDLP_DOWNLOAD_TIMEOUT_MS`). The FINALIZE handler grew a URL
branch: for a `URL`-origin source video with no `storageKey`, it fetches metadata first and
enforces `MAX_VIDEO_DURATION_S` (`VIDEO_TOO_LONG`) and the workspace plan limit
(`PLAN_LIMIT_EXCEEDED`) *before* downloading, then downloads into the handler's temp workDir
(capped at `MAX_UPLOAD_BYTES`; fetch/download failures fail as `URL_IMPORT_FAILED`), uploads via
the storage provider, sets `sourceVideo.storageKey`, and falls through to the unchanged
probe/reserve/PROBE flow. `createDraftProjectForWorkspace` enqueues FINALIZE as `QUEUED` with
`idempotencyKey: finalize:<projectId>` (mirroring the upload path) instead of the
`WAITING`/`URL_IMPORT_UNAVAILABLE` stub, worker readiness now requires a working `yt-dlp`
(`YTDLP_PATH`, probed with `--version`), and `Dockerfile.worker` installs the standalone Linux
binary in the runtime stage.

Why: Closes the honest-but-stubbed URL-paste gap as a standalone win, and it is the fetch
foundation the auto-import channel-polling work (Phases 2-4 of `docs/AUTO_IMPORT_LOOP.md`)
builds on — the poller creates URL projects and relies on this exact pipeline.

Tradeoff: yt-dlp is a moving target (extractor breakage whenever YouTube changes), so the Docker
install is deliberately unpinned — a pinned release goes stale in weeks, and image builds trade
bit-reproducibility for a binary that still works; `--version` fails the build fast if the
download breaks. The pre-download duration gate trusts yt-dlp metadata; the authoritative
ffprobe duration is still re-checked after download by the unchanged finalize flow. Tests fake
only the subprocess boundary (same trust line as ffprobe/whisper); CI never shells out to a real
yt-dlp. The web process's best-effort inline job runner (`after()` in the upload action) could
claim a URL FINALIZE job on an image without yt-dlp — that failure is retryable and the worker
picks it up, accepted at MVP scale.

Status: Active.

## 2026-07-18 - Channel Registration Resolves Synchronously; No Bulk Backfill On Registration

Decision: Registering a YouTube channel for auto-import (`src/lib/channel-import-service.ts`)
resolves the channel against the YouTube Data API *during* registration — normalizing flexible
input (@handle, bare handle, UC... channel id, or youtube.com channel URL) and persisting the
resolved `channelId`/`channelTitle`/`uploadsPlaylistId` — so a bad handle or URL fails fast with
a clear, typed error instead of creating a silently-broken row the poller would grind on. No
bulk backfill happens on registration: no `ChannelImportedVideo` rows are seeded and no
historical uploads are imported — only videos published after registration are ever imported
(the poller compares against `lastPolledAt`/already-seen video ids). Legacy `/c/` and `/user/`
URLs are rejected with guidance to use the @handle, since `channels.list` cannot resolve legacy
custom URLs reliably. Duplicate registration is enforced by the
`@@unique([workspaceId, platform, channelId])` constraint, surfaced as a friendly error.

Why: A church registering its channel almost certainly wants *future* sermons clipped, not a
surprise import of years of archive (and the quota, minutes, and storage bill that implies).
Synchronous resolution keeps the failure at the moment the user can fix it, and storing the
uploads playlist id at registration means the poller never needs `channels.list` again —
`playlistItems.list` only, 1 quota unit per poll.

Tradeoff: Registration requires the YouTube API to be reachable and `YOUTUBE_API_KEY` configured
(a quota outage blocks new registrations, not just polling). A channel whose handle changes
keeps working — polling is keyed to the immutable channel/playlist ids — but the stored handle
label can go stale until re-registered. Users who genuinely want old videos imported must paste
those URLs manually through the existing URL-import path.

Status: Active.

## 2026-07-18 - Channel Import Daily Cap Counts "imported" Rows Per Workspace Over A Rolling 24h; Over-Cap Videos Are Retryable "skipped_cap" Rows

Decision: `checkChannelImportLimit` (`src/lib/rate-limit.ts`, env `CHANNEL_IMPORT_DAILY_LIMIT`,
default 10) caps channel auto-imports per workspace over a rolling 24h window, counted from
`ChannelImportedVideo` rows with `status: "imported"` created within the window (joined through
the source's workspace). Over-cap videos get a `"skipped_cap"` row — retryable, unlike terminal
`"failed"` — and the poller lowers its listing cutoff to just before the oldest pending skip so
those videos re-enter the candidate list and import once the window has room. Cap skips never
touch `lastPollErrorAt`/`lastPollErrorMessage`: pacing is not an error.

Why: The existing limits count the domain rows the limited action creates (`checkExportJobLimits`
counts `exportJob` rows over `now - 24h`), so the channel cap mirrors that shape rather than
inventing an event-based or calendar-day counter. "imported" rows map 1:1 to auto-created
projects, so the cap measures exactly the cost it exists to bound (each import runs the full
paid transcription/analysis pipeline) while manual uploads/URL pastes never consume it and
failed or deferred attempts don't either. Retry-by-cutoff-lowering keeps the no-backfill
invariant: a skipped_cap row only ever exists for a video strictly newer than some earlier
cutoff (>= registeredAt), so the effective cutoff never drops below registration.

Tradeoff: Rolling-window counting means a burst that fills the cap at 9pm still throttles until
9pm the next day (no midnight reset a user might expect). The DB-count check is race-tolerant
like the other limits — near-simultaneous imports may both pass within one row of the limit —
which is fine for a single-worker poller. A channel that uploads more than the cap every day
falls progressively behind until the operator raises `CHANNEL_IMPORT_DAILY_LIMIT`.

Status: Active.

## 2026-07-18 - Sermon Clipper Is the Intended Long-Term Successor to Pulpit Engine; No Piecemeal Renaming Before a Deliberate Cutover

Decision: Sermon Clipper is the operator's intended flagship product going forward — the old
Pulpit Engine build (`euphoric-patrol-493623-b8` in Google Cloud, `pulpitengine.com`, the
`pulpit-engine` Dropbox workspace) will eventually be retired, and Sermon Clipper is expected to
take over the Pulpit Engine name and, likely, its domain. Until that happens, infrastructure and
codebase naming stays **"sermon-clipper"** everywhere — repo name, Railway project/services, and
any new cloud resources (e.g. the dedicated Google Cloud project created for `YOUTUBE_API_KEY` is
named `sermon-clipper-prod`, fully separate from the old project). Do not rename, alias, or
partially brand any individual resource as "Pulpit Engine" before the cutover.

Why: Two live things both named "Pulpit Engine" — the old build and a newly-created resource — is
strictly more confusing than the current state, not less, and it's the exact failure mode that
caused this cycle's credential-hygiene incidents (resources that *look* related get reached for
by mistake, by humans and agents alike). The isolation work already done for this reason —
dedicated Resend sending subdomain instead of reusing `pulpitengine.com`, a dedicated
`sermon-clipper-prod` GCP project instead of reusing `euphoric-patrol-493623-b8` — is not in
tension with the eventual consolidation; it's what makes that consolidation a clean, deliberate
event later instead of an accidental one now. Domain reuse in particular (email sender reputation,
DNS, auth) needs a real migration plan, not an incidental one.

Tradeoff: Some near-term friction from having "sermon-clipper"-branded infra for a product whose
eventual public name will be "Pulpit Engine" — acceptable, since GCP project IDs are the only
piece of this that's genuinely permanent, and everything else (repo, Railway project, domain)
renames cleanly with redirects when the operator is ready.

Migration trigger: When the operator decides to retire the old Pulpit Engine build, treat the
rename as one atomic, planned migration (domain/DNS, email sending domain, Railway project name,
GCP project display name, repo name with GitHub redirect, Stripe account naming, marketing) —
not a rolling series of one-off renames.

Status: Superseded in part — see 2026-07-18 "Sermon Clipper's Email Clean-Room Uses a
pulpitengine.com Subdomain" for the operator's explicit override on the email-sending-domain
question specifically. The rest of this entry (no infra renaming, `sermon-clipper-prod` GCP
project) stands.

## 2026-07-18 - Sermon Clipper's Email Clean-Room Uses a pulpitengine.com Subdomain, Not a New Domain

Decision: Sermon Clipper's transactional email (OTP, workspace invitations, approval
notifications) sends from `send.pulpitengine.com`, a dedicated Resend-verified subdomain of the
old Pulpit Engine's existing domain — not `noreply@pulpitengine.com` (the address it shared until
today), and not a newly-registered domain like `sermonclipper.com`. This is an explicit operator
override of the "no domain reuse before a deliberate cutover" posture recorded in the entry above,
scoped narrowly to email.

Why: The operator's stated direction is that `pulpitengine.com` is where the business is
consolidating regardless, so registering a third domain for an interim period is wasted effort.
A dedicated subdomain still gets its own DKIM/SPF/DMARC records in Resend, independent from
whatever the root domain or other subdomains send — it is not the same sending identity as
`noreply@pulpitengine.com`, which is what the original clean-room recommendation was actually
trying to avoid (one shared address/reputation stream serving two unrelated products). A
subdomain does not fully eliminate coupling — the parent domain's registrar/DNS control and any
domain-level reputation signals are still shared — but it removes the sharpest edge (a single
sender identity and a single Resend domain-verification record for two products) without a new
purchase.

Tradeoff: If `pulpitengine.com` at the registrar/DNS level is ever compromised, suspended, or
loses reputation for reasons entirely outside Sermon Clipper's control, Sermon Clipper's login
email (OTP-gated auth) goes down with it. This is a real, accepted dependency, not a hypothetical
— it's the tradeoff of the consolidation direction itself, not a new one introduced here.

Status: Active.

## 2026-07-18 - Defer the app.pulpitengine.com Email Split Until Past the Test-Church Pilot

Decision: The `send.pulpitengine.com`/`app.pulpitengine.com` dedicated-subdomain email split
(previous entry) is a documented plan, not something executed today. Sermon Clipper keeps sending
from `noreply@pulpitengine.com` on Resend's Free plan (1 domain, 100 emails/day) through the
2-3-church test pilot. Migration trigger: upgrade to Resend Pro ($20/mo, 10 domains, 50k
emails/mo, no daily cap) and execute the subdomain split before real public launch, before
marketing email exists on `pulpitengine.com`, or immediately if the 100/day cap is ever actually
hit during testing.

Why: At pilot volume (a handful of OTP logins and invites across 2-3 churches), the reputation-
isolation problem the subdomain solves has near-zero probability of materializing, and the 100/
day cap is nowhere close to binding. Spending $20/mo plus DNS and code changes to solve a
low-stakes-at-this-scale problem is disproportionate to the current stage — consistent with this
project's standing "simple until earned" posture. The target architecture (confirmed with the
operator) is `app.pulpitengine.com` as the product/dashboard domain — separable from the email
question, since pointing DNS at Railway costs nothing and needs no Resend plan change; only the
`login@`/`notify@` sending addresses on that subdomain depend on the Pro upgrade.

Status: Active.

## 2026-07-19 - Sermon Clipper's Tier 3 Facebook Auto-Posting Will Reuse Pulpit Engine's Meta App/Business Manager

Decision: When Sermon Clipper's Tier 3 (automatic Facebook posting — see `docs/BUSINESS_OVERVIEW.md`)
is unfrozen, it authenticates through the same Meta App/Business Manager that Pulpit Engine already
operates, rather than registering a new Meta App and going through app review a second time. This is
an explicit operator override of the "isolation is permanent — separate repo/DB/keys" posture for
this one subsystem specifically; the rest of that posture (separate repo, separate database,
separate non-Meta credentials) is unchanged.

Why: Pulpit Engine already has a Meta App/Business Manager with a working System User token
(`META_SYSTEM_USER_TOKEN`, Graph API v25.0) that has posted scheduled Facebook Reels for real —
session `f29711c6` on 2026-06-03 against sandbox page `1128280933691493`, six real scheduled posts,
`schedule_push_status=succeeded`. That means the slowest, least certain part of Tier 3 — getting a
Meta App through review for scheduled Page posting — is already done and proven in production, on a
different product. Registering and re-reviewing a second Meta App for Sermon Clipper would
duplicate months of already-cleared review lead time for no isolation benefit that matters at this
stage: a Meta App/Business Manager is a credential boundary, not a data boundary, and each church's
own Facebook Page token (obtained via that church's own OAuth grant) is what actually scopes access
to that church's page — the shared App is just the thing Meta reviewed once.

Tradeoff: Sermon Clipper's Facebook posting capability now has an operational dependency on Pulpit
Engine's Meta App/Business Manager standing — if that App is ever suspended, restricted, or has its
permissions revoked by Meta for a Pulpit-Engine-side reason, Sermon Clipper's Facebook posting goes
down with it, with no independent app to fall back to. Credential rotation/management (system user
tokens, per-church page tokens) needs to account for two products' traffic patterns and rate limits
sharing one App's quota. This is a deliberate, accepted coupling, scoped narrowly to the Meta
App/Business Manager identity — not a merger of the two products' repos, databases, or other
secrets.

Status: Active — decided ahead of Tier 3 implementation. **Superseded in part** by the 2026-07-19
entry below ("Tier 3 Freeze Lifted") — the operator explicitly removed the >=3-churches gate the
same day. This entry's Meta App/Business Manager reuse decision stands unchanged.

## 2026-07-19 - Tier 3 Freeze Lifted; Build Gated Behind a Manual Go-Live Step Instead

Decision: The operator explicitly lifted the ">=3 churches ask" freeze on Tier 3 (Facebook
auto-posting) recorded in the 2026-07-18 entries above and in CTO.md's feature-freeze framework.
Tier 3 is now being built. In its place, Tier 3 ships with its own gate: a per-workspace
`facebookAutoPostEnabled` flag, default `false`, that must be manually flipped before any real
Graph API call is made for that workspace — mirroring Pulpit Engine's own "mechanism ready, live
gate separate" pattern (see `pulpit-engine_live-gate-go-no-go_80-81_2026-07-04_v1.md` in that
repo, where creds/code were proven ready well before the first live run was authorized). No
workspace auto-posts merely by connecting a Facebook Page; posting requires the flag plus a
configured Page ID plus real `META_SYSTEM_USER_TOKEN`/`META_GRAPH_API_VERSION` credentials in the
environment — three independent conditions, all fail-closed if unmet.

Why: The founder judged the original freeze rationale (avoid building a feature nobody's asked
for yet) no longer the binding constraint, and separately wanted a safety boundary between
"the code exists" and "it posts to a real church's real Facebook Page" — those are different
risk levels and shouldn't be the same event. Reusing Pulpit Engine's exact proven pattern (a
manual, explicit go-live step distinct from code completion) means Tier 3 launches with a
precedent that's already been exercised successfully once, rather than inventing new go-live
discipline from scratch.

Tradeoff: Tier 3 code (OAuth/connection storage, the Graph API client, the publish worker, the
per-workspace enable toggle) can now exist and be merged to `main` before any church has asked for
it, which is a real reversal of the original "don't build speculative features" reasoning — the
team accepted that tradeoff explicitly in exchange for de-risking the actual first live post via
the manual gate.

Status: Active.

## 2026-07-23 - Open Question: YouTube URL Import Is Blocked By Datacenter IP / Bot Detection In Production

Open Question: Production URL-paste import (and by extension the unmerged `auto-import-loop`
channel-polling branch, which shares the same fetch path) fails on essentially every real
attempt from Railway. This is not a code bug in our handling — it's a fetch-infrastructure gap.
No decision has been made yet on how to close it; this entry records the findings so the research
isn't lost to chat history.

Findings: Discovered live during the Tier 3 sandbox test walkthrough. Two real bugs were found
and fixed along the way (PR #19: yt-dlp needs `--js-runtimes` since YouTube's extractor now
requires executing a JS challenge, and our worker image only has Node, not yt-dlp's default
`deno` — fixed by pointing yt-dlp at the worker's own Node binary; PR #20: `JobFailureError`'s
underlying `cause` wasn't surfaced into the Operations event feed, only a generic error code —
fixed by adding a truncated `detail` field). Fixing both did not fix the underlying import: the
real error, only visible after PR #20 shipped, is `HTTP Error 429: Too Many Requests` plus
`Unable to fetch GVS PO Token for web_safari client: Missing required Visitor Data`. Reproducing
the identical yt-dlp call from a home IP succeeded 3/3 times with full metadata; from Railway's
IP it fails immediately. This is YouTube's anti-bot system blocking/throttling known
datacenter/cloud IP ranges harder than residential ones — confirmed as an industry-wide,
escalating problem via the yt-dlp project's own PO Token Guide and open issues (IP-based blocking,
PO tokens "no longer bypass the bot check for the majority of cases" as of 2026), not something
specific to our setup.

A live side-by-side test against Opus Clip (using the exact same failing video, with the
founder's own logged-in account) confirmed competitors have solved this, not avoided it: the
identical URL completed successfully end-to-end in Opus Clip in ~8 minutes. Opus metered the
import hard (49 credits for a 49-minute video, link-paste gated to paid plans only), consistent
with them carrying a real per-fetch infrastructure cost. A vendor ecosystem exists that sells this
capability directly (Apify YouTube-downloader actors bundling residential proxy access, Sieve's
YouTube API), which is corroborating evidence for "buy proxy/vendor capacity" being a normal,
solved-elsewhere approach rather than something requiring novel engineering.

One assumption from earlier discussion was walked back on reflection: connecting a channel via
YouTube OAuth ("connect your channel," which Opus Clip also offers) was initially assumed to be
an arms-race-free alternative fetch mechanism. That's not confirmed — the public YouTube Data API
has no endpoint that returns downloadable video bytes, even for the channel owner, so OAuth more
likely functions as a consent/attribution/publish-back layer stacked on the same underlying fetch
infrastructure, not a replacement for it. Treat OAuth as a separate, complementary decision
(trust/UX/ToS-comfort, and it is still the only way to auto-poll a *specific* church's own
channel without them re-pasting links) rather than a fix for the fetch-reliability problem itself.

Options on the table (not yet decided): (1) buy fetch capacity — either a managed vendor API
(Apify/Sieve-style) behind our own abstraction, or a residential proxy provider (Bright
Data/IPRoyal/Decodo-tier) wired directly into our existing yt-dlp call; (2) cookies from a
dedicated Google account as a cheap near-term stopgap, accepting ToS-gray/fragile status; (3) do
nothing further and treat URL import as effectively non-functional in production until a path is
chosen.

Status: **Resolved same day** by the entry below ("YouTube Import Goes Through a Residential
Proxy"). Kept for the findings and the reproduction detail.

## 2026-07-23 - YouTube Import Goes Through a Residential Proxy; PERC Is the Post-90-Day Cost Path

Decision: Route all yt-dlp traffic through a residential proxy, configured by a new
`YTDLP_PROXY_URL` env var (`src/lib/env.ts`, applied in `src/lib/media/ytdlp.ts` to metadata and
download alike). Unset means direct, which still works from a residential dev machine. Two things
were explicitly **rejected**: (a) a fully-managed fetch vendor (Apify/Sieve-style) as the primary
path, and (b) the two-pass bandwidth optimization described below.

Separately, and not as a substitute: churches retained past ~3 months are intended to migrate to
**PERC** (Pulpit Engine Recording Cloud — the church's streaming platform pushes a copy to a
Cloudflare Stream live input, which records it and exposes a downloadable MP4), which removes
YouTube from the path entirely for those churches and lowers cost further.

Why: URL import is the only intake that scales onboarding — a church can paste a link the day
they sign up, whereas PERC requires them to add an RTMP destination inside their streaming
platform before they see any value. That setup burden is exactly why Pulpit Engine removed PERC as
its default intake (its ADR-0003, 2026-06-15, "too much setup") and put it back only as a
post-launch path (ADR-0006, "~90 days after the first church launches"). So YouTube must work for
acquisition even though PERC is cheaper at steady state; they serve different stages of the same
customer, not competing options.

Proxy over managed vendor: at $49/mo pricing a managed vendor (~$47/church/month for a
90-min Sunday + 50-min Wednesday church) leaves ~4% margin and goes negative for any church
uploading higher-bitrate video; a wholesale residential proxy (~$10/church/month unoptimized)
leaves ~80%. The capability itself is commodity bandwidth, so per the CTO.md build/buy framework
we buy the bandwidth and own the orchestration (the yt-dlp adapter already exists and is tested).

Rejecting the two-pass optimization: the idea was to fetch a low-res proxy copy up front and only
fetch full-quality bytes for the seconds actually published. Investigation showed the pipeline does
split cleanly — TRANSCRIBE reads only the PROBE-produced WAV, ANALYZE only the transcript, and the
review page has no video at all — but the savings and costs don't justify it now: (i) measured
savings are ~2.3x, not the ~5x first estimated, worth roughly $6/church/month; (ii) clip boundaries
extend outward in unbounded 15s steps (`EXTEND_STEP_MS`, `src/components/clip-editor.tsx`) up to
the whole sermon, and the editor loads the full source into a `<video controls>` element, so no
fixed pre-fetch window is safe; (iii) `sourceVideo.width/height` written at FINALIZE drives the
export crop rect (`src/lib/exports/handler.ts`), so probing a low-res proxy would silently
mis-crop every clip; (iv) `cleanup.ts`/`retention.ts` hard-code four storage key columns, so a new
proxy key would leak forever; (v) uploaded (non-URL) sources have no URL to re-fetch, forcing a
permanent second code path; and (vi) it increases the *number* of YouTube round-trips, which is
what triggers blocking, to save bytes — trading reliability for a small cost win on the exact
feature that was broken. Deferred with an explicit trigger: revisit when monthly proxy spend
exceeds ~$200 or church count passes ~25.

Findings that constrain any future work here: format URLs are **IP-locked** — the signed URL
carries an `ip=` parameter inside `sparams`, verified against the real failing video — so
"resolve metadata through the proxy, download direct from the CDN" is not possible, and all bytes
must traverse the proxy. This was an open assumption in the prior entry; it is now settled.

Tradeoff: a recurring per-GB infrastructure cost that scales with usage and must be metered
against plan limits (metering is duration-based today, `estimateProcessingMinutes`, and is
idempotent per job, so it does not need to change for this). Ongoing exposure to YouTube's
escalating countermeasures (PO tokens, SABR) means this path needs periodic maintenance — accepted
deliberately, with PERC as the structural exit for long-tenured churches. Proxy providers are a
new vendor dependency, though a commodity and replaceable one: the integration surface is a single
env var, so switching providers is a config change.

Reversibility: high. `YTDLP_PROXY_URL` unset restores the previous behavior exactly.

Status: Active — code merged and env var documented. **Proof status amended by the 2026-08-11
entry "Residential Proxy Import Is Functionally Proven; Its Economics Remain Unproven": item (1)
below is now satisfied for function but not for economics; item (2) is unchanged.** Two open items:
(1) buy a small amount of residential proxy traffic and confirm a real
import succeeds from Railway before relying on it; (2) PERC's automated MP4 retrieval has never
worked end to end (Pulpit Engine's `current-build-status.md` records the one real recording
returning `download_status = null`, resolved by pasting the URL by hand), so that needs its own
proof before any church is migrated onto it. If Sermon Clipper adopts PERC it should use its own
Cloudflare Stream account, not Pulpit Engine's — unlike the Meta App there is no review process to
reuse, so sharing would add a failure point and buy nothing.

## 2026-08-11 - Repository Stays Public Until P5; Strategy, Margin, and Editorial-Policy Documents Stay Private

Decision: Keep `Jgandara24/sermon-clipper` public through P0–P4. Make it private before the first
P5 commit lands. No GitHub visibility or protection setting changes at P0. P5 is the named trigger
because it is the first phase that implements the proprietary Selector and Review Agent policies.
P0–P4 consists of correctness, provenance, scheduling, cost, review-data, and media-index plumbing
that can remain public.

While the repository is public, never commit the external private `CTO.md`; margin, revenue, scale,
acquisition, or price-positioning plans; or the private implementation plan's full P5 Selector
policy and P6 Review Agent design. The P0.2 public plan copy must replace all protected sections
with pointers to the private planning copy. Technical architecture, editorial invariants, provider
unit costs, technical stage costs, cost gates, code, migrations, tests, `DECISIONS.md`, and sandbox
evidence can be committed normally.

Why: Public repositories support the required branch rules and free, unlimited standard GitHub
Actions minutes. A private repository requires a paid plan to keep the same protection and changes
the included Actions allowance. The heavy P0–P4 implementation sequence benefits from the current
public CI capacity. The repository must become private before proprietary editorial logic enters
history.

Permanence rule: Public git history cannot be retracted. Changing the repository to private later
does not remove indexed copies, archives, or existing public forks. Deferring the visibility change
is safe only because protected documents and policy sections do not enter public history before
the trigger. The `$49` proxy comparison already recorded above is a bounded public fact and cannot
be withdrawn; this decision prevents the private margin, scale, acquisition, and editorial-policy
material from being added or amplified.

Verified state on 2026-08-11: visibility `PUBLIC` with `isPrivate=false`; required checks `verify`,
`integration`, `e2e`, and `worker-image`; strict status checks and administrator enforcement enabled;
force pushes and branch deletion blocked. This supersedes the open-ended revisit instruction in
`docs/DEPLOYMENT.md` that accompanied the 2026-07-16 public visibility change.

P5 entry procedure: activate a paid GitHub plan, change the repository to private, reapply and
verify the saved branch-protection payload, and prove all four checks remain required on one pull
request before any P5 policy commit lands. The current assumption is GitHub Pro at about $4 per
month with 3,000 included Actions minutes. Recheck GitHub features and pricing when the trigger
fires. Do not restore public visibility after proprietary policy enters history.

Tradeoff: P0–P4 source remains publicly visible. This preserves free protected-branch CI during the
largest implementation phase but accepts public exposure of non-proprietary correctness plumbing.
The cost of reversing early is the paid plan and lower included Actions allowance. Going private
earlier is always allowed. Going public again after P5 is not an acceptable rollback.

Status: Active. The trigger is the start of P5.

## 2026-08-11 - Catch-Up Record: ANALYZE Stage A Streams With a 32,000-Token Ceiling

Decision: Recorded after the fact for commit `a4b0ab6` (2026-07-24, PR #23), which changed
recorded ANALYZE behavior without a decision entry. Stage A classification now streams via
`messages.stream` + `finalMessage()` with a 32,000-token ceiling, matching the fix PR #22 applied
to Stage B, and throws a retryable `AnalysisResponseTruncatedError` on a `max_tokens` stop or
unparseable output.

Why: The production retest failed in Stage A with the same signature PR #22 had fixed for Stage B —
`Failed to parse structured output as JSON` at position 14722, which is the ~4,096-token cap of the
`messages.parse` call (4,096 tokens x ~3.6 chars/token is about 14,700 chars). Stage A emits one
classification per candidate window and a full sermon produces up to 500 of them, so the cap was
reached on any real service. The 32,000-token ceiling is provably sufficient: 500 candidates at
about 15 tokens each is roughly 7.5K in the worst case.

Tradeoff: Both analysis stages now use streaming rather than the simpler `messages.parse` helper,
because 32,000 exceeds the SDK's non-streaming guidance. The added `AnalysisResponseTruncatedError`
turns a previously silent failure — classifying nothing and continuing — into a retryable job
failure, which is louder but correct.

Status: Active.

## 2026-08-11 - Catch-Up Record: Candidate Windows Cover the Whole Sermon; Verified 2026-08-11

Decision: Recorded after the fact for commit `c1603cd` (2026-07-24, PR #24), which changed
recorded ANALYZE behavior without a decision entry. Candidate generation changed in three ways.
Each start position now emits at most `DURATION_TARGETS_PER_START = 3` windows at durations evenly
spaced from 20s to 90s, replacing a window at every segment end. When the candidate pool exceeds
the 500 cap it is now **evenly sampled across the whole transcript** rather than truncated at the
front. Stage A survivors are thinned by IoU greater than 0.5 before the fixed
`MAX_STAGE_B_CANDIDATES = 25` slice.

Why: The 2026-07-24 production run exposed the funnel as 500 candidates to 6 scored to 2 kept, with
both kept clips drawn from the opening 90 seconds of a 50-minute service. Front-truncating the
candidate pool meant the analyzer never saw most of the sermon.

Verification (2026-08-11): This change had never been tested against a real service — it was
written in response to the failing run and deployed about 16 hours after it. It has now been
verified by re-importing the same source video (`z4FCS3JcZPs`, 49:41) through the same production
path, as project `Clip Count Retest 8-11` in workspace `Jake's Church`:

- Clips generated: **6**, against 2 before. The configured `targetClipCount` of 6 was met exactly.
  Part of the increase is configuration — the earlier run was in a two-service workspace with a
  target of 3 — so the count is not a clean like-for-like comparison.
- Content: all six are sermon material (Philippians paradoxes, Paul rejoicing in chains, the
  creator-creature distinction, a critique of Mormon theology). The 2026-07-24 run produced two
  announcement clips and never reached the sermon. This change is not explainable by configuration.
- Cost: $0.157 for the analysis stage, against $0.19 before, at 74,662 input and 9,348 output
  tokens across Haiku Stage A and Sonnet Stage B.
- Pipeline: FINALIZE through ANALYZE completed in about 6 minutes for a 50-minute source.
- Transcript coverage was confirmed complete — 978 segments ending at 49:41 against a 49:41 source
  — ruling out silent transcription truncation as a cause of any clustering.

Open issue: coverage is improved but not whole-sermon. All six clips fall between 1:25 and 10:58 of
a 50-minute service; minutes 11 through 50 produced nothing. Analysis metadata shows 500 candidate
windows in and `scoredCount` of 6, so Stage A classification — not window generation and not Stage B
ranking — is the binding constraint, and the candidates it approves cluster early. Whether that is a
defect is not yet established: a sermon's opening states its thesis and may honestly be the most
clippable material. This is recorded as the measured baseline that the P5 Selector work must beat,
and P0.4's charter tests capture it as a named scenario.

Status: Active. The commit's "covering the whole sermon" claim is accurate for candidate generation
and not yet accurate for candidate selection.

## 2026-08-11 - Catch-Up Record: Clip Boundaries Are Edited on a Drag Timeline

Decision: Recorded after the fact for commit `4d51e5d` (2026-07-27, originally `004db2f` before the
authorship rewrite recorded below), which changed the editor without a decision entry. The clip
editor gained a drag-to-trim timeline: new `src/components/editor/clip-timeline.tsx` and pure
boundary math in `src/lib/editor/trim.ts` (`MIN_CLIP_MS` 3,000; viewport padding 15s to 60s;
snap-to-word-boundary; start/end/region clamping). `VideoPreview` gained `onCurrentMsChange` and a
token-keyed external seek.

Why: Boundary adjustment was previously only possible through numeric fields. The timeline was
built self-contained so planned canvas text and banner overlay controls can mount alongside it the
same way.

Tradeoff: The timeline writes only `state.source.startMs` and `state.source.endMs`. It adds no new
edit-state fields, no schema change, and no change to kept-range or word-deletion behavior. This
turns out to align exactly with the continuous-source rule adopted on 2026-08-10: start and end are
permitted edits, and the timeline is the surface that will remain after the word-deletion controls
are removed in P1.4.

Status: Active.

## 2026-08-11 - Residential Proxy Import Is Functionally Proven; Its Economics Remain Unproven

Decision: Amends the proof status recorded in the 2026-07-23 entry "YouTube Import Goes Through a
Residential Proxy; PERC Is the Post-90-Day Cost Path", which stated that the path was "not yet
proven against a real proxy endpoint". Proxy import is now functionally proven: a real 49:41 YouTube
service was imported end to end through `YTDLP_PROXY_URL` in production on 2026-07-24, and again on
2026-08-11. Both runs completed FINALIZE, PROBE, TRANSCRIBE, and ANALYZE.

What remains unproven, and is unchanged: transferred bytes and the contracted price per GB are not
measured anywhere — the yt-dlp path records no byte or cost telemetry, so the roughly $10 per church
per month estimate is still an assumption, not a measurement. PERC's automated MP4 retrieval has
still never worked end to end and has no implementation. The ADR's revisit trigger — monthly proxy
spend above about $200 or church count above about 25 — remains unfired and is now additionally
gated by the P0 cost-truth work, which makes byte measurement a launch gate rather than a
background concern.

Why: The original entry's status conflated "the code path works" with "the economics are
acceptable". Those are separate claims with separate evidence, and only the first is now satisfied.
Recording them separately prevents a future reader from treating one real import as economic
validation.

Status: Active. Supersedes only the proof-status sentence of the 2026-07-23 entry; that entry's
decision, rationale, and revisit trigger stand.

## 2026-08-11 - Agentic Editor Architecture, Editorial Standard, and Plan Are Frozen in the Repository

Decision: The accepted agentic-editor architecture is now recorded in the repository as three
documents. `docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` states what a clip is allowed to be and
governs both the automatic system and human editing. `docs/AGENTIC_EDITOR_REV2_FROZEN.md` is the
architecture of record. `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` is the commit-by-commit plan.
Authority order is: product-owner decisions, then the frozen architecture, then the plan, with the
editorial standard binding on all three.

Three product-owner overrides are recorded as part of the freeze. First, master candidate default
and maximum are built now, together with a hidden per-church override that only platform staff can
change and that no church-facing screen or API response exposes. Second, the human-only reference
period is a fixed full 30 days; it may be extended by an outage but never shortened, superseding the
earlier permission to compress it after two or three services. Third, every delivered clip uses one
continuous source range — this binds the operator's own revisions as well as automatic clips, and
internal word, filler, pause, and repeated-phrase deletion are forbidden at the render boundary
rather than only in the editor.

The plan copy in this repository is sanitized. Revenue and gross-margin projections, the scale
model, price positioning, and the P5 Selector policy and P6 Review Agent design are withheld and
marked in place, per the 2026-08-11 repository-visibility decision. The withheld material lives with
the private planning copy and is added here after the repository becomes private at the start of P5.
Everything the build needs is public: usage profiles, per-stage technical costs, the intake
comparison, the code-enforced cost gates, the measured production anchors, provider price sources,
and the full P0-P4 commit sequence.

Why: An agent cannot learn from review decisions if the system cannot prove which edit version
produced the reviewed file. Freezing the editorial invariants and the phase order before any code
changes means later commits are auditable against a fixed standard instead of a moving one, and it
prevents the correctness work from being quietly relitigated commit by commit. Recording the
overrides in the repository — rather than leaving them in planning conversation — is what makes them
enforceable in review.

Tradeoff: The repository now carries a large planning document that will drift from reality as
P0-P4 lands, and the sanitized copy is deliberately incomplete, so a reader may find pointers to
material they cannot access. Both are accepted. Drift is handled by treating the decision log, not
the plan, as the record of what actually happened; incompleteness is the price of deferring the
go-private trigger to the phase that first produces proprietary editorial logic.

Status: Active.

## 2026-08-12 - Candidate Limits Are Internal Capacity Controls

Decision: The retained candidate-pool limit is an internal Pulpit Engine capacity control. The
application has a master default and hard maximum. Trusted staff can set or clear a hidden
per-workspace override with the operations CLI. The value is stored under the protected
`Workspace.settings.internalOperations` subtree. Church users cannot read or change it through
church settings, routes, or screens. Each staff change creates a workspace-scoped operational
event.

Why: Candidate capacity affects processing cost and the size of the editorial reserve. It is not a
church editing preference or a customer-facing quantity promise. A protected override lets staff
control cost or test a larger pool without adding an unsafe tenant setting.

Tradeoff: This P0.6 control changes the live workspace setting. P0.7 snapshots the effective value
when a project is created, so later master or workspace changes affect only new projects.

Status: Active.

## 2026-08-12 - Project Candidate and Schedule Settings Freeze at Creation

Decision: Each project copies its effective candidate limit, scheduled count, timezone, configured
service weekdays, service frequency, service occurrence, and configuration version into
`Project.processingConfig` when the project is created. Upload, pasted-URL, and automatic channel
imports all use the same snapshot builder. Later master-control or workspace-setting changes affect
only new projects.

Why: Analysis, scheduling, review, and audit code must operate against the configuration that
created a project. Reading live workspace settings would change old project behavior without a
project edit and would make an analysis run impossible to reproduce.

Tradeoff: Existing projects have incomplete snapshots. Defensive readers supply current defaults
for missing fields. Until P1.8, an unmatched service date is still snapshotted as `PRIMARY` by the
existing occurrence derivation.

Status: Active.

## 2026-08-12 - Production Analysis Fails Closed Without Claude

Decision: Development and tests can automatically use deterministic, labeled `heuristic-v1`
analysis when no Claude key exists. Production ANALYZE jobs fail closed when the key is missing,
rejected, the provider is unavailable, or the Claude call fails. The only production fallback is
the exact-string `ANALYSIS_ALLOW_HEURISTIC=true` incident override. Every override use records a
warning operational event and explicit provider, model, selection-reason, and override provenance.

Why: Silent heuristic fallback creates output that appears production-ready without the required
AI analysis and hides a paid-provider outage from operators. Job-time enforcement is necessary
because the web and worker services can have different environments.

Tradeoff: A Claude incident stops normal analysis. An operator can use the visible, time-bounded
override to restore degraded service, but the web readiness check remains failed and affected jobs
remain labeled. The override must be removed after recovery.

Status: Active.

## 2026-08-12 - Processing COGS Facts Are Separate From Customer Minute Entitlements

Decision: All paid-provider and local-compute cost telemetry uses one versioned processing-cost
fact stored in `OperationalEvent.metadata`. A cost fact records stage, quantity, unit price or
unpriced status, provider and model provenance, bytes, CPU and wall time, cache state, attempt, and
workspace/project/clip/job attribution. Cost recording does not read or write `UsageLedger`.

Why: COGS answers what Pulpit Engine spent to process work. The usage ledger answers how many
customer plan minutes were reserved, charged, or refunded. Combining them would corrupt billing
entitlements and make retries or zero-cost local work hard to measure accurately.

Tradeoff: Raw cost facts live in operational-event JSON until Migration Wave 1 adds durable rollup
models and direct clip attribution. A null unit price stays explicitly unpriced and blocks a cost
gate; it is never treated as zero.

Status: Active.

## 2026-08-12 - Proxy Economics Are a Measured Launch Gate

Decision: Each URL-source download records two processing-cost facts. The first records direct or
residential-proxy acquisition bytes. The second records Railway-to-storage egress bytes. Both facts
include source duration, calculated bitrate, elapsed time, attempt, outcome, and automatic-channel
attribution when available. A direct acquisition has a known zero network price. A configured proxy
or Railway egress price uses USD per decimal GB. A missing price stays explicitly unpriced. Stored
proxy data contains only the host name and never contains the proxy URL or credentials.

The residential-proxy ADR's revisit trigger remains monthly proxy spend above about $200 or church
count above about 25. This trigger is now a measured launch gate. Launch evidence must use recorded
bytes and configured prices. An estimate without cost facts does not satisfy the gate.

Why: Functional production imports prove that the proxy path works. They do not prove that its
economics are acceptable. Attributable facts make successful transfers, partial failures, and
retries visible without mixing infrastructure cost with customer minute entitlements.

Tradeoff: The current fact records downloaded file bytes and any partial bytes left by yt-dlp. A
provider can bill more protocol traffic than the final file size. Operators must compare recorded
facts with provider invoices before launch and must keep the configured per-GB prices current.

Status: Active.

## 2026-08-12 - Filler Tags Never Delete Spoken Words by Default

Decision: A filler tag is transcript and editor display metadata only. It does not delete a word.
Low transcription confidence does not create a filler tag and does not create a deletion. A new
editor state keeps every spoken word. Only an explicit word id in `deletedWordIds` changes the
rendered range. The legacy `restoredFillerIds` field remains readable so existing editor documents
still parse.

This decision supersedes only the automatic-filler-removal behavior described in the 2026-07-06
entry "Export Rendering Is A Real Multi-Pass FFmpeg Pipeline". The multi-pass render decision and
explicit legacy edit behavior remain active until P1 removes internal word deletion from delivery.

Why: A confidence score describes the transcription system's certainty. It is not an instruction
to remove what the speaker said. Automatic filler deletion can also change meaning, cadence, and
pastoral tone. Faithful delivery requires the default export to preserve the continuous source.

Tradeoff: Filler tags remain visible as chips, but they no longer shorten a clip automatically.
Existing explicit deletion documents still render for compatibility. P1 must block those edits
from delivery before the continuous-source invariant is fully enforced.

Status: Active.

## 2026-08-12 - Automatic Publishing Requires an Exact Global Positive Enable

Decision: Automatic publication requires the exact environment value
`AUTOMATIC_PUBLISHING_ENABLED=true`. Missing, false, malformed, uppercase, padded, or any other
value disables publication before the publisher reads or claims a due row. This global kill switch
takes precedence over the Meta token, the workspace Page ID, the workspace auto-post flag, and all
later delivery gates. The publisher enforces the switch itself so direct callers cannot bypass it.

The worker records one disabled-state operational event per process-level disabled period. It
continues to inspect and reconcile stale `IN_PROGRESS` claims because reconciliation makes no Meta
request and cannot create a new publish claim. Readiness reports the switch state, but disabled is
a valid ready state.

Why: A repository-visible positive enable gives operators one fail-closed control before schema and
delivery-eligibility changes. It also prevents a configured Meta token or church flag from enabling
publication by itself.

Tradeoff: The switch cannot cancel a Meta request already in flight. Deployment and rollback must
inspect `IN_PROGRESS` rows. Keep the switch false through P1 and P2 sandbox preparation. Use exact
true only for the controlled sandbox publication defined by the implementation plan.

Status: Active.

## 2026-08-12 - Wave 1 Is Expand-First and Historical Exports Stay Unproven

Decision: Agentic Editor Wave 1 adds only forward-compatible nullable fields, new enum values,
new tables, foreign keys, and indexes. Historical `ExportJob.editVersion` values stay null because
the rendered edit identity cannot be proved after the fact. A null edit version is permanently
ineligible for automatic delivery. It is not backfilled from the latest current edit.

Each non-`MISSED` scheduled post reserves its `(workspaceId, scheduledDate)`. `NOT_STARTED`,
`IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `BLOCKED`, and `UNFILLED` all reserve the date. Only `MISSED`
releases it. A slot binds to at most one exact export. The foreign key cannot prove workspace,
project, and clip agreement, so every delivery consumer must also use the shared fail-closed
identity contract.

The schedule enum expansion is a small migration immediately before the main Wave 1 migration.
PostgreSQL requires the new `missed` value to commit before an index predicate can use it. The main
migration omits Prisma's two known invalid transcript-search-vector statements. The local P0.15
census found zero legacy exports and zero date collisions. The production audits are still a hard
deployment precondition and their output is the authoritative production blast radius.

Why: Expand-first schema lets the existing web and worker binaries continue to run while P1 adds
consumers. Guessing legacy identity would recreate the unsafe latest-export behavior. One active
date owner makes a cross-project collision a visible failure instead of a duplicate publication.

Tradeoff: Existing exports cannot become automatically deliverable without a new pinned render.
The additive schema remains in place during an application rollback. Index removal requires a new
forward migration.

Status: Active.

## 2026-08-13 - Plan-Grid Conflicts Are Reported Without Changing Entitlements

Decision: Keep the current Free, Starter, and Pro entitlement values unchanged during P0. Add a
deterministic plan-grid report and source validator. The report measures the current limits against
one weekly 70-minute service, one weekly 90-minute service, and the published light, typical, and
heavy church profiles. A later small decision commit will select any price, included-minute,
maximum-duration, overage, or upload-gate change.

The measured conflicts are: Free grants 60 minutes but permits one 90-minute video; Starter grants
300 minutes but one weekly 70-minute service needs 303.1 minutes per average month; and Starter does
not cover the 358-, 618-, or 878-minute profile midpoints. Pro's 1,200 minutes cover all three
published profile midpoints. The reservation remains a hard block. It does not use the declared
`overageAllowed` field.

Paid-period grants accumulate. `grantMinutesForBillingPeriod` adds a new invoice grant to the
existing balance and does not reset it. Carryover can delay a recurring shortfall, but it does not
remove a steady-state deficit. Prices remain Stripe Price IDs resolved through
`STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`; no dollar amount was added to the plan-limit table.

The upload presign gate checks only `minuteBalance > 0`. It does not know the video duration.
`FINALIZE` calculates the real reservation later, so a low-balance church can transfer a full file
before receiving `INSUFFICIENT_MINUTES`. This is recorded as a small later UX fix, not changed in
this report-only commit.

Why: The current plan grid cannot support its stated limits and church usage in every case. A
measured report makes the conflicts visible without silently changing customer promises or mixing
an engineering audit with a pricing decision.

Status: Superseded by the Trial and Paid decision below. The measured historical conflicts remain
valid evidence for why the old plan grid was removed.

## 2026-08-13 - The Current IPRoyal Contract Fails the YouTube Cost Gate

Decision: Apply the P0.19 hard stop. Do not approve the current YouTube proxy path and do not spend
on a redundant second service until the proxy contract or intake path changes. The actual IPRoyal
residential order was 2 GB for $12.50, or $6.25 per decimal GB. No account, order, payment, or
credential identifier is stored in the repository.

The existing real 49:41 production service has a 392,808,104-byte source object in production
Cloudflare R2. At the contracted proxy rate, stored source bytes alone cost $2.4551 per service,
or $2.9641 per source hour. At 8.66 services per typical month, proxy cost alone is $21.26. Adding
only the measured $0.156798 analysis anchor creates a conservative $22.62 monthly lower bound. The
YouTube-path gate is $12. Protocol overhead and all omitted core stages can only increase this
result.

Production storage is Cloudflare R2 at
`04bed3f430e69de89a54a5ec15ac997a.r2.cloudflarestorage.com`, with contracted direct egress at
$0/GB. This settles the P0 storage-provider and egress question. The complete all-stage Gate A
report remains open because P0.11 and P0.12 telemetry landed after the reference run, and the new
price variables are not deployed in production.

Why: A new paid run cannot turn a lower bound that already exceeds the cap into a pass. Recording
the measured failure prevents an estimate or successful import from being misreported as economic
approval. The next decision must change intake economics before the full real-service run is
useful.

Status: Active. YouTube economics failed. Gate A has not passed.

## 2026-08-13 - Direct Upload Passes the P0 Cost-Truth Gate

Decision: Approve direct upload as the P0 Gate A intake path. One paid production run used the
existing 47:00 service file. It completed direct upload, probe, local transcription, paid Claude
analysis, approval, and one final export. Automatic publishing stayed disabled. The public-safe
report is `evaluation/p0-cost-truth-2026-08-13.json`.

The measured source was 158,665,289 bytes. Proxy bytes and proxy cost per source hour were zero.
Railway egress for the browser-to-R2 transfer cost $0.007933. Core processing cost was corrected
to $0.174481 per service. Total measured cost was $0.182414 per service and $1.579708 per typical church month at
8.66 services. The direct-upload monthly gate is $8.00. Production storage is Cloudflare R2 with
contracted direct egress at $0/GB. All required stages had priced or contract-confirmed zero-cost
facts. Gate A passed.

The paid run used `claude-haiku-4-5` for classification and `claude-sonnet-5` for scoring. It used
92,189 input tokens and 11,130 output tokens. Both totals are within 25 percent of the committed
Run 2 usage anchor. Analysis cost was $0.174481, which is 11.3 percent above the old $0.156798 cost
anchor. The first report used the known September 2026 Sonnet 5 price before it became effective.
The corrected report uses the $2 input and $10 output promotion price that was active on the run
date. Gate A uses
token volume for the cross-run plausibility check. It records actual paid cost separately and
enforces the $1.50 core cost cap.

The successful direct-upload report does not approve the YouTube proxy path. The current IPRoyal
contract still fails its separate $12 monthly gate.

Why: Token volume is comparable across model price changes. Paid cost is not. Using token volume
for the sandbox reconciliation keeps the plausibility check stable. The separate cost caps still
block an uneconomic run.

Status: Active. Direct upload passed Gate A. YouTube proxy intake remains disapproved.

## 2026-08-13 - Use Versioned Per-Stage Model Routing

Decision: Store one active, versioned master analysis policy. The policy selects a provider and a
model for Stage A and Stage B separately. A project copies the exact policy into its processing
configuration when analysis starts. A later master change does not change that project.

Provider credentials stay in environment secrets. A model route cannot become active without an
effective-dated price record. Master changes use an audited command. The system does not select the
cheapest model automatically. A human promotes a tested policy after a shadow benchmark.

Why: Model price and quality change. Static model names prevent safe comparison. Automatic cost
routing can silently reduce editorial quality. Versioned routing permits controlled tests and
reproducible results.

Status: Active. The first policy preserves the Claude production baseline. Google is the first
alternate provider target. OpenAI remains an allowed provider kind for a later adapter.

## 2026-08-13 - Replace Free, Starter, and Pro with Trial and Paid

Decision: The product has two plans. Trial lasts for 30 days. Trial and Paid have the same
capabilities. No card is required during the pilot. When Trial ends, existing work stays visible,
but the workspace cannot start new imports, processing, exports, scheduling, or publishing. Paid
has no published customer usage limit during the pilot.

Keep technical safety limits, rate limits, global switches, cost facts, and cost alerts. Stop using
the minute balance as an access gate. Use one Stripe price named by `STRIPE_PRICE_PAID`. Map old
Starter, Pro, and Development workspaces to Paid. Map old Free workspaces to Trial and keep their
original workspace creation date as the trial start.

Why: The pilot needs simple access and direct observation of real church use. Product limits can be
selected later from measured cost and behavior. Safety controls remain separate from billing.

Status: Active. This decision supersedes the 2026-08-13 P0 plan-grid decision.

## 2026-08-14 - Keep Claude Active After the First Google Shadow Test

Decision: Keep Claude routing policy version 1 active. Keep Google routing policy version 3 as a
draft. Proceed to P1 without activating the Google route. Re-test the route after selector work can
improve full-service coverage.

The paid, no-mutation shadow run used `gemini-3.1-flash-lite` for Stage A and
`claude-sonnet-5` for Stage B. Estimated analysis cost was $0.1211745, which was 30.6 percent below
the $0.174481 Claude Gate A baseline on the same service. However, every scored candidate still
started inside the first quarter of the service. The front-loading defect remains. The public-safe
test facts and the human review are in `evaluation/routing-shadow-2026-08-14.json`.

Why: Lower cost is useful, but cost does not replace editorial coverage. The versioned routing
system permits P1 to continue with the proven Claude baseline while the cheaper Google route stays
available for another controlled test.

Status: Active. Google policy version 3 is not approved for activation.

## 2026-08-14 - A Workspace That Has Paid Never Returns to an Unfinished Trial

Decision: A workspace becomes read-only when its subscription ends, whatever its original trial
window says. `Workspace.paidAt` is the durable marker. It is set when a workspace first becomes
Paid, it survives cancellation, and a subscription that ends on a Paid workspace without one
stamps it. Access reports this state as `lapsed`, separately from `trial_expired`. Read actions,
billing, and settings stay available, so existing work stays visible.

Stripe maps a canceled subscription back to `accessPlan` TRIAL. Without this rule, a church that
upgraded on day 5 and canceled on day 10 kept full free access until day 30. A cancellation must
not refund unused trial days. Stripe's normal cancel-at-period-end flow still delivers the whole
paid period, because it sends `customer.subscription.deleted` only when that period ends.

The accepted trade: a workspace whose first payment does not complete (for example an
authentication step that the church abandons) becomes read-only instead of returning to its
remaining trial days. An operator can extend `trialEndsAt` by hand for a goodwill case. That is a
deliberate act with an audit trail, not a billing loophole.

Why: The 2026-08-13 Trial and Paid decision defines two billing states and one read-only rule. It
does not describe a workspace that paid and then stopped. Reusing the trial window for that case
made cancellation refund free access.

Status: Active. Supersedes nothing; it completes the Trial and Paid access rules.

## 2026-08-14 - Cost Telemetry Never Fails Customer Work; the Gate Enforces Completeness

Decision: Recording a processing cost fact is best effort at every stage. A recording failure
emits one `cost_fact_record_failed` warning event and the work continues. Gate A enforces
completeness instead: a cost-truth report carries `recording.costFactRecordFailures`, and the
validator fails any report where that count is above zero.

Failing a job on a telemetry error was strictly worse for cost truth. The fact was lost anyway,
the customer lost the work, and the retry spent real money again on calls whose facts could fail
again. One failure could also turn a non-retryable oversized-download refusal into a retryable
error, which repeated a paid proxy download.

Why: Cost facts are COGS telemetry, separate from customer entitlements by the 2026-08-12
decision. Telemetry must not destroy customer work or cause repeated paid spend. Completeness
belongs at the evidence gate, where an incomplete report must be rejected.

Status: Active. Cost-truth report schema version 2 adds the recording block.

## 2026-08-16 - Transcription Provider Selection Is Explicit Policy, Not Key Detection

Decision: The target provider policy is base ElevenLabs Scribe v2 primary and whisper.cpp
secondary. The active pair is named by `TRANSCRIPTION_PRIMARY_PROVIDER` and
`TRANSCRIPTION_FALLBACK_PROVIDER`. Selection never follows credential presence. (The defaults now match the target pair — see the
2026-08-19 decision.)

whisper.cpp keeps a second, separate role. The pre-Scribe sermon-boundary stage may run short
local whisper.cpp samples at ambiguous corridor boundaries. That role does not make whisper.cpp
the normal production caption provider.

Sermon-boundary detection is two passes. Before Scribe, use source metadata, audio
classification, scene evidence, and short local whisper.cpp boundary samples to select one
conservative continuous sermon corridor. Send that corridor to Scribe once. After Scribe, use its
transcript, diarization, and audio events to classify precise forbidden regions. A boundary that
stays ambiguous raises a human exception. There is never a silent full-service Scribe fallback.

The fallback provider serves only when the primary cannot: no credential, or a failure mid-job.
Every attempt records its own cost fact, and the downgrade writes a
`transcription_provider_fallback` warning event carrying provider names only, never error text.

Why: A key can exist in an environment for reasons unrelated to captioning production sermons — a
boundary-detection sample, a staging copy, a rotation in progress. Under key detection, any of
those silently redirects a church's sermon audio to a paid external provider. Naming the provider
makes the switch an auditable act, and makes readiness able to report the provider a deployment
actually chose rather than the one whose key it happens to hold.

Tradeoff: Two more variables to set, and a deployment that forgets them keeps whisper.cpp instead
of quietly upgrading. That is the intended failure direction.

Activation preconditions: superseded by the 2026-08-19 decision. Scribe is active. The 250-word
check is satisfied, the retention review is separate work rather than a gate, and the boundary
stage is an efficiency improvement.

Status: Active. Benchmark evidence is in
`evaluation/asr-benchmark-whisper-cpp-vs-scribe-2026-08-16.md`. Scribe corrected all seven
targeted church-language errors that whisper.cpp missed, completed a 47-minute sermon in 47.77
seconds, and produced timing close to the separate forced-alignment result. The no-keyterm output
was 99.42 percent similar to the keyterm output and produced all seven targeted phrases, so the
keyterm surcharge had no measured benefit and keyterms stay opt-in per project.

Cost exposure while the boundary stage is missing: Scribe costs about $0.22 per audio hour, so a
47-minute sermon costs about $0.17 and a 90-minute full service about $0.33. Until the corridor
stage lands, a full-service source is paid for as if worship, announcements, baptisms, prayer, and
altar calls were sermon. Transcription submits the narrowest range already known and records the
submitted duration and scope on every run, so this cost is measured while it lasts.

## 2026-08-18 - Editorial Approval Gates Publishing and Scheduling, Not Manual Export

Decision: A manual MP4 export from the clip editor no longer requires editorial approval.
Publishing and scheduling still do. `isClipApprovedForPublish` and `publishApprovalBlockMessage`
are the one authority for "may this clip reach an audience?", and the route-level
`APPROVAL_REQUIRED` refusal on `POST /api/clips/:id/exports` is removed.

Billing, access, and role enforcement are unchanged. `requireApiWorkspace("EXPORT_CLIP")` still
checks the role permission and still refuses a trial-expired or lapsed read-only workspace with
402. Relocating an editorial gate must not, and does not, weaken an access gate.

An editor save still demotes an APPROVED clip to DRAFT. That rule protects the publish gate,
which still stands: the reviewer approved a specific cut, and the clip is no longer that cut.

Why: A downloaded MP4 reaches no audience by itself. It goes to a member who is already inside
the workspace and already holds EXPORT_CLIP. Requiring approval for it taught people to route
clips through review that they never intended to post, which devalues the approval that guards
real delivery. The old arrangement was also incoherent: the publisher never checked approval at
all, while a saved edit demoted APPROVED to DRAFT and left the earlier SUCCEEDED export
publishable.

Tradeoff: A church that used the export gate as an informal "nobody touches this without the
pastor" control loses it for downloads. The editor still shows why publishing is blocked, so the
review path stays visible; the control now applies where delivery actually happens.

Sequencing: This relocation was scheduled for P1.11/P2.4 in
`docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md`. The export half is now done and the plan is
updated to say so, so P1.11 implements only the publish-side composition and does not
re-implement or re-retain an export gate. P2.4's "only a scheduled or reserve-selected clip can
receive a final export" rule now stands alone rather than beside an approval gate.

Status: Active.

## 2026-08-19 - Scribe v2 Is the Active Primary Provider; whisper.cpp Is the Secondary

Decision: Base ElevenLabs Scribe v2 is the primary transcription provider in every environment,
including production. whisper.cpp is the secondary fallback, and separately the local sampler the
pre-Scribe sermon-boundary pass uses. Scribe is activated now.

The active pair is named by `TRANSCRIPTION_PRIMARY_PROVIDER` and `TRANSCRIPTION_FALLBACK_PROVIDER`
(`scribe` and `whisper_cpp`), and the code defaults match. Selection never follows credential
presence: a key can exist for a boundary sample, a staging copy, or a rotation in progress, and
none of those should redirect sermon audio on their own.

The 250-word human quality comparison is complete. The product owner ran it, Scribe was clearly
better, and the gate is satisfied. The provider retention review is NOT an activation requirement;
it continues as separate work.

Until coarse sermon-boundary detection exists, transcription submits the narrowest sermon range
already known for the source, read from `Project.processingConfig.sermonRange`. When only the
complete service is available, Scribe may temporarily process the complete service. Every
transcription records the submitted duration, the submitted scope, and the resulting cost, so the
price of the missing stage is a measured number rather than an assumption. The boundary stage
remains required for long-term cost and processing efficiency; it is an efficiency improvement,
not an activation gate.

If Scribe cannot serve — no credential, or a failure mid-job — whisper.cpp may produce the
transcript. That downgrade is recorded three ways: a `transcription_provider_fallback` warning
event, the transcript's own provider column, and an OPEN `EditorialException` on the project. The
exception holds the resulting clips: they stay visible and fully editable, but the automatic
publisher refuses them until a person reviews them.

A hold clears automatically only when all three of these hold, checked together inside the clip
rebuild transaction so a failed rebuild clears nothing:

1. the stored transcript came from the configured primary provider;
2. the clips rebuilt successfully;
3. nobody edited, approved, or exported a clip built on the fallback transcript.

If any human work exists from the fallback transcript, the hold stays OPEN for manual
reconciliation and records how much work is waiting. The count runs before the rebuild deletes the
project's clips, because `ClipEdit`, `ClipApproval`, and `ExportJob` all cascade from
`GeneratedClip` — the same transaction that would declare the work reconciled is the one that
destroys it. Only work created at or after the hold opened counts; edits from an earlier, healthy
transcript are not the fallback's business. Every outcome writes its reason, resolved or not.

Why: Scribe corrected all seven targeted church-language errors whisper.cpp missed, produced word
timing close to forced alignment, and finished a 47-minute sermon in about 47 seconds. Quality
first is the stated priority, and the manual comparison settled it. Holding fallback clips rather
than blocking transcription keeps a provider outage from stopping a church's Sunday, while keeping
a lower-quality transcript from reaching an audience unreviewed.

Tradeoff: Sermon audio leaves our infrastructure for an external vendor at about $0.22 per audio
hour, and until the boundary stage lands a full service costs about $0.33 against about $0.17 for
the sermon alone. A named fallback with no credential now fails readiness, because discovering
mid-outage that the fallback does not exist is too late.

Billing, access, editorial review, and publishing safeguards are unchanged by this decision. The
publish hold is added to them; nothing is removed.

Status: Active. Supersedes the activation preconditions in the 2026-08-16 provider-selection
decision. The two-pass boundary sequencing in that decision still stands.

## 2026-08-20 - Neighbouring Words Move Aside for the Active Word, Then Return

Decision: Caption words are laid out at normal spacing. When a word becomes active and pops, its
immediate neighbours move slightly aside for the duration of the pop and return to rest
afterwards. Spacing is never permanently widened, and popped words never overlap their
neighbours' ink.

This amends the 2026-08-13 kinetic caption decision. That decision positioned every word at its
own centre specifically so that "nothing else can move", making reflow impossible by
construction. Motion is now deliberate, bounded, and identical in both renderers — but it is
motion, and the earlier absolute claim no longer holds.

The two rejected alternatives: permanent clearance in every gap (what shipped in the prototype and
what the product owner rejected — a line reads as spaced-out even when nothing is animating), and
bounded overlap at rest spacing (cheapest, but it trades a spacing artefact for a collision
artefact rather than removing both).

Implementation constraint that shapes the work: libass `\t` cannot animate `\pos`. Position is
animated only by `\move`, which is one linear motion per Dialogue event with no acceleration
parameter. A neighbour that moves out and back therefore needs to be split across events rather
than expressed as one transform, and its motion is linear while the active word's scale stays
accelerated. The browser preview must interpolate neighbour offsets linearly to match, even though
it interpolates the pop itself on the shared accelerated curve.

Tradeoff: event count per word rises from at most three to roughly seven to nine, because every
word is a neighbour twice as well as being active once. libass handles thousands of events and
x264 dominates render cost, so this is expected to be affordable — but "expected" is not "proven",
which is why this ships as its own slice with a real render test rather than as part of the
caption control cleanup.

Status: Active. Preview and export must be proven to agree frame for frame before the slice lands;
if the real render shows the split-event motion is not smooth, the fallback is a stepped shift
(neighbour jumps aside for the pop and back afterwards, no interpolation), recorded here so the
retreat is a decision rather than a surprise.

## 2026-08-20 - Timeline Thumbnails Stay Browser-Side Until P4

Decision: The timeline's video row keeps extracting frames in the browser, hardened: wait for a
decoded frame rather than assuming a seek is complete, retry a failed seek, and show a neutral
placeholder when extraction fails. A frame that cannot be produced must never render as a
plausible-looking wrong image.

Worker-generated filmstrips remain the P4 plan's `timeline_view` work, where the derived-artifact
storage key and its retention class are already accounted for.

Why: the defect the product owner saw — a blue strip instead of recognisable frames — is a
missing-decoded-frame bug, not evidence that browser extraction cannot work. Pulling the worker
filmstrip forward would drag a storage-retention decision into a UI slice, and an unregistered
storage key leaks forever.

Tradeoff: extraction stays browser-dependent and spends the viewer's bandwidth and CPU on a full
sermon. That cost is accepted until P4 supplies the shared proxy.

Status: Active.

## 2026-08-20 - An Export Renders Its Requested Edit Version or It Fails

Decision: `ExportJob.editVersion` is authoritative for what a render contains. The export route
selects the version once, `enqueueExportJob` stores it and derives the idempotency key from that
same number, and the worker loads exactly that `ClipEdit`. There is no newest-edit fallback.

Version `0` means the clip was never edited and renders the default editor state. A job whose
version is null, not a non-negative integer, names a `ClipEdit` that no longer exists, or stores a
document that is not an object fails closed with a stable code:

- `EXPORT_EDIT_VERSION_MISSING`
- `EXPORT_EDIT_VERSION_NOT_FOUND`
- `EXPORT_EDIT_VERSION_UNREADABLE`

Each of these is terminal. The worker fails the job outright instead of spending its remaining
attempts on a failure that cannot change. A manual retry reuses the same row, so it stays pinned to
the version originally requested.

Why: the previous code computed the version for the idempotency key and then discarded it, so the
worker rendered whatever was newest when it started. A user could request version 1, save version 2
before the worker picked the job up, and download version 2 under a key that claimed version 1.
Removing the manual-export approval gate (PR #40) made that one click away, and a wrong render that
looks plausible is worse than a refused one: a church can publish it without noticing.

Tradeoff: export jobs written before this change carry a null `editVersion` and now fail instead of
rendering. That is the intended direction — a legacy job cannot prove what it was meant to contain,
and the user can export again from the editor in one click.

Status: Active.

## 2026-08-20 - A Transcript Correction Changes What A Word Says, Never What The Clip Contains

Decision: The transcript panel edits text and nothing else. Clicking a word seeks the playhead to
that word's own start time and opens it for correction in place; `editor_state` gains
`wordEdits.textOverrides`, an array of `{ wordId, text }` keyed by the same positional word id
(`segmentId:index`) that deletions already use. A correction never changes a word's id, never
changes its start or end, and never changes `source.startMs`/`source.endMs`. The transcript the
transcription produced is never rewritten — the override sits in the editor document beside it.

The word-delete control is removed. The editor can no longer create an internal cut. A document
that already carries `deletedWordIds` still renders those words struck through and still cuts them
at export, and gains one explicit "Restore all deleted words" control so the clip can be put back
on a continuous range. That restore is a versioned edit the user asks for, never a background
migration: word ids are positional, so a silent rewrite could repoint them at different words.

The floating selected-word action box from the not-accepted canvas-desk prototype (`5b687ca`) is
not reinstated. Its "Set clip start" and "Set clip end" buttons are precisely the coupling this
decision removes — they let a click in the transcript retime the clip.

Why: the 2026-08-12 entry "Filler Tags Never Delete Spoken Words by Default" recorded that faithful
delivery requires preserving the continuous source, and left P1 to block internal word deletion
from delivery. Correcting a mis-transcribed word is the thing a transcript is actually needed for,
and it is separable from trimming. Keeping them apart means a click on a word can never surprise
someone by shortening the sermon, and the timeline stays the single surface where clip length
changes.

Tradeoff: corrections are keyed by positional word id, so re-transcribing a source repoints them —
the same exposure `deletedWordIds` already carries, not a new one. An empty correction is refused: a
word can be changed but not removed, because removing a word is a cut. `textOverrides` is defaulted
to `[]` in the schema so older documents parse unchanged, but the editor page hands stored JSON to
the client without parsing it, so readers must tolerate the field being absent rather than trust the
default. This does not implement P1.4's export-side `CONTINUOUS_RANGE_REQUIRED` gate, which still
lives unmerged on `p1/kinetic-captions-and-editor`; a legacy document's existing cuts still render
until that lands or the user restores them.

Status: Active. Implements Slice 5 of `docs/EDITOR_DELTA_PLAN_2026-08-18.md`.

## 2026-08-20 - The P1.4 Continuous-Range Export Gate Landed Early, With Slice 5

Decision: the export-side continuous-range gate is implemented and active now, in the same change
that removed the word-delete control. **P1.4 must not implement it a second time.** What remains of
P1.4 when it is picked up is the prototype branch's other work, not this gate.

What landed:

- `CONTINUOUS_RANGE_REQUIRED`, a stable code in `src/lib/exports/continuous-range.ts`, alongside the
  `EXPORT_EDIT_VERSION_*` codes it sits beside.
- The **worker** validates the *pinned* editor state — the same document P1.1 pins onto the job —
  before it downloads the source, probes it, or starts ffmpeg. This is the check that binds. It
  catches a job queued before the rule existed, a retry of one, and any other path that reaches the
  worker. The failure is terminal, so a refusal never spends the attempt budget.
- The **route** answers the same question at request time so the user gets an immediate 409 instead
  of watching a job fail. It runs before the idempotency lookup, so re-requesting an already-queued
  cut export is refused too. This is convenience, not the guarantee.
- Refusal is decided against the kept ranges the renderer itself derives, not against the presence
  of a deleted word id. A cut outside the clip's range removes nothing from the render, and refusing
  that export would be a refusal the user could do nothing about.
- A document with nothing deleted answers without reading the transcript, which is every clip made
  since the delete control was removed.

Why now rather than in P1.4: removing the delete control without the gate would have left existing
cuts unreachable in the editor while they still shortened the export — the user could see the
strike-through, could no longer act on it through the old control, and would still receive a
shortened video. The restore control and the gate are the same guarantee from two sides, so they
ship together.

Nothing is repaired automatically. A refused export leaves the stored document exactly as it was;
only the user's own "Restore all deleted words" clears the cuts, and that is a versioned edit that
goes through the ordinary autosave and undo history. Word ids are positional, so a silent rewrite
could repoint them at different words.

This supersedes one sentence of the 2026-08-20 entry "A Transcript Correction Changes What A Word
Says, Never What The Clip Contains" — the sentence stating that the change "does not implement
P1.4's export-side `CONTINUOUS_RANGE_REQUIRED` gate". It does. The rest of that entry stands.

Status: Active.

## 2026-08-21 - A Caption Carries A Point On The Canvas; How The Canvas Is Viewed Is Never Saved

Decision: a caption is a direct-manipulation object. It is selected by clicking it on the video,
dragged to any point, and scaled from four corner handles. `captions.overrides.box` stores that
point as `{ xPct, yPct }` — fractions of the frame — and a corner resize writes the existing
`sizePx`. A caption has no independent width and height to drag; the text decides those, so what a
corner handle controls is how big the type is.

`box` is optional and absent by default. Without it the discrete `position` decides, the ASS
generator emits no positioning override at all, and every clip made before direct manipulation
renders byte-identically to how it always did. With it, the burn-in emits `\an5\pos(x,y)` — the
same point the preview draws at, so the two cannot disagree.

**Zoom and pan are view state and are never written to the document.** They live in the component,
not in `editor_state`. The one place the view and the document meet is `pointerToCanvasPct`, which
undoes the viewport on the way in, so dragging an object to the same visible place produces the
same saved coordinate at 100% and at 400%. `canvasTransform` and its inverse sit beside each other
in `src/lib/editor/canvas.ts` for exactly that reason: the inverse is only correct while it undoes
that transform, and separating them would let the two drift.

Guides — safe zones, the centre-snap guide — and the selection border and handles are DOM in the
editor and have no representation in an ASS subtitle file. There is no path by which one could
reach a rendered video; that is a property of the architecture, not a filter applied at render time.

Canvas zoom is separate from the trim timeline's window. They are different views of different
things (a frame and a stretch of time) and share no state.

Why the module and the component are written without mentioning captions: Slice 9's title overlay
is the second object on this canvas. `src/lib/editor/canvas.ts` and
`src/components/editor/canvas-object.tsx` are the reusable half, and Slice 9 is meant to mount them
rather than grow a parallel implementation. Slice 6 deliberately stops short of the title itself.

Tradeoff: a dragged caption is positioned absolutely, so it no longer reflows with the frame's
margins the way an alignment-and-margin caption does — a caption dropped near an edge stays near
that edge. That is what direct manipulation means, and the safe-zone guides exist to make the
consequence visible while editing. Pinch-to-zoom claims two-finger gestures over the canvas, so a
two-finger page scroll started on the video zooms instead; the canvas is one screen-height tall at
most, and scrolling from anywhere else on the page is unaffected.

Status: Active. Implements Slice 6 of `docs/EDITOR_DELTA_PLAN_2026-08-18.md`.

## 2026-08-21 - The Playhead Owns The Strip Above The Track; The Trim Handles Own The Track

Decision: the playhead's pointer target is a knob sitting immediately above the timeline track. The
trim handles keep the track itself. The two share no pixels, so neither can take a gesture aimed at
the other. The red line the playhead draws is decoration only and takes no pointer at all.

Why: the playhead and a trim handle occupied identical pixels whenever the playhead was parked at a
clip edge — which is where it sits when the editor opens, and again after "Go to end". Both claimed
the full height of the track at the same horizontal position. The handle was deliberately stacked on
top (2026-08-20, Slice 4: trimming is the timeline's primary control, and the playhead had been
swallowing presses meant for a handle), so every press aimed at the playhead at an edge reached the
handle instead. **Trying to scrub from the start of a clip trimmed it.** Measured on a 0–4,000 ms
clip: the start moved to 954 ms and the editor wrote a new `ClipEdit`, which invalidates an
editorial approval.

That write is why the guarding test looked flaky. `dragging the playhead does not save a new
version` asserts the `ClipEdit` count straight after the drag, and the trim's save is idle-debounced
— measured at 0 rows 100 ms after the gesture and 1 row four seconds later. The defect was
deterministic; only whether the write had landed by assertion time varied. The test was right every
time it failed, and right every time it passed.

Separating the targets settles both defects at once rather than trading one for the other: Slice 4's
rule stands untouched, and the playhead becomes reachable at an edge for the first time.

Tradeoff: the knob sits outside the track, so the track needs clearance above it and the timeline is
a little taller. The knob is a 16 px circle rather than the full height of the track, which is a
smaller target than the handles have — acceptable, because clicking anywhere on the track already
seeks, so dragging the knob is the precise gesture rather than the only one.

Status: Active.

## 2026-08-21 - CI Runs The End-To-End Suite Against A Built Application

Decision: CI builds the application in its own workflow step and points Playwright's web server at
`npm run start`. Local runs keep `npm run dev`. The suite signs in by creating a real `AuthSession`
row and setting the session cookie that holds its token — the same pair the application creates
when a visitor completes an email one-time code.

Why: a cold `next dev` start has to compile the first route before the URL answers, and CI kept
timing out at `config.webServer` on commits that had passed minutes earlier on another branch. The
timeout was already raised once, 120s to 300s, and that theory was wrong — a later failure hit the
300s ceiling too. A built server has nothing left to compile and answered in under half a second on
every run measured here (393 ms, 395 ms, 421 ms). Next's own testing guide recommends running
end-to-end tests against production code for the same reason.

That switch was blocked by authentication. Every spec set `DEV_SESSION_COOKIE`, which
`getCurrentUser` reads only behind `process.env.NODE_ENV !== "production"`, so the branch is
dead-code-eliminated from a production build. This is not a deduction from the bundle: with the dev
cookie unchanged, the built server served the login page instead of the dashboard.

The alternative was an escape hatch beside that gate — a new environment variable read in
production code purely so tests could bypass login, plus a readiness check to make sure it was
never set in production. Creating a real session needs none of that. No product code changed, no
new environment variable exists, and the suite now travels the exact path production uses, so an
expired session and a revoked session are covered for the first time.

Building the application also exposed two production behaviours the development server had been
hiding. Signed media URLs refuse to fall back to a development secret, and `POST
/api/videos/[id]/srt` drains pending jobs in-process, which puts `ANALYZE` inside the web server —
where production refuses the heuristic analyzer unless `ANALYSIS_ALLOW_HEURISTIC` is set. With no
provider key configured the job parked in `RETRYING` with `ANALYZE_PROVIDER_UNAVAILABLE` and the
project never left `PROCESSING`. Both are now supplied to the end-to-end server through
`playwright.config.ts`, beside the `WHISPER_MODEL_PATH` that was already there.

Tradeoff: a pull request now builds the application twice, once in `verify` and once in `e2e`, for
roughly a minute of extra runner time — paid to remove a failure mode that has cost whole runs.
CI no longer exercises `next dev`, so a defect that appears only under the development server would
have to be caught locally, where `next dev` remains the default. `MEDIA_URL_SECRET` is generated
per run and never leaves the process tree, so a media URL captured from one run signs nothing in
the next.

Status: Active.

## 2026-08-21 - One Resolver Decides The Highlighted Word, And Retired Presets Keep Rendering

Decision: exactly one word is highlighted at any timestamp, and the same function decides which one
in the browser preview and in the burned-in render. `src/lib/editor/active-word.ts` is that
function. The preview asks it per frame; the export asks it once per stretch, through
`highlightSlices`, and emits one subtitle event per stretch with the active word coloured.

Source word intervals overlap — forced alignment and ASR both emit spans that run into each other —
so "which word is active" needs a total rule, not a `find`. Among the words covering an instant,
the one that started most recently wins; ties break on the shorter interval and then on position.
Those tie-breaks are arbitrary but fixed. What matters is that the answer is single and stable: a
caption that lights one word on screen and a different word in the file is worse than one that
lights neither.

**The picker offers Clean and Highlighter. Nothing else is removed.** `bold-serif`, `karaoke` and
`quiet` keep their exact styles and still resolve by id, so a clip a church already approved
renders as it always did. Retiring a preset from the picker is not a reason to change delivered
work. Highlighter is new: Neon Yellow (`#CCFF00`) on the bottom safe band, uppercase, weight 800.

**Uppercase is the default for new content only.** It lands in `buildDefaultEditorState`, not in a
preset, so a stored document that carries no case still falls back to its preset's case and does
not change. The one edge this leaves: a clip created before today, never edited, and exported for
the first time after today renders uppercase, because a version-0 export builds the default state
at render time. That clip has no saved appearance to preserve, and the alternative — putting the
default on the Clean preset — would change every existing Clean clip instead.

X and Y position fields are gone; the canvas from Slice 6 is the position control. Font moves into
the main Captions section. Every numeric control is a slider paired with a number field, both
writing through one handler so they cannot drift; `src/lib/editor/numeric-field.ts` owns what a
typed value means, including that an emptied field is "no override" rather than zero.

Words are laid out at rest spacing. The highlight is a colour change and nothing else — no
reserved clearance, no scale, no shift — so a line with no active word is laid out exactly like a
line with one. Moving a word's neighbours is Slice 8's work and is deliberately absent here; the
export test asserts that by refusing every ASS animation and scaling tag.

Tradeoff: per-word highlighting multiplies subtitle events — one per stretch instead of one per
line — which makes the ASS file larger and slightly slows libass. A line the member has retyped
no longer corresponds to its words, so it renders whole and unhighlighted rather than guessing an
alignment. Font weight has no direct equivalent in ASS, which knows only bold or not, so 600 and
above renders bold and everything below renders regular; the browser shows the true weight.

Status: Active. Implements Slice 7 of `docs/EDITOR_DELTA_PLAN_2026-08-18.md`.

## 2026-08-21 - Highlighting And Weight Belong To Highlighter, Not To Every Clip

Decision: per-word colour, the pop, and a heavy default weight are properties of the Highlighter
preset. `activeWordHighlight` on the resolved caption style decides them, and it is true for
Highlighter alone. `weight` is optional: every preset that predates this slice leaves it unset,
which renders as an unset browser weight and ASS `Bold=0` — exactly what `origin/main` produced.
An explicit weight in a saved document still wins, for any preset.

Why: the first version of this slice gave `clean`, `bold-serif` and `karaoke` a weight of 700 and
`quiet` 500, and applied the active-word colour to every preset. Both change clips that already
exist. 700 crosses the `>= 600` threshold that maps to ASS bold, so every Clean clip a church had
already approved would have re-rendered bold, and every one of them would have gained a coloured
word the member never asked for. Hiding a preset from the picker was already understood not to
license changing its output; adding a property to it is the same thing by another route.

The supersession is narrow and worth stating plainly: the entry above this one says the highlight
is "a colour change and nothing else — no reserved clearance, no scale, no shift". The colour and
the scale are both here now, on the active Highlighter word. What that entry was right about, and
what still holds, is that **no width is reserved and no neighbour moves**. The plan removes the
permanent maximum-pop clearance in this slice and gives the neighbour micro-shift to Slice 8; it
does not remove the pop. Until Slice 8 lands, an active word can overlap its neighbours slightly
at large sizes, which the plan calls out as a deliberate short-lived state.

`src/lib/editor/caption-animation.ts` holds the curve, and both renderers evaluate it: the preview
per frame, the burn-in as libass `\t` transforms on the active word's run only. Its numbers — rise
90 ms to 1.18, settle 120 ms to 1.06, then flat — are a starting point for the manual visual pass,
not a measured result, and they are in one constant so that pass can move them once.

Caption lines are now mutually exclusive in time. A line ended at its last word's end, and source
word intervals overlap, so the last word of one line could still be running when the first word of
the next had started: two lines on screen, the burn-in lighting a word in each while the preview,
which takes the first line matching the instant, showed one. Each line now ends where the next
begins. The words are untouched; only the line's own span moves, and only ever earlier.

Uppercase is no longer a default for new documents. A version-0 clip is rendered by building the
default document at export time, so anything set there reaches clips that already exist and were
never edited. The previous entry accepted that as a known exception; it is not one we are keeping.
Uppercase now arrives by choosing Highlighter, which carries it in its own style. The cost is
explicit: a genuinely new clip no longer starts in Uppercase, because at version 0 nothing
distinguishes a new clip from an old one.

The font picker offers only what the render host has. `fc-list` inside the built worker image
reports three families — DejaVu Sans, DejaVu Serif, DejaVu Sans Mono — and none of Inter, Georgia,
Arial Black or Courier New. libass substitutes silently, so a member choosing Georgia was getting
something else in the file they published, with nothing to tell them. `Dockerfile.worker` now
installs those faces by name and fails the build if any stops resolving. Preset font stacks are
deliberately left alone: changing them would change existing clips, which is the defect this entry
is about.

Typed numbers snap to their control's step. A range input normalises what it is given, so typing
350 into a 100-900 field stepping by 100 left the number field on 350 while Chromium put the
slider on 400 and the document saved a third value.

Tradeoff: the pop puts scale tags on every highlighted event, which grows the ASS file and gives
libass more to interpolate. The font list is shorter and plainer than the one it replaces, and its
faces are not the ones a designer would pick — but they are the ones that survive the render.

Status: Active. Corrects the entry above it; supersedes its "no scale" and default-Uppercase
statements only.

## 2026-08-21 - What Slice 7 Actually Settled, After Three Rounds Of Correction

Decision: this entry supersedes specific statements in the two entries above it. Those stay as
written — the record of what was believed when it was believed is worth more than a tidy file —
but where they conflict with this, this is what the code does.

**Uppercase for new content lives in ANALYZE, not in the default document.** The entry above says
uppercase is no longer a default for new documents and arrives only by choosing Highlighter. That
was the safe half of the answer, and it gave up the requirement. `buildDefaultEditorState` still
carries no case, because it is also the fallback for a clip that predates the default and must keep
rendering what it always rendered. `buildInitialEditorState` carries it instead, and ANALYZE — the
only production path that creates a generated clip — writes it as the clip's first `ClipEdit` at
`INITIAL_EDIT_VERSION`, unsigned. New clips get Uppercase; a clip with no document is untouched;
no date cutoff decides anything.

That had a consequence nobody wanted. `settleTranscriptionFallbackHold` counts a `ClipEdit` as
human work, so every rebuilt clip arrived already looking edited and a healthy re-transcription
could never close the hold it opened. The count now excludes an unsigned row at the initial
version, which is exactly the shape the machine writes and never the shape a person's save takes.
The stored document also stamps the same version as its row; it had been writing 0 inside a row
numbered 1.

**The pop is timed by the activation, and it rises, settles and returns.** The entry above
describes a single transform that rises to a peak and holds, and says the settle was deferred.
Both are superseded. Holding at 1.18 until the highlight moved was not a pop — it ended in a snap.

Two things make the curve one curve rather than two that resemble each other. Word intervals nest:
"alpha" can run 0–1000ms with "beta" inside it at 200–400ms, so alpha is active, then beta, then
alpha again. Timed from alpha's own start, that second activation is already 400ms old; timed from
the event drawing it, it has just begun. The activation is the clock — both renderers measure from
the start of the `HighlightSlice`. And because two `\t` over one property have no agreed meaning
across renderers, each phase is its own Dialogue event carrying a single transform from a starting
value it states, rather than several transforms layered in one event.

A short activation cannot fit every phase. The return is reserved first out of whatever time
exists, because a word cut off at full size is the snap this was meant to remove; rise and settle
take what is left, and the return starts from wherever the curve actually reached.

**A retyped caption keeps its timings when only the words changed.** The entry above says the
line's span is divided evenly among the tokens as typed, full stop, and calls losing the source
timing the honest cost. It is the honest cost of a rewrite, not of a typo. The same number of
tokens is a correction: each token keeps the timing of the word it replaces. A changed count is a
rewrite, where no correspondence survives, and keeps the even division.

**Mutually exclusive line spans are Highlighter's alone.** Stated in the entry above and unchanged,
recorded here because it is easy to lose: `buildCaptionLines` produces the spans it always
produced, and `exclusiveLineSpans` is applied by the burn-in and the preview only when the resolved
style highlights. Clipping every line shortened Clean's captions — measured at 2.40s against
2.60s on an overlapping transcript — and a clip a church approved would have burned in with
different timings.

**The bundled faces are the only copy.** The entry above says the faces are bundled and the image
build gates on fontconfig resolving them. Half of that shipped broken and the gate caught it:
ffmpeg pulls `fonts-dejavu-core` in transitively, so the image carried two copies of every family
and fontconfig chose the distribution one. The burn-in would have drawn a file the browser never
loaded — the defect bundling exists to prevent, hiding inside the fix for it. The distribution
directory is removed at build time, and the gate asserts each family resolves to a file under
`/usr/share/fonts/truetype/sermon-clipper`, not merely that it resolves.

**Every caption word is an inline block, not only the active one.** This landed inside a commit
whose message is about waiting for fonts in a test, so it is recorded here as the product change it
is. A span that changes `display` changes the line's layout, so scaling only the active word moved
the line by 23.67px — the pop has to be a transform, which does not affect layout, over a display
that never changes. Rest spacing is now identical whether or not anything is active, which is what
the slice promised and what the guarding test measures.

Tradeoff: the phase split multiplies subtitle events again — one per phase of each activation
rather than one per activation — which grows the ASS file and gives libass more to interpolate.
Bundling the faces also puts about 2.8MB of font files in the repository and a webfont load in
front of the first caption paint; anything measuring a caption has to wait for
`document.fonts.ready` or it measures the fallback's metrics, which cost one real defect and one
misdiagnosis before it was written down.

Status: Active. Supersedes the two entries above it on uppercase defaults, retyped-caption timing,
and the pop curve; confirms them on exclusive line spans and bundled fonts.

## 2026-08-21 - Provenance Belongs In The Document, And Parity Belongs At The File's Resolution

Decision: two narrow corrections to the entry above it. Everything else there stands.

**A system-created document says so in the document.** That entry says the fallback hold excludes
"an unsigned row at the initial version, which is exactly the shape the machine writes and never
the shape a person's save takes". The second half was wrong. `ClipEdit.savedBy` is ON DELETE SET
NULL, so a person's first edit on a clip that predates the initial document becomes unsigned at
version 1 the moment their account is removed — indistinguishable from the machine's row, and their
work would have stopped counting exactly when they left.

The document carries `systemInitial: true`, written only by `buildInitialEditorState` and stripped
by the save route so a client cannot forge it onto a person's edit. Deleting a user does not reach
inside a stored document, so the distinction survives what `savedBy` does not.

The count also moved out of SQL. A JSON filter for "not the machine's document" is a NOT over a
comparison that is NULL for every row without the key, and in SQL that excludes the rows it was
meant to find — every human edit. The rows are fetched and filtered in code, which says what is
meant and is what the tests actually exercise.

**Parity holds at the resolution the file has, not at the resolution the browser has.** An ASS
timestamp is centiseconds and an ASS scale is whole percent. The preview has neither limit, so a
curve agreed "exactly" still came apart: an activation running 3ms to 203ms is written as 0ms to
200ms, and at 201ms the browser was still drawing one word while the file had moved to the next.
Partial phases had the same problem in the other axis — a rise that only half happens reaches
1.0329 in the browser and is written as 103.

So the quantisation happens once, before either renderer draws: `quantisePopTime` to the
centisecond, `quantisePopScale` to whole percent, and `quantisedHighlightSlices` as the single set
of stretches both renderers select from. Within a phase both then evaluate the same endpoints over
the same span with the same exponent, so they agree at every millisecond rather than nearly.

Choosing whole percent rather than decimal `\fscx` is deliberate: decimal scale syntax would have
needed proving against the worker's own libass build before it could be relied on, and rounding
both sides to what every renderer certainly accepts needs no such proof.

Tradeoff: an activation shorter than a centisecond disappears from the highlight rather than
flickering for a frame, and every pop boundary is now up to 5ms from where the transcript put it.
Both are below what anyone can see, and both are the price of the preview and the file agreeing
about which word is lit.

Status: Active. Corrects the entry above it on how a system document is recognised and on what
"the same curve" means.

## 2026-08-21 - Human Work Is Counted In The Database, Not Loaded Into Code

Decision: one narrow correction to the entry above it. Everything else there stands.

That entry says the fallback hold's rows "are fetched and filtered in code". That is not how it
ships. Loading every stored editor state since the hold opened transfers documents the count never
needs — autosaves and overlays make that unbounded — and the last Slice 7 commit moved the count
back into the database without the negative JSON filter that made the first attempt wrong.

The method, as `settleTranscriptionFallbackHold` now does it:

- Count every `ClipEdit` in the project since the hold opened.
- Count the machine's documents with a positive JSON comparison:
  `editorState.systemInitial` equals `true`. Asked positively, a row without the key is simply
  not a match, which is the answer wanted; asked negatively it was NULL, which excluded exactly
  the human edits.
- Human edits are the first count minus the second.
- No `editorState` document is transferred.

Status: Active. Supersedes the entry above it on one statement only: where the fallback hold's
human-edit count happens.

## 2026-08-21 - A Slice Estimates Against The Branch It Is Built On

Decision: §1 of `docs/EDITOR_DELTA_PLAN_2026-08-18.md` is corrected to the verified state of
`origin/main` at `276d3fd`, and Slices 8 and 9 are re-scoped against it. No other slice changes.

The original §1 listed nine modules and behaviours as "already true in the baseline":
`caption-animation.ts`, `caption-layout.ts`, `font-metrics.ts`, `use-text-measurer.ts`,
`social-safe-area.ts`, `panel-resize.ts`, `document-history.ts`, `title-banner.ts`, and the
`activeCaptionWordId` / `exclusiveCaptionWordEnds` pair. Every one of them lives only on the
unmerged prototype branch `p1/kinetic-captions-and-editor`, which the plan names as the thing it
is a delta against. The slices were built on `origin/main`, where none of them existed. The row
claiming Clean did not animate was also untrue until Slice 7 made it so.

Slice 7 found this when it went to wire the pop curve and had to write `caption-animation.ts`,
`active-word.ts` and `caption-timeline.ts` instead. Two of the nine are now true under other
names (`history.ts` from Slice 2; the active-word resolver from Slice 7); one was true all along
(export policy); the rest are still absent.

The consequence for the work ahead: Slice 8 must create a measured, shared caption layout before
any word can move, and Slice 9 must create the title-banner model, a safe-area datum, a track, a
panel and a burn-in path before it can set defaults on them. Both are larger than planned, and the
plan now says so.

The rule: a plan's baseline is the branch the work will be built on, verified by reading that
branch's tree, not the branch the plan was drafted from. Every future slice estimate states what
it must create, and that statement comes from `git ls-tree` against the target, not from the
plan's own history.

Status: Active. Corrects the plan's baseline; does not supersede any prior entry.

## 2026-08-21 - Corrections To The Baseline Entry, And A Disk-Floor Failure

Decision: the entry above it stands in its conclusion — slices estimate against the verified
tree of the branch they are built on — and is corrected on six statements. Nothing in it is
edited; this entry says what was wrong.

**Nine claims, not nine modules.** The original §1 made nine claims about the baseline. Seven of
them named modules and one named two symbols; the ninth (export policy) named no artifact at
all. The entry above counted "nine modules", which is not what §1 said.

**The time scope.** The entry above says every one of those modules "lives only on the unmerged
prototype branch". The accurate statement is about a point in time: before Slice 1, the target
branch `origin/main` lacked every one of the exact prototype artifacts the claims named. Since
then the slices have built some of those behaviours on `main`. The tally on `origin/main` at
`276d3fd`: five of the nine claims are true. Four became true through the completed slices —
history (`history.ts`, Slice 2), active-word resolution (`resolveActiveWord` and
`exclusiveLineSpans`, Slice 7), the shared pop curve (`caption-animation.ts` and
`caption-timeline.ts`, Slice 7), and the Clean/Highlighter preset set (Slice 7). One was true all
along by other means: export policy. Four remain absent: measured shared layout, a safe-area
datum, panel resizing, and the title-banner model. The entry above said "the rest are still
absent" after counting three, which implied six.

**"Clean does not animate".** The entry above says this "was also untrue until Slice 7 made it
so". Before Slice 7, `main` had no Highlighter, offered four presets, and highlighted nothing in
either renderer — so the statement held trivially. What was untrue before Slice 7 was the
surrounding claim: "only Clean and Highlighter are offered" and "Highlighter is neon yellow,
word-by-word". Slice 7 made those true.

**"Exactly one active word" is "at most one".** `resolveActiveWord` returns the single covering
word, or `null` before the first interval, after the last, and in any gap between intervals. It
is deterministic, not total over time. The corrected §1 row says so and cites the commits:
`active-word.ts` in `631870c`, `exclusiveLineSpans` in `94c6601`.

**§7 was stale on P1.1.** It said nothing writes or reads `ExportJob.editVersion`. PR #42
(`62815d2`, merged `9c0e8fc`, 2026-08-20) writes it in the exports route and reads it through
`loadPinnedEditorState` in `runExportJob`. P1.1 is done; P1.2 and P1.3 remain. Corrected in the
plan.

**Panel dividers belong to Slice 12**, not Slice 10, and the narrow fact is that there is no
panel-resize module or panel-width arithmetic — not that there is "no resize arithmetic anywhere
under `src/`", which the canvas object's corner resize contradicts.

**Process failure: the disk floor was crossed.** Jake's rule is 15 GiB free before any build or
deployment step, and stop if a reading falls below it. During `npm run verify` for the commit
that wrote the entry above, free disk went from 15.13 GiB to 14.09 GiB, and the sampler meant to
watch it during the build produced no readings (macOS `awk` has no `strftime`; the failure was
silent). The commit, push and PR were made after removing the worktree's `.next` brought the
reading back to 15.14 GiB. That was the wrong call: the rule is stop on the first reading below
the floor, clean only the session's own artifacts, and report — not continue once the number
recovers. Recorded so the next session treats it that way. Two consequences are already in
effect: the floor is confirmed before each step rather than once at the start, and a sampler
that emits nothing is treated as a failed sampler, not a quiet disk.

Status: Active. Corrects the entry above it on the count, the time scope, the Clean claim, the
active-word claim, the §7 P1.1 statement, and the Slice 12 ownership of panel resizing; records
the disk-floor failure. Does not change the entry's conclusion.

## 2026-09-02 - An Export Is Identified By Its Clip And Its Edit Version, And Nothing Else

Decision: the export idempotency key is `export:{clipId}:v{editVersion}`. The filename is removed
from it. `buildExportIdempotencyKey` no longer accepts a filename parameter, so no caller can
reintroduce one by accident. The filename is still chosen, still stored on the `ExportJob` row,
and still names the downloaded file. It describes the download, not the work.

`parseExportIdempotencyKeyVersion` still reads keys written before this change. A key from
between P1.1 and P1.2 carries the filename after the version and parses to the same version; a
key from before P1.1 carries no version and still returns null. A legacy key that stopped parsing
would turn a pinned export back into an unpinned one, which is what P1.1 exists to prevent.

The idempotency lookup keeps running before `checkExportJobLimits`. That ordering is now
deliberate rather than incidental: a re-request that returns an existing job creates no render,
so it is not charged against the workspace caps, and with the filename out of the key a
re-request can no longer be a rename in disguise. A test asserts both halves.

Why: the user interface posts no filename, so the server built the default itself from
`new Date()`. The date sat inside the identity, so the same clip at the same saved edit version
became a different key at midnight and rendered a second time on its own. A caller-supplied
rename did the same thing on demand. Neither produces different pixels. Two requests that would
render the same frames are one piece of work.

Tradeoff: a clip that already has an export under a legacy key will not match the new key, so its
next export request renders once more under the new identity. That is one extra render per
already-exported clip and version, and it is preferred to a backfill: two legacy rows for the same
clip and version with different filenames would collide on the unique index, and choosing a
winner between two real rendered files is not a migration's decision to make. A caller that
deliberately wants the same cut under two names now gets one job and one name; renaming a
finished download is the user's own step.

Status: Active. Supersedes the 2026-07-06 entry "Export Idempotency Key Is Scoped To (Clip, Edit
Version, Filename)".


## 2026-09-02 - A Successful Export Is One That Proved Itself Before It Was Stored

Decision: every rendered export passes quality control before anything keeps it. `SUCCEEDED` now
means the file passed these checks, not that ffmpeg exited zero.

Seven checks run on the rendered file, in `src/lib/qc/render-output.ts`, a pure module: the file
decodes, its dimensions are the expected vertical frame, an audio stream is present, the duration
is within tolerance of the duration the edit asked for, the file is not empty, a checksum exists,
and a clip that has caption lines produced caption events. The duration tolerance scales with the
clip — five percent, never below one second — because a flat tolerance either fails short clips on
ordinary re-encode drift or lets a badly truncated long clip through.

QC runs before the upload. A refused render leaves no object in storage, no `ExportedFile` row,
and nothing for retention to clean up later.

The verdict is stored either way, on the Wave 1 columns: `qcStatus`, `qcCheckedAt`, `qcChecksum`,
and `qcDetails`, which carries a versioned record of every check that ran, passing and failing.
The checksum QC computed is the same value `ExportedFile.checksum` receives, so the two are
asserted equal rather than assumed to agree. A failure also records an `export_render_qc_failed`
operational event carrying the clip id.

`ExportedFile.width` and `height` are now the measured values. The old path probed after the
upload with `.catch(() => null)` and then wrote the 1080x1920 constants whenever the probe had
failed, so a wrongly shaped file was recorded as a correctly shaped one. Nothing substitutes a
dimension any more.

A QC failure is retryable, not terminal. This follows the precedent set for
`CONTINUOUS_RANGE_REQUIRED`: the common case is deterministic and will fail three times and land
FAILED with the QC record visible, but a truncated write or a transient encoder fault is real and
a retry can clear it. A terminal refusal would spend that possibility to save two renders.

The caption-events check is an input-side fact carried in the same gate on purpose. It is what
catches the blank-caption render — a file that decodes, has audio, is the right shape and the
right length, and has no captions drawn on it. No other check here would notice that.

Why: the previous path uploaded first and validated afterwards, and swallowed the probe error
when it validated at all. A file that did not decode was stored, recorded with invented
dimensions, marked SUCCEEDED, and made available to download and to schedule.

Tradeoff: a caption defect still costs one full render before it is caught, because QC runs after
ffmpeg. Catching an empty caption script before the encode would be cheaper and is a later
improvement, not a change to this gate. The duration tolerance is a judgement: five percent
accepts keyframe-seek drift on a long clip, and a truncation small enough to hide inside it is
smaller than a viewer would notice.

Status: Active.

## 2026-09-02 - A Caption Keeps Its Bottom Anchor And Wraps, Because That Is What The Category Does

Decision: when each caption word carries its own position, the two rules libass currently supplies
implicitly are written down and reproduced exactly.

**Vertical.** With no dragged position, the block is anchored at its bottom: the last row sits
where it sits today, and extra rows stack upward at a pitch of one font size. With a dragged
position, the block centres on that point. Both are expressed through libass's own alignment rather
than reconstructed arithmetic — the bottom-anchored case emits `\an2` at the margin line, the
dragged case emits `\an5` at the point — so the placement is computed by the same code that
computes it today.

**Wrapping.** A line wider than the usable frame breaks onto further rows by greedy fill at that
width, which is what libass does now. Font size never changes to make a line fit, and the line
builder's grouping is not altered.

Per-word positioning applies only where it is safe to measure: a preset that highlights, drawing in
a bundled face, centre-aligned. Today that is Highlighter alone. Everything else keeps the whole-run
event it has always emitted, so Clean and every retired preset are untouched.

Why: the product owner asked for whichever answer matches an Opus Clip style editor. For both
questions that is the same answer, and it also happens to be the answer that changes no existing
clip.

A short-form caption is anchored to the bottom safe band because the bottom of the frame belongs to
the platform's own chrome; a caption that grew downward as it got longer would walk into it. Growing
upward from a fixed bottom is what every editor in this category does, and it is what this renderer
already does. Centring on the point when a caption has been dragged is what direct manipulation
means: the object goes where it was put.

Wrapping rather than shrinking is the same argument. Caption size is a setting a church chooses, and
a renderer that quietly reduced it for one line would make the text change size mid-clip, which no
editor in this category does. Re-grouping lines by width upstream was rejected for a wider reason:
it would change how captions are grouped on every clip, including the ones that fit today, to solve
a problem only long lines have.

Measured from real renders before deciding, at Highlighter's 48px bold on a 1080x1920 frame: a
one-row caption's text bottom sits 240px above the frame bottom and a two-row caption's sits 239px,
so the block is bottom-anchored; row pitch is 48px; a caption dragged to y 806 measured its centre
at 805 with one row and with two. `EVERLASTING RIGHTEOUSNESS THROUGHOUT` is 1242px against 1000px of
usable frame, and libass breaks it after `RIGHTEOUSNESS`. With every word on its own event and no
wrapping rule, the same line runs from x -81 to x 1161 and is clipped on both sides.

Tradeoff: the layout module now returns rows rather than one row, and the pop and the neighbour
shift that follows in Slice 8b operate within a row. Wrapping is ours to get right, and a wrap point
that disagrees with libass's would move an existing caption, so the acceptance test compares real
rendered frames rather than only the generated text.

Status: Active.

## 2026-09-02 - An ASS Font Size Is A Height, Not An Em

Decision: the caption measurers size a face the way libass sizes it. An ASS `Fontsize` is not an em
size: libass scales the face so that its ascent plus descent equals the number. The em is therefore
`Fontsize x unitsPerEm / (ascent + descent)`, which for DejaVu Sans Bold at 48 is 41.23px, not 48px.

Both measurers now use that em. The server one derives it from the font's own metrics. The browser
one asks the face for its ascent and descent through the canvas at a probe size and derives the same
number, so neither has to carry a table. The preview draws at that em as well.

Nothing about the exported file's own sizing changes. The style line still states the same
`Fontsize`, so every existing clip renders exactly as it did.

Why: per-word positioning made this assumption load-bearing. Measuring at the nominal size made
every advance 16.4 percent too wide, and rendered that put a gap of about 40px where libass puts 20.
The product owner watched a render and said it looked as though the space bar had been pressed twice
between every word. He was right, and the cause was arithmetic rather than taste.

The evidence, three independent measurements agreeing on one ratio: the font's em over its ascent
plus descent is 2048/2384 = 0.8591; the measured step from PEACE to IS in a libass run divided by
the step the em-based math predicts is 163/189.84 = 0.8586; and the rendered ink span of that run
divided by its em-based prediction is 201/234.35 = 0.8577. With the rule applied, the predicted step
is 163.09px against 163 rendered, and the rendered gaps of a five-word line are 22, 20 and 18px
against libass's own 21, 21 and 17.

This also closes a second, older disagreement nobody had measured: the preview drew captions at the
nominal size while the export drew them at the em, so the editor showed captions about a sixth
larger than the file produced. It now shows the size the file produces.

Tradeoff: editor captions get smaller again, on top of the earlier correction for the canvas scale.
Both changes move the preview toward the exported file rather than away from it, and neither changes
the file. A face whose ascent and descent equal its em is unaffected by this rule, so it is not a
special case for one font.

The guard is a render, not a unit test, because nothing about this is visible in the generated text:
the same five words are burned in twice, once positioned per word and once laid out by libass, and
the gaps must agree within a few pixels.

Status: Active.

## 2026-09-02 - A Neighbour's Motion Is Subdivided Until It Tracks The Pop Curve

Decision: a neighbouring word's `\move` events are no longer one per pop phase. The motion is split
recursively until every straight piece sits within `POP_SHIFT_TOLERANCE` of the shared curve, or
until the piece is one `POP_TIME_STEP_MS` long and the file has no shorter time to state. Only a
phase that actually curves is split; a phase a neighbour crosses in a straight line stays one event.

Why: the product owner watched the first render and said the motion was "a lot better ... could be a
little more smoother all together". Measured, the cause was not subtle. One straight line per phase
put a neighbour **0.25 of its whole clearance** away from the curve it was meant to be following,
mid-rise, and gave it three or four speed changes across a pop while the active word's own scale was
interpolated smoothly by libass. The word was smooth; its neighbours were piecewise, and that is
what reads as stepping.

Subdividing takes that 0.25 down to 0.083, and the 0.083 is the format's floor rather than a choice:
an accelerated rise leaves rest at unbounded speed, so across the first centisecond no straight line
can do better. Past that first step the achieved error is under 0.018.

Only the neighbour is subdivided. The active word emits exactly the events it emitted before, so the
pop's own shape — the part already accepted — is untouched, and the three Clean fixtures are
unchanged byte for byte.

Tradeoff: **events per word on a five-word line rise from 20.0 to 36.0**, and the asserted budget
rises from 20 to 45 per word with it. That is the direct cost of the smoothness and it is paid in
file size, not in render time — libass reads thousands of events and x264 dominates. The restraint
that keeps it from being worse is splitting only the curved phase: subdividing the settle, the hold
and the return would have cost another 24 events per word and moved nothing, because a neighbour
already crosses those in a straight line.

Rejected: the stepped shift recorded as the fallback in the 2026-08-20 neighbour decision. It is the
opposite of what was asked for, and it is now off the table rather than dormant.

Status: Active. Amends the 2026-08-20 neighbour micro-shift decision, whose "one linear motion per
phase" implementation constraint this replaces. Pending the product owner's verdict on a re-render.

## 2026-09-02 - A Neighbour Follows Its Own Curve, Not The Active Word's Scale

Decision: a neighbouring word is no longer pinned to `shiftProgressForScale(popScaleAt(t))`. It
keeps up with the scale while the word is growing, then drifts back to rest across everything that
follows in one continuous move, and comes home over the word's own return. Out, one turn, home.

Why: subdividing the motion fixed how faithfully a neighbour followed its curve, and left untouched
the fact that it was the wrong curve. The scale is a shape drawn for a word growing. Read as the
motion of the word *beside* it, it said: dart out, reverse two thirds of the way back over 120ms,
stop dead for the 200ms hold, then set off again for the return. Four changes of speed, three of
them abrupt, and a full stop in the middle that a viewer reads as two separate movements. No amount
of subdivision helps, because subdivision reproduces that shape more faithfully, not less.

What makes the freedom legitimate: a neighbour's only obligation is to stay clear of the active
word. Anywhere further aside than the clearance the word needs is safe, and the layout already
reserves room out to the peak, so the offset is bounded above by 1 as well. Following the scale
exactly was the cheapest way to satisfy that, not the only one.

Measured on a five-word line, across one activation:

| | before | after |
|---|---|---|
| speed changes | 4, one a full stop | 3, no stop |
| the turn at the peak | -5.56/s | -2.08/s |
| dead stop mid-pop | 200ms | none |
| events per word | 36.0 | 32.0 |

The gap around the active word stays a little wider than the word strictly needs through the middle
of the activation. That is the deliberate cost, and it is what buys the missing stop.

Tradeoff: the neighbour's corners are no longer the pop's phase boundaries, so "both renderers are
exact at every phase boundary" is retired and replaced by the stronger statement that they are exact
at every *segment* boundary — the boundaries they now both read. The rendered gate samples the
neighbour's corners rather than the pop's for the same reason. The pop is untouched: the active word
emits exactly the events it did before, and the Clean fixtures are unchanged byte for byte.

Not done, and the next lever if this is still not enough: the return still starts and ends abruptly,
and the rise still leaves rest at unbounded speed because `POP.riseAccel` is 0.5. Both are the pop's
own accepted shape rather than the neighbour's, which is why neither was changed without asking.

Status: Active. Amends the 2026-08-20 neighbour micro-shift decision and the subdivision decision
above it. Pending the product owner's verdict on a re-render.

## 2026-09-02 - The Social Safe Area Is One Versioned Datum

Decision: `src/lib/editor/social-safe-area.ts` states the frame's reserved edges once, and every
consumer derives its own geometry from it. The values themselves sit in a separate
`social-safe-area-values.ts`, which is what makes "every consumer reads the datum" a property a test
can prove: the test replaces that module and watches every consumer move.

Why now: Slice 9 adds a title overlay, and "Top Safe" names a datum that did not exist. Before this,
the same idea was written down in five places and disagreed with itself in three:

| | the number it used | what it is |
|---|---|---|
| canvas guide | top 6%, bottom 12%, sides 6% | Tailwind literals in JSX |
| burn-in caption margin | top 8%, bottom 12% | `videoHeight * 0.08` |
| burn-in caption side margin | 40px (3.7% at 1080) | `const MARGIN_H` |
| preview resting caption centre | top 10%, middle 45%, bottom 86% | a local function |
| brand lower third | sides 6%, bottom 22% | Tailwind literals in JSX |

Adding a sixth copy for the title is what this prevents.

Two of those disagreements turn out to be a model rather than a mistake, and are now expressed as
one: the bottom anchor **is** the chrome edge (both said 12%), and the top anchor sits a stated
`topPadding` of 2% below the top band (6% + 2% = the 8% the burn-in always used). So `top-safe` and
`bottom-safe` are derived, not listed.

**Nothing moves.** Every value is what its consumer already used. The three Clean and three per-word
Highlighter fixtures are unchanged byte for byte, which is the evidence: recording the numbers in
one place re-rendered nothing.

Two real disagreements are recorded rather than resolved, because resolving either re-renders clips
churches have already approved and that is not a decision to take unattended:

1. **The caption's side margin is not the guide's side margin.** 40px against 6%, so at 1080 wide a
   full-width caption reaches about 25px into the side band the guide draws. Either the guide is
   drawing the wrong zone or the caption is allowed too wide.
2. **The preview's resting caption centre is not derivable from the burn-in's margin**, because one
   is a block centre and the other an anchored edge, and the block's height depends on its text.
   They are recorded side by side so the question is at least visible.

Tradeoff: the datum carries two related families of number — what the platforms cover, and where a
caption rests — rather than one. Collapsing them into one is the change that moves renders, so it
waits for the product owner.

Status: Active. The title overlay reads `top-safe` from this datum from birth, so it starts with no
copy of its own.

## 2026-09-02 - The Title Overlay Parses Leniently And Writes Strictly

Decision: `EditorState.overlays` keeps its `z.array(z.unknown())` schema. The title lives in it as a
`{ type: "title" }` entry, found by `readTitleBanner`, which validates that one entry and steps over
everything else untouched. Writing goes through `upsertTitleBanner`, which validates before it puts
anything in.

Why not a discriminated union in the schema: `overlays` has been `unknown[]` since the beginning and
every stored document carries whatever was in it. A stricter parser that rejected an old shape would
stop a clip loading — the worst failure this editor has, because the member cannot get to their work
to fix it. An entry that claims to be a title but does not parse is treated as no title, so a
document written by a later version degrades to "no title" rather than to "cannot open".

**Removal needs two operations, not one.** The behaviour is that X removes the title and selecting
the empty Title track recreates the default. Those pull in opposite directions: something has to
create a default, and the member has to be able to say no permanently.

- `removeTitleBanner` drops the title and nothing else.
- `dismissTitleBanner` drops it and leaves a `{ type: "titleDismissed" }` marker. This is what X
  does. Without the marker the title would reappear on the next load and the member would have to
  remove it every time.
- `ensureDefaultTitleBanner` adds the default only when there is no title **and** none was
  dismissed.
- `upsertTitleBanner` clears the marker, because putting a title back is the member asking for one.

Defaults, from the plan: the clip's first three seconds, Top Safe, horizontally centred,
centre-aligned, uppercase black on white, no border, no shadow. Two are decisions the plan did not
state. A clip shorter than three seconds gets a title that **ends with the clip** rather than one
that runs off the end and is never fully seen. And the default is *not* written into
`buildDefaultEditorState`: a version-0 document is what an unedited clip is rendered from, so a
title there would appear on every clip that already exists and was never opened.

The anchor is a name in the shared safe area, not a number, so the title starts with no private copy
of the frame's geometry. The face is `DejaVu Sans`, already bundled, already declared in
`globals.css`, already in the worker image and already named in the `Dockerfile.worker` `fc-match`
gate — so the gate guarding the caption faces guards this one unchanged.

Tradeoff: reading is a linear scan that silently ignores a malformed title, so a member whose title
was corrupted sees it vanish rather than sees an error. That is the right way round for a document
they cannot otherwise open, but it means corruption is invisible rather than reported.

Status: Active. The burn-in and the panel follow; the model lands first so parity is provable before
there are controls to break it.

## 2026-09-02 - The Title Is Drawn As Shapes, Not As A Styled Box

Decision: the burn-in draws the title as an explicit `\p1` rectangle with the text on a layer above
it, not as an ASS opaque box (`BorderStyle: 3`). A border is a second, larger rectangle behind the
first, and it is drawn **inside** the width the member set rather than growing the box past it.

Why: "box dimensions" is one of the properties the preview and the file have to agree on. An opaque
box hugs its own text at a size neither renderer states — it is libass's arithmetic over the glyphs,
and the browser has no way to reproduce it. A drawing is stated: the rectangle in the file is the
rectangle `layOutTitleBanner` computed, to the pixel, and the render test reads it back out of the
frame to prove it.

`src/lib/editor/title-layout.ts` is the single selector both renderers read, the same pattern
`captionActivations` established in Slice 7. It owns the box, the wrap, the line height, where each
line's centre sits and where the text is anchored. Neither renderer measures anything the other
does not.

Two rules inside it worth stating:

- **A line's height is the font size.** An ASS `Fontsize` is a height — libass scales the face so
  ascent plus descent equals it — so a line occupies exactly that many pixels and neither renderer
  has to guess a leading. This is the same correction the caption measurers got earlier today.
- **The case is applied before the text is measured.** Measuring "grace" and drawing "GRACE" is how
  a box comes out too small for its own text.

Also decided: an override colour is `&HBBGGRR&`, not the style line's `&H00BBGGRR`. A style line
carries alpha in the same field; an override does not, and running them together makes libass read
the pair wrong. That is a separate helper now rather than a reused one.

The title's times are remapped onto the kept timeline through `retimeTitleBanner`, the same way
caption lines already were. A title left on the source timeline drifts by however much was deleted
before it.

Tradeoff: a title costs three or more events where an opaque box would cost one, and the generator
now carries a second layout path. Bought with it: every property in the parity list is asserted
against one shared number rather than inferred, and the rendered frame is checked against it.

Status: Active. The preview reads the same layout; the panel follows.
