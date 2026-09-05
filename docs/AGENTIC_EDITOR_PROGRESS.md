# Agentic Editor — Build Progress and Handoff

**Purpose.** `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` is the *target*. This file is the
*actual*: what shipped, what deviated, and what the next agent needs to know that the plan does not
say. `DECISIONS.md` remains the authoritative record of decisions; this is a working index.

**Last updated:** 2026-09-05, after the editor delta plan closed and the product owner chose to
build the whole implementation plan in order.

---

## Where the build stands

`main` is at `9f5470b` (PR #81, 2026-09-05). Production web and worker both run P1's last commit.

| Work | State | Evidence |
|---|---|---|
| P0 (20 commits) | done | merged as `331dbc5` (PR #34, 2026-08-14); table below |
| Pre-P1 model routing and Trial/Paid | done | `aff7979` (PR #36); independent audit `0344735` (PR #37) |
| P1.1 render a pinned edit version | done | `9c0e8fc` (PR #42, 2026-08-20) |
| P1.2 export identity is clip + edit version | done | `ea6f9f7` (PR #53, 2026-09-02) |
| P1.3 mandatory render QC | done | `8e7ab42` (PR #54, 2026-09-02) |
| P1.4 no new internal word cuts | done | inside editor Slice 5, `01860fa` (PR #47, 2026-08-21) |
| P1.5 one continuous range at export | done | the gate landed with Slice 5 (`1d4b8e3`); the one-pass renderer on 2026-09-05 — see below |
| Editor delta plan, Slices 1–13 | done | PRs #43–#51, #55, #58, #60–#65, #67–#72; plan closed 2026-09-05 |
| P1.6 stable caption override identity | done | 2026-09-05; `captionLineId` names a line by its words; legacy `line-N` is read by position, never written |
| P1.7 block destructive reanalysis | done | 2026-09-05; `reanalysis-policy.ts` refuses a rebuild once durable work exists, at the route and in both handlers |
| P1.8 posting schedule module | done | 2026-09-05; `src/lib/schedule/posting-schedule.ts` allocates weekday slots and `deriveServiceSlot` returns `UNMATCHED`. Pure — no production caller until P1.9 |
| P1.9 arm weekday slots, stage retention | done | 2026-09-05; `analyze.ts` arms from the allocator behind `AUTOMATIC_SCHEDULE_ARMING_ENABLED`; `expiresAt` set; source deletion report-only behind `SOURCE_RETENTION_DELETION_ENABLED`. Both flags default false |
| P1.10 capture and correct service occurrence | done | 2026-09-05; direct uploads state the service date and occurrence; correction gated at the reanalysis boundary |
| P1.11 delivery eligibility module | done | 2026-09-05; `src/lib/delivery/{eligibility,settings,query}.ts`, wired into the publisher; the latest-export fallback is gone |
| P1.12 harden publication claims | done | 2026-09-05; intent rows before the Meta call, exact claim, indeterminate outcomes block instead of retrying |
| P2.1 deploy migration wave 2 | done | 2026-09-05; `clip_reviews`, `clip_review_feedback`, the platform-operator marker and the editorial program tables. Append-only enforced by a database trigger, not by the service that writes it |
| P2.2–P8 | not started | |

**The decision that sets the order (2026-09-05).** The product owner chose to build the whole
plan in order — P1.5's remainder, then P1.6 through P1.12, then P2, P3, P4, P5 and P6 — and to
take no paying customer until automatic publishing works. The 90-day launch date set on 2026-07-18
no longer binds. Automatic publishing turns on at the end of P2, after the product owner runs the
Tier 3 sandbox test by hand (`docs/TIER3_SANDBOX_TEST_CHECKLIST.md`), and not before. Recorded in
`DECISIONS.md` as "Build The Whole Plan In Order; No Customer Until Publishing Works".

### P1.5, in two parts

The gate: `CONTINUOUS_RANGE_REQUIRED` in `src/lib/exports/continuous-range.ts`, with Slice 5. The
worker refuses a pinned document that would render as more than one span, before it downloads
anything; the route answers the same question at request time. Recorded in `DECISIONS.md` on
2026-08-20 as "The P1.4 Continuous-Range Export Gate Landed Early, With Slice 5" — that entry
numbers the gate as P1.4, the plan numbers it as P1.5; it is one gate.

The renderer, 2026-09-05: `src/lib/export/render.ts` runs one ffmpeg pass over the clip's one
range — seek, trim, crop, fill, burn, normalise, encode — where it ran three (one re-encode per
kept range, a concat, then the final encode). `src/lib/exports/render-plan.ts` carries `range`
and asserts the gate itself; `toOutputTimeline` in `src/lib/export/output-timeline.ts` is the one
source-to-file conversion. Recorded in `DECISIONS.md` as "An Export Is One Range In One Pass". A
fresh render of an old clip now differs in bytes from the three-pass output and improves in
quality; nothing stored changes.

### P0 commits

| Commit | SHA | State | Notes |
|---|---|---|---|
| P0.0 record repository-visibility policy | `6ddbba6` | done | Reauthored; originally `db7c1c3` |
| P0.1 sandbox evidence + decision-log catch-up | `737a01c` | done | `CTO.md` deliberately excluded |
| P0.2 freeze the accepted product rules | `30dbfc7` | done | Sanitized plan copy committed |
| P0.3 labeled benchmark manifest | `855567e` | done | 22 tests added |
| P0.4 charter the current analyzer and scheduler | `7f382dc` | done | 10 integration + 11 unit tests; adds funnel-metrics instrument |
| P0.5 candidate-limit resolution | `3873b28` | done | 7 unit tests; extracts the shared scheduled-count reader |
| P0.6 hidden staff-only church override | `328e40b` | done | Protected operations CLI and 9 integration tests |
| P0.7 project configuration snapshot | `e2271cb` | done | One shared snapshot boundary; 4 unit + 2 integration tests |
| P0.8 dynamic ANALYZE candidate limit | `0df9c3a` | done | Honors the frozen ceiling; 2 integration tests |
| P0.9 production analysis fail-closed policy | `6715321` | done | Explicit provenance, emergency override, and job-time events |
| P0.10 typed COGS event contract | `e145719` | done | Versioned paid/local cost facts, separate from entitlements |
| P0.11 source acquisition metering | `fd613d1` | done | Direct/proxy bytes, partial failures, retries, and Railway egress |
| P0.12 all-stage processing metering | `e668753` | done | Claude, Whisper, FFmpeg, and storage facts with legacy rollup support |
| P0.13 preserve spoken words | `c941974` | done | Filler tags are metadata; never-edited export preserves every word |
| P0.14 accurate crop claims | `3fac93e` | done | UI states that Face mode is a static center crop |
| P0.15 collision and legacy-export preflight | `1e98f25` | done | Earlier date wins visibly; two read-only production audits |
| P0.16 global publisher kill switch | `7c6572a` | done | Exact positive-enable guard at the publisher boundary |
| P0.17 correctness-substrate migration | `e747196` | done | Expand-first schema wave; publishing stays disabled |
| P0.18 daily cost rollups and worker isolation | `354ea5d` | done | Durable totals and independent periodic blocks |
| P0.19 real-service cost-truth gate | `cef55a5` | done | Direct upload passed at $1.81 per typical month; YouTube remains disapproved |
| P0.20 plan-grid conflict report | `dd010e7` | done | Superseded by the Trial/Paid decision |

P0 merged to `main` as `331dbc5`.

### Pre-P1, as history

The pre-P1 change (`aff7979`, PR #36) added versioned per-stage analysis routing, an
effective-dated model price catalog, a Google Gemini adapter, a no-mutation shadow evaluation
command, and Trial/Paid access. The old minute balance remains as history. It is not an access
gate. The P0.19 Gate A report was corrected to use the Sonnet 5 price that was active on the run
date.

Claude policy version 1 remains active. Google policy version 2 failed its shadow test because
Google no longer offers `gemini-2.5-flash-lite` to new users. Draft version 3 uses the current
stable `gemini-3.1-flash-lite` model and completed one paid, no-mutation shadow run against the
existing 47-minute Gate A service. It sent 25 of 491 candidates to Stage B and reduced estimated
analysis cost by 30.6 percent, but all candidate starts remained inside the first quarter of the
service. Human review rejected activation on 2026-08-14. Keep Claude policy version 1 active, keep
Google policy version 3 as a draft. The public-safe facts are in
`evaluation/routing-shadow-2026-08-14.json`.

An independent review of all P0 commits and the pre-P1 merge ran on 2026-08-14 (`0344735`,
PR #37). It confirmed eight defects and fixed them: the yt-dlp proxy URL reaching church-visible
events, the hidden candidate ceiling and override reaching the same operations page, Stripe
webhook events lost after a processing failure, routing activation accepting heuristic stages, the
shadow evaluation falling back to the heuristic scorer, non-deterministic price selection across
overlapping windows, double-recorded and work-destroying cost facts, and a readiness check that
could pass while the active routing policy could not run. It also closed two decisions: a
workspace that has paid never returns to an unfinished trial, and cost telemetry never fails
customer work while Gate A enforces completeness (cost-truth schema version 2). No charter
assertion was changed. The Stage A front-loading baseline stays intact for P5 to invert.

### The editor delta plan, as history

Between P1.1 and P1.2 the editor was rebuilt slice by slice on `main`, following
`docs/EDITOR_DELTA_PLAN_2026-08-18.md` (Slices 1–13, 2026-08-20 to 2026-09-05). That plan is
closed. Each slice's "Built" note in it says what landed and what the plan had wrong. The three
findings most likely to matter to later phases: a trim in an export is a range, never a mid-clip
word cut; the export's every render decision is derived in one pure place,
`src/lib/exports/render-plan.ts`, which the parity gate drives with the same document the preview
holds; and the workspace billing badge now resolves through the exhaustive `workspaceAccessLabel`
switch in `src/lib/billing/access.ts`, under a one-time authorised exception that is closed.

---

## Deviations from the plan

Each of these is a deliberate departure. Follow them; do not "correct" them back to the plan text.

1. **`CTO.md` is never committed while the repository is public.** The plan's original P0.1 file
   list included it. The 2026-08-11 visibility decision removed it. It stays in the operator's
   Dropbox workspace. `DECISIONS.md` references it as an external private document.

2. **The benchmark zod module lives in `src/lib/evaluation/benchmark-manifest.ts`.** The plan listed
   only `evaluation/`, `scripts/`, and `tests/` files. Validation logic belongs in `src/lib` per the
   repository's pure-module convention, and the script is a thin CLI over it. `evaluation/` holds
   only human-facing artifacts and data.

3. **`evaluation/benchmark-manifest.schema.json` is generated, not authored.** It is produced from
   the zod module by `z.toJSONSchema()`. A unit test asserts the committed file matches. Editing it
   by hand fails CI. Regenerate with `npm run verify:benchmark -- --write-schema`.

4. **P0.2's public plan copy is redacted.** Revenue and margin projections, the scale model, price
   positioning, and private-plan §§14–15 (the P5 Selector policy and P6 Review Agent design) are
   withheld and marked in place. The exact-value redaction manifest stays in the private plan and is
   **not** committed — publishing a checklist of protected values defeats the purpose.

5. **Two P0.4 charter scenarios were added after the plan was written**, from the 2026-08-11
   production measurement. See "P0.4 preconditions" below.

6. **Wave 1 uses two consecutive migration directories.** PostgreSQL will not let the partial
   date index use the new `MISSED` enum value in the same transaction that adds it. The first
   migration commits all enum expansion. The second adds the Wave 1 substrate and the exact index.
   Clean-database and production-shaped upgrade tests both passed this order.

7. **P1.1's pinned-state loader lives in `src/lib/exports/`, not `src/lib/editor/`.**
   `loadPinnedEditorState` is in `src/lib/exports/edit-version.ts`. It reads the database, so it
   belongs with the orchestration modules, not with the pure editor math.

8. **P1.3 needed no migration.** Wave 1 had already added `qcStatus`, `qcCheckedAt`, `qcChecksum`
   and `qcDetails` to `ExportJob`. The plan was right about that.

9. **P1.4's conversion is a control, not a module.** There is no
   `src/lib/editor/continuous-edit.ts`. The explicit conversion is `restoreAllDeletedWords` in
   `src/lib/editor/transcript.ts`, reached from the "Restore all deleted words" control in the
   Script panel. It is a versioned edit the member asks for, never a background migration, because
   word ids are positional and a silent rewrite could repoint them at different words.

10. **The editor was rebuilt slice by slice on `main`, not by merging the prototype.** Branch
    `p1/kinetic-captions-and-editor` (`914d23d`) stays unmerged and labelled `PROTOTYPE, NOT
    ACCEPTED`. Nothing on it counts as existing on `main`. `docs/EDITOR_DELTA_PLAN_2026-08-18.md`
    is the record of what was built instead.

---

### The Inter font question, decided 2026-09-05

Asked to choose between bundling Inter and leaving preview and burn-in differing. Took neither:
both change what approved clips render with, and a third option does not.

Only the **fallback tail** of the affected stacks moved, to a bundled family — `Inter, 'DejaVu
Sans', sans-serif` and `Georgia, 'DejaVu Serif', serif`. The ASS `Fontname` is
`resolveCaptionFace()`, the first family, which is untouched, so the rendered file cannot change.
The preview reads the whole stack (`video-preview.tsx:657`), so it now lands on the same face the
worker draws with instead of on `system-ui`.

**An attempt to verify the bolder option failed, and that is why it was not taken.** Renaming the
first family looked safe: `fc-match` maps `Inter` to DejaVu Sans and `Georgia` to DejaVu Serif. A
burn test with ffmpeg was meant to confirm it and instead proved the test worthless — libass
ignored the restricted `FONTCONFIG_FILE` and substituted a macOS system face, rendering `Inter`
byte-identically to a family that exists nowhere. Docker was not running, so the built worker
image could not be checked either.

**What would settle it:** inside the built worker image, render one clip with the first family
named and again with the bundled family named, and compare the frames. Until then the head of each
stack is frozen. The existing guard test was narrowed rather than deleted: it now asserts the first
family of each retired preset, which is the part that reaches a file.

### P2.1 deviations

**Append-only is a database trigger, not a service rule.** The plan lists "append-only
constraints" among P2.1's tests without saying where they live. They live in the migration:
`editorial_evidence_is_append_only()` fires `BEFORE UPDATE` on `clip_reviews` and
`clip_review_feedback` and refuses every update, with one exemption for a referential `SET NULL`
clearing a live foreign key. Putting it in P2.3's service instead would leave the standard of
record editable by any script, migration, or future route that forgot the rule.

**`DELETE` is not blocked, and that is a deliberate limit.** Both tables cascade from
`workspaces`. A trigger that refused the cascade would break tenant teardown — and every
integration test that deletes its workspace in cleanup — with an error nobody could act on. The
guarantee is that a decision cannot be silently altered; erasure is bounded by deleting a whole
tenant, which is not a product feature today. Recorded in `DECISIONS.md`.

**Seven feedback categories, not the six the plan lists.** The S15 actionability table names
`CONTENT`, `FORBIDDEN_CONTENT`, `BOUNDARY`, visual crop, `CAPTION` and audio level. The editorial
standard §7 also puts the machine-generated title and hook in front of the reviewer as fields
under review, and none of the six is a home for a finding about them, so `title_hook` was added,
revisable like the other metadata defects. Adding it now costs a line in an unshipped enum; adding
it in P2.6 costs a migration.

**Identity facts are typed columns; context is JSON.** Wave 1's `EditorialException` stores
`projectSnapshot` and `slotSnapshot` as JSON. `ClipReview` splits them: the four facts P2.8 must
match exactly — clip, edit version, the slot's bound export, and the QC-time checksum — are typed
columns because they are query inputs, and the delivery gate has an index over
(`export_job_id_snapshot`, `decision`, `created_at`) that JSON could not serve. Scheduled date,
platform, title and hook stay in `slot_snapshot`.

**No `ClipReview` is seeded, and the program row is.** The seed marks the demo user a platform
operator and upserts the single `human_reference` program plus the demo workspace's `human_only`
cohort row, but it seeds no review. A fabricated review would be evidence of a decision nobody
made, in the one table delivery eligibility trusts. The program row itself is created by the
migration, so P2.9's start command can only ever move an existing row's state.

**The SQL was generated with `migrate diff`, not `migrate dev --create-only`.** The plan says to
use `--create-only`, which needs a dev database in sync with the migration history. The local one
is not: it carries `20260724120000_add_sermon_outline` from `feat/semantic-outline-pipeline` and
is missing `20260814040000_gemini_31_flash_lite_price`, so `--create-only` offers to reset it.
`prisma migrate diff --from-migrations --to-schema-datamodel` against a throwaway shadow database
produces the same SQL without touching the dev database. Verified by replaying every migration
into a fresh database and diffing it back against the datamodel: only the three known spurious
statements remain, so Wave 2 introduces no drift.

**One extra spurious statement had to be removed from the generated SQL.** The plan warns about
"the two known bad tsvector statements". Prisma now also re-emits
`ALTER TABLE "workspaces" ALTER COLUMN "trial_ends_at" SET DEFAULT (CURRENT_TIMESTAMP + interval
'30 days')` — the identical default the column already carries, which Prisma cannot compare
because it is `dbgenerated`. It is a no-op and was removed with the other two. Expect three, not
two, in Wave 3.

### P1.12 deviations

**Its first outcome had already landed in P1.11.** The plan opens P1.12 with "delete the
latest-SUCCEEDED-export lookup", citing `facebook-publisher.ts:199-205`. P1.11 removed it, because
leaving a forbidden path live while introducing the module that forbids it was not defensible.
P1.12 covers the rest: the exact claim, intent rows, and indeterminate handling.

**The retry ladder got narrower, and that is the point.** It previously caught network failures
and 5xx responses — exactly the outcomes where a post may already exist on the Page. Those now
block. What still retries is a refusal: a 4xx, or a rejected token, where Meta created nothing.
Two existing tests described network failures and an HTTP 500 as "transient failures" to retry;
both were respecified, because under the new rule those are the cases that must not retry.

**An unrecognised error is treated as indeterminate.** `classifyPublishFailure` only calls an
outcome definite when it recognises the error as a refusal. A mistaken "indeterminate" costs an
operator one look at the Page; a mistaken "failed" costs the church a duplicate post.

**`PublishAttempt.scheduledPost` is `onDelete: Restrict`, which blocks workspace deletion.**
Surfaced by an integration teardown, not by product code: nothing in `src/` deletes a workspace,
and the Restrict is deliberate — a record that an external post may exist must outlive a cascade.
Fixed in the test teardown rather than by weakening the constraint. Worth knowing if workspace
deletion ever becomes a real operation.

### P1.11 deviations

**The publisher was rewired, though the plan's file list does not name it.** P2.4 states that
"P0.16 and P1.11 must both be deployed before this commit", because P2.4 removes today's accidental
safety barrier. Deployed means in force in the publish path, so a module nobody calls would not
satisfy it. More directly: `facebook-publisher.ts` resolved a clip's newest finished `SUCCEEDED`
export (`orderBy: { finishedAt: "desc" }, take: 1`) — the exact "latest successful export" path
Rev2 §6 forbids, live in the code while a new module declared it must not exist. It now reads only
`ScheduledPost.exportJobId`.

**The publisher gained an injectable `assessDelivery` dep.** With the real rule in place the
publisher refuses every slot, because `review` is null until P2 — intended, but it also makes the
clamp, retry and misconfiguration tests unreachable, and those cover logic that still matters and
must work at P2. The seam lets those cases stub an eligible verdict; two further cases run the
real rule unstubbed and assert it refuses and never claims the row, so the stub cannot hide a
wiring regression. Nothing in production passes the dep.

**Billing access and the transcription hold stay outside the module.** Rev2 says one module
proves eligibility, and the plan enumerates its inputs; neither of those two is among them.
Neither is a fact about whether a render is the right render, and importing plan state into a pure
delivery rule would couple publishing correctness to billing. Both remain in the publisher, ahead
of the eligibility call, and this is recorded rather than left implicit.

**Caption burn-in substitution — resolved 2026-09-05, see the P1.12 entry above and DECISIONS.md.**
The preview now falls back to the bundled face the burn-in actually draws; the first family, which
is what reaches the rendered file, is frozen. Original finding follows.

**Caption burn-in substitution, checked on request and left alone.** `main` ships only the six
DejaVu faces, while three presets name `Inter` and one names `Georgia`. Verified with `fc-match`
against a fontconfig tree holding only `public/fonts`: with the alias rules a Debian image has,
`Inter` resolves to DejaVu Sans and `Georgia` to DejaVu Serif — sensible substitutions, not broken
ones. The substitution is by design: `Dockerfile.worker` deletes the distribution DejaVu copy and
fails the build unless the three bundled families resolve to `public/fonts`, and
`font-metrics.ts` deliberately has no fallback face, so an unbundled family raises and the render
keeps the whole-run path. The two paths that would be dangerous are already guarded — the only
preset with `activeWordHighlight: true` uses a bundled face, and `TITLE_BANNER_FONT_FAMILY` is
`"DejaVu Sans"`. What remains is that the browser preview shows `system-ui` for the Inter presets
while the file gets DejaVu Sans, so preview and output differ for four of five presets. Bundling
Inter would fix it; changing those presets would alter what already-approved clips render with,
which `caption-fonts.ts` warns against. A product decision, not a code fix.

### P1.10 deviations

**A stated calendar date must have its weekday read in UTC.** `buildStatedServiceContext` derives
the occurrence from the date the uploader picked, which is stored at UTC midnight. Passing it
straight to `deriveServiceSlot`, which reads the weekday in the church's timezone, applied the
offset a second time and reported the previous day — a Wednesday service came back `UNMATCHED`
for a Chicago church. Same trap as P1.8, opposite direction. Caught by a unit test.

**The correction writes the snapshot as well as the columns.** P1.9 schedules from
`processingConfig.serviceOccurrence`, so a correction that updated only `Project.serviceSlot`
would have looked applied and changed nothing about the schedule.

**Abandoned uploads now have a cleanup path (added on request, outside the plan's P1.10 scope).**
`tmp/{workspaceId}/{uploadId}` was the one class of object no database row pointed at, so the
project-scoped CLEANUP job could never reach it. Two fixes: the `complete` route now removes the
partial object on the size-mismatch rejection instead of leaving it, and `purgeAbandonedUploads`
sweeps the `tmp/` prefix for anything older than a day — well past the fifteen-minute upload URL
TTL — on the worker's existing retention interval. This required a `list(prefix)` method on
`StorageProvider`, implemented for both the local-disk and S3 providers; S3 pages through
`ListObjectsV2`. Storage is the only index these objects have, which is why the sweep is by prefix
and age rather than by row.

### P1.9 deviations

**P1.7 had classified `MISSED` and `UNFILLED` as durable work; P1.9 had to reverse that.** The
P1.7 comment was right for its own moment — no code created either state, so any such row could
only have been left behind detached. P1.9 creates both routinely: every sermon uploaded after its
own posting week produces `MISSED` rows, and every thin candidate pool produces `UNFILLED` ones.
Left durable, the first analysis of an old sermon would have made that project permanently
un-re-analysable. Both moved to the reschedulable set, `clearReschedulableScheduledPosts` now
clears them (matching on the project as well as the clip, since an `UNFILLED` row has no clip),
and re-analysis closes their open exceptions as `superseded_by_reanalysis`. Caught by an existing
integration test — "still rebuilds a project nobody has touched" — not by review.

**The allocator takes the snapshotted slot count, not one re-derived from the profile.** P1.8
derived the count from `sermonsPerWeek`. P1.9 must read the P0.7 project snapshot, which stores
its own `targetClipCount`, and the two can differ for a legacy project or an operator override.
`allocatePostingSlots` gained an optional `slotCount`; `UNMATCHED` still forces zero ahead of it,
so no caller-supplied count can schedule a service the church does not hold.

**`src/lib/scheduling.ts` lost `scheduledDateForRank` entirely** rather than keeping a deprecated
export. The plan calls the module a compatibility facade; leaving a live rank-arithmetic function
exported invites reuse, and the plan is explicit that turning arming off must not return to it.
The module keeps only the database-coupled helpers.

**One gap found while verifying the storage-key lists, not fixed here.** The two four-key lists in
`retention.ts` and `cleanup.ts` do match every key FINALIZE and PROBE write — `src/…` to
`storageKey`, `thumbs/…` to `thumbnailKey`, `audio/…` to `audioKey`, and the SRT route's `srt/…`
to `srtOverrideKey`, with `exports/…` handled by the separate stale-file path. But
`tmp/{workspaceId}/{uploadId}`, written by the upload PUT route, is removed only by the `move` on
successful completion. An abandoned upload, or one that fails the size check at `complete` (which
returns `UPLOAD_INTERRUPTED` without removing the temp object), leaves that object in storage
forever, and nothing scans `tmp/`. Pre-existing and outside P1.9's scope; it needs an owner.

### P1.8 deviations

**Fixed a second misfile site the plan does not list.** P1.8's file list names only
`church-profile.ts`, but `readProjectProcessingConfig` (`project-service.ts`) collapsed any
occurrence that was not the exact string `"SECONDARY"` back to `PRIMARY`. P1.9 reads occurrence
from the project snapshot rather than the live profile, so leaving that in place would have read
every `UNMATCHED` project back as `PRIMARY` and made the new derivation inert — the exact failure
the plan warns about in its own preamble. `readServiceOccurrence` now recognises all three values
and still falls back for anything unrecognised, so legacy rows are unaffected.

**The allocator takes a stored calendar date, not a service instant.** `Project.sermonDate` is
already normalised to UTC midnight in the church's timezone at project creation. Running it
through `calendarDateInTimezone` a second time moves a west-of-UTC church back one day and posts
the whole week early, so `allocatePostingSlots` truncates in UTC instead and only converts `now`.
This is the same contract `scheduledDateForRank` documents; it is stated on the input type and
covered by tests across four timezones.

**`serviceOccurrence` is spelled a third way elsewhere, and was left alone.**
`src/lib/evaluation/benchmark-manifest.ts` validates `z.enum(["PRIMARY", "SECONDARY", "SPECIAL"])`
— `SPECIAL` is the pre-Wave-1 name for `UNMATCHED`. That file is a versioned manifest format
belonging to the P5 evaluation work, so renaming the value is a format break rather than a P1.8
edit. Recorded here instead; fold it into the P5 work that owns the manifest.

## Conventions established during the build that the plan does not state

- **Commit authorship.** Git identity is now configured locally and globally as
  `Jake Gandara <jake@jakegandara.com>`, verified on the GitHub account. Earlier history contains
  138 commits authored `jakegandara@Jakes-MacBook-Pro.local` — **leave those alone.** They are
  pushed, branch protection blocks force pushes, and rewriting them breaks published history.
- **Docs-only commits still run the full gate.** `npm run verify` before every commit, no
  exceptions. Gitleaks runs on commit via `.githooks/pre-commit`.
- **New npm scripts are inserted alphabetically** in `package.json`.
- **Redaction is verified, not trusted.** After generating a sanitized copy, grep it for every
  forbidden value. The first P0.2 scan found two genuine leaks that the transform had missed.
- **CI runs on pull requests and on pushes to `main` only.** A feature branch gets no checks until
  a pull request exists; a draft one is enough. The four jobs are `verify`, `integration`
  (Postgres 17 container + ffmpeg), `e2e` (against a built application), and `worker-image` (the
  worker font gate lives inside `Dockerfile.worker` and is proved there).
- **Branch protection is strict and auto-merge is off.** Every pull request must be up to date
  with `main` and green before it can merge. Poll `gh pr view N --json mergeStateStatus` until it
  says `CLEAN`; `gh pr checks` reports the previous head's results right after an update.
- **The "Install ffmpeg" apt step sometimes hangs** in the integration and e2e jobs. The step has
  its own timeout; if a job sits there, `gh run cancel <id>` then `gh run rerun <id> --failed`.
- **Kill `next dev` before any Playwright run.** A running dev server is reused
  (`reuseExistingServer: !isCI`) and reads `.data/storage` while the specs write to
  `.data/e2e-storage`, so every media request 404s and video tests fail in ways that look like
  defects. The tell is no `[WebServer]` lines in the Playwright output.
- **Two local failures are the machine, not the code.** The upload e2e spec fails when the local
  `.env` carries `ELEVENLABS_API_KEY` (transcription takes the Scribe path and the expected warning
  never appears), and the retention integration test can fail when run straight after the full
  e2e suite. Rerun alone; let CI decide. Do not chase them as branch regressions.
- **Never regenerate `package-lock.json` with a bare macOS `npm install`.** It drops the
  `@emnapi/*` optional entries and breaks `npm ci` on Linux. If a regeneration is unavoidable,
  merge only the new subtree into `main`'s lockfile — a correct result is a purely additive diff —
  and prove it with `npm ci`.
- **The parity gate is the export's evidence.** `tests/integration/export-parity.integration.test.ts`
  renders four real MP4s through `runExportJob` and reads them back against the same pure
  functions the preview draws with. It takes about a minute and needs Postgres and ffmpeg.
- **Some tests deliberately record known defects as executable evidence:** the Stage A funnel
  ratio and the opening-quarter clip assertion, belonging to P5 and P0.17. Do not "fix" them;
  invert or respecify them in the commit that fixes the defect. Sunday-spill scheduling was
  inverted by P1.9 and destructive reanalysis by P1.7; both now assert the fixed rule.

### Commands

```bash
npm ci

# The verify gate: prisma validate + generate, lint, typecheck, unit tests, next build
npm run verify

# The worker build; the font gate itself lives in Dockerfile.worker and runs on CI
npm run worker:build

# Integration tests need a real Postgres and ffmpeg on PATH
docker compose up -d
npm run db:migrate:deploy
npm run test:integration

# Just the parity gate
npx vitest run --config vitest.integration.config.ts \
  tests/integration/export-parity.integration.test.ts

# Browser tests — kill any running `next dev` first
npm run test:e2e
```

---

## P0.4 preconditions and scope

P0.4 is characterization only. It records what the code does **today**, including its defects, so
later commits have a provable before-and-after. It must land before anything touches
`runAnalyzeJob`.

**Environment.** These are the first tests requiring a live Postgres. They belong in
`tests/integration/*.integration.test.ts`, run by `npm run test:integration` with its own vitest
config, and are **excluded** from `npm run verify`. CI runs them in a separate job with a Postgres 17
container.

**Scenarios, from the plan plus the 2026-08-11 measurement:**

- `CANDIDATE_POOL_SIZE` 18 as a ceiling; thin pools stay thin.
- Window generation: at most 3 duration targets per start; even sampling rather than
  front-truncation when the pool exceeds the 500 cap; IoU > 0.5 thinning before the 25-candidate
  Stage B slice.
- Slot arming on `rank <= targetClipCount && project.sermonDate`; a null `sermonDate` skips arming.
- `scheduledDateForRank` = `sermonDate + rank` days, **including the current Sunday-spill defect** —
  a Tuesday sermon schedules a Sunday post today. P1.8 fixes it; charter it first.
- Cross-project date collision, where no unique constraint exists and `slotAlreadyPublished` is the
  only guard.
- The destructive reanalysis transaction.
- The current `keptCount` / `targetClipCount` metadata shape.
- **Stage A is the binding funnel constraint.** Roughly 500 windows enter and `scoredCount` reaches
  Stage B in single digits. Charter the ratio, not an exact number, so the test is stable but fails
  if Stage A recall moves materially.
- **Selected clips cluster in the opening of the service.** On the reference service every kept clip
  starts within the first 20% of the source duration. This characterizes a *current limitation*, not
  an invariant. When P5 lands, this assertion **inverts** rather than being deleted, so the
  improvement is provable.

**Measured reference (2026-08-12 production run, project `Clip Count Retest 8-11`):** source
`z4FCS3JcZPs`, 49:41, 6 clips spanning 1:25–10:58, `candidateCount` 500, `scoredCount` 6,
`keptCount` 6, `targetClipCount` 6, $0.157 analysis cost. The pre-fix run on the same source
produced 2 clips, both announcements, both at minute 0.

---

## Branches that are not `main`, and why they still exist

Settled 2026-09-05. Three branches are kept on purpose; do not "tidy" them away, and do not
re-ask this question. None of them is a candidate to merge — each is a record, and the code that
matters is read off it by hand.

| Branch | Tip | Why it is kept |
|---|---|---|
| `p1/kinetic-captions-and-editor` | `914d23d` (2026-08-18) | The origin of the P1 caption work, 14 commits ahead of its merge-base. Holds two things `main` never absorbed: the self-hosted OFL burn-in fonts (Inter, Poppins, Source Serif 4) and the whisper sub-word token merge in `src/lib/transcription/token-merge.ts`. Also carries the canvas-desk editor redesign (`5b687ca`) as an explicit **prototype, not accepted** — Jake ran eleven manual acceptance gates and rejected eight. `main`'s editor was rebuilt from the accepted parts, not from this branch. |
| `rebase/p1-editor-tree` | `e7787a5` (2026-08-17) | A separate lineage, not an ancestor of the branch above. It is the merge of Jake's uncommitted editor/captions/transcription tree onto `main`, and it is what makes the deleted `wip/uncommitted-p1-editor-snapshot` safe to lose — that snapshot is contained in this branch. It also keeps `SESSION_SUMMARY_2026-08-13.md`, which exists nowhere else. |
| `feat/semantic-outline-pipeline` | `80002e4` (2026-07-24) | The only implementation of the semantic outline and Stage A discovery pipeline: `src/lib/analysis/outline/`, `src/lib/analysis/semantic/`, a `sermon_outline` Prisma migration, a live validation harness (`scripts/validate-semantic-run.ts`), and eight test files. `main` has no outline or semantic module at all. Stage A recall is the known product bottleneck and P5's target — this branch is the prototype P5 starts from. |

**Deleted on 2026-09-05, after checking that nothing unique was lost.**
`wip/uncommitted-p1-editor-snapshot` (`abbebfe`) was an ancestor of `rebase/p1-editor-tree`.
`feat/editor-trim-and-caption-typography` (`5617755`) held `trim-timeline.tsx`, superseded on
`main` by the larger `src/components/editor/clip-timeline.tsx` plus `src/lib/editor/trim.ts`.
`slice7-prerebase-backup` (`099258d`, local only) had every distinctive file land on `main` at
equal or greater size — `active-word.ts`, `numeric-field.ts` and its four test files.

**One live gap this surfaced.** `src/lib/editor/caption-presets.ts` on `main` names `Inter` as a
font family, but `main` ships only the six DejaVu faces in `public/fonts/`. The Inter, Poppins and
Source Serif 4 files exist solely on the two editor branches above. Whether burn-in silently falls
back to DejaVu is unverified — worth a look before P2 publishing, not a P1.8 blocker.

---

## Open items not owned by any commit yet

- **OpenAI adapter.** The policy schema reserves `openai`, but the activation command refuses it
  until an adapter and benchmark exist.
- **Stage A recall** is now the known product bottleneck. It is P5's target, not a P0 fix.
- **PERC** has no implementation and its retrieval has never worked end to end.
- **YouTube proxy economics failed.** The current contract exceeds its monthly gate. Direct upload
  passed Gate A and is the approved P0 intake path.
- **Channel imports denied by an expired trial are terminal.** `channel-poller.ts` records a
  `failed` row when project creation refuses the workspace, and `failed` is final by design
  (`channel-poller.ts:233-235`), so the sermons streamed during a lapsed period never import after
  the church pays. The remedy is a retryable status beside `skipped_cap`, which already transitions
  in place on a later poll; the existing daily import cap bounds the catch-up burst. Reviewed
  2026-08-14 and deliberately deferred: channel import fetches YouTube, and that intake path is
  economically disapproved today, so this matters only once PERC or a better proxy contract makes
  it viable. Revisit with that intake decision.
- **`prisma` carries a high-severity advisory with no stable fix.** GHSA-ggr8-5vv4-36mx
  (`deepmerge-ts` below 8, stack exhaustion on a recursive input) reaches `prisma` through
  `@prisma/config`, which pins `deepmerge-ts@7.1.5` in every stable Prisma release up to 7.10.0.
  `@prisma/config` is loaded by the CLI alone; nothing in `src/` or the worker bundle imports it,
  and there is no `prisma.config.*` file for it to merge. Accepted on 2026-09-05 — see
  `DECISIONS.md`, "A Prisma CLI Advisory Is Accepted Until Prisma 8 Is Stable". Revisit when
  Prisma 8 is stable.
