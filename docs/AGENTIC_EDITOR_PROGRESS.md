# Agentic Editor — Build Progress and Handoff

**Purpose.** `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` is the *target*. This file is the
*actual*: what shipped, what deviated, and what the next agent needs to know that the plan does not
say. `DECISIONS.md` remains the authoritative record of decisions; this is a working index.

**Last updated:** 2026-08-12, after P0.16.

---

## Status

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
| P0.16 global publisher kill switch | _(backfilled below)_ | done | Exact positive-enable guard at the publisher boundary |
| P0.17 correctness-substrate migration | — | **next** | Expand-first schema wave; publishing stays disabled |

A commit cannot contain its own hash, so the newest row's SHA is backfilled by the following
commit. P0.16 is the most recent; `git log --oneline` is authoritative.

Branch: `feat/reel-builder-trim`, eighteen commits ahead of `origin/main`. **Nothing pushed yet.**
The P0 pull request must include `4d51e5d` (drag-to-trim), which predates the program.

Suite as of P0.16: **61 unit test files, 475 tests**; **19 integration test files, 178 tests**.
`npm run verify` and `npm run test:integration` green.

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

---

## Conventions established during P0 that the plan does not state

- **Commit authorship.** Git identity is now configured locally and globally as
  `Jake Gandara <jake@jakegandara.com>`, verified on the GitHub account. Earlier history contains
  138 commits authored `jakegandara@Jakes-MacBook-Pro.local` — **leave those alone.** They are
  pushed, branch protection blocks force pushes, and rewriting them breaks published history.
- **Docs-only commits still run the full gate.** `npm run verify` before every commit, no
  exceptions. Gitleaks runs on commit via `.githooks/pre-commit`.
- **New npm scripts are inserted alphabetically** in `package.json`.
- **Redaction is verified, not trusted.** After generating a sanitized copy, grep it for every
  forbidden value. The first P0.2 scan found two genuine leaks that the transform had missed.

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

- **Push and open the P0 pull request.** Nothing is pushed. All four CI jobs must pass before merge.
- **Stage A recall** is now the known product bottleneck. It is P5's target, not a P0 fix.
- **PERC** has no implementation and its retrieval has never worked end to end.
- **Proxy economics** remain unmeasured; P0.11 makes byte metering a launch gate.
