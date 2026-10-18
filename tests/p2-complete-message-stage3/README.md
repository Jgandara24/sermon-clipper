# P2 Stage 3: disabled analysis integration

Stage 3 connects complete-message selection to the analysis handler behind an explicit project policy.
Missing settings and `enabled: false` retain the existing analysis path.
This task activated no policy in any running environment.

Read the [design](../../docs/P2_COMPLETE_MESSAGE_DESIGN.md) and [Stage 2 contract](../p2-complete-message-stage2/README.md) for earlier decisions.
The original design, Stage 1 tests, Stage 2 tests, and P2 plan remain unchanged.

## Changes

| File | Change |
|---|---|
| `src/lib/jobs/handlers/analyze.ts` | Selects the new path only after explicit policy validation. Preserves the existing persistence safeguards. |
| `src/lib/analysis/types.ts` | Adds an optional `completeMessageAdapter` capability. |
| `src/lib/analysis/complete-message/integration.ts` | Reads the disabled-default policy and binds region evidence to the exact transcript. |
| `src/lib/analysis/complete-message/adapter.ts` | Defines bounded requests, cancellation signals, token measurement, and usage responses. |
| `src/lib/analysis/complete-message/provider.ts` | Classifies context, validates messages, batches scoring, enforces budgets, and applies neutral duration scoring. |
| `src/lib/analysis/complete-message/contract.ts` | Updates the historical comment. Its policy values remain unchanged. |

No settings interface, activation command, environment switch, migration, or live adapter was added.
Existing live providers do not advertise the new adapter capability.
An enabled policy without that capability stops safely. It does not use legacy selection as a fallback.
The new adapter contract runs only through mocks in this task.
A reviewed live adapter remains necessary before activation.

## Disabled behavior

The handler reads `processingConfig.completeMessagePolicy`.
Absent settings or explicit `enabled: false` use the original provider, windows, filters, padding, scoring, and persistence path.
The disabled path adds no complete-message job metadata.
Malformed attempted activation stops before clip replacement.

An enabled snapshot requires version `complete-message-v1` and transcript-bound region and gap evidence.
The evidence revision combines transcript identity, source transcript revision, and transcript update time.
Stale evidence causes refusal before classification.
The handler copies stored word text and times into the policy contract.
Word identifiers use the existing `segmentId:index` convention.
It invents no word times, silence labels, or region clearance.

## Classification and scoring

Classification uses 360-second core ranges with a 180-second step.
Each request includes up to 30 seconds of adjacent context on both sides.
Segments remain whole when they cross a context edge.
Existing short candidates enter the request as seeds.
The prompt distinguishes a complete sentence from a complete message.
It requires existing references, exact evidence, and explicit missing-context judgments.
It treats transcript instructions as data.

Stage 2 validation checks every response against the supplied transcript and request.
Only complete decisions enter admission and scoring.
The implementation caps each classification response at 32 proposals.
It limits admitted candidates to 500 and scoring candidates to 25.
It preserves the existing Stage A overlap function and the final overlap threshold of `0.5`.
This task adds no duplicate-prevention behavior or overlap optimization.

Scoring receives each complete range with adjacent context and required evidence.
Request packing keeps each candidate and its context together.
Oversized candidates cause refusal instead of text truncation.
Scoring must return every requested candidate exactly once.
Missing, repeated, invalid, or truncated scoring output stops analysis before persistence.

Supported complete messages receive a neutral `platform_fit` score of `100`.
The existing score weights remain unchanged.
Other scores still measure qualities such as clarity and speaking pace.
The handler does not pad validated ranges again.
The 180,000-millisecond limit therefore includes the policy's final padding.

Stored score notes retain the policy version, transcript revision, selected content range, and required references.
Model versions also identify the complete-message policy.
Job metadata records candidate counts, request counts, and decision-reason counts.
These records do not constitute human approval.

## Bounded work

Classification reserves at most 1,024 output tokens per request.
Scoring reserves at most 2,048 output tokens per request.
These are conservative reservation values, not measured model capacity.
Truncation stops the analysis rather than accepting incomplete output.

All calls share these Stage 2 limits:

- 60 requests per analysis.
- 12,000 input tokens per request.
- 120,000 input tokens per analysis, including repeated context.
- 24,000 reserved output tokens per analysis.
- 60 seconds per request and 300 seconds per analysis.

The wrapper measures full serialized requests before dispatch.
Actual reported usage cannot exceed its reservation.
The wrapper enforces deadlines with timers and sends an abort signal on timeout or failure.
It starts no automatic retries and invokes no fallback provider.
Later live adapters must honor cancellation and report every request's usage.
Transport errors without usage cannot establish exact cost.

## Data protection

The handler checks durable work before provider selection and again under the existing database locks.
Saved edits, approvals, exports, and editorial reviews continue to block destructive reanalysis.
The existing transcript identity and revision checks remain in place.
The new path also rechecks its policy snapshot under those locks.
Unrelated routing snapshot changes do not invalidate the complete-message policy.

Incomplete analysis, missing adapters, exhausted budgets, and empty validated results preserve the existing project and clip pool.
Those errors set `preservesProject: true` and disable automatic job retries.
The existing hold settlement logic remains unchanged.
Mocked handler tests confirm that backup-transcription holds stay open.
No change bypasses approvals, final-render identity, publication eligibility, or the human review program.

## Isolated checks

Run from the repository root:

```sh
./node_modules/.bin/vitest run --config tests/p2-complete-message-stage3/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-complete-message-stage3/tsconfig.json
```

The test configuration selects only these relevant local checks:

- The unchanged Stage 1 and Stage 2 suites.
- Stage 3 mocked provider and handler tests.
- Existing chunking, scoring, reanalysis, and transcription-hold unit tests.

The final run passed 278 tests across 11 files in 5.59 seconds.
The isolated TypeScript check passed.
New tests cover default-disabled behavior, extended ranges, neutral duration scoring, bounded context, and token reservations.
They also cover cancellation, malformed responses, changed transcripts, policy changes, and protected human work.
Fake database responses exercise the real handler and guard functions.
They do not prove real database concurrency or transaction rollback.
No database, model, source media, renderer, or publication service ran.

## Local preservation

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
Of 652 recorded existing files, 649 stayed unchanged.
Only the handler, provider interface, and related contract comment changed.
The Git index stayed unchanged. Existing unrelated changes remain intact.
The P2 plan remains uncommitted.
This task made no production, PR, deployment, merge, or transcription-hold changes.
Remote PR and hold states were not checked.

## Next step

Recommend Stage 4 next with the policy still disabled.
Test editor saves, render planning, and output checks using synthetic data and fabricated probe facts.
Keep live adapter installation, policy activation, media processing, and publication outside that task.
Mocked judgments do not prove model accuracy, audio boundaries, or any missing P2 proof.

Suggested prompt:

> Read the complete-message design and Stage 3 README. Confirm the branch and existing changes.
> Implement Stage 4 only. Keep the complete-message policy disabled.
> Validate editor saves, source bounds, render planning, caption timing, and output-duration checks with synthetic data.
> Preserve saved-edit compatibility, approvals, holds, continuous ranges, and exact-render identity checks.
> Run only relevant isolated local tests. Use fabricated probe facts and mocked external services.
> Do not access production, install a live adapter, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve unrelated changes. Defer duplicate prevention.
> Use ASD-STE100 Simplified Technical English. Recommend the next step and provide its prompt.
