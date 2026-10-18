# P2 live-adapter design

Date: 2026-09-21. Status: local design only.

Keep the complete-message policy disabled.
This task installs no live adapter and changes no application runtime code.
The [Stage 5 checklist](P2_STAGE5_READINESS_CHECKLIST.md) still governs missing evidence and separate authorizations.
The [complete-message design](P2_COMPLETE_MESSAGE_DESIGN.md) still governs selection, duration, and preservation requirements.

## Confirmed local state

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
The ten tracked changes listed in the Stage 5 checklist remain present.
Existing untracked work includes Stages 1–4, the checklist, sandbox-service work, backup work, release notes, and training files.
The Git index remains empty. The P2 plan remains uncommitted.
No existing file requires modification for this design or its tests.

Keep PR #106 in draft and the original transcription hold open.
This task changes neither state and checks neither remote record.
No source, transcript, media, credential, or production database is needed for these tests.

## Existing interfaces and gaps

The current `CompleteMessageAdapter` defines `measureInputTokens(payload)` and `invoke(call)`.
The call contains a stage, payload, output reservation, and cancellation signal.
No installed provider exposes that capability.

Local routing supports separate Anthropic and Google classification and scoring adapters.
`ClaudeStageAdapter` uses an Anthropic SDK stream and structured output.
`GeminiStageAdapter` uses injected `fetch` and a JSON response schema.
Both existing paths request up to 32,000 output tokens.
They implement the legacy stage protocol, not the complete-message proposal protocol.
Do not attach them directly as complete-message adapters.

The complete-message wrapper currently reserves 1,024 classification output tokens and 2,048 scoring output tokens.
Its scoring batch builder checks input size only.
Its synchronous input meter receives no explicit stage, route, schema, or provider request body.
That interface does not establish complete provider-envelope accounting for mixed routes.

The local Anthropic SDK exposes request cancellation and retry controls.
Its `messages.countTokens` method makes a service request.
Do not call it during local preparation or hide its requests inside an uncounted meter.
These observations describe installed code. They do not establish current external API limits or model availability.

## Proposed structure

Use explicit dependencies. Construct no provider client during module import.
Keep existing legacy adapters unchanged while the policy is disabled.

| Proposed component | Responsibility |
|---|---|
| Complete-message route adapter | Select the recorded provider, model, and price snapshot for each stage. |
| Anthropic transport adapter | Build one structured request, forward cancellation, and normalize one response. |
| Google transport adapter | Build one JSON request, forward cancellation, and normalize one response. |
| Request preparation | Freeze the exact body, schema version, route, input reservation, and output limit before dispatch. |
| Token meter | Count or conservatively bound the complete prepared request with a reviewed method. |
| Response validator | Enforce proposal or scoring schema, required identity, complete coverage, and bounded output. |
| Usage normalizer | Preserve reported counts and distinguish unknown usage from zero usage. |

Implement Anthropic support first as a bounded local task with mocked SDK transport.
Implement Google support separately with mocked `fetch`.
Keep mixed routes unavailable until both adapters and their stage selection tests pass.
Never substitute another provider when a selected route lacks support.
Use recorded route models and prices. This design selects no live model or current price.

### Prepared request contract

Replace the ambiguous payload-only measurement boundary in a later authorized implementation.
The proposed prepared request contains these fields:

```ts
type PreparedMessageRequest = {
  stage: "analysis_classification" | "analysis_scoring";
  provider: "anthropic" | "google";
  model: string;
  schemaVersion: string;
  body: Readonly<unknown>;
  bodyDigest: string;
  inputReservation: number;
  maxOutputTokens: number;
};
```

The sketch defines intent, not installed application types.
Prepare each request once. Measure and dispatch that same immutable body.
Count prompts, JSON schemas, message wrappers, word identifiers, timestamps, and repeated context.
Include provider-specific token overhead through a documented, reviewed accounting method.
Reject dispatch if the body digest, route, or output limit changes after reservation.
The digest identifies the prepared request. It adds no duplicate-prevention behavior.

The injected meter must support the exact provider and model.
The current test estimate cannot serve as a production meter.
If no safe local meter exists, refuse live dispatch until a separately reviewed counting strategy exists.
Any remote counting strategy needs explicit authorization, bounded requests, time limits, usage records, and revised budget accounting.
Do not silently add remote counting to the synchronous interface.

### Provider mapping

| Contract item | Anthropic proposal | Google proposal |
|---|---|---|
| Payload | One recorded user message with the complete serialized payload. | One recorded user content item with the complete serialized payload. |
| Structured response | Use the installed SDK format helper with the complete-message or scoring schema. | Use the corresponding supported JSON response schema. |
| Output limit | Pass the exact reserved `max_tokens`. | Pass the exact reserved `maxOutputTokens`. |
| Cancellation | Forward the supplied signal through the SDK request options and cancel the stream on failure. | Forward the supplied signal to injected `fetch` and stop response consumption. |
| Retry | Set SDK retries to zero. Add no application retry. | Add no automatic retry or fallback. |
| Truncation | Treat token-limit termination and incomplete structured output as failure. | Treat token-limit termination and incomplete candidate output as failure. |
| Success | Require the expected normal completion and one valid response. | Require the expected normal completion and one valid candidate. |

Validate provider schema support before live use. Do not remove required contract constraints merely to obtain a response.
Treat refusal, safety termination, tool output, missing text, and unknown completion reasons as failures.
Bound response bytes before parsing, as well as provider output tokens.
Keep provider errors and credentials out of user-visible diagnostics.
Do not follow instructions embedded in transcript text.

### Usage, cancellation, and cost

Normalize input into mutually exclusive uncached, cache-read, and cache-write counts.
The wrapper adds those counts when checking its input reservation.
Follow the existing Anthropic field mapping only after verifying the selected response shape.
For Google, subtract cached tokens from inclusive prompt tokens before assigning uncached input.
Reject negative counts, cached counts above totals, missing required usage, or unsupported usage semantics.
Do not convert missing counts to zero.

Count billed reasoning output if the selected model reports it separately.
Do not install that model until its complete usage mapping is defined.
Record failed-call usage once when the provider supplies it.
Represent unknown usage explicitly when cancellation or transport failure prevents measurement.
Extend the failure contract in a later task if the existing return type cannot carry that evidence.

Keep the existing 60-request, 120,000-input-token, and 24,000-output-token analysis limits.
Keep the 12,000-input-token request limit and the existing time limits.
Reserve before dispatch. Stop on reservation failure, truncation, or missing scoring results.
Never save partial analysis or retry automatically after an ambiguous outcome.
Actual dollar ceilings need a separate decision and recorded pricing before a real run.

## Dense request and output findings

The new [test suite](../tests/p2-adapter-readiness/README.md) uses invented speech at 180 words per minute.
Each ten-second segment contains 30 timed words.
The tests call the existing complete-message wrapper with mocked adapters.

The sensitivity model uses `ceil(UTF-8 bytes / 4)`.
It is not a tokenizer, provider measurement, or guaranteed upper bound.
Other tests use controlled counts to isolate packing and rejection behavior.
No passing test establishes live token capacity.

| Case | Observed local result |
|---|---|
| Complete 30- and 60-second messages | The wrapper preserves every source word and the complete range. |
| 390-second delivered context | The request contains 1,170 words and exceeds 12,000 units under the sensitivity model. Dispatch stops. |
| Overlapping blocks in 720 seconds | Requests contain 39, 42, and 39 whole segments. Repeated context contributes repeated input. |
| Full 180-second classification response | Complete evidence exceeds the 1,024-unit output reservation under the sensitivity model. Mocked truncation stops analysis. |
| Ten complete scoring results | Input-only packing places ten candidates in one request. Their response exceeds 2,048 units under the sensitivity model. |
| Full-envelope boundary | A controlled reservation of 12,000 proceeds. A reservation of 12,001 stops before dispatch. |

The ten-candidate test validates the complete synthetic response against the real scoring schema.
It then supplies a mocked provider truncation result.
The wrapper refuses that result and calls no fallback provider.
This characterizes the current capacity risk without changing runtime limits.

### Recommended capacity decision

Keep current limits during this task.
Before live integration, add output-aware scoring batch preparation in a separately authorized implementation.
Reserve space for every score, note, title, summary, and excerpt in a batch.
Keep each candidate and its required context together.
If one complete response cannot fit, stop with an explicit capacity reason.
Do not omit evidence, split required meaning, or truncate transcript text to pass a budget.

Measure actual provider-envelope and response costs before selecting new numeric limits.
Adaptive classification blocks need a separate design that preserves context and crossing-message coverage.
The current dense tests do not authorize smaller blocks or larger budgets.

## Queued-export policy decision

The new tests create synthetic queued job objects and invoke the real worker through mocked services.
They do not execute the real enqueue route or a database transaction.
They preserve the pinned editor version throughout each policy transition.

For a fabricated 145-second output from a 152-second plan:

| Policy at synthetic queue time | Policy at worker load | Current result |
|---|---|---|
| Enabled | Enabled | Strict timing check fails. |
| Enabled | Disabled or absent | Legacy timing check passes. |
| Disabled | Enabled | Strict timing check fails. |
| Disabled | Disabled | Legacy timing check passes. |

Malformed activation stops before any mocked media operation.
A policy change after plan construction does not change that run's timing requirements.
Policy shutdown does not bypass continuous-range refusal or missing pinned-edit refusal.
QC and stored file checksums remain identical in successful mocked runs.
Separate delivery tests retain human acceptance and exact-render identity requirements.

### Recommended policy decision

Record an immutable, versioned export-validation policy when a future job is queued.
Keep policy activation separate from previously recorded validation requirements.
Shutdown should stop new complete-message selection without weakening checks for already queued complete-message exports.

For a future persistence change:

- Preserve legacy behavior for old jobs without a snapshot.
- Require a valid snapshot for newly queued complete-message jobs.
- Record the source and transcript identity needed to reproduce the validation evidence.
- Keep the existing pinned edit and continuous source range.
- Reject unknown snapshot versions and source identity changes.
- Do not overwrite existing snapshots or reuse weaker QC as stronger-policy evidence.
- Keep existing clip, edit, export, and checksum review identities unchanged.
- Do not change export idempotency keys or duplicate-prevention rules in this work.
- Refuse incompatible job reuse until a separately reviewed operator path exists.

This recommendation is not an applied migration or an approved release decision.
It needs enqueue-path review, compatibility tests, and separately authorized disposable database tests.
The original P2 plan and Stage 5 checklist remain unchanged.

## Implementation order and stop points

1. Review the prepared-request, usage-failure, and queued-policy decisions.
2. Implement pure request preparation and output-aware batch bounds with mocked tests in a separate task.
3. Implement one disabled provider transport with injected mocks and zero automatic retries.
4. Add the second provider and mixed-route tests only after the first contract passes.
5. Implement export policy persistence only after separate approval of its schema and compatibility behavior.
6. Obtain named source, model, spending, activation, processing, and rendering authorizations before real Stage 5 work.

Do not infer permission for a database, live model, source copy, render, or release from this design.
Preserve saved edits, approvals, holds, continuous ranges, exact-render identity, and unrelated work.
Duplicate prevention remains deferred.
Atomic replacement, exact accepted render, and single sandbox publication proofs remain missing.

## Recommended next step

Implement pure prepared-request and output-budget helpers with mocked tests only.
Leave provider clients, runtime wiring, policy activation, and database schema unchanged.
Keep export policy persistence as a separate task.

Suggested prompt:

> Read the live-adapter design and its test README. Confirm the branch and existing changes.
> Implement pure prepared-request and output-budget helpers only, without runtime wiring.
> Use injected token meters and mocked services. Test immutable envelopes, stage routes, complete responses, and budget refusal.
> Preserve whole candidate context. Do not silently truncate evidence or raise existing budgets.
> Keep the policy disabled. Do not install provider transport or change the database schema.
> Do not access production, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve saved edits, approvals, continuous ranges, exact-render identity checks, and unrelated changes.
> Defer duplicate prevention. Use ASD-STE100 Simplified Technical English.
> Recommend the next step and provide its prompt.
