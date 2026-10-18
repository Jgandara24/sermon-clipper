# P2 Stage 2: pure policy and adapter validation

Stage 2 adds pure functions under `src/lib/analysis/complete-message/`.
No application handler imports these functions.
This task changes no active selection, scoring, editor, rendering, scheduling, or publication behavior.

The [complete-message design](../../docs/P2_COMPLETE_MESSAGE_DESIGN.md) supplies the policy requirements.
The [Stage 1 README](../p2-complete-message/README.md) records the disposable test model and its limits.
The original design, Stage 1 files, and P2 plan remain unchanged.

## Functions

| File | Function or contract | Purpose |
|---|---|---|
| `contract.ts` | `POLICY`, schemas, transcript checks | Defines versioned limits and validates source structure. |
| `policy.ts` | `evaluateResponse` | Validates a supplied adapter response and checks each proposed message. |
| `requests.ts` | `planMessageRequests` | Keeps each supplied message group together with intervening segments and adjacent context. |
| `admission.ts` | `admitDecisions` | Admits complete candidates within source, duration-band, and count limits. |
| `budget.ts` | `initialBudget`, `reserveWork`, `finishWork`, `budgetStatus` | Checks serial work reservations using supplied time and token counts. |

The new source files import only local pure functions and the installed `zod` package.
They contain no environment reads, network calls, database calls, file writes, timers, or worker operations.
They import none of the Stage 1 test helpers.

## Adapter contract

The caller supplies the transcript and the exact request identity, revision, origin, and delivered segment identifiers.
The response must repeat that request identity and revision.
It uses protocol version `1`.
Unknown fields, padded identifiers, unsupported field types, and oversized arrays cause refusal.
Validation never normalizes identifiers or changes source text.

Each proposal names existing segment or word references for its start and end.
The model cannot supply timestamps or claim trusted boundary verification.
Each required reference includes its exact source text and meaning roles.
Roles include claim, context, development, objection, and resolution.
A complete proposal must include claim and resolution evidence.
One reference can carry both roles when appropriate.

Required evidence must exist in the delivered request.
Required evidence outside the proposed range makes the message incomplete.
Missing intervening request context makes it uncertain.
An explicit unresolved dependency also makes it uncertain.
A response that claims completeness while declaring missing context contains a contradiction and fails validation.

Unknown references and unsupported quotations cause refusal.
Repeated protocol identifiers cause refusal. This does not remove overlapping clips.
Malformed response envelopes return no decisions.
A valid envelope returns separate complete, incomplete, uncertain, or rejected decisions.

## Boundary and duration rules

The functions preserve the 20,000-millisecond automatic minimum.
They enforce a 180,000-millisecond maximum, including padding.
The standard band ends at 90,000 milliseconds of selected content, before padding.
The extended band covers longer selected content within the maximum.
No function changes manual editor limits.

Word references derive their times from the validated transcript.
Segment boundaries require matching edge word times or trusted `verifiedStart` and `verifiedEnd` assertions.
The caller supplies those assertions through transcript input. Model responses cannot supply them.
The functions do not manufacture boundary verification.

The full range must have transcript coverage and approved region coverage.
Explicit silence can cover gaps between segments.
Unmarked gaps remain uncertain. Conflicting speech and silence labels cause refusal.
Excluded regions cause refusal. The policy never joins separated audio ranges.

Padding requires explicit silence and region clearance.
This tightens the Stage 1 helper, which allowed padding into unlabelled outer space.
The functions add at most 150 milliseconds per edge.
They reduce padding before removing required speech.
When padding capacity is limited, they allocate it to the left edge first.
Required speech longer than 180 seconds returns `message_exceeds_limit`.

## Request grouping and work bounds

Each supplied message group occupies one request.
The request includes every intervening segment and up to 30 seconds of adjacent context.
A segment that crosses a context boundary stays whole.
The planner never splits a supplied message group to meet a token limit.
An oversized group returns `context_budget_exceeded` and no partial request plan.

The injected token meter must count the complete serialized request, including prompts and repeated context.
The isolated tests supply fake counts. No provider token counter runs here.
The planner allows at most 60 groups and 120,000 input tokens.
Each request allows at most 12,000 input tokens.
The planner groups supplied dependencies. It does not discover message boundaries or search a real transcript.

The budget functions additionally enforce 24,000 reserved output tokens.
They enforce a 60-second request deadline and a 300-second analysis deadline.
They allow one outstanding request at a time.
Every attempt consumes its reservation, including retries and failed attempts.
Actual usage cannot exceed the reservation.
An unresolved request or stopped budget reports `analysis_incomplete`.

Time comes from the caller. The functions do not wait, cancel, retry, or start requests.
Later integration must enforce the returned deadlines during real requests.
No function receives or replaces a saved clip pool.

## Candidate admission

Only decisions from `evaluateResponse` belong in `admitDecisions`.
This internal function accepts validated decisions, not raw adapter output.
It preserves the 500-candidate limit and the 25-candidate scoring limit.
It initially allocates 250 positions to each proposal origin, with unused capacity transferable.
Within each origin, it divides positions between standard and extended durations.
It samples each band across source time and returns candidates in chronological order.
The scoring subset also represents both duration bands when both exist.
An odd remaining position goes to the standard band.

Counts separate policy refusals from capacity omissions.
Coverage reports the earliest selected start and latest selected end.
This does not prove complete source coverage.
No new overlap rule, duplicate-prevention rule, quality score, or publication rule applies.
Stage 3 still owns neutral duration scoring and application integration.

## Isolated verification

Run from the repository root:

```sh
./node_modules/.bin/vitest run --config tests/p2-complete-message-stage2/vitest.config.ts
```

This configuration selects only Stage 1 and Stage 2 tests.
It loads no application setup or production environment.

For an isolated type check:

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types node,vitest/globals src/lib/analysis/complete-message/*.ts tests/p2-complete-message-stage2/*.ts tests/p2-complete-message/*.ts
```

The final run passed 186 tests across five files in 2.82 seconds.
This includes 93 unchanged Stage 1 tests and 93 Stage 2 tests.
The isolated TypeScript check passed.
Tests reuse invented Stage 1 transcripts with independent expected outcomes.
They use mocked adapter responses, token counts, and clock values.

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
Preservation checks found no changes to the 642 recorded existing files.
The tracked diff and Git index stayed unchanged.
No existing runtime file references the new module.
The P2 plan remains uncommitted.
This task made no production, PR, or hold changes. It did not verify remote states.

## Limits and next step

These functions check supplied evidence. They cannot detect every unstated dependency that a model omits.
A passing judgment does not prove complete meaning, transcript accuracy, or an exact audio boundary.
No model, media, rendering, publication, or P2 proof test ran.
The limits remain design values, not measured production capacity.

Recommend Stage 3 next, with the new policy disabled by default.
Preserve legacy behavior when that policy is disabled.
Keep real processing and activation outside that local implementation task.

Suggested prompt:

> Read the complete-message design and Stage 2 README. Confirm the branch and existing changes.
> Implement Stage 3 only behind a policy that defaults to disabled.
> Preserve existing behavior when the policy is disabled.
> Integrate context-aware classification, validated message selection, bounded work, and neutral duration scoring.
> Use mocked adapter responses and isolated local tests. Do not enable the new policy in any running environment.
> Preserve transcription holds, reanalysis safeguards, saved edits, approvals, and exact-render identity checks.
> Do not access production, call external models, process media, render, publish, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve unrelated changes. Defer duplicate prevention and overlap changes.
> Use ASD-STE100 Simplified Technical English. Recommend the next step and provide its prompt.
