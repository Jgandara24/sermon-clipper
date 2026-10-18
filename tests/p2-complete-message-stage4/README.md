# P2 Stage 4: editor and output validation

Stage 4 adds checks behind the existing complete-message policy.
The policy stays disabled by default. This task activated no policy.
Read the [design](../../docs/P2_COMPLETE_MESSAGE_DESIGN.md) and [Stage 3 README](../p2-complete-message-stage3/README.md) for selection rules.

## Changes

| File | Change |
|---|---|
| `src/lib/analysis/complete-message/editor-validation.ts` | Checks source identity, manual ranges, and selected word timing. |
| `src/app/api/clips/[id]/edit-state/route.ts` | Checks new saves only when the policy is enabled. |
| `src/lib/exports/render-plan.ts` | Checks the pinned range and prepares final-word timing evidence when the policy is enabled. |
| `src/lib/exports/handler.ts` | Supplies source facts and sends timing evidence to output checks. |
| `src/lib/qc/render-output.ts` | Adds a strict duration check when complete-message timing evidence is present. |

No configuration, activation command, live adapter, migration, or publication rule changed.
Missing policy settings and explicit `enabled: false` retain existing behavior.
Malformed attempted activation causes refusal.
Duplicate prevention remains deferred.

## Editor saves and compatibility

The enabled save check requires the correct source identity and a known positive source duration.
Times must use safe integer milliseconds.
The range must stay within the source and last at least 3,000 milliseconds.
The check does not clamp or rewrite the range.

The 20,000–180,000-millisecond generation limits do not become manual editing limits.
Tests retain manual ranges of 3,000, 19,999, 180,001, and 300,000 milliseconds.
Tests also retain the 103,000- and 152,000-millisecond ranges from the design.
Existing saved documents remain readable after policy shutdown.

Version conflicts still return `409`.
The unique version constraint still handles competing inserts.
Human saves still remove `systemInitial` and record the saving user.
Edits after approval still require new approval and revoke the old review link.
Workspace and transcript-change checks remain intact.
These tests use mocked transactions. They do not prove database concurrency or rollback.

## Render plans and captions

The worker still loads the exact `ExportJob.editVersion`.
It never substitutes the latest edit or the original generated range.
The existing continuous-range check still refuses deleted words within the clip.
Filler metadata does not remove spoken words.
Extension metadata does not splice separate ranges into the output.

The enabled plan checks source identity, source bounds, and available word timestamps before any media operation.
It refuses missing word evidence, inconsistent timestamps, and words that cross either clip boundary.
It retains the original range and exact planned duration.
It never adds padding during render planning.

Tests check caption corrections, word timing, title timing, and source offsets with synthetic transcripts.
A fake font measurer avoids font file access.
Existing caption timeline tests also check subtitle event timing.
Caption changes do not change the source text, source timestamps, or selected range.

## Output-duration evidence

The legacy tolerance remains `max(1 second, expected duration × 0.05)` while the policy is disabled.
A synthetic 145-second output passes that duration check for a 152-second plan.
The new check refuses that output.

The strict tolerance uses `min(1 / measured fps, 0.1 seconds) + 0.001 seconds`.
The extra millisecond allows timestamp precision differences.
The output must also reach the final selected word's end on the output timeline.
No frame tolerance permits a shortfall before that word ends.
All selected words provide conservative timing evidence, including words with caption corrections and filler tags.
Missing or invalid frame rates and invalid timing evidence cause refusal.

The existing decode, dimensions, audio, checksum, byte count, and caption event checks remain active.
The worker records failed checks before it refuses storage upload.
Mocked worker tests check that order.
Exact-render identity, human review, approval, and hold checks remain separate requirements.

These checks compare measured duration with transcript timestamps.
Average frame rate and container duration do not prove audio alignment or variable-frame timing at each boundary.
Synthetic words do not prove transcript accuracy or message completeness after a manual edit.
Real boundary review remains necessary before release.
This task supplies none of the three missing P2 proofs.

## Isolated tests

Run these commands from the repository root:

```sh
./node_modules/.bin/vitest run --config tests/p2-complete-message-stage4/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-complete-message-stage4/tsconfig.json
```

The final test run passed 250 tests across 14 files.
The isolated TypeScript check passed.
The selected tests cover Stage 4 and existing save, caption, export, delivery, approval, hold, and reanalysis safeguards.
Stage 3 handler tests also confirm disabled behavior and hold preservation.
The tests construct disposable synthetic transcripts in memory.
Worker tests mock storage, filesystem operations, media probes, rendering, and cost services.
No database, external model, media process, renderer, or publication service ran.

## Local preservation

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
The initial file record contained 734 files outside the unrelated training directory.
Of those files, 730 stayed unchanged.
Only the four existing application files listed above changed.
The new helper and Stage 4 test files contain this task's other changes.
The Git index remains empty. The P2 plan remains untracked and uncommitted.
All prior Stage 1–3 files and unrelated changes remain intact.
The existing `AGENTS.md` trailing whitespace remains unchanged.

This task made no PR, deployment, merge, or transcription-hold changes.
It left PR #106 in its existing draft state and left the transcription hold open.
It did not check remote PR or hold state.

## Next step

Recommend a local readiness review before Stage 5.
Review the live adapter requirements, timestamp evidence, and separate authorizations for real selection and rendering.
Keep the policy disabled during that review.
Do not start Stage 5 from these synthetic results alone.

Suggested prompt:

> Read the complete-message design and Stage 4 README. Confirm the branch and existing changes.
> Review Stages 1–4 locally. Keep the policy disabled.
> Prepare the Stage 5 readiness checklist and identify missing evidence and separate authorizations.
> Review live adapter requirements, frame timing limits, source boundaries, and exact-render review requirements.
> Use existing local evidence only. Do not install a live adapter or run media tests.
> Do not access production, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve saved edits, approvals, holds, continuous ranges, exact-render identity checks, and unrelated changes.
> Defer duplicate prevention. Use ASD-STE100 Simplified Technical English.
> Recommend the next step and provide its prompt.
