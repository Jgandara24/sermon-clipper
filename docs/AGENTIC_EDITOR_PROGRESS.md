# Agentic Editor — Build Progress and Handoff

**Purpose.** `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` is the *target*. This file is the
*actual*: what shipped, what deviated, and what the next agent needs to know that the plan does not
say. `DECISIONS.md` remains the authoritative record of decisions; this is a working index.

**Last updated:** 2026-09-05, after the editor delta plan closed and the product owner chose to
build the whole implementation plan in order.

---

## Where the build stands

`main` is at `bd934ca` (PR #72, 2026-09-05). Production web and worker both run that commit.

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
| P1.7 block destructive reanalysis | **next** | not started; no `src/lib/analysis/reanalysis-policy.ts` |
| P1.8–P1.12 | not started | none of their named modules exist |
| P2–P8 | not started | |

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
- **Some tests deliberately record known defects as executable evidence:** Sunday-spill
  scheduling, destructive reanalysis, the Stage A funnel ratio, and the opening-quarter clip
  assertion. They belong to P1.8, P1.7, P5 and P0.17. Do not "fix" them; invert or respecify them
  in the commit that fixes the defect.

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
