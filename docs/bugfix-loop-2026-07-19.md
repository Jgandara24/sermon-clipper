# Overnight Bugfix Loop — 2026-07-19

Fixes for the 14 findings from the 2026-07-19 code review. This file is the single
source of truth for the loop: it holds the work items, the protocol, and the progress
checkboxes. Update the checkboxes in this file as items complete.

## Protocol (every iteration)

1. **Branch:** All work happens on `fix/review-findings-2026-07-19`, branched from
   `feature/tier3-facebook-autopost`. If the branch doesn't exist yet, create it first.
   Never commit to `main` or directly to `feature/tier3-facebook-autopost`.
2. Read this file. Pick the **first unchecked item** in the list below (they are ordered;
   do not reorder or skip unless an item is blocked — if blocked, note why under the item
   and move on).
3. Implement the fix. Rules:
   - Read the relevant guide in `node_modules/next/dist/docs/` before writing any
     Next.js-facing code (per AGENTS.md — this Next.js version has breaking changes).
   - Add or extend unit tests in `tests/` for every behavioral fix. The existing tests
     for a module show the established mocking patterns — follow them.
   - Migrations: run `npx prisma migrate dev --name <name>` against the **local** dev
     database only (the default `DATABASE_URL` fallback in package.json scripts).
     Never point at a remote/production database. Never edit `.env`.
4. Verify: run `npm run verify` (prisma validate + generate, lint, typecheck, unit
   tests, build). For worker-touching items also run `npm run worker:build`. All must
   pass before committing.
5. Commit **one commit per item** on the fix branch with message
   `fix: <short description> (review finding #N)`. Do NOT push. Do NOT open a PR.
6. Check the item's checkbox in this file and include that edit in the same commit.
7. When all items are checked: run `npm run verify` one final time, then append a
   summary section at the bottom of this file titled `## Completion report` listing each
   commit hash and any items skipped/blocked with reasons, commit that, and **stop the
   loop**.

Hard rules for the whole run: no pushing, no deploys, no touching `.env` or anything
under `OUTPUTS/`, no dependency upgrades unless a fix strictly requires one, and no
scope beyond the items below. If an item turns out to need a product decision that
isn't specified here, implement the specified default, and note the open question under
the item.

## Work items (in order)

### - [x] 1. Guard terminal job-state transitions against overwriting CANCELED

> Done. Note: the identical defect existed in the parallel export-job queue
> (`src/lib/exports/queue.ts` / `src/lib/exports/runner.ts`) via stale recovery re-claims,
> so the same RUNNING-guard + lost-claim abort was applied there too.

`src/lib/jobs/queue.ts:89-145` — `markJobSucceeded`, `markJobFailed`, and
`markJobFailedOrRetry` use unconditional `update`, so a job the user cancels mid-run
gets flipped CANCELED → SUCCEEDED (or worse, → RETRYING, re-running a canceled job).
`heartbeatJob` in the same file shows the correct pattern: conditional `updateMany`
guarded on `state: RUNNING`.

**Fix:** Convert all three terminal transitions to `updateMany` guarded on
`state: RUNNING` (for `markJobFailedOrRetry`, guard the RETRYING branch the same way).
Return the count; in `src/lib/jobs/runner.ts`, when the guard fails (count 0), skip the
follow-on project-status update so a CANCELED project is never overwritten with
FAILED/COMPLETED. Also in `runner.ts:44-47` / `src/lib/worker/reliability.ts:153-171`:
check the heartbeat `updateMany` count — if 0, the claim was lost to stale recovery, so
abort the handler instead of continuing to run concurrently with the re-claiming worker
(throwing a dedicated error that the runner catches without marking the job failed is
fine).
**Tests:** cancel-then-succeed and cancel-then-fail scenarios assert state stays
CANCELED; lost-heartbeat scenario asserts the handler aborts.

### - [x] 2. Fix lost-update race on `workspace.settings`

> Done. New helper `src/lib/workspace-settings.ts` (optimistic guard on `updatedAt`,
> 3 attempts); both actions migrated. No other settings write sites existed.

`src/app/actions/facebook-connection.ts:38-62` and
`src/app/actions/workspace-profile.ts:33-57` both read the settings JSON, spread, and
write back non-transactionally. Concurrent saves silently clobber each other — including
re-enabling `autoPostEnabled` (the Tier 3 kill switch) after an owner turned it off.

**Fix:** Add a shared helper (e.g. `updateWorkspaceSettings(workspaceId, mutate)` in
`src/lib/` near the settings parsing code) that does optimistic concurrency: read
`settings` + `updatedAt`, apply the mutation, then `updateMany` guarded on
`updatedAt` equal to the value read; on count 0, re-read and retry (max 3 attempts, then
throw a clear error). Migrate both actions (and any other settings read-modify-write
call sites — grep for `settings` spreads) onto the helper.
**Tests:** simulate an interleaved write (mock client whose first `updateMany` returns
count 0) and assert the retry preserves both changes.

### - [x] 3. Fix `wallClockInstantInTimezone` wrong-day bug for UTC-10/-11

> Done. Correction now compares full wall-clock timestamps (date + time) with a second
> pass for DST-transition exactness.

`src/lib/church-profile.ts:102-123` — the drift correction uses only observed
hour/minute and ignores the date, so 9 AM in Pacific/Honolulu resolves to 9 AM the
**previous** day.

**Fix:** Compute the correction using the full observed date+time in the target
timezone (e.g. format the guess with an `Intl.DateTimeFormat` that includes year, month,
day, hour, minute; build the observed instant from all of those; drift = guess −
observed, including day difference).
**Tests:** exact-instant assertions for Pacific/Honolulu (UTC-10), Pacific/Pago_Pago
(UTC-11), America/Chicago, UTC, Asia/Tokyo (UTC+9), Australia/Sydney, and
Pacific/Auckland, on both a DST and non-DST date for the DST zones.

### - [x] 4. Fix due-time vs publish-time mismatch in the Facebook publisher

> Done. Under 15 minutes of lead the publisher posts immediately (no
> scheduled_publish_time); publishedAt records the actual go-live instant.

`src/lib/integrations/facebook-publisher.ts:104` treats a post as due at UTC midnight
of `scheduledDate`, but `:160` schedules it for 9 AM church-local — which Meta rejects
whenever that instant is less than ~10 minutes in the future (always true for UTC+9 and
east; true everywhere when the export completes after 9 AM local; true for any backlog
at go-live).

**Fix:** After computing `scheduledPublishAt`, clamp: if it is less than **15 minutes**
in the future, publish immediately instead — call the Graph API **without**
`scheduled_publish_time`/`published:false` (adjust `publishScheduledVideo` in
`src/lib/integrations/facebook.ts` to accept an optional `scheduledPublishAt` and omit
the scheduling params when absent). Record `publishedAt` accordingly. Also make the due
query cheap-safe: keep `scheduledDate: { lte: now() }` as-is (the clamp makes it
correct).
**Tests:** past-time → immediate publish params (no `scheduled_publish_time`);
future-time → scheduled params; boundary at exactly now+15min.

### - [x] 5. Make FAILED scheduled posts retryable

> Done. Migration `20260719083000_add_scheduled_post_retry` was hand-written and applied
> via `prisma db execute` + `migrate resolve --applied` instead of `prisma migrate dev`:
> migrate dev demanded a full reset because the pre-existing migration
> `20260718165517_channel_import_sources` was modified after being applied (drift that
> predates this branch — worth investigating separately). `prisma migrate deploy` will
> apply the new migration normally in production.

`src/lib/integrations/facebook-publisher.ts:185-191` — any error (including a network
blip) marks the row FAILED, and nothing ever re-queries FAILED rows. One hiccup =
clip never posts, forever.

**Fix:** Migration: add `attempt_count INT NOT NULL DEFAULT 0` and
`next_attempt_at TIMESTAMP NULL` to `scheduled_posts` (update the Prisma model to
match). On failure: increment `attemptCount`; if `attemptCount < 5`, set status back to
`NOT_STARTED` with `nextAttemptAt = now + backoff` (5min, 30min, 2h, 8h), else FAILED
terminally. Add `nextAttemptAt` (null-or-past) to the due-post query filter. Keep the
operational event on every failure.
**Tests:** transient failure → NOT_STARTED with backoff; 5th failure → FAILED;
due-query respects `nextAttemptAt`.

### - [x] 6. Recover stale IN_PROGRESS scheduled posts

> Done. recoverStaleScheduledPosts (15-min updatedAt cutoff) wired into the worker's
> recovery block; recovery counts as an attempt and fails terminally when exhausted.

`src/lib/integrations/facebook-publisher.ts:144-148` claims NOT_STARTED → IN_PROGRESS,
but if the worker dies before writing a terminal state, the row is stuck "Posting…"
forever (the due query only matches NOT_STARTED).

**Fix:** Add a recovery pass mirroring `recoverStaleProcessingJobs` /
`recoverStaleExportJobs` in `src/lib/worker/reliability.ts`, wired into the worker loop
in `src/worker/run-jobs.ts:56-81`: flip IN_PROGRESS rows whose `updatedAt` is older
than 15 minutes back to NOT_STARTED (this composes with item 5's attempt counter —
increment `attemptCount` on recovery so a poison post still terminates). Record an
operational event on recovery.
**Tests:** stale row recovered; fresh IN_PROGRESS row untouched.

### - [ ] 7. Stop re-analysis from destroying publish records / double-posting

`src/lib/jobs/handlers/analyze.ts:122` deletes all generated clips inside re-analysis,
and `scheduled_posts.clip_id` is `ON DELETE CASCADE` — so a re-run (reachable via the
SRT override upload) cascades away SUCCEEDED scheduled posts (the only record a real FB
post exists) and re-creates NOT_STARTED rows for slots that may already have published
content.

**Fix:** Migration: make `ScheduledPost.clipId` nullable and change the FK to
`ON DELETE SET NULL` (`onDelete: SetNull` in the schema) so publish history survives
clip deletion. In the analyze handler's scheduled-post (re)creation: skip creating a
NOT_STARTED row for any (workspace, scheduledDate, platform) slot that already has a
SUCCEEDED or IN_PROGRESS post. Guard the publisher and calendar UI for null `clipId`
(a SUCCEEDED row with null clip just renders as published history; the due-post query
must exclude null-clip rows).
**Tests:** re-analysis preserves the SUCCEEDED row (clipId null) and does not re-arm
that slot; null-clip rows are never selected as due.

### - [ ] 8. Validate timezone as a real IANA zone

`src/app/actions/workspace-profile.ts:10` accepts any 2–80-char string; "CST" saves
fine, then `Intl.DateTimeFormat` throws on every project creation and in the publisher,
bricking the workspace.

**Fix:** Zod `.refine` that the value is a valid IANA zone — accept it if
`Intl.supportedValuesOf("timeZone")` contains it OR `new Intl.DateTimeFormat("en-US",
{ timeZone: value })` doesn't throw (covers aliases like `US/Central`). Return the
action's normal validation-error shape with a helpful message. As defense-in-depth,
make `calendarDateInTimezone` / `wallClockInstantInTimezone` /`deriveServiceSlot` in
`src/lib/church-profile.ts` fall back to UTC (with a reported error via the existing
error-reporting module) instead of throwing, so a bad stored value can't brick project
creation.
**Tests:** "CST" rejected by the action; stored-bad-zone falls back to UTC without
throwing.

### - [ ] 9. Fail closed when `NEXT_PUBLIC_APP_URL` is unset in the worker

`src/lib/integrations/facebook-publisher.ts:53` falls back to
`http://localhost:3000` for `file_url`; Meta fetches it asynchronously, so the post is
marked SUCCEEDED while the video silently never uploads.

**Fix:** In the publisher run, if the configured app URL is missing or is a
localhost/127.0.0.1 URL, skip publishing entirely: count the posts as skipped in the
summary, record a single `severity: "error"` operational event
(`facebook_publish_misconfigured`), and leave rows NOT_STARTED. Do not mark anything
FAILED.
**Tests:** unset URL → no Graph calls, rows untouched, event recorded.

### - [ ] 10. Add `maxBuffer` to yt-dlp metadata fetch

`src/lib/media/ytdlp.ts:62-67` — promisified `execFile` defaults to 1 MiB stdout;
`--dump-json` for a normal YouTube video with many formats/auto-captions exceeds it and
the import fails with a generic internal error.

**Fix:** Pass `maxBuffer: 64 * 1024 * 1024` (match `render.ts`).
**Tests:** existing ytdlp tests still pass; add one asserting the option is passed if
the mocking pattern makes that natural, otherwise skip the test.

### - [ ] 11. Enforce download size cap post-download

`src/lib/media/ytdlp.ts:91-100` — `--max-filesize` is per-format, pre-merge, and
skipped for unknown-size formats, so merged output can exceed `maxBytes`.

**Fix:** Keep the flag, but after download `stat` the resolved file in
`resolveDownloadedFile` (or just after it) and throw a typed error (e.g.
`YtDlpFileTooLargeError`) when `size > maxBytes`; delete the oversized file. Map the
error to a user-facing "video too large" message wherever download errors are already
classified (check the callers, e.g. the finalize/import handler).
**Tests:** oversized file → typed error + file removed; at-limit file passes.

### - [ ] 12. Return 409 (not 500) on concurrent clip-editor saves

`src/app/api/clips/[id]/edit-state/route.ts:96-158` — the version check isn't atomic
with `clipEdit.create` (`@@unique([clipId, version])`), so an autosave racing a manual
save throws an uncaught P2002 → 500 instead of the intended `EDIT_STATE_CONFLICT` 409.

**Fix:** Catch Prisma P2002 around the create and return the same 409
`EDIT_STATE_CONFLICT` response the version check produces.
**Tests:** mock create throwing P2002 → 409 with the conflict body.

### - [ ] 13. Make `enqueueJob` idempotency race-safe

`src/lib/jobs/queue.ts:25-40` — find-then-create; two concurrent calls with the same
`idempotencyKey` race and the loser throws P2002 up as a 500 instead of returning the
existing job.

**Fix:** Try `create` first and catch P2002 → `findUnique` by idempotency key and
return the existing job (keep the fast-path `findUnique` first if you like; the catch
is what matters).
**Tests:** create throwing P2002 → existing job returned.

### - [ ] 14. Make default-template flip atomic

`src/app/actions/templates.ts:43-61` — the save and the clear-other-defaults
`updateMany` are separate queries; concurrent saves can leave two defaults.

**Fix:** Wrap both statements in `prisma.$transaction`, clearing other defaults
**before** setting the new one inside the transaction.
**Tests:** unit test asserting both operations run inside a transaction (per existing
mocking patterns).

## Completion report

(append here when done)
