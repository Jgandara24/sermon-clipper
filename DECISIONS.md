# Decisions

## 2026-07-06 - Phase 1 Uses Dev Cookie Auth

Decision: Phase 1 uses a clearly labeled development-only cookie session instead of wiring OTP or Google OAuth.

Why: The first goal is repository, schema, app shell, seeded workspace, and dashboard flow. Real auth would introduce provider setup and secrets before the foundation is proven.

Tradeoff: The UI can exercise login and workspace routing locally, but production auth remains unimplemented until a later phase.

Status: Active.

## 2026-07-06 - No External Provider Calls In Foundation

Decision: Upload, URL import, transcription, AI analysis, rendering, storage, billing, and publishing are visible as stubs only.

Why: The goal explicitly forbids paid providers, Pulpit Engine infrastructure, and live credentials. The foundation must be runnable from a clean clone without external services beyond local Postgres.

Tradeoff: The dashboard is useful for project records and seeded data, but it does not process video yet.

Status: Active.

## 2026-07-06 - Postgres Is The Only Database Target

Decision: Prisma is configured for PostgreSQL only, with Docker Compose for the standard local path.

Why: The product spec requires a fresh Postgres instance and one canonical ordered migration path. Avoiding SQLite keeps the local schema close to the intended deployment target.

Tradeoff: Local setup requires Docker or a local Postgres service.

Status: Active.

## 2026-07-06 - Phase 2 Upload Is Real; URL Import Stays Stubbed

Decision: Direct file upload, FINALIZE (ffprobe metadata), and PROBE (thumbnail + audio extraction via ffmpeg) are real as of Phase 2. Pasting a URL still only records a draft with a WAITING job — the yt-dlp fetch adapter isn't implemented yet.

Why: ffmpeg/ffprobe are free, local, self-hosted binaries, not paid providers, so they don't violate the no-external-provider constraint (§1). yt-dlp is a separate, larger surface (extractor failures, geo-blocking, live-stream edge cases per guide §8) better sequenced as its own unit of work rather than rushed alongside the upload plumbing.

Tradeoff: The dashboard's "Or paste a link" form is honestly labeled as not-yet-functional. Churches can upload files today; link-based import is a follow-up within Phase 2 (or an early Phase 3 task) before the phase's URL-import surface is considered done.

Status: Active.

## 2026-07-06 - Local-Disk StorageProvider Stands In For S3/R2

Decision: `src/lib/storage/` defines a `StorageProvider` interface with a `LocalDiskStorageProvider` implementation (root configurable via `STORAGE_LOCAL_ROOT`, default `.data/storage`, gitignored). The upload API returns a same-origin URL (`/api/uploads/:id`) as the "presigned" target instead of a real presigned S3/R2 URL, and does a single direct PUT rather than true chunked multipart.

Why: No cloud bucket is provisioned yet, and the spec forbids paid providers before the foundation is proven. Keeping the real interface (not a fake/no-op one) means swapping in an S3Provider later is a drop-in change for every caller (upload routes, FINALIZE/PROBE handlers, the `/api/storage/[...key]` read route).

Tradeoff: No true resumable/chunked upload yet (a dropped connection mid-upload must restart from zero), and the 5GB/3h caps in `src/lib/limits.ts` are enforced but not battle-tested against real multi-GB files. Revisit when a Marketplace storage integration (R2/S3/Supabase Storage) is wired up.

Status: Active.

## 2026-07-06 - DB-Polling Job Queue Instead Of BullMQ + Redis

Decision: `src/lib/jobs/queue.ts` implements the job queue as conditional-UPDATE claims against the existing `processing_jobs` Postgres table (QUEUED -> RUNNING only if still QUEUED), polled by `src/worker/run-jobs.ts` (`npm run worker`). No Redis/BullMQ dependency yet, though the guide's tech stack (§3) and job queue design (§18) call for Redis + BullMQ.

Why: Redis isn't provisioned locally and adds a second piece of local infrastructure (beyond Postgres) before it's earned its keep at MVP scale. Postgres already has the durable job state (`processing_jobs`); a conditional UPDATE is a well-understood, race-safe claim pattern that needs zero extra services. Per guide §26 ("prefer simple working implementations over premature generality") — the provider-interface carve-out in that same sentence names ASR/LLM/storage specifically, not the queue transport.

Tradeoff: No priority lanes, no built-in backoff/retry scheduling, and polling (default every 2s, `WORKER_POLL_INTERVAL_MS`) adds latency BullMQ's pub/sub wake-up wouldn't have. Fine at single-workspace MVP volume; revisit if concurrent job volume or multi-region workers make polling latency or DB load a real problem.

Status: Active.

## 2026-07-06 - No Ledger Reservation For FINALIZE/PROBE

Decision: The usage-ledger reserve/settle/release mechanism (`src/lib/usage-ledger.ts`) is fully built and tested (atomic balance update, idempotent by job id, `balance-never-negative` invariant verified against a real Postgres in `tests/integration/usage-ledger.integration.test.ts`), but FINALIZE and PROBE jobs don't actually reserve any minutes.

Why: The guide's own pipeline (§8 step 6) reserves minutes when the user confirms processing config for transcription — a Phase 3 concern — not at finalize/probe time, which the guide treats as free plumbing. Charging a made-up "intake fee" here would mean inventing pricing the spec doesn't define.

Tradeoff: `cancel` still calls `releaseReservationForJob` for every job on the project, which is a correct no-op today (nothing to release) and becomes load-bearing the moment Phase 3 reserves real transcription minutes.

Status: Active — expected to start mattering in Phase 3.

## 2026-07-06 - Real-Database Tests Live Outside `verify`/CI

Decision: `vitest.config.ts` excludes `tests/integration/**`; those tests run separately via `npm run test:integration` against a real, migrated Postgres. `npm run verify` (and CI) stay exactly as DB-free as they were before Phase 2.

Why: `verify`'s existing contract ("does not require external provider credentials") implicitly meant no live services at all, including Postgres — `prisma validate` only checks schema syntax. Introducing DB-backed tests into that path would silently break local verify for anyone without Postgres already running, and CI has no Postgres service today.

Tradeoff: The ledger's balance-never-negative and idempotency invariants (required by guide §21) are proven, but only when a developer remembers to run `npm run test:integration` locally — CI doesn't catch a regression there yet. Revisit by adding a Postgres service to `.github/workflows/ci.yml` when Phase 8 ("test suite green") tackles CI hardening in earnest.

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
