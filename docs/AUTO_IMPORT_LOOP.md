# Auto-Import Goal (autonomous Claude loop, Phases 1–4)

> **Goal prompt for an autonomous Claude loop.** Work this document top to bottom until every
> checkbox is either `[x]` (done, verified, committed) or `[~]` (blocked on a human/dashboard
> action, recorded in "Human actions required" below). This file is the single source of truth
> for progress — update it as you go and include it in each commit. The full design rationale
> lives in `/Users/jakegandara/.claude/plans/parallel-forging-rocket.md`; this file distills it
> into an executable checklist so a fresh loop instance doesn't need that path to proceed.

## Mission

Add auto-import: a workspace registers a public YouTube channel, and a background poller
periodically turns new uploads into Projects automatically — the same pipeline a manual upload
already goes through, just without a human clicking upload. Confirmed decisions (do not
re-litigate): **YouTube only** for v1; **app-level `YOUTUBE_API_KEY`** (like `ANTHROPIC_API_KEY`),
**no per-workspace OAuth**, polling only *public* channel data; **no bulk backfill** on
registration (only videos published after registration are ever imported).

This is not greenfield: `src/lib/project-service.ts`'s `createDraftProjectForWorkspace`
(URL-paste path) already creates the `SourceVideo`/`Project` but stubs the fetch — FINALIZE is
created `WAITING` with `errorCode: "URL_IMPORT_UNAVAILABLE"`. Phase 1 below closes that gap (which
also fixes manual URL-paste, a real independent win), and Phases 2–4 build channel registration
and polling on top of the now-working fetch adapter.

## Operating rules

1. **One sub-item per iteration.** Pick the next unchecked item, implement it completely, verify
   it, commit it, tick it. Do not batch unrelated items into one commit.
2. **Verification gate.** `npm run verify` must pass before every commit. If the item touches
   DB-backed logic, also run `npm run test:integration` (requires `docker compose up -d`). If it
   touches a browser-facing flow (Phase 2 settings UI), run `npm run test:e2e` if the existing
   suite already covers comparable settings pages.
3. **Honesty rule (inherited from `docs/PRELAUNCH_REVISIONS.md`).** Never fake a green path, never
   stub something and mark it done, never claim a test proves something it doesn't. Unit/
   integration tests must exercise real parsing/branching/dedup logic; only the true external
   boundary (the YouTube API call, the yt-dlp subprocess) may be an injected fake — the same trust
   boundary this repo already accepts for ffprobe/whisper-cli. CI must never make a real network
   call to `googleapis.com` or shell out to a real `yt-dlp` binary.
4. **Read before writing.** This is Next.js 16 with breaking changes — read the relevant guide in
   `node_modules/next/dist/docs/` before writing new route/action code. Match existing patterns:
   business logic in `src/lib/*`, thin route handlers/server actions, Zod validation,
   `requirePrimaryWorkspacePermission`/`assertWorkspaceScope` on every data path, operational
   events via `src/lib/observability/operational-events.ts`, async `params` (`Promise<{...}>`)
   on any new dynamic route.
5. **Secrets discipline.** `YOUTUBE_API_KEY` flows only `.env.production.local` → Railway
   variables, same as every other provider key. Never commit, print, or log its value — this repo
   already had two credential-hygiene near-misses this cycle (see `docs/LAUNCH_NIGHT.md`), so
   treat this rule as non-negotiable, not best-effort.
6. **Record decisions.** Any non-obvious tradeoff gets a dated entry in `DECISIONS.md`
   (Decision / Why / Tradeoff / Status). At minimum: superseding the "URL Import Stays Stubbed"
   entry after Phase 1, and the "no bulk backfill on registration" choice in Phase 2.
7. **Commit discipline.** Conventional, descriptive one-line commit messages matching the repo's
   existing style. Commit locally only — **never push** unless the human explicitly asks.
8. **No cloud resources or spend.** Do not create a Google Cloud project, enable APIs, or mint a
   `YOUTUBE_API_KEY` yourself — that's a human/dashboard action (see below). Do not deploy to
   Railway or touch production env vars. Build and test everything against local
   Postgres/fixtures/injected fakes.
9. **Stuck rule.** If the same step fails 3 times with no new information, log it under Blocked,
   move to the next independent item.
10. **Stop condition.** All phases done or blocked → write "## Loop result" (what shipped, what's
    blocked, exact next-session to-do list), commit this file + any doc updates, stop the loop.

---

## Phase 1 — yt-dlp fetch adapter (standalone; unblocks manual URL-paste too)

- [x] **1.1** `src/lib/media/ytdlp.ts`: `parseYtDlpMetadataJson` (pure parser, unit-testable
      against fixture JSON — mirror `parseFfprobeOutput`'s test shape), `fetchYtDlpMetadata(url)`
      (`yt-dlp --dump-json --skip-download`), `downloadYtDlpVideo(url, destPath, { maxBytes })`.
      Both fetch/download functions must accept an injectable subprocess-execution function so
      tests never shell out for real.
- [x] **1.2** `src/lib/jobs/handlers/finalize.ts`: before the existing
      `if (!project.sourceVideo?.storageKey)` throw, branch on `origin === URL && !storageKey`:
      fetch metadata, check duration against `MAX_VIDEO_DURATION_S` and the workspace's plan limit
      *before* downloading (fail with `URL_IMPORT_FAILED`/`VIDEO_TOO_LONG`, not a partial
      download), download into the existing `mkdtemp` workDir, `storage.uploadFile(key, tmpPath,
      "video/mp4")` (no storage-layer change needed), update `sourceVideo.storageKey`, then fall
      through into the unchanged probe/reserve/enqueue-PROBE flow.
- [x] **1.3** `src/lib/worker/reliability.ts`: extend `checkWorkerRuntimeEnvironment` with a
      `YTDLP_PATH` check, following the exact `FFMPEG_PATH`/`FFPROBE_PATH` injected-
      `commandAvailable` pattern (unit test alongside the existing fakes in
      `tests/worker-reliability.test.ts`).
- [x] **1.4** `Dockerfile.worker`: install the `yt-dlp` static binary in the runtime stage.
- [x] **1.5** `src/lib/project-service.ts`: `createDraftProjectForWorkspace` now enqueues FINALIZE
      as `state: QUEUED` with `idempotencyKey: finalize:${project.id}` and `status: QUEUED`
      (mirroring `createProjectFromUploadedSourceVideo`) instead of the `WAITING`/
      `URL_IMPORT_UNAVAILABLE` stub. Update/remove its now-stale doc comment.
- [x] **1.6** `DECISIONS.md`: add a dated entry superseding "2026-07-06 — Phase 2 Upload Is Real;
      URL Import Stays Stubbed."
- [x] **1.7** Unit tests for 1.1 and 1.3; integration test proving a pasted URL now produces a
      `QUEUED` FINALIZE job that runs the fetch branch against an injected fake and proceeds to
      PROBE (extend `tests/integration/job-reliability.integration.test.ts` or add a new file).

## Phase 2 — Channel registration model + settings UI

- [x] **2.1** `prisma/schema.prisma` + migration: `ChannelImportPlatform` enum (`YOUTUBE`),
      `ChannelImportSource` (workspaceId, platform, channelId, channelHandle, channelTitle,
      uploadsPlaylistId, enabled, registeredAt, lastPolledAt, lastPollErrorAt/Message,
      `@@unique([workspaceId, platform, channelId])`), `ChannelImportedVideo`
      (channelImportSourceId, platformVideoId, projectId, publishedAt, status,
      `@@unique([channelImportSourceId, platformVideoId])`).
- [ ] **2.2** `src/lib/integrations/youtube.ts`: `resolveUploadsPlaylist(channelIdOrHandle)` via
      `channels.list`, `listRecentUploads(playlistId, { after })` via `playlistItems.list`
      (never `search.list`), using `YOUTUBE_API_KEY`. Plain `fetch`, no `googleapis` dependency.
- [ ] **2.3** `src/lib/channel-import-service.ts`: registration (resolves the channel
      synchronously so a bad handle/URL fails fast with a clear error, not a silently-broken row)
      and workspace-scoped listing/disable.
- [ ] **2.4** `src/app/actions/channel-imports.ts` (server actions) +
      `src/app/app/settings/imports/page.tsx` (new route, gated on `MANAGE_OPERATIONS`),
      following the zod-validate → `requirePrimaryWorkspacePermission` → service-call → revalidate
      shape already used by `src/app/actions/projects.ts`.
- [ ] **2.5** Unit tests for `youtube.ts` (injected `fetch`, canned Data API v3 JSON fixtures:
      happy path, 404 unknown channel, 403 quota/key error) and the registration service
      (duplicate-channel rejection via the unique constraint, bad-input rejection).

## Phase 3 — Worker polling loop (depends on Phases 1 and 2)

- [ ] **3.1** `src/worker/run-jobs.ts`: add `lastChannelPollAt` + `CHANNEL_POLL_INTERVAL_MS`
      (default ~45 min), following the exact `lastCleanupScanAt`/`enqueueDueCleanupJobs`
      timestamp-comparison-in-loop pattern used for the CLEANUP reaper.
- [ ] **3.2** `src/lib/integrations/channel-poller.ts`: `pollDueChannelImportSources(prisma)` —
      for each due, enabled source: list recent uploads, stop at the first already-seen video ID
      or `publishedAt <= lastPolledAt`, and for each new video call
      `createDraftProjectForWorkspace` (Phase 1) with the video URL, recording a
      `ChannelImportedVideo` row per outcome (`imported` | `failed`). Update
      `lastPolledAt`/`lastPollErrorAt`/`lastPollErrorMessage` on the source.
- [ ] **3.3** Integration test (`tests/integration/channel-import.integration.test.ts`): register
      a source, poll against a mocked `youtube.ts` client twice — assert exactly one project per
      new video on the first pass and zero new projects/rows on the identical second pass (dedup
      proof).

## Phase 4 — Rate limits + observability + docs

- [ ] **4.1** `src/lib/rate-limit.ts`: `channelImportDailyProjectLimit()` (env
      `CHANNEL_IMPORT_DAILY_LIMIT`) + `checkChannelImportLimit`, same shape as
      `checkExportJobLimits`/`checkUploadPresignLimit`. Wire into the Phase 3 poller itself — over
      cap, record `status: "skipped_cap"` and retry the same video on a later poll (pacing, not
      permanent rejection).
- [ ] **4.2** `src/lib/observability/operational-events.ts`: add a `"channel_import"` category;
      emit `channel_registered`, `channel_poll_ran`, `channel_import_created`,
      `channel_import_skipped_cap`, `channel_poll_failed` at the appropriate call sites in
      Phases 2–3.
- [ ] **4.3** `docs/DEPLOYMENT.md`: document new env vars (`YOUTUBE_API_KEY`, `YTDLP_PATH`,
      `CHANNEL_POLL_INTERVAL_MS`, `CHANNEL_IMPORT_DAILY_LIMIT`) and a short "Auto-Import" runbook
      section (how to register a channel, how to read poll failures from
      `lastPollErrorMessage`/`/app/settings/operations`).
- [ ] **4.4** Integration test seeding the daily cap and asserting the (N+1)th video for the day
      is `skipped_cap` and gets imported on the next poll once the cap window rolls over.

---

## Human actions required

> Append here as encountered. Known-in-advance:

- **Before Phase 3 can be verified end-to-end (real, not mocked):** create/enable the YouTube Data
  API v3 in a Google Cloud project, mint an API key restricted to that API, and set
  `YOUTUBE_API_KEY` in `.env.production.local` for local testing (Railway variables only at actual
  deploy time, which is out of scope for this loop per rule 8).
- **Local manual verification of Phase 1 (optional but recommended):** install the real `yt-dlp`
  binary locally to manually paste a real short public YouTube URL through the dev UI and confirm
  the full pipeline runs — not required for the loop's automated tests, which use injected fakes.
- **Deploying any of this to Railway** (env vars, redeploying web/worker): human action, out of
  scope for this loop per rule 8.

## Loop result

_(Filled in when the loop reaches its stop condition — what shipped, what's blocked, and the
prioritized next-session to-do list.)_
