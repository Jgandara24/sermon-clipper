# Agentic Editor — Build Progress and Handoff

**Purpose.** `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` is the *target*. This file is the
*actual*: what shipped, what deviated, and what the next agent needs to know that the plan does not
say. `DECISIONS.md` remains the authoritative record of decisions; this is a working index.

**Last updated:** 2026-09-05, after the editor delta plan closed and the product owner chose to
build the whole implementation plan in order.

---

## Where the build stands

`main` is at `4ae7720` (PR #89, 2026-09-05). Production web and worker both run P1's last commit; Wave 2 is additive, so they keep running after the migration.

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
| P2.2 platform-operator authorization | done | 2026-09-05; `src/lib/operator-auth.ts` reads the marker, `src/lib/operations/platform-operator.ts` grants it, `npm run set:platform-operator` is the only door. No route, action, or toggle |
| P2.3 append-only review and feedback services | done | 2026-09-05; `src/lib/review/{types,feedback-policy,snapshots,service}.ts`. Exact-render check, S15 table, bare `REPLACE` refused, reanalysis now blocks after any review |
| P2.4 render only scheduled review clips | done | 2026-09-05; `src/lib/review/{final-render-eligibility,render-coordinator}.ts`, called after analysis and on a worker sweep. Records nothing while `AUTOMATIC_PUBLISHING_ENABLED` is false |
| P2.5 exact-render operator review queue | done | 2026-09-05; `/app/operator/review` and its detail page, `src/lib/review/query.ts`. Signs the reviewed church's file, shows the four identity facts, hides every selector signal |
| P2.6 accept, revise and multiple-feedback UI | done | 2026-09-05; `src/app/actions/clip-review.ts` authorizes itself; `REPLACE` blocked at the button, the schema and the service |
| P2.7 atomic replacement | done | 2026-09-06; `src/lib/review/{reserve-policy,replace-scheduled-clip}.ts`. One transaction, project row locked so two replacements take different reserves; empty pool still records the decision and opens an exception |
| P2.8 require exact editorial acceptance | done | 2026-09-06; `src/lib/delivery/{eligibility,query}.ts` now query the standing decision about the exact render. Four identity facts, human reviewer, `ACCEPT`; a retry clears the QC verdict so a rerender cannot inherit one |
| P2.9 start the human-only program explicitly | done | 2026-09-06; `src/lib/review/{editorial-program,program-key}.ts`, two scripts, `docs/HUMAN_REVIEW_30_DAY_RUNBOOK.md`. Fixed 30 days, no backdating, no restart; a pause extends and also pauses delivery; the sandbox census scans exactly what the publisher scans |
| P3.1 role-safe candidate-pool read model | done | 2026-09-06; `src/lib/candidates/{project-pool,query}.ts`. Six presentation states, rank preserved, borrowed prior-service fill found through the slot; church shape derived from the operator shape by removal. No production caller yet |
| P3.2 show the complete actual pool to churches | done | 2026-09-06; the project page and `/api/projects/[id]/clips` now read P3.1's church pool. Selector score, subscores, model version and excerpt removed from both — they were church-visible before this commit |
| P3.3 cross-workspace operator project view | done | 2026-09-06; `/app/operator/projects/[projectId]`, two components, lineage and exception readers in `review/query.ts`. Reading only — no limit editor, no settings, no publishing |
| P3.4 cheap on-demand candidate previews | done | 2026-09-06; `src/components/candidates/source-range-preview.tsx` on both the church and operator pools. One signed recording per service, byte ranges, `preload="none"`, one open at a time, no `ExportJob` ever |
| P3.5 explicit prior-service fill policy | done | 2026-09-06; `src/lib/review/prior-service-fill-policy.ts`. Pure, and exports no way to *find* a candidate — only to judge one an operator named. No caller yet; P3.6 applies it |
| P3.6 apply a prior-service fill atomically | done | 2026-09-06; `src/lib/review/prior-service-fill.ts`. Source-video lock serialises it against cleanup; exact conditional claim; no second `REPLACE`; exception resolved in place; delivery still needs a fresh acceptance |
| P3.7 operator shortage-resolution action | done | 2026-09-06; `src/app/actions/operator-prior-service-fill.ts`, its form, the options loader, and an operator-only calendar link. Nothing preselected, confirmation re-checked server side, review link waits for a real file |
| P3.8 reschedule a missed slot explicitly | done | 2026-09-06; `src/lib/schedule/reschedule-missed.ts` and its operator action. Same row mutated, binding retained, no automatic caller — asserted by a grep test |
| P3.9 third-service option shown as coming later | done | 2026-09-06; disabled option in onboarding and settings, one shared `sermonsPerWeekSchema`, and the false candidate-count claim removed from church settings |
| P4–P8 | not started | P3.9 is the last P3 slice. P4–P8 need their measured commit-by-commit update written and approved first — see the planning-status note at `AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` §13 |

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

### P2.7 deviations

**The `REPLACE` row is written inside `replace-scheduled-clip.ts`, not in `service.ts`.** The plan
lists `service.ts` among the files. Putting the write there would mean a function that creates a
`REPLACE` exists beside `appendClipReview`, which refuses one — two neighbouring functions with
opposite rules, and only a comment between them. One call site, inside the transaction that makes
it correct, is the stronger arrangement.

**The lock is the project row, not the candidate rows.** The requirement is that two concurrent
replacements cannot select the same reserve. Locking each candidate would be finer-grained and
would still need a second pass when the chosen one is taken. `SELECT … FROM projects … FOR UPDATE`
serializes replacements within one sermon, which is the only scope where they compete: the loser
waits, re-reads the pool, and takes the next reserve. `ScheduledPost.clipId` is unique and remains
the backstop.

**The subject is read before the lock, and re-checked after it.** `loadReviewSubject` runs first so
a stale identity is refused without taking a lock at all. That leaves a window, so after the lock
the slot's `clipId` and `exportJobId` are compared again and a `SLOT_MOVED` refusal is raised if
either moved. Cheap, and it closes the read-then-lock gap rather than pretending it is not there.

**`decisionSchema` now accepts `REPLACE`, which reverses a P2.6 decision.** In P2.6 that schema was
where a `REPLACE` was refused, because there was nowhere for one to go. Now the page may submit one
and the action routes it to the command. The refusal moved to `APPENDABLE_DECISIONS` and to
`appendClipReview`; the guard test was rewritten to assert the new arrangement rather than deleted.

**A UX gap the e2e found, fixed in the product rather than the test.** After a successful
replacement the promoted reserve's render has not finished, so the decision form disappears — and
took its success message with it, leaving an operator who had just replaced a clip with no
confirmation that anything happened. The "no decision can be recorded" branch now shows *why*
(`unplayableReason`: the render is queued) and points at the history. The test asserts that durable
state instead of a message that legitimately no longer exists.

**One more shared-database lesson.** `claimNextExportJob` takes the globally best job, so a test
asserting "the replacement's render is claimed first" was answered by a priority render left queued
by an earlier test in the same file. The test now settles the queue before making its claim. That
is the third time a global query has made a test lie; the pattern to watch for is any assertion
about "the next" or "the count" of something not scoped to the test's own rows.

### P3.9 deviations

**The removal was the substance.** The church settings page told churches their profile "controls
how many clips we generate per sermon". It never did — the retained candidate count is a staff
control (plan §2.2, product-owner Decision 1) that a church can neither see nor change, and saying
otherwise invites a conversation about a number they have no lever for. The copy now describes what
those settings actually control: which days clips go out and how many per day.

**One shared `sermonsPerWeekSchema`, in `src/lib/church-profile-input.ts`.** The onboarding action
and the profile action each carried their own `.min(1).max(2)`. Two copies of a rule about what the
product supports is two places to forget when three services arrive, so the rule is single-sourced
beside `SUPPORTED_SERMONS_PER_WEEK` and the `SermonsPerWeek` type. A disabled `<option>` is
courtesy; the schema is the control, and the test proves a forged `3` is refused.

**A guard test caught its own explanation.** The comment recording the removed claim quoted it
verbatim, which the grep guard duly failed on. The comment now describes the old wording instead of
reproducing it, and says why — the alternative was loosening a guard to accommodate a comment.

**Source-reading tests, because there is still no component environment.** Two claims are about
what the page markup says — the disabled option exists, the forbidden phrases do not — and with no
jsdom in the repo the honest way to assert them is to read the file. The behavioural claims are in
the e2e, against a workspace deliberately seeded with a hidden override so the page has something
real to leak.

### P3.8 deviations

**Today is a valid date; the plan said "future".** `allocatePostingSlots` already rules that "a
slot dated today is still postable; only a strictly earlier date is missed", and an operator
noticing a missed post on the morning it should have gone out has a real reason to send it that
afternoon. Contradicting that rule inside the same domain would be the larger inconsistency, so the
refusal is `date_in_past`. Flagged because it is a judgement call against the plan's wording.

**The form is not gated on client state, after an e2e proved why it should not be.** The first
draft revealed the confirmation only once a date was chosen and disabled the button until then —
so `page.fill()` on the controlled date input left React's state empty and the button permanently
disabled. Rather than work around the timing, the form became uncontrolled: date field, confirmation
and submit are all always present, and the server decides the refusals it was already deciding.
That is the behaviour a Server Action form is supposed to have — it works before hydration.

**A structural test asserts the module has one caller.** "MISSED is terminal for automation" is a
claim about what does *not* exist, so it is checked by grepping `src/` for the command's import
path rather than described in a comment. The first version of that grep matched
`reschedule-missed-form.tsx` too and failed correctly; the pattern now includes the closing quote,
which is the difference between "imports the command" and "has a similar filename".

**The success message is unreachable here as well.** A successful move stops the date being missed,
so the row stops offering the form. Third time this session: the durable state is the assertion,
not the message.

### P3.7 deviations

**The `"use server"` export trap, hit a second time.** `PRIOR_SERVICE_FILL_IDLE` was a plain
`const` in the action file, exactly as `CLIP_REVIEW_IDLE` was in P2.6 — and exactly as the P2.6
note in this document warned. A `"use server"` module may export nothing but async functions, and
the failure ("can only export async functions, found object") arrives at *request* time, so
typecheck, lint and build all pass and the page breaks in a browser. The e2e caught it. The state,
the idle constant and the zod schema now live in `src/lib/review/prior-service-fill-input.ts`, the
same shape P2.6 settled on. **Reading a past deviation is not the same as applying it.**

**A new loader the plan did not list.** `prior-service-fill-options.ts` enumerates what an operator
may choose from. It is deliberately not a selector: services come back oldest first and candidates
in the selector's original rank order — orderings the data already had — and nothing scores, ranks
by desirability, or marks a suggestion. A loader that returned "the best option first" would put
back the recommendation P3.5 was careful not to make.

**The success message is unreachable in this layout, and the test says so.** A successful fill
stops the date being a shortage, so the server stops sending options and the whole form unmounts,
taking its message with it. Same shape as the P2.6 gap. The confirmation an operator actually sees
is the date itself now reading "a render is in progress", and the test asserts that durable state
rather than a message that legitimately no longer exists.

**One fixture was wrong in a way that looked right.** The "no options" case seeded a service dated
*after* the one holding clips, so the clips were eligible for it and the empty-list copy never
rendered. The only honest way to produce an empty list is a service older than every other, which
is what the fixture now does.

**The review link waits for a checksum, not for a job state.** `BoundRenderFacts` gained
`hasChecksum`. The review page identifies a file by four facts and the checksum is one of them, so
a `SUCCEEDED` job that has not yet been QC-checked still has nothing to review; linking on state
alone would open a page that can only say the file is not ready.

### P3.6 deviations

**`SLOT_MOVED` is narrower than it looks, and a test had to say so.** The first draft asserted that
a stale form — one rendered while a date was empty and submitted after somebody else filled it —
refuses with `SLOT_MOVED`. It does not: the policy runs before the conditional claim, and a filled
date is already `NOT_STARTED` by then, so the refusal is `slot_state_not_fillable`. `SLOT_MOVED`
covers only the window *inside* the transaction, between the policy passing and the claim landing.
Both guards are wanted; the test now asserts the one an operator actually meets, and the
concurrency cases exercise the other.

**The retry path returns before the policy runs.** A second click on a date this command already
filled returns the same answer rather than being refused. Without it the conditional claim would
report an operator's own completed work as somebody else having taken the date, which is a
confusing thing to be told about something you did.

**The audit event names both services in `metadata`, not just `projectId`.** An operational event
has one `projectId` column, and this act involves two. The target owns the column because that is
the date affected; the source is in the metadata beside it, so a later reader can see what was
borrowed from where without joining anything.

### P3.5 deviations

**"Known forbidden" resolves to a recorded `FORBIDDEN_CONTENT` finding.** The plan names the state
without saying where it lives. `ReviewFeedbackCategory.FORBIDDEN_CONTENT` is the editorial
standard's one irreversible verdict, so a clip carrying such a finding is the durable meaning of
"forbidden". Kept as a separate refusal from `HIDDEN`, which is only a preference: a clip that must
not reach an audience does not become acceptable by being needed.

**`renderableSource` is one boolean, not two branches.** The plan describes a `SourceVideo` key
before P4 and a registered `DerivedMediaArtifact` after it. `DerivedMediaArtifact` does not exist
yet, and which of the two satisfies the requirement is a question for whatever loads the facts.
From the policy it is one fact either way, which is what lets P4 move the media source without
touching this rule.

**"Older" is measured on the sermon's own date.** A prior service is one that was *preached*
earlier, so the comparison is `sermonDate` (falling back to `createdAt` where a project has none),
compared strictly and by day. Same-day is refused: a sermon preached the same morning is not a
prior service.

**`hasOpenPublishClaim` is checked even though the slot state already excludes publishing.** P1.12
writes the publish intent before the provider call, so a process that died mid-publish leaves a
claim behind a state that looks safe. Same defence-in-depth pattern as the delivery module.

**A test asserts the module's whole export list.** Rev2 §9 puts automatic cross-project borrowing
out of scope, and a module that could rank or search candidates is one call away from doing it. The
absence of a selector is the policy, so it is pinned rather than described.

### P3.4 deviations

**No component unit tests, because there is no component test environment.** The repo has no
jsdom, happy-dom or testing-library, and `vitest.config.ts` runs in `node`. Adding a browser
environment and a second config for one component is a larger change than this slice warrants, and
media behaviour — autoplay policy, `preload`, byte ranges, what a browser actually fetches — is
exactly what a real browser tests better than a simulated DOM. The plan's "component/E2E tests"
are therefore all E2E, plus an integration test for the byte-range route they rest on.

**One signed URL per service, not per candidate.** Every preview plays a span of the same sermon
recording, so the page signs once and each preview seeks into it. Signing a dozen links to the
same file would cost a dozen HMACs to say the same thing.

**A borrowed prior-service fill gets no preview here.** It is cut from a different service's
recording, so this service's link would play the wrong sermon. Its own page is where it can be
previewed. Passing `mediaUrl: null` reuses the unavailable state rather than inventing a second
one.

**The element is unmounted when closed, as well as `preload="none"`.** Either alone would probably
do; both together mean a closed preview has no `src` for a browser to be clever about, and the
"opening a page fetches nothing" test asserts zero `<video>` elements rather than trusting an
attribute.

**An accessible label broke a test locator, and the label was right.** Each toggle carries the
candidate's title in an `sr-only` span, so `getByText("Preview candidate 1")` matched the heading
and the button both. Fixed in the test by asking for the heading role.

### P3.3 deviations

**The operator pool gained `slots`; the church shape does not inherit it.** A slot holding nothing
— what P2.7 leaves when a replacement finds no reserve — has no candidate row, so it was invisible
in the pool read model. An operator inspecting a service has to see the empty date; it is the one
needing action. `toChurchPool` drops it along with `limits`, because P3.2 deliberately built the
church view around clips and changing what a church sees is a decision of its own.

**No selector facts on the operator page either.** The plan only requires hiding them from
churches. This page is one click from the review queue, and S14 is about reviewers rather than
about churches, so the page runs the same `assertNoSelectorSignal` guard the review model runs.

**An exact-key-set assertion caught the new field, which is what it is for.**
`operator-review-query.integration.test.ts` pins the queue row's whole shape rather than searching
for a score's value — its own comment records that hunting a two-digit number through a blob of
UUIDs found "87" inside one. Adding `projectId` failed it, correctly; the field is now recorded
there as a chosen one.

**The same two-digit trap, twice more.** An e2e assertion that the score total "88" was absent from
visible text failed because the generated operator email contains a timestamp with 88 in it. The
label is what a leak looks like, so the assertions check for "Score" and the distinctive strings
instead. That makes three times in this session — it is a property of asserting absence of short
substrings in a page, not of any one test.

### The `SUGGESTED` misreading, fixed 2026-09-06

`GeneratedClipStatus.SUGGESTED` reads as "the selector produced this and did not keep it". It is
the opposite: `analyze.ts` builds a local list called `kept` — the candidates that survived
selection — and writes every one of them as `SUGGESTED`. Nothing in production writes `KEPT`; the
only writer is a manual `PATCH /api/clips/[id]` that no surface calls.

The same misreading was in two places and cost two slices:

- **P3.1's candidate pool** excluded `SUGGESTED`, which emptied every church's project page. Caught
  by an end-to-end test walking the real analysis path, after every unit and integration fixture
  agreed with the bug.
- **`reserve-policy.ts`** promoted only `KEPT`, so a replacement found `NO_ELIGIBLE_RESERVE` for
  any real sermon: it superseded the rejected clip, emptied the slot, set it `UNFILLED` and opened
  an exception, every time. Its own unit test asserted this as correct behaviour.

The fact now lives once, in `src/lib/analysis/clip-status.ts`, and both the writer and the two
readers point at it. `tests/reserve-policy.test.ts` asserts the policy accepts
`ANALYSIS_RETAINED_CLIP_STATUS` rather than a literal, so a change to what analysis writes moves
the policy with it.

**The fixtures were the actual bug.** Every replacement test created clips with `KEPT` by hand, so
the whole suite agreed no real clip was promotable. `createClip`'s default is now the shared
constant. Proof the tests bind the fix: reverting `PROMOTABLE_STATUSES` to `KEPT` alone now fails
5 unit and 5 integration tests, where before it failed none.

**A guard that cannot be tested at the integration level.** `reserve-policy.ts` refuses a
zero-length clip, but `generated_clips_start_before_end_chk` refuses one at the database, so that
branch is defence in depth and is tested in the unit suite against a plain object.

### P3.2 deviations

**A regression P3.1 shipped, and the reading behind it.** `GeneratedClipStatus.SUGGESTED` reads as
"the selector produced this and did not keep it", and P3.1's pool excluded it on that basis. It is
not what the enum means here: `analyze.ts` writes `SUGGESTED` for **every** candidate it retains,
and nothing in production ever writes `KEPT` — only a manual `PATCH /api/clips/[id]` can, and no
surface calls it. Excluding `SUGGESTED` therefore emptied the project page for every normally
analysed sermon. Every integration and unit fixture created clips as `KEPT` explicitly, so nothing
caught it until an end-to-end test walked the real analysis path. The pool now holds all four
statuses, and `RESERVE` covers both `SUGGESTED` and `KEPT`.

**The same misreading is live in P2.7, and is not fixed here.** `reserve-policy.ts` promotes only
`KEPT`, so in production a replacement finds no eligible reserve for any normally analysed sermon:
it supersedes the rejected clip, empties the slot, and opens an `UNFILLED` exception every time.
Its tests pass because every fixture sets `KEPT` by hand. Left for its own commit rather than
folded into a church-UI change — see the open items below.

**Two e2e tests asserted the behaviour this commit removes.** `phase-6-7-reviewed-export.spec.ts`
opened the "Show score breakdown" control and checked each subscore label was visible. Rewritten
to assert the same four labels are absent, because "these words must not reach this page" is worth
a test of its own and this is the page that used to show them.



**This commit removed something churches could already see.** The project page and the clips API
both carried the Selector's score, its subscores, the model version and the quoted excerpt — a
score tile, a colour-coded tone, and a "show score breakdown" toggle. Plan §2.2 says no
church-facing response, page, or label exposes them, so all of it is gone. The `score` relation is
no longer selected in either place: not selected is a stronger guarantee than selected-and-dropped.

**Card titles moved from `h3` to `h4`.** The list gained a section layer (going out / in reserve /
set aside), so the section heading is the `h3` and the cards below it are `h4`. Found because an
e2e selector reading `h3` picked up the section heading; fixed in the markup rather than in the
selector, because the heading order was the thing that was wrong.

**One e2e assertion had to be rewritten, and the reason is worth keeping.** `expect(html).not
.toContain("93")` — the fixture's score total — fails against any page, because two-digit numbers
appear inside Next's chunk hashes. Distinctive strings (the model version, the excerpt) are checked
against the raw HTML where they could hide in an attribute; the numeric total is checked against
the page's visible text, which is where a leaked score would actually show.

**The page merges the pool with the church-only extras rather than widening P3.1.** Summary,
scripture references, approval state and the like/dislike flag are church-page concerns; teaching
the pool read model about them would make P3.1 a church-page module. A borrowed prior-service fill
has no row in this service's clip list, so it renders with the facts the slot supplies and a
sentence saying where it came from — nothing invented to fill the gap.

### P3.1 deviations

**No selector facts in either role shape, not just the church's.** The plan lists scores,
subscores, model version, excerpt and rationale among the things *church* responses omit, which
implies an operator shape that carries them. Nothing needs them today — P3.1 has no production
caller at all — and S14 already says a reviewer must not see the machine's confidence in the work
they are judging. A field that exists is a field that leaks into the next surface, so the pool
carries none. Adding them later for a P4 evaluation consumer is a smaller change than removing
them from a review page.

**The church shape is `Omit` of the operator shape, not a second literal.** Two independently
written shapes leak by omission the first time someone adds a field to one and forgets the other.
Written as a removal, a new field reaches churches only if somebody deletes it on purpose.

**Slots are queried by the service that owns them, never through the clips.** Following each clip
to its slot would miss the whole reason this read model exists: a slot of *this* service filled by
a clip from an older one has no row in this service's clip list. The borrowed candidate is added
from the slot side or it is invisible.

**`PRIOR_SERVICE_FILL` is decided before the replacement check, and that ordering is the rule.** A
borrowed clip usually *was* promoted by a `REPLACE` — that is how it reached the slot — so asking
"was it promoted?" first would tell a church this service produced a replacement it never
produced. Both integration and unit tests pin the borrowed-and-promoted case specifically.

**The promotions lookup is scoped to the clips the pool presents.** The obvious query —
`replacementClipIdSnapshot: { not: null }` — is correct and unbounded: it loads every replacement
ever made in every workspace to answer a question about six clips, and that set only grows. Caught
while re-reading rather than by a test, because a global read that returns a superset gives the
right answer and simply costs more every month.

### P2.9 deviations

**`NOT_STARTED` does not refuse delivery.** The obvious reading of "nothing publishes outside the
program" would have made the P2 sandbox proof impossible: that sequence publishes one row *before*
the clock starts, because publishing it is the evidence the start requires. Only `PAUSED` refuses,
which is also the documented rollback. The global switch is what holds the pre-start window shut.

**The census and the publisher now share one definition of "due".** `duePublishWhere` moved into
`src/lib/delivery/query.ts` and `publishDueScheduledPosts` calls it. The plan did not list that
file, but the dry run's whole claim is that flipping one switch would release exactly one row, and
a census over a different population would be a claim about rows that never publish.

**The status calculation was split into a pure function.** `summariseEditorialProgram` takes rows
and returns the report. "Day 29 is held, day 30 is not" and "a pause extends the phase" are the two
claims the phase rests on, and neither should need a database to state. The loader is now four
lines around it.

**`HUMAN_REFERENCE_PROGRAM_KEY` lives in its own module.** `delivery/query.ts` needs it and
`review/editorial-program.ts` imports the delivery census; putting the constant in either would
have closed an import cycle.

**Two integration tests could not be written the obvious way, and saying why is the point.** The
census is an installation-wide query, so "exactly one switch-only row" cannot be asserted while
another file's fixtures are due. Every slot in the program file is scheduled in 2019 and every
census is taken with a `now` in 2019 — earlier than the 2026 floor every other integration file
uses — so foreign rows are not due at that instant. Filtering the census by workspace would have
been easier and would have tested something the operator never runs. For the same reason
`collectStartEvidence` cannot be tested by absence: the refusal is proved on the value
`missingEvidence` returns, and the integration test instead proves which of *its own* rows are
accepted as evidence and which are not.

**A test that could pass without asserting anything was rewritten before it landed.** The first
draft of "refuses while any precondition is unproved" returned early when another case had already
seeded evidence. That is the same failure as the global-query trap wearing different clothes — a
test whose assertion is conditional on database state it does not own. Fifth instance.

### P2.8 deviations

**The QC verdict is cleared in `queue.ts`, not in the retry route.** The plan lists
`src/app/api/exports/[id]/retry/route.ts`. The route does nothing but call
`requeueFailedExportJob`, and the reason a rerender must invalidate an acceptance is a property of
reusing the job row, not of the HTTP path that asks for it. Clearing `qcStatus`, `qcCheckedAt`,
`qcChecksum` and `qcDetails` inside the queue function covers every caller that reuses a row,
including any later one. The route itself needed no change.

**The rule re-checks the four facts the loader already matched on.** `query.ts` finds the review by
clip, edit version, bound export and QC checksum, so the identity check inside
`assessDeliveryEligibility` cannot fail in production. It is there because `DeliveryFacts` is an
exported type and the publisher takes the assessor as an injectable dependency: this module is the
one thing that must not be talkable-into a publish, and a loosened `where` should fail a unit test
rather than quietly widen what can go out. The same reasoning already put
`verifyBoundDeliveryIdentity` beside foreign keys that imply most of what it checks.

**An `AGENT` acceptance is refused, which the plan did not ask for in so many words.** Nothing
writes one today, which is exactly why it was worth writing now — when P4 begins producing agent
reviews they must not become publishable by having arrived. P2.9 owns the program clock and P7 owns
the change to this rule; neither is a reason to leave the gap open in between.

**One test premise had to be rewritten rather than deleted.** `tests/delivery-eligibility.test.ts`
carried "refuses after an edit demoted the approval, though an old SUCCEEDED export exists", which
asserted `customer_approval_missing`. Under P2.8 the re-rendered export invalidates the acceptance
first, so the reason changed. The case now walks all four layers — stale export, stale acceptance,
demoted approval, then eligible — which is more than it proved before.

**The global-query trap, caught before it landed this time.** `publishDueScheduledPosts` sweeps
every due post in the database, so a new end-to-end case asserting `summary.postsPublished === 0`
was answered by the two slots the cases above it had just made genuinely deliverable — the first
rows in the project's history that could pass the real rule. The assertion is now on the test's own
slot's `publishStatus`. Fourth instance; the tell in the P2.7 note held.

### P2.6 deviations

**A `"use server"` module may export nothing but async functions, and the error arrives late.**
`CLIP_REVIEW_IDLE` started life beside the action as a plain `const`. Typecheck and lint both
passed; the failure surfaced at request time as *"A 'use server' file can only export async
functions, found object"* with a 500 on the POST. `npm run build` would have caught it — running
only `typecheck` and `lint` after writing an action is not enough. The state constant and its type
now live in `src/lib/review/decision-input.ts`.

**Form parsing lives outside the action, in `decision-input.ts`.** The plan lists only
`src/app/actions/clip-review.ts`. Everything inside a `"use server"` module is unreachable from a
unit test, for the same rule as above, and the parsing is the part worth testing on its own — it is
where untrusted `FormData` becomes something the service is allowed to see. `tests/review-decision-
input.test.ts` covers it.

**`REPLACE` is blocked three times, not once.** The plan says to show the control as unavailable.
A disabled button is a suggestion, and a Server Action is a POST endpoint anyone can reach — Next's
own guidance is that "render-time gating is not a security boundary". So the button is disabled,
the action's schema does not accept the value, and `appendClipReview` refuses a bare `REPLACE`
besides. The control is shown rather than hidden so a reviewer learns what a `CONTENT` finding
costs from the control, not from a refusal after writing it all out.

**Two components, not the plan's one.** The plan lists `review-feedback-list.tsx`. That file holds
the editable findings list, which both forms reuse; `review-decision-form.tsx` holds the decision
form and the later-feedback form that use it. One file holding all three would mean the findings
list could not be shared.

**Zod 4 checks a UUID's version and variant nibbles, not just its shape.** A placeholder like
`11111111-1111-1111-1111-111111111111` is refused. Real ids come from `gen_random_uuid()` and are
v4, so production is unaffected — but test fixtures must use genuine v4 UUIDs.

**Every e2e interaction is scoped to its form.** A recorded decision renders an add-feedback form
into the history, and both forms label their inputs "Finding 1 note". Page-level `getByLabel`
becomes ambiguous the moment the first decision exists, which is a failure that only appears after
a passing test writes a row.

### P2.5 deviations

**The authorization check is in each page, never in a layout.** Next 16's own guidance is explicit
and contradicts the obvious design: "A layout also does not control whether the rest of the route
renders. Route segments and parallel route slots are rendered by the router, so a layout that
hides or swaps them does not stop them from running or from appearing in the RSC Payload."
An `app/app/operator/layout.tsx` holding `requirePlatformOperator()` would look like a gate and be
a decoration. Both operator pages call it themselves, next to the data.

**An operator must also be a member of some workspace.** `app/app/layout.tsx` calls
`requirePrimaryWorkspaceMembership`, which redirects to `/onboarding`, and the operator pages live
under `/app` because that is where the plan puts them and where the nav item lives. So a pure staff
account belonging to no church cannot reach the queue, which sits awkwardly beside P2.2's note that
the marker is deliberately independent of workspace membership. The *authorization* is still
independent — no role grants it — but the *route* is not. Moving the pages to a top-level
`/operator` segment with its own layout would fix it; not done, because it diverges from the plan's
file list and from the shell the nav item belongs to.

**The signed-URL trap is closed at the source, not documented.** `createSignedMediaUrl` now throws
if the key does not belong to the workspace it was asked to sign for, and the media route and the
signer share one predicate so they cannot drift. The plan lists `signed-url.ts` as a file to touch;
this is what it needed. Recorded in `DECISIONS.md`.

**Hiding the selector is checked at runtime, not just by careful selecting.** `ClipScore` is never
included in a query here, but that is a rule someone breaks by adding one convenient field.
`assertNoSelectorSignal` walks every DTO before it is returned and throws on `score`, `subscores`,
`rationale`, `excerpt` or `modelVersion`. `total` is deliberately *not* on that list: QC writes a
free-form details document that could reasonably count things, and a false positive would break the
operator's page over nothing — a spread `ClipScore` is still caught by the other four.

**One test assertion was wrong in a way worth remembering.** The first version checked that the
serialised queue did not contain the score's value, `"87"`. It failed, because `"87"` appears
inside a UUID. Searching a JSON blob full of identifiers for a two-digit number proves nothing; the
test now pins the DTO's exact key set instead, which is a stronger claim and cannot collide.

**The e2e fixture writes real bytes.** An `ExportedFile` row without a file on disk makes the
signed link return 404, which would have let the scoping assertion pass for the wrong reason — the
point of that check is that the link *works*, not that it is shaped correctly.

### P2.4 deviations

**The final-render rule is gated on the publishing switch, and the plan does not say to gate it.**
The plan says to apply it to both the automatic and manual export paths. It is applied to both —
but only once `AUTOMATIC_PUBLISHING_ENABLED` is true. Ungated, it would refuse **every** export in
the product today, because `AUTOMATIC_SCHEDULE_ARMING_ENABLED` is still false and therefore no
`ScheduledPost` rows are being created at all. Even with arming on, refusing a church's Tier 2
manual export to prevent a delivery cost that is not yet being incurred is the wrong trade. The
cost of the gate is that the rule has no production mileage until the switch flips, and that
flipping it changes church-visible behaviour — recorded in `DECISIONS.md` and called out in
`docs/DEPLOYMENT.md` beside the switch.

**The plan's "or a reserve selected by the atomic replacement command" needed no exception.** P2.7
binds the promoted reserve to the slot inside the same transaction, before it enqueues that
reserve's export, so by the time the rule is asked the reserve *is* the scheduled clip. The
eligibility helper takes a client so P2.7 can call it inside its transaction.

**Eligibility is checked after the route's idempotent early return, not before it.** A clip
replaced out of its slot keeps the file it already has. The rule refuses new renders; confiscating
a finished one over an editorial decision made about a different clip would punish the church for
something it did not do.

**A slot can fail forever, on purpose.** A slot whose export another slot already binds cannot
write its binding — `ScheduledPost.exportJobId` is unique — so it is logged as an error event and
retried on every sweep. That state is unreachable through any normal path (`clipId` is unique too,
and the idempotency key contains the clip), so it is a "should never happen" that says so loudly
every fifteen minutes rather than one that hides.

**Tests live in a new integration file, not in the three the plan lists.** `analyze-job` and
`phase-6-7-workflow` needed no change: the coordinator no-ops with the switch off, which is their
state, and asserting a no-op there would say nothing. The coordinator's real behaviour needs slots,
clips and export rows, which is a new
`tests/integration/scheduled-render-coordinator.integration.test.ts`. The plan's "worker-isolation
test" is `npm run worker:build`, whose `tsc -p tsconfig.worker.json` step proves the coordinator
pulls no Next server code into the worker bundle; it passes.

### P2.3 deviations

**"Mid-clip" got a definition, and it came from P1.5.** The plan says `FORBIDDEN_CONTENT` is
replace-only "mid-clip" without saying where the edge is. Rather than pick a tolerance, the rule
reuses the continuous-range constraint the renderer already enforces: a forbidden span is
revisable exactly when excising it leaves one continuous range, which is true at either end and
false in the middle. A finding with no position is treated as mid-clip, which fails closed.
Recorded in `DECISIONS.md`, against the plan's "Decision log: none beyond Wave 2" — the plan said
that before anyone had to define the word.

**The bare-`REPLACE` guard checks at runtime, not only in the types.** `AppendableDecision`
excludes `REPLACE` from the union, which stops a TypeScript caller. It does not stop a decision
arriving from a form, a script, or JSON, which is a string until something checks it. The service
checks the value as well, and the test casts through `never` to prove the runtime guard holds.

**`latestReviewForRender` matches all four identity facts, not the export id.** The obvious
implementation looks up the bound export and takes its newest review. That would let a rerender
that reused an export id inherit an acceptance of different bytes. P2.8 will call this, so the
narrow version exists now rather than after it is depended on.

**The church-facing refusal message gained no words.** Reviews joined the durable-work set that
blocks reanalysis, but `REANALYSIS_BLOCKED_MESSAGE` still lists edits, approvals, exports and
schedules. A review can only exist against a slot whose bound export passed QC, and that export is
itself durable work on the same project — so `reviews` can never be the only non-zero count, and
the sentence is never incomplete. Naming staff review to a church would also mean explaining a
process that is not theirs, beside the "approved" they do recognise.

**No read model was built.** The plan lists `src/lib/review/query.ts` under P2.5, and P2.3's file
list does not include it. The service carries only the reads its own guarantees need —
`latestReviewForSlot`, `latestReviewForRender`, `reviewHistoryForSlot`. The queue read model stays
P2.5's.

### P2.2 deviations

**The grant lives in `src/lib/operations/`, not in `operator-auth.ts`.** The plan lists one new
module. Two exist: `src/lib/operator-auth.ts` reads the marker, and
`src/lib/operations/platform-operator.ts` grants it, beside `candidate-limit-override.ts` where
audited operations commands already live. One module holding both would let a route that imports
the check reach the grant, and the repo already has a home for the second half.

**Nothing was added to the route matrix, because P2.2 adds no route.** The plan lists
`tests/integration/route-authorization.integration.test.ts`, whose completeness guard walks
`src/app/api` and demands a row per route. P2.2 deliberately ships no staff dashboard — the
operator surfaces are P2.5 — so there is no route to add a row for. The behaviour that exists is
the gate helper and the command, covered by a new
`tests/integration/platform-operator.integration.test.ts`. P2.5 adds the matrix rows.

**`operator-auth.ts` takes a Prisma client rather than importing the singleton.** The plan does
not say. `src/lib/auth.ts` imports `@/lib/prisma` because it is a Next server module that cannot
be unit-tested anyway; every other DB-coupled module in `src/lib` — `retention.ts`,
`workspace-settings.ts`, `operations/candidate-limit-override.ts` — takes a client parameter, and
the marker check has to be unit-testable without pulling `PrismaClient` into the pure test config.

**The operator gate deliberately skips the billing check.** `requireApiWorkspace` ends in
`decideWorkspaceAccess`, which returns 402 for a lapsed church. Composing the operator gate onto
it would mean a lapsed trial silently stops staff reviewing work already done for that church.
`requireApiPlatformOperator` reads no plan state. Recorded in `DECISIONS.md`.

**One test-isolation bug worth remembering.** The first version of the audit assertions counted
`operational_events` rows globally by `eventType`. It passed alone and failed in the full suite,
because an earlier manual `npm run set:platform-operator` against the same database had left two
rows. Every assertion is now scoped to a user the test created, and the cleanup no longer deletes
rows it did not write. The shared integration database makes a global count a latent failure, not
a convenience.

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
ones. **The `Georgia` half of that was wrong, and the method is why.** A render inside the built
image on 2026-09-05 showed libass draws `Georgia` as DejaVu **Sans**, not Serif: `fc-match` and
libass disagree for a family the repository does not ship, and only the render is authoritative.
Do not use `fc-match` to answer what an unbundled family draws as. The substitution is by design: `Dockerfile.worker` deletes the distribution DejaVu copy and
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

**One live gap this surfaced — closed 2026-09-05.** `src/lib/editor/caption-presets.ts` named
`Inter`, while `main` ships only the six DejaVu faces in `public/fonts/`. A render inside the built
worker image settled it: `Inter` draws the identical frame to `DejaVu Sans`, so `clean`, `karaoke`
and `quiet` now name the bundled family. `Georgia` does not draw as `DejaVu Serif` — it draws as
`DejaVu Sans` — so `bold-serif` keeps its head. See `DECISIONS.md`, "The Caption Font Question Is
Settled, And It Split In Two", and `npm run audit:caption-faces`.

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
