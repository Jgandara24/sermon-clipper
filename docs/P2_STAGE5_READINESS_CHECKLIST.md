# P2 Stage 5 readiness checklist

Date: 2026-09-20. Status: local review complete; Stage 5 execution not authorized.

Stages 1–4 pass their selected local tests.
They do not establish readiness for real selection, rendering, or release.
Keep the complete-message policy disabled.
This checklist authorizes no production access, external model call, media operation, deployment, merge, or publication.

## Local state

Branch: `codex/p2-sandbox-preparation`.
HEAD: `86d1691`, `Fix PR106 lock ordering, stale sandbox clips, and journal invariants`.
The Git index is empty.

These tracked files already contained changes before this review:

- `AGENTS.md`
- `docs/P2_SOURCE_COPY_COMMAND.md`
- `package.json`
- `src/app/api/clips/[id]/edit-state/route.ts`
- `src/lib/analysis/types.ts`
- `src/lib/exports/handler.ts`
- `src/lib/exports/render-plan.ts`
- `src/lib/jobs/handlers/analyze.ts`
- `src/lib/qc/render-output.ts`
- `tests/integration/source-copy.integration.test.ts`

Existing untracked work includes Stages 1–4, sandbox-service work, backup work, release notes, and training files.
The design and P2 plan also remain untracked.
Preserve those files. Do not combine this checklist with unrelated changes.
The [P2 plan](P2_SANDBOX_TEST_PLAN.md) remains uncommitted and owns the six-clip listening evidence.
Keep PR #106 in draft and the demo transcription hold open.
This review checked neither remote state.

## Review of Stages 1–4

The [design](P2_COMPLETE_MESSAGE_DESIGN.md) defines the policy.
The stage notes record implementation details and historical results.
Earlier notes describe their original stage state; later stages supersede their integration statements.

| Stage | Local evidence reviewed | What remains unproved |
|---|---|---|
| [1](../tests/p2-complete-message/README.md) | Disposable transcripts test supplied meaning dependencies, duration limits, padding, and budgets. | Real message judgment and audio boundaries. |
| [2](../tests/p2-complete-message-stage2/README.md) | Pure functions validate references, quotations, coverage, regions, duration, admission, and work reservations. | Dependencies omitted by a model and real provider token accounting. |
| [3](../tests/p2-complete-message-stage3/README.md) | Disabled-default integration adds context, validated selection, bounded work, and neutral duration scoring. | Live adapter behavior, realistic request capacity, cost, latency, and database concurrency. |
| [4](../tests/p2-complete-message-stage4/README.md) | Mocked saves and exports check source bounds, versions, continuous ranges, captions, and output timing. | Real audio coverage, frame timing, final caption quality, and exact-render human acceptance. |

Source review confirms these safeguards:

- Missing policy settings and `enabled: false` retain the existing path.
- No installed analysis provider exposes `completeMessageAdapter`.
- Attempted analysis activation without that capability stops before clip replacement.
- Analysis rechecks transcript identity, revision, durable work, and policy under the existing locks.
- Partial or empty validated analysis preserves the saved pool.
- Manual saves preserve version conflicts, user identity, and approval invalidation.
- Manual edits retain the 3,000-millisecond minimum without a new maximum.
- Export planning uses the pinned edit version and the existing continuous-range check.
- Strict output timing checks apply only when the complete-message policy supplies timing evidence.
- Delivery still requires its separate approval, hold, and exact-render identity checks.

No source change occurred during this review.
No duplicate-prevention or overlap change forms part of Stage 5 readiness.

## Missing evidence and decisions

### R1. Live adapter and realistic work capacity

- [ ] Select the exact classification and scoring provider routes for a later test.
- [ ] Implement and review the missing adapter in a separate authorized local task.
- [ ] Test the adapter with mocked transport before any external model call.
- [ ] Count complete requests, including provider wrappers, schemas, prompts, and repeated context.
- [ ] Define cache-token accounting without double counting.
- [ ] Verify cancellation, truncation, malformed output, unknown usage, and provider errors.
- [ ] Keep automatic retries and silent provider fallback disabled.
- [ ] Test dense invented transcripts and full response structures, not only sparse word fixtures.
- [ ] Check whether 1,024 classification tokens and 2,048 scoring tokens support complete responses.
- [ ] Check scoring batch capacity against output limits, as well as input limits.
- [ ] Record source sections omitted by admission or existing overlap rules.

The current scoring batch builder packs by input size.
Its fixed output reservation does not establish capacity for every packed candidate.
Current truncation refusal protects saved data, but it does not prove useful throughput.
A reviewed live adapter remains a blocker for real selection.

Retain these limits unless a separate decision changes them:

| Item | Limit |
|---|---|
| Generation | 20,000–180,000 milliseconds; the maximum includes padding |
| Standard band | Selected content through 90,000 milliseconds |
| Padding | At most 150 milliseconds per edge, within verified silence and cleared regions |
| Classification | 360-second cores, 180-second steps, up to 30 seconds of adjacent context |
| Candidate admission and scoring | 500 admitted; at most 25 scored |
| Requests | At most 60 per analysis |
| Input tokens | 12,000 per request; 120,000 per analysis |
| Reserved output tokens | 24,000 per analysis |
| Time | 60 seconds per request; 300 seconds per analysis |

These are design limits. They are not measured production capacity or a dollar spending authorization.

### R2. Queued exports and policy changes

The export worker loads the pinned editor version but reads the project's current policy.
An intervening policy change can therefore change its QC requirements.
Disabling the policy restores legacy timing checks without rewriting saved ranges.

- [ ] Test policy changes between export queueing and worker execution with mocked services.
- [ ] Decide whether future complete-message exports need a recorded policy version at queue time.
- [ ] Require a separate implementation task for any resulting persistence change.
- [ ] Preserve old saved ranges and exact-render identity through either decision.

This is an unresolved readiness decision, not evidence that an incorrect file reached a user.

### R3. Save validation and database concurrency

The new editor source check runs before its save transaction.
Mocked tests do not establish behavior when source metadata changes during that interval.
Existing transcript guards and version constraints remain in place.

- [ ] Define source, policy, and transcript change cases for simultaneous saves and analysis.
- [ ] Obtain separate authorization before creating a disposable local database for these tests.
- [ ] Prove conflict handling, rollback, lock ordering, and preservation of prior edits and approvals.
- [ ] Never substitute production records or credentials for disposable fixtures.

### R4. Real transcript and selection evidence

- [ ] Name the authorized source, target service, workspace, retention period, and private evidence location.
- [ ] Use a separate test service when existing durable work prevents reanalysis.
- [ ] Record transcript identity, revision, provider, word times, source duration, and region evidence.
- [ ] Obtain trusted region and silence labels for that exact transcript revision.
- [ ] Check missing coverage, overlapping timestamps, uncertain edges, and context across search blocks.
- [ ] Review model selections against independent human judgments.
- [ ] Record false completeness, missed messages, uncertain results, and reasons for refusal.
- [ ] Measure request counts, input, output, cache use, elapsed time, and actual cost.
- [ ] Record failures and unknown usage. Do not count an interrupted request as free work.

Use the six findings as review requirements, not as copied production test fixtures.
Retain short complete messages, exclude announcements, and stop before a separate thought.
Check the 152-second resolution and the 103-second span with earlier context.
Keep the unresolved case uncertain unless new evidence establishes its complete range.
The P2 plan remains the authoritative source for exact clip findings and unresolved corrections.

### R5. Real boundaries, captions, and output

- [ ] Obtain separate authorization for named media and rendering operations.
- [ ] Verify source duration precision and both word boundaries against the authorized source.
- [ ] Review recognition corrections separately from readable-caption changes.
- [ ] Preserve original text, word identifiers, timestamps, and the continuous source range.
- [ ] Measure actual output duration and frame timing, including variable-frame-rate cases.
- [ ] Check final audio coverage independently of container duration.
- [ ] Check captions, title timing, crop, and audio across the entire output.
- [ ] Recheck message completeness after any manual range change.
- [ ] Record clip ID, edit version, export ID, output checksum, and matching `qcChecksum`.
- [ ] Require a human to review the exact output before recording acceptance.

The strict tolerance is `min(1 / measured fps, 0.1 seconds) + 0.001 seconds`.
The output must also reach the final selected word's timestamp.
Average frame rate and container duration alone do not prove audible word coverage.
Do not loosen this check merely to make a real test pass.
Investigate the cause and review any proposed change separately.

## Required authorizations

All execution authorizations below remain pending.
Approval of this checklist does not approve its execution steps.

| Action | Required authorization details |
|---|---|
| Local adapter implementation | Exact provider scope, disabled integration, mocked transport, and allowed local tests. |
| Disposable database tests | Named isolated local database, synthetic data only, setup, and cleanup scope. |
| Real source access or copying | Exact source and target, consent, byte limits, transfer budget, retention, and evidence location. |
| Transcription or real analysis | Exact service, provider routes, data transfer, request limits, dollar ceiling, and stop conditions. |
| Test policy activation | Exact disposable target, policy version, transcript-bound evidence, duration, and shutdown procedure. |
| Media processing or rendering | Exact source ranges, pinned edits, render count, compute limit, storage location, and cleanup scope. |
| Stored review or replacement | Exact file identity and supported operator action; disclose any automatic render queueing. |
| Production access or release | Separate production authorization and unresolved recovery decisions. |
| Publication or the 30-day phase | Separate later instructions; neither belongs to this Stage 5 checklist. |

If the existing production sandbox workflow is selected, follow the [P2 plan](P2_SANDBOX_TEST_PLAN.md) and its separate approvals.
Its source-copy command reads media bytes. Its service setup can queue processing.
`program:sandbox-proof` writes an audit event despite making no publication call.
Manual export and `REPLACE` can queue rendering while global publishing remains off.
Do not treat these actions as zero-write inspection.

The [release decisions](PR106_RELEASE_DECISIONS.md) remain separate requirements before production backup, migration, or deployment.
They do not block the present local review.
Preserve the original demo hold. Do not clear it by direct database edit.
A later selected service must satisfy the supported transcription requirements independently.

## Stage 5 execution order after authorization

1. Close R1–R3 decisions and record the authorized test scope.
2. Confirm isolation, target identities, source custody, spending limits, and executor controls.
3. Collect R4 transcript and human reference evidence without modifying protected services.
4. Activate only the separately authorized test target and measure one bounded selection run.
5. Review selections before any separately authorized render operation.
6. Collect R5 output and exact-file review evidence.
7. Stop the test, record policy and executor states, and preserve the evidence.
8. Present results and remaining failures before any release or publication proposal.

Stop for a source mismatch, stale evidence, missing context, exhausted budget, or unresolved provider usage.
Stop if durable work blocks reanalysis or fallback transcription creates a hold.
Stop for failed timing checks, unclear audio boundaries, or changed file identity.
Preserve saved edits, approvals, holds, and the existing pool when a test stops.
Do not retry, delete evidence, shorten required speech, or clear a hold to force success.

## P2 proof status

The local P2 plan still records these missing proofs:

| Proof | Status after this review |
|---|---|
| Atomic replacement | Missing. Synthetic tests do not prove the named operational replacement. |
| Exact accepted render | Missing. No real output or new human acceptance occurred. |
| Single sandbox publication | Missing. No publication was authorized or attempted. |
| 30-day phase | Not started. It needs a separate instruction. |

Stage 5 selection and rendering evidence does not automatically supply atomic replacement or publication proof.
An exact-render acceptance must reference the required current identity and follow the P2 plan.
No current platform-limit claim forms part of this local review.
Verify official endpoint requirements later, before a separately authorized publication proposal.

## Verification from this review

The Stage 3 configuration passed 278 tests across 11 files.
It includes the Stage 1 and Stage 2 suites.
The Stage 4 configuration passed 250 tests across 14 files.
The configurations share some tests; their counts are not distinct totals.
Both isolated TypeScript checks passed.
File checks confirmed that all 743 recorded existing files stayed unchanged.
This checklist is the only new file. The Git index remains empty.
The P2 plan remains untracked and uncommitted.

```sh
./node_modules/.bin/vitest run --config tests/p2-complete-message-stage3/vitest.config.ts
./node_modules/.bin/vitest run --config tests/p2-complete-message-stage4/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-complete-message-stage3/tsconfig.json
./node_modules/.bin/tsc --project tests/p2-complete-message-stage4/tsconfig.json
```

All services used by the selected tests were mocked where required.
No production access, external model call, media processing, rendering, deployment, or merge occurred.
This review changed no policy setting, PR state, saved edit, approval, or hold.
Remote states remain unchecked.

## Recommended next step

Prepare the live-adapter design and realistic synthetic workload tests in a separate local task.
Address R1 and document the R2 policy decision before requesting real Stage 5 execution.
Keep provider transport mocked and the policy disabled.

Suggested prompt:

> Read the design, Stage 4 README, and Stage 5 readiness checklist.
> Confirm the branch and existing changes.
> Prepare a provider-specific live-adapter design using the existing local routing code.
> Add isolated tests for dense synthetic requests, complete responses, and queued-export policy changes.
> Use mocked transport and services. Report capacity limits and required implementation decisions.
> Do not change application runtime code or activate the policy.
> Do not access production, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve saved edits, approvals, continuous ranges, exact-render identity checks, and unrelated changes.
> Defer duplicate prevention. Use ASD-STE100 Simplified Technical English.
> Recommend the next step and provide its prompt.
