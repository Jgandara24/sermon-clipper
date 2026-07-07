# Decisions

## 2026-07-06 - Phase 1 Uses Dev Cookie Auth

Decision: Phase 1 uses a clearly labeled development-only cookie session instead of wiring OTP or Google OAuth.

Why: The first goal is repository, schema, app shell, seeded workspace, and dashboard flow. Real auth would introduce provider setup and secrets before the foundation is proven.

Tradeoff: The UI can exercise login and workspace routing locally, but production auth remains unimplemented until a later phase.

Status: Active.

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

Tradeoff: OTP delivery is not wired to a production email provider yet; codes are printed to server
logs so the auth flow can be verified locally and in tests without pretending email delivery exists.
The next hardening slice should add a delivery provider, rate limiting, and audit events around
OTP sends/verifications.

Status: Active — authentication/session foundation is real; notification delivery remains open.

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

Tradeoff: Public review links remain token-authorized for now; production-safe review-link
expiration, revocation, audit events, and notification delivery are still separate Phase 8 slices.
There is not yet a workspace member management UI for owners/admins to assign roles.

Status: Active — core role checks are enforced; review-link hardening and member administration
remain open.

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

Tradeoff: The signed media endpoint still streams from local disk, so production storage is not
complete yet. Export availability still uses the database `download_expires_at` window, while each
actual returned download URL has a much shorter cryptographic expiry. The next storage slice should
add an S3/R2-compatible provider and eliminate local filesystem path dependencies from workers.

Status: Active — signed URL hardening is in place; cloud object storage remains open.

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
workflow real without jumping ahead to full teams, comments, notification delivery, or direct
publishing. The review token is opaque and tied to one clip approval, giving a simple URL that is
good enough for local/demo workflow and easy to replace with authenticated invitations later.

Tradeoff: This is not a full collaboration system. There are no threaded comments, role-specific
approval permissions beyond possession of the token, or email/SMS notifications. Exports are now
approval-gated, and any successful editor save after approval returns the approval to `DRAFT` so
the clip must be reviewed again before export. Lower-thirds are text-only ASS overlays, not
logo/image assets or animated brand packages. The model and editor state shape leave room for those
upgrades.

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

Status: Active.

## 2026-07-06 - Export Idempotency Key Is Scoped To (Clip, Edit Version, Filename)

Decision: `POST /api/clips/:id/exports` derives its idempotency key as `export:${clipId}:v${currentEditVersion}:${filename}` rather than a fixed per-clip key, and the client doesn't supply it.

Why: Guide §15 step 2 requires "re-submitting the same job id must not double-charge" — but unlike `ProcessingJob` stages (at most one per project, ever), a clip's export is something a user legitimately wants to redo after further edits. A fixed `export:${clipId}` key would silently return a stale export forever after the first one. Scoping by edit version means a retried/double-clicked request against the *same* saved state returns the same job (true idempotency), while editing the clip further and re-exporting naturally mints a new job.

Tradeoff: Two exports of the same clip state with two different filenames create two separate render jobs rather than reusing one — an accepted minor inefficiency in exchange for keeping the idempotency key derivation simple and not requiring a client-supplied key.

Status: Active.
