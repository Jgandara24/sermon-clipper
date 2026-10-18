# P2 Stage 1: isolated transcript tests

This folder contains a disposable test model for the complete-message design.
It imports no application code.
Application code imports none of these files.
The helper does not select clips from real speech or infer meaning.

Read [the design](../../docs/P2_COMPLETE_MESSAGE_DESIGN.md) for the proposed policy.
The [P2 plan](../../docs/P2_SANDBOX_TEST_PLAN.md) remains the source for listening evidence.
The tests use invented words, identifiers, timestamps, region labels, and service responses.
They copy no production transcript text.

## Files

| File | Purpose |
|---|---|
| `harness.ts` | Supplies the fixed test model, padding calculations, admission experiment, fake clock, and work counters. |
| `fixtures.ts` | Creates fresh transcript objects and scripted judgments in memory. |
| `messages.test.ts` | Tests supplied meaning dependencies, evidence, missing context, and source preservation. |
| `boundaries.test.ts` | Tests duration, padding, source limits, region limits, word times, and transcript gaps. |
| `budgets.test.ts` | Tests simulated request limits, context blocks, candidate admission, and saved-pool preservation. |
| `vitest.config.ts` | Selects only the three test files in this folder. |

Each test receives fresh objects. No transcript files require cleanup.
Expected results stay in the test assertions, outside helper inputs.
The fake adapter supplies dependencies and evidence separately.
No fixture label tells the helper whether a message passes.

## Run only this suite

Run this command from the repository root:

```sh
./node_modules/.bin/vitest run --config tests/p2-complete-message/vitest.config.ts
```

This command uses the installed local runner.
It loads no application setup, environment files, workers, database clients, or network clients.
It starts no transcription, rendering, or publication.
The repository's default test discovery can also find these files during a future broad test run.
This task used only the isolated configuration.

Optional type check for this folder only:

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types node,vitest/globals tests/p2-complete-message/*.ts
```

## Coverage and choices

The six listening findings supply test patterns, not new listening evidence.
The tests preserve complete 56.620-, 37.590-, and 32.230-second examples.
They require the full 152-second example after a sentence ends at 67 seconds.
They leave the unresolved example uncertain.
They require earlier context within the 103-second example.

Duration tests cover both sides of the 20-second minimum and 180-second maximum.
They also cover 90,000, 90,001, 103,000, and 152,000 milliseconds.
Padding uses cleared space and never removes required words.
At 179,900 milliseconds, only 100 milliseconds remain for padding.
The helper assigns that space to the left edge first.
This deterministic test choice does not establish the final application policy.

The helper requires word timestamps at both selected edges.
It conservatively returns `boundary_uncertain` when those timestamps are absent.
Stage 2 must define the evidence needed for safe segment-only boundaries.

The admission experiment keeps at most 500 proposals and 25 scoring candidates.
It allocates 250 positions to each proposal source and transfers unused capacity.
It samples across source time and performs no overlap removal.
Proposal source means `short` or `message`.
It does not establish a final allocation between duration bands.

Fake counters test these limits:

- 60 requests, including repeated attempts.
- 12,000 input tokens per request.
- 120,000 input tokens per analysis.
- 24,000 output tokens per analysis.
- 60 seconds per request and 300 seconds per analysis.

Token counts come from supplied numbers. They are not provider measurements.
Output counts represent conservative reservations, including failed requests.
The fake clock advances instantly. No test waits for those time limits.
A stopped budget prevents further attempts in that rehearsal.
The helper returns `analysis_incomplete` and preserves the original saved-pool reference.
Even a successful rehearsal never writes the saved pool.

## Result from this task

Branch: `codex/p2-sandbox-preparation`.
HEAD: `86d1691`.

The isolated suite passed all 93 tests across three files.
Vitest reported 2.10 seconds for the run.
The isolated TypeScript check passed.
File checks found no changes to the 635 recorded existing files.
The tracked diff and Git index also stayed unchanged.
The P2 plan remains uncommitted.
This task changed no PR state or transcription hold.
It did not check either remote state.

## Limits and next step

This test model accepts supplied meaning judgments. It cannot detect a model that omits an unstated dependency.
Its tests establish rule behavior, not semantic accuracy on unseen transcripts.
Synthetic word times do not prove real audio cuts, caption quality, or any missing P2 proof.
Sparse synthetic words do not represent realistic speaking speed.

The helper supplies a small shape check for fake responses.
Stage 2 still needs a complete contract for adapter validation and policy functions.
Whole-segment packing tests do not establish complete-message grouping across provider requests.
Production token accounting, retries, cancellation, and memory limits remain future work.
Editor, render-plan, and output-check tests remain later stages.
Duplicate prevention remains deferred.

Recommend Stage 2 next. Keep its functions disconnected from application handlers.
Use independent fixture expectations when replacing this disposable helper.
Do not copy test success into a production-readiness claim.

Suggested prompt:

> Read the complete-message design and `tests/p2-complete-message/README.md`.
> Confirm the branch and existing changes.
> Implement Stage 2 only: pure policy functions and adapter validation with mocked responses.
> Keep those functions disconnected from application handlers and runtime behavior.
> Define complete-message grouping, boundary evidence, duration-band admission, and malformed-response handling.
> Reuse the independent synthetic expectations. Run only relevant isolated local tests.
> Do not access production, call external models, process media, render, publish, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve unrelated changes. Defer duplicate prevention.
> Use ASD-STE100 Simplified Technical English. Recommend the next step and provide its prompt.
