# Build Prompt for Claude or Codex

You are an AI coding agent. Build an **original** AI-powered web application that helps users upload or import long-form videos, automatically detect high-value short clips, edit those clips with captions and layouts, and export vertical videos for social platforms. The primary initial niche is **church sermon clipping**.

This prompt is derived from a competitive product analysis (`OPUS_CLIP_PRODUCT_SPEC.md`, provided alongside this prompt — read it first for context and rationale). You are building an original product in the same category. **Do not copy Opus Clip branding, UI text, visual design, asset names, or preset names. Original UI, original copy, original code, original workflows where appropriate.**

---

## 1. Product Goal

Long video in → ranked, captioned, branded, 9:16 clips out — with a review/approval step suited to church teams. Success metric for the MVP: a non-technical volunteer uploads a 45-minute sermon and downloads a captioned vertical clip in under 15 minutes without help.

Design principles (learned from category analysis):
- One-click default path; every AI decision human-overridable.
- Show cost (processing minutes) BEFORE starting any paid work.
- The transcript is the timeline: edit words, the video follows.
- Every AI-chosen clip ships with a score AND a plain-language reason.
- Archive-first, not feed-first: churches keep sermons forever.
- Fail safe: a failed job never half-charges, never half-posts, always says why.

**Repository & infrastructure isolation (hard constraints — read before writing any code):**
- This is a **greenfield product in its own standalone git repository** (suggested name: `sermon-clipper`). Do not build it inside, import from, or depend on the existing Pulpit Engine workspace repo or any of its code.
- Deploy to a **new, dedicated Railway project** — separate from the existing Pulpit Engine Railway project. No shared services between the two.
- Provision **its own PostgreSQL** (a fresh Supabase project, or Railway Postgres). Never connect to Pulpit Engine's existing Supabase database or reuse its credentials.
- Its own Redis, storage buckets, environment variables, secrets, and domains. Zero shared infrastructure, zero shared credentials, in either direction.
- Rationale: an acquisition-ready standalone codebase, per-product spend visibility, and no blast radius into the production Pulpit Engine stack.

## 2. MVP Scope

**In scope:**
- Authentication (email OTP or Google OAuth).
- Single workspace per user (schema supports more later).
- Dashboard: import box + project list.
- Video upload (local file, presigned direct-to-storage) and YouTube/URL import via yt-dlp.
- Pre-processing config screen: language, clip length bucket, processing timeframe (partial-video "cost saver" slider), optional own-SRT upload, cost estimate display.
- Processing status: visible pipeline stages + cancel (cancel = no charge).
- Transcription with word-level timestamps.
- AI clip suggestion (5–10 clips) with deterministic-plus-LLM scoring.
- Clip list with score badges + rationale; like/dislike feedback capture.
- Clip preview (low-res proxy playback with caption overlay approximation).
- Editor: transcript-based trim (delete words), extend-from-source-transcript, caption text edit, caption style presets (3–4) + font/size/color/position/uppercase controls, layout choice (center crop / face crop / manual crop), 9:16 canvas.
- Export: 1080×1920 H.264 MP4 with burned captions; download link.
- Usage metering: minutes-based ledger, balance display, pre-job estimate, insufficient-balance block.
- Error states for every failure listed in §20.

**Explicitly OUT of MVP** (stub interfaces only): direct social publishing, team collaboration/approval (schema yes, UI later), advanced scheduling, stock/AI B-roll, music library, translation, enterprise billing, template marketplace, TTS spoken hooks, upscaling, analytics, Pulpit Engine data sync (schema field reserved only — see §25).

## 3. Recommended Tech Stack

Default (adjust only with stated tradeoffs):
- Frontend: Next.js (App Router), React, TypeScript, Tailwind.
- Backend: Node.js (single service exposing tRPC or REST), plus worker processes.
- DB: PostgreSQL — a **new, dedicated instance** (fresh Supabase project or Railway Postgres). ORM: Prisma, with Prisma Migrate as the single canonical, ordered migrations path. Never connect to any existing Pulpit Engine database.
- Object storage: S3-compatible (R2/S3/Supabase Storage) with presigned multipart uploads.
- Queue: Redis + BullMQ. One queue per job family; concurrency configured per worker.
- Video: FFmpeg (+ ffprobe) in a containerized worker; libass for caption burn-in.
- YouTube / URL import: **yt-dlp** (self-hosted binary, same container as FFmpeg) for fetching metadata (title, duration, thumbnail) and downloading source video from a pasted link. This is an MVP requirement, not a later add — churches import from their own YouTube uploads/livestream VODs on day one. Implement behind a `VideoSourceAdapter` interface with `YtDlpAdapter` as the first implementation, so the future "watch this channel and auto-import new uploads" feature (V1/V2, see product spec §2/§13) can reuse the same fetch logic behind a scheduled poller instead of a manual paste, without a rewrite.
- Transcription: WhisperX (self-host) or Deepgram (managed) — abstract behind a `TranscriptionProvider` interface; word timestamps required, diarization optional.
- AI analysis: Claude API (claude-sonnet-5 for analysis/scoring/titles; claude-haiku-4-5 for cheap mechanical passes) behind an `AnalysisProvider` interface with JSON-schema-validated outputs.
- Auth: Supabase Auth or Auth.js (email OTP + Google).
- Payments: Stripe (NOT in earliest MVP; ledger first, Stripe wiring later).
- Deploy: Vercel (web) + containerized workers on Railway/Fly (FFmpeg + GPU-optional).
- Observability: structured JSON logs, Sentry, per-job metrics table.

## 4. Required Pages and Routes

| Route | Purpose | Key components | Data | Empty state | Loading | Error | Main actions | Acceptance |
|---|---|---|---|---|---|---|---|---|
| `/login` | auth | OTP/OAuth form | — | — | spinner | invalid code | sign in | session created |
| `/onboarding` | name workspace, church profile (tz, service day) | wizard | workspace | — | — | validation | create workspace | lands on dashboard |
| `/app` | dashboard | ImportBox, ProjectGrid, UsageMeter | projects, balance | "Upload your first sermon" CTA | skeleton cards | banner + retry | import, open project | projects listed w/ status |
| `/app/import` | pre-processing config | ConfigPanel, CostEstimate | url preview/probe | — | probe spinner | invalid URL, too long, no balance | start processing | job created, redirected |
| `/app/projects/:id` | clip review | ClipCard grid, filters, sort, JobStatusTracker | clips+scores | "processing…" stages | shimmer | job-failed panel w/ reason + retry | open clip, like/dislike, download | ranked clips visible |
| `/app/clips/:id/editor` | edit | ScriptEditor, CanvasPreview, CaptionPanel, LayoutPanel, Timeline(min) | clip + edit state + transcript slice | — | editor skeleton | load-fail retry | trim, extend, style, save, export | edits persist; export job enqueued |
| `/app/exports` | downloads | ExportTable | export jobs | "no exports yet" | rows shimmer | failed rows w/ retry | download | file downloads |
| `/app/templates` | brand templates | TemplateEditor (logo, colors, caption preset, lower-third text) | templates | "create your first template" | — | validation | save template | template applies at import |
| `/app/settings` | profile/workspace | forms | user, ws | — | — | validation | save | persisted |
| `/app/settings/billing` | usage + placeholder | LedgerTable, BalanceCard | ledger | "no usage yet" | — | — | — | ledger accurate |
| `/app/help` | placeholder | links | — | — | — | — | — | renders |

## 5. Required Components

AppShell (sidebar: Home, Templates, Exports, Settings; topbar: balance, avatar); SidebarNav; UserMenu; UsageMeter (minutes + est. remaining); ProjectCard (thumb, status chip, date, duration); ClipCard (score badge, duration, title, actions); UploadDropzone (multipart, progress, resumable); LinkImportForm (probe + preview card + cost estimate); ProcessingStatusTracker (stage list: uploaded → probed → transcribing → analyzing → cutting → ready, with per-stage status and cancel); ClipScoreBadge (number + tier color); ClipReasonPanel (rationale + source range + transcript excerpt toggle); VideoPreviewPlayer (proxy + caption DOM overlay); TranscriptViewer (read-only, timestamped, searchable); ScriptEditor (virtualized tokens, pause chips, delete/restore selection toolbar); CaptionStylePanel (Presets / Font / Position tabs); Timeline (filmstrip, in/out handles, playhead; minimal at MVP); LayoutSelector (center / face / manual w/ drag-crop); ExportSettingsModal (filename, confirm); ExportJobStatus; ScheduleMetadataPanel (V1: suggested caption/hashtags/post-time copyable); Toasts; ConfirmModal (destructive actions); EmptyState; ErrorBoundary.

## 6. Database Schema

Implement with migrations (one canonical ordered path). All tables: `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`. All workspace-scoped tables: `workspace_id` FK + index; enforce isolation in a shared query guard.

- **users**: email unique, name, auth_provider, locale.
- **workspaces**: name, owner_id FK users, plan_code default 'free', minute_balance int default 60, storage_used_bytes bigint, settings jsonb (default processing config, church profile: timezone, service_day), external_refs jsonb default '{}' (reserved for a future third-party org link, e.g. `{ "pulpitEngineChurchId": "..." }` — unused at MVP, nothing reads or writes it yet; see §25).
- **workspace_members**: workspace_id, user_id, role enum(owner,admin,editor,approver,viewer), status enum(active,invited). Unique(workspace,user).
- **projects**: workspace_id, name, source_video_id FK, status enum(draft,queued,processing,ready,failed,canceled), processing_config jsonb, folder text null, series text null, speaker text null, expires_at null (null = never for paid).
- **source_videos**: workspace_id, origin enum(upload,url), origin_url, filename, duration_s numeric, size_bytes, width, height, fps, storage_key, audio_key, thumbnail_key, language, srt_override_key null, copyright_ack_at timestamptz.
- **processing_jobs**: project_id, type enum(finalize,probe,transcribe,analyze,generate_clips,preview_render,export,cleanup), state enum(queued,running,waiting,succeeded,failed,canceled,retrying,expired), progress int, attempt int, idempotency_key unique, error_code, error_message_user, minutes_reserved numeric, started_at, finished_at. Index(state,type), index(project_id).
- **transcripts**: source_video_id unique, language, provider, full_text tsvector-indexed.
- **transcript_segments**: transcript_id, idx, start_ms, end_ms, text, speaker_label null. Index(transcript_id, start_ms).
- **word_timestamps**: segment_id, idx, word, start_ms, end_ms, confidence, is_filler bool, deleted bool default false. (MVP alternative: `words jsonb` on segment; choose one and document.)
- **generated_clips**: project_id, rank, start_ms, end_ms, title, hook_text null, summary, status enum(suggested,kept,hidden), liked bool null. Index(project_id, rank).
- **clip_scores**: clip_id unique, total int, subscores jsonb ({clarity, biblical_usefulness, emotional_impact, completeness, shareability} each {score int, letter text, note text}), model_version, excerpt text.
- **clip_edits**: clip_id, version int, editor_state jsonb (§12), is_autosave bool, saved_by. Index(clip_id, version desc).
- **caption_tracks**: clip_id, language, style jsonb, generated_from_transcript bool.
- **caption_segments**: track_id, start_ms, end_ms, text, words jsonb (karaoke timing), line_count int.
- **caption_style_presets**: name, style jsonb, is_builtin bool, workspace_id null.
- **brand_templates**: workspace_id, name, logo_asset_id null, colors jsonb, caption_preset_id, lower_third jsonb ({speaker_name, church_name}), intro_asset_id null, outro_asset_id null, ai_defaults jsonb.
- **assets**: workspace_id, kind enum(logo,intro,outro,font,media,music), storage_key, meta jsonb.
- **export_jobs**: clip_id, workspace_id, preset enum(mp4_1080), state (same enum as processing_jobs), output_file_id null, minutes_charged numeric, error_code null.
- **exported_files**: storage_key, bytes, width, height, checksum, download_expires_at.
- **usage_ledger**: workspace_id, kind enum(grant,processing,export,refund,adjustment), project_id null, minutes_delta numeric, balance_after numeric, job_id null, note. Append-only. Index(workspace_id, created_at desc).
- **notifications**: user_id, kind, payload jsonb, read_at null.
- **integrations** (placeholder): workspace_id, platform enum(youtube,facebook,instagram,tiktok), status enum(disconnected), tokens_encrypted null.
- **scheduled_posts** (placeholder): clip_id, destination jsonb, caption text, hashtags text[], scheduled_at, state enum(draft).
- Church extensions (schema now, UI later): **sermons** view over projects (series, speaker, passage_refs text[]), **clip_approvals**: clip_id, state enum(draft,in_review,approved,changes_requested), approver_id, comment text, decided_at.

Constraints that matter: ledger balance_after computed in a serialized transaction; export charge + ledger row + job state change in ONE transaction (idempotent by job id — a re-run must not double-charge); clips must satisfy `start_ms < end_ms` and fall within source duration.

## 7. Backend Services

Modules (single deployable + worker images; keep boundaries as folders/interfaces, not microservices):
`auth`, `workspace`, `project`, `upload` (presign/finalize), `probe` (ffprobe metadata), `transcription` (provider interface + SRT override path), `analysis` (chunking, candidates, scoring, titles), `clips` (CRUD, feedback), `captions` (derive track from transcript minus deleted words; style application), `editorState` (versioned save/load), `render` (FFmpeg graph builder + runner), `export` (job orchestration, files, links), `usage` (estimate, reserve, settle, refund), `notify` (email on job done/failed via Resend), `publish` (interface stub only).

## 8. Video Upload Pipeline

1. Client requests presigned multipart for (filename, size, type); server validates plan cap (MVP: 5 GB, 3h) and balance > 0.
2. Browser uploads parts directly to storage w/ progress + retry per part.
3. Client calls complete → server verifies object exists + size matches.
4. `finalize` job: MIME sniff, ffprobe (duration, streams, fps, resolution); reject non-video/DRM; write metadata.
5. `probe` extracts poster thumbnail + filmstrip sprite; extracts 16 kHz mono audio to `audio_key`.
6. Cost estimate = ceil(duration_min × timeframe_fraction); shown to user; user confirms processing config → `transcribe` + downstream jobs enqueued; minutes RESERVED in ledger (settled on success, released on cancel/failure).
7. UI polls project jobs; each stage visible; cancel button cancels remaining stages and releases reservation.
8. Failed uploads: orphan cleanup job deletes storage objects with no finalized record after 24h.

URL import variant: `url-preview` endpoint (yt-dlp metadata only: title, duration, thumbnail — no download yet) → on confirm, `fetch` job downloads media via yt-dlp to storage, then same pipeline. Handle: invalid URL, private/geo-blocked video, live-not-finished, >3h duration, yt-dlp extractor failures (a platform changed its page layout — log the extractor error, surface a plain "we couldn't fetch that link" message, don't crash the worker). Keep the fetch call behind `VideoSourceAdapter.fetch(url)` so a later scheduled "check this channel for new uploads" poller can call the identical adapter.

## 9. Transcription Pipeline

1. Input: audio_key, language (or auto), custom vocabulary list (workspace settings; seed with church terms).
2. Provider call w/ word timestamps; segments normalized to sentences (punctuation restore if provider lacks it).
3. Optional diarization: if provider returns speakers, store labels; else null (graceful).
4. Filler detection: lexicon (uh, um, you know, like, amen-repeats configurable) + word-confidence threshold → `is_filler`.
5. If user supplied SRT: parse + store as segments; word timing = linear interpolation within cue (documented limitation); skip STT.
6. Persist; build tsvector for search; expose GET transcript API.
7. Failure: 3 retries exponential; then job failed w/ user message "We couldn't transcribe this audio" + release reservation.

## 10. AI Clipping Pipeline

1. Chunk transcript into candidate windows: sentence-boundary segments, 20s–90s (config bucket), sliding with overlap.
2. Stage A (cheap model): for each window, classify moment types — hook line, complete thought, story/illustration, quotable statement, emotional peak, teachable explanation, call to action/invitation — and hard-reject incomplete thoughts (starts mid-pronoun, ends mid-sentence).
3. Stage B (strong model): top ~25 candidates → rubric scoring (§11) + one-sentence rationale + transcript excerpt selection. STRICT JSON schema outputs; validate + retry once on schema failure.
4. Boundary refinement: snap start to sentence start w/ preceding gap ≥ 300ms; snap end to sentence end; pad 150ms both sides.
5. Dedup: reject candidate if time-range IoU > 0.5 with a higher-scored kept clip.
6. Keep top 5–10; rank by total score.
7. Generate per clip: title (≤60 chars, no clickbait-lie, sermon-appropriate), hook_text (≤8 words), summary (the rationale).
8. Persist clips + scores; enqueue preview renders (480p) for top N.
9. User overrides: hide clip, like/dislike (store for future model tuning), re-run analysis with a user prompt ("find the part about forgiveness") as an additive pass (only NEW candidates, don't clobber existing).
10. Sermon mode additions (Phase 7): sermon-boundary pre-pass (exclude worship/announcements — classify 30s windows as music/speech/other via audio features + transcript density before chunking), scripture reference extraction (regex + LLM verify against a public Bible API; store normalized refs), invitation/prayer detectors as moment types.

## 11. Clip Scoring System

Deterministic layer combines LLM subscores with computed features. Each subscore: `{score: 0–100, letter: A+..F (banded), note: one sentence, excerpt: supporting transcript quote}`.

General categories: hook_strength (first 3s text grabs?), clarity (standalone understandability — no unresolved pronouns/context), emotional_impact, completeness (thought resolves), shareability (would a member send this to a friend), speaker_energy (computed: words/min + pitch variance if available), topic_relevance (vs video's main topics), platform_fit (length vs bucket).

Sermon mode replaces/augments: biblical_usefulness (teaches a truth of the text), theological_clarity (accurate, not out-of-context — flag risky out-of-context cuts), pastoral_tone, scripture_relevance (contains/expounds a reference).

`total = round(Σ weight_i × score_i)` with weights in config (not code); model_version stamped on every score row. Show total + letters + note in UI exactly as stored — the reason string is a product feature, not debug output.

## 12. Editor System

Editor state = one versioned JSON document (`clip_edits.editor_state`):

```json
{
  "version": 3,
  "source": { "videoId": "...", "startMs": 2551000, "endMs": 2577000 },
  "wordEdits": { "deletedWordIds": ["..."], "restoredFillerIds": [] },
  "extensions": [{ "startMs": 2545000, "endMs": 2551000, "position": "before" }],
  "captions": { "trackId": "...", "presetId": "clean-serif", "overrides": { "sizePx": 52, "position": "bottom", "uppercase": false, "highlightColor": "#FFD34D" }, "textOverrides": [{ "segmentId": "...", "text": "..." }] },
  "layout": { "mode": "face|center|manual", "crop": { "x": 0.22, "y": 0, "w": 0.56, "h": 1 }, "aspect": "9:16" },
  "overlays": [{ "type": "lowerThird", "templateId": "...", "startMs": 0, "endMs": 4000 }],
  "brandTemplateId": null,
  "audio": { "originalVolume": 1.0 },
  "export": { "preset": "mp4_1080" }
}
```

Behaviors: autosave (2s debounce) + explicit Save; undo/redo client-side patch stack; deleting words splits the render into sub-ranges (concat at render time) and re-flows captions; extend pulls additional transcript + video range; preview approximates everything in DOM/CSS; server render is the source of truth. Version conflicts: reject save if base version stale; client refetches and re-applies local patches.

## 13. Caption System

- Derive caption segments from surviving (non-deleted) words: greedy line-fill up to `maxWordsPerLine` (default 5) and `maxLines` (1 or 3), split at punctuation/gaps ≥ 500ms.
- Store karaoke timing per word for active-word highlight styles.
- Manual text edits override display text but keep timing (edited flag).
- Styles (minimum): fontFamily (2 bundled open-licensed fonts), sizePx, textColor, highlightColor, background (none/pill), position (top/middle/bottom + safe-zone margins), alignment, uppercase toggle, strokeColor+px, shadow.
- 3–4 original presets with our own names (e.g., "Clean", "Bold Serif", "Karaoke", "Quiet") — do NOT reuse competitor preset names.
- Render path: generate .ass file from track + style (libass handles karaoke via \k tags, outline, shadow, alignment, margins); `subtitles=` filter burns in. Browser preview = DOM overlay approximation; document accepted drift (±1 frame).
- Safe zones: enforce default bottom margin ≥ 12% height (platform UI chrome).

## 14. Layout and Reframing System

- Output 1080×1920 (9:16) MVP; keep aspect enum extensible (1:1, 16:9 later).
- Modes: `center` (static center crop), `face` (single tracked subject), `manual` (user drag/zoom crop box stored normalized).
- Face mode MVP: sample frames at 1 fps → face detect (mediapipe/onnx) → smooth track (EMA + max-velocity clamp) → export as ≤ 20 crop keyframes → FFmpeg piecewise crop; fall back to center when confidence low. Full per-frame tracking is Phase 8 polish.
- Split layout (two speakers) = placeholder enum now, implement V1.
- Safe-zone overlay toggle in editor (visual guide only).
- Store all layout params in editor state; renderer consumes only the state document (pure function of state → filtergraph).

## 15. Export System

1. User confirms export (filename default: `{series|project}-{clipTitle-slug}-{yyyymmdd}.mp4`).
2. Server: create export_job + charge/settle in one idempotent transaction (re-submitting the same job id must not double-charge; MVP: exports free, processing minutes already paid — keep the transaction shape anyway).
3. Worker builds filtergraph from editor state: sub-range extraction (+concat for word-deletes) → crop keyframes → scale → subtitles burn → overlays (logo/lower-third PNG) → loudnorm → x264 CRF 18 high + AAC 192k.
4. Store output; create exported_file w/ 7-day signed download link (re-signable on demand).
5. UI: progress (queued/rendering %/done), download button, export history table.
6. Failure: retry ×2; then failed w/ user-visible reason + "try again" that reuses the job (idempotent).

## 16. Authentication and Authorization

Email OTP + Google OAuth; session via httpOnly cookies; every API handler resolves (user, workspace, role) through one middleware; single `assertAccess(entity, workspaceId)` guard used by ALL queries (no ad-hoc where-clauses); role matrix: owner/admin (billing, templates, delete), editor (import, edit, export), approver (approve/comment — Phase 7), viewer (read). Storage access only via short-TTL signed URLs; export downloads authorized per request. Future team seats: schema already supports; UI later.

## 17. Storage

Buckets/prefixes: `src/` originals, `audio/` extracted, `thumbs/` posters+sprites, `previews/` 480p proxies, `exports/` finals, `brand/` logos/intros/fonts, `tmp/` worker scratch. Cleanup policies: tmp 24h; failed-upload orphans 24h; previews regenerable — 30d; originals + exports per plan retention (MVP: keep; flag for policy); all deletes soft-logged to audit.

## 18. Job Queue

Workers: `finalize`, `probe`, `fetch-url`, `transcribe`, `analyze`, `generate-clips`, `preview-render`, `export-render`, `cleanup`. Every job: idempotency key (type+entity+config-hash), retries w/ backoff (network-classed errors only; deterministic failures fail fast), timeout per type (probe 2m, transcribe 30m, analyze 10m, render 30m), heartbeat + stuck-job reaper, state transitions persisted + broadcast (SSE/poll), user-facing failure message distinct from internal error. Priority lanes: interactive (preview) > batch (analysis) > cleanup. Concurrency: renders limited by CPU cores; ASR by provider rate.

## 19. API Design

REST (or tRPC mirroring these shapes). All responses `{ data }` or `{ error: { code, message, retryable } }`.

- `POST /api/imports/url-preview` {url} → {title, durationS, thumbnailUrl, estMinutes}
- `POST /api/uploads/presign` {filename,size,type} → {uploadId, parts[]}
- `POST /api/uploads/:id/complete` → {sourceVideoId}
- `POST /api/projects` {sourceVideoId, config{language, lengthBucket, timeframe{startS,endS}, srtKey?, brandTemplateId?, mode: clip|caption_only, genre: sermon|talk|podcast}} → {projectId} (validates balance; reserves minutes)
- `GET /api/projects` / `GET /api/projects/:id` (embeds jobs summary)
- `POST /api/projects/:id/cancel`
- `GET /api/projects/:id/clips?sort=score|time&filter=liked,edited`
- `PATCH /api/clips/:id` {title?, status?, liked?}
- `GET /api/clips/:id/edit-state` / `PUT /api/clips/:id/edit-state` {baseVersion, state}
- `GET /api/videos/:id/transcript?fromMs&toMs`
- `POST /api/clips/:id/exports` {filename?} → {exportJobId}
- `GET /api/exports?workspace` / `GET /api/exports/:id` → {state, progress, downloadUrl?}
- `GET/POST/PATCH /api/brand-templates`
- `GET /api/usage/ledger?cursor` / `GET /api/usage/balance`
- `GET /api/notifications` / `POST /api/notifications/:id/read`
- Stubs returning 501 with roadmap note: `/api/integrations`, `/api/posts`, `/api/integrations/pulpit-engine/webhook` (see §25).

Include request/response TypeScript types shared via a `contracts` package.

## 20. Error Handling

Every error: internal code, user message, retryable flag, log with job/workspace context, recovery path.

| Code | User message (tone: plain, no blame) | Recovery |
|---|---|---|
| INVALID_FILE_TYPE | "That file isn't a video we can read." | re-upload |
| FILE_TOO_LARGE | "Videos up to 5 GB for now." | compress/split |
| VIDEO_TOO_LONG | "Videos up to 3 hours for now." | trim timeframe |
| UPLOAD_INTERRUPTED | "Upload lost connection — resume?" | resume parts |
| URL_IMPORT_FAILED | "We couldn't fetch that link (private or removed?)." | check link |
| TRANSCRIBE_FAILED | "We couldn't transcribe the audio." | retry; support link; auto-release reservation |
| ANALYZE_FAILED | "Clip analysis failed — your minutes were returned." | retry |
| NO_CLIPS_FOUND | "We didn't find strong standalone moments. Try a narrower timeframe or a prompt." | adjust + re-run (no double charge for same config) |
| RENDER_FAILED | "Export failed on our side — your clip is safe." | auto-retry, then manual |
| STORAGE_UNAVAILABLE | "Storage hiccup — try again in a minute." | retry |
| PERMISSION_DENIED | "You don't have access to that workspace." | switch workspace |
| INSUFFICIENT_MINUTES | "This needs ~{n} minutes; you have {m}." | shorten timeframe / upgrade |
| DOWNLOAD_LINK_EXPIRED | "Link expired — here's a fresh one." | auto re-sign |
| PUBLISH_UNAVAILABLE | "Direct posting isn't available yet." | download path |

Never show stack traces; never mark a failed thing as done; a canceled/failed pipeline always releases reserved minutes (verified by test).

## 21. Testing Requirements

- Unit: scoring weights math; boundary snapping; caption line-breaking; ASS generation (golden files); credit reserve/settle/refund invariants (property tests: balance never negative, ledger sums to balance).
- API: auth guard on every route (fuzz cross-workspace ids); schema validation; idempotent export charge (submit same job twice → one charge).
- Workers: each job type happy + timeout + retry + cancel; stuck-job reaper.
- FFmpeg: filtergraph builder snapshot tests; render 3 fixtures (talking head, music-intro sermon, low-light) → assert duration/resolution/streams; SSIM caption-frame diff vs golden PNGs.
- Transcript parsing: provider mock + real SRT fixtures incl. malformed.
- Editor state: version-conflict rejection; word-delete → sub-range mapping.
- E2E (Playwright): full happy path (upload fixture → clips → edit → export → download); failure path (bad URL; canceled mid-processing → balance restored).
- Accessibility: axe pass on all pages; keyboard-only editor smoke.

## 22. Deployment Assumptions

Infrastructure topology: one **new, dedicated Railway project** (e.g. `sermon-clipper`) containing the worker services (FFmpeg render, queue workers), Redis, and Postgres — or a fresh Supabase project supplying Postgres/Auth/Storage with Railway running only the workers. Web app on Vercel or as a service in the same Railway project. This project shares nothing with any other Railway project: separate env vars, separate databases, separate domains, separate spend tracking. Env vars documented in `.env.example`: DB URL, storage keys/bucket, Redis URL, ASR provider key, Anthropic key, auth secrets, Resend key, Sentry DSN, PUBLIC_URL. Migrations run on deploy (one ordered path; never hand-edit applied migrations). Worker image includes ffmpeg+libass+fonts. Queue + workers scale independently of web. Rate limits at edge (per-IP auth, per-workspace API). Backups: nightly DB snapshot + storage lifecycle rules. Cost controls: per-workspace daily processing cap; provider spend alarms; render CPU ceiling. Logging/monitoring wired before public traffic.

## 23. Implementation Phases

1. **Foundation:** app shell, auth, schema+migrations, workspace/project models, dashboard skeleton, seed data. *Done when: login → empty dashboard → create project record.*
2. **Upload & processing plumbing:** presigned uploads, probe, thumbnails, job framework + status UI, cancel, ledger reserve/release. *Done when: upload → probed project with visible stages.*
3. **Transcription:** audio extract, provider integration, storage, transcript viewer, SRT override. *Done when: sermon fixture shows timestamped transcript.*
4. **AI clip generation:** chunking, scoring, titles, clip list UI with badges + reasons, like/dislike. *Done when: fixture produces ≥5 sensible ranked clips.*
5. **Editor MVP:** script editor (delete/restore, pause chips), extend modal, caption presets + controls, layout (center/face/manual), preview overlay, autosave. *Done when: trims + styled captions persist and preview.*
6. **Export:** filtergraph builder, caption burn, crop, loudnorm, download links, export history. *Done when: downloaded MP4 matches editor state.*
7. **Church features:** sermon-boundary pre-pass, sermon scoring rubric swap, scripture detection (+verify), brand template w/ lower-third, approval state machine + review link. *Done when: worship set excluded automatically; approver can approve from phone.*
8. **Polish & reliability:** all §20 errors exercised, retries, usage caps, test suite green, observability dashboards, perf pass (45-min sermon E2E < 15 min wall clock).

## 24. Acceptance Criteria (MVP complete when)

- Sign up, log in, land in own workspace.
- Upload a 45-min 1080p sermon OR paste a YouTube link; see minute cost before confirming.
- Processing runs async with visible stages; cancel returns reserved minutes.
- Transcript with word timestamps viewable.
- 5–10 suggested clips, each with title, total score, subscores, and a one-sentence reason.
- Preview any clip; adjust start/end by deleting/adding transcript words; edit caption text; pick a caption style; export 9:16 1080p MP4 with burned captions; download it.
- Every failure mode in §20 shows its message and recovery path; no failed job charges minutes.
- All data scoped to the correct workspace (cross-workspace fuzz test passes).
- CI: unit + API + one E2E happy path green.

## 25. Future Integration: Pulpit Engine Bridge (reserved — do not build in MVP)

This product is infrastructurally isolated from Pulpit Engine per the constraints in §1: separate repo, separate Railway project, separate database, no shared credentials. That isolation is permanent and non-negotiable, even as the two products mature. What is *not* permanent is the possibility of an application-level integration later — Pulpit Engine already maintains a directory of churches (names, campuses, pastors, service schedules) in its own Supabase, and a future version of this product may want to read that directory (so a church doesn't re-enter its profile) and/or report clip/publishing activity back for Pulpit Engine's dashboards.

Design for that possibility now by leaving seams, not by building the integration:
- The `external_refs jsonb` column on `workspaces` (§6) is reserved for this — eventually `{ "pulpitEngineChurchId": "..." }`. Leave it empty; nothing in the MVP reads or writes it.
- Any future sync MUST be API-to-API — Pulpit Engine exposing an authenticated endpoint this product calls, or this product exposing one Pulpit Engine calls. Never a direct cross-project database connection, a shared connection string, or shared service-role credentials, no matter how convenient that looks later. This is what keeps the §1 isolation guarantee real instead of aspirational.
- Stub the endpoint shape only: `POST /api/integrations/pulpit-engine/webhook` returns 501 "not yet available." This reserves the URL so a future sync doesn't force a breaking route change.
- Do not build a Pulpit Engine-specific auth handshake, data mapping, or sync job in this phase. This section exists purely so a future integration is a small, additive lift — it should not slow down, complicate, or influence any other part of the MVP build.

## 26. Coding Agent Instructions

Bootstrap a fresh standalone git repository (suggested name `sermon-clipper`) with README, `.env.example`, and CI from the first commit — this repo never lives inside another project's repo. Build incrementally phase by phase; prefer simple working implementations over premature generality (but keep the provider interfaces for ASR/LLM/storage). Typed end to end; zod at boundaries. Every schema change is a migration in the single ordered path. Seed script: demo workspace + a 3-min fixture video + pre-baked transcript so the UI is demoable without provider keys. Keep UI original — no competitor names, preset names, or copy. Ask for clarification only when truly blocked; otherwise decide, document the assumption in `DECISIONS.md`, and move on. Deliver: runnable code, `README` setup (local + deploy), test instructions, known limitations list. Honesty rule: if a feature is stubbed, label it stubbed in code and UI — never fake a green path.
