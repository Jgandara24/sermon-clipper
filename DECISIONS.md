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

Status: Active.

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

Status: Active — code merged and env var documented; **not yet proven against a real proxy
endpoint**. Two open items: (1) buy a small amount of residential proxy traffic and confirm a real
import succeeds from Railway before relying on it; (2) PERC's automated MP4 retrieval has never
worked end to end (Pulpit Engine's `current-build-status.md` records the one real recording
returning `download_status = null`, resolved by pasting the URL by hand), so that needs its own
proof before any church is migrated onto it. If Sermon Clipper adopts PERC it should use its own
Cloudflare Stream account, not Pulpit Engine's — unlike the Meta App there is no review process to
reuse, so sharing would add a failure point and buy nothing.
