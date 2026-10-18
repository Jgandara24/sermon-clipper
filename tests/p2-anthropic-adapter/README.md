# P2 disconnected Anthropic adapter

This task implements the Anthropic adapter from the [local design](../../docs/P2_LIVE_ADAPTER_DESIGN.md).
It uses the [pure request helpers](../p2-prepared-requests/README.md).
Application runtime paths do not import the new adapter.
The complete-message policy remains disabled by default.

## Interface

`src/lib/analysis/complete-message/anthropic-adapter.ts` exports `DisconnectedAnthropicAdapter`.
Construction requires explicit classification and scoring routes, a token meter, and an injected transport.
There is no default transport, SDK import, environment lookup, credential read, or network implementation.
Create one instance for one analysis budget. Do not recreate it to bypass exhausted work limits.

`prepare(stage, payload)` preserves the complete JSON payload in one user message.
It adds the exact model, output cap, disabled thinking, and stage-specific response schema.
It measures the full prepared body, including that schema.
Zod attaches hidden metadata to generated schemas. The adapter serializes that trusted schema before freezing it.
It does not serialize away unsupported fields from caller-supplied context.

`dispatch(request, identity, signal)` requires the separately retained prepared identity.
It checks the body digest, route, model, schema version, output cap, and complete provider body.
It rejects substitution or provider-body changes before transport.
The injected transport receives the exact prepared `bodyJson`.

The adapter owns serial reservations through the existing budget helpers.
This interface does not implement the old payload-only `CompleteMessageAdapter` interface.
Do not attach it directly to the existing runtime wrapper.
A later integration must select one budget owner and avoid double reservation.

## Cancellation and retries

The transport receives `maxRetries: 0` and an abort signal.
The adapter invokes it once per reserved call and adds no retry or fallback.
An already cancelled request never reaches transport.
Caller cancellation and request deadlines abort the injected transport signal.
The adapter also settles its promise when a mock ignores cancellation.

The existing 60-second request and 300-second analysis deadlines remain active.
Concurrent dispatch attempts cause refusal.
Any dispatch failure stops further work on that instance.
Reservations remain charged after failure, cancellation, or low actual usage.
The adapter clears timers and removes its cancellation listener after settlement.

A future real transport must honor cancellation and disable its own internal retries.
These mocked tests do not prove provider cancellation or absence of remote billing after cancellation.

## Response and usage checks

Success requires the configured model, `end_turn`, one text block, valid JSON, and the bounded stage schema.
Classification output must repeat the request ID and transcript revision.
Scoring output must contain every requested candidate index exactly once.
The adapter refuses truncation, refusal, tool output, unknown termination, and malformed content.
It never repairs or truncates a response to make it valid.

Classification retains the existing response contract and caps proposals at 32.
Scoring caps results at 25 and uses these additional text bounds:

| Field | Maximum characters |
|---|---|
| Title | 200 |
| Hook text | 2,000 |
| Summary | 4,000 |
| Excerpt | 100,000 |
| Each subscore note | 2,000 |

The adapter checks a 262,144-byte text limit before JSON parsing.
It also passes that byte limit to the injected transport.
A future transport must enforce the limit while reading the response, before constructing its return object.
The local adapter cannot bound memory already allocated by an injected transport.
These structural limits do not increase the 1,024- and 2,048-token output caps.

All four usage categories must contain explicit nonnegative safe integers.
Input, cache creation, and cache read counts remain separate and contribute once to the input reservation check.
Missing cache counts do not silently become zero.
The adapter rejects actual usage above its reservation.
Twenty-three classification requests retain 23,552 reserved output tokens, even when their measured outputs are smaller.
The next full classification reservation exceeds the unchanged 24,000-token analysis limit.

Results distinguish three usage states:

- `not_requested`: Transport did not run.
- `known`: Valid measured usage accompanies success or failure.
- `unknown`: Transport ran but trustworthy usage is unavailable.

Known failures retain usage with `outcome: failed`.
A model mismatch retains the reported model and removes the requested model's price association.
Cancellation and transport errors do not invent zero cost.
Diagnostics contain stable reason codes instead of raw provider errors.
This adapter writes no usage, cost, or review records.

## Limits before live use

The token meter remains an injected dependency. Tests supply controlled counts only.
Exact model identifiers are required; this adapter does not normalize model aliases.
The generated schema's compatibility with a real provider remains unverified.
No SDK transport or schema-conversion compatibility layer was installed.
Future transport must support the bounded contract without discarding required local validation.

Complete-message meaning and source-reference checks remain the responsibility of the existing Stage 2 validator.
This adapter checks response structure and identity. It does not approve message meaning or rendered output.
The output-aware planner remains separate. Callers must preserve its complete batches during later integration.
No runtime coordinator connects these components in this task.

Real token calibration, model availability, billed usage semantics, cost limits, and request capacity remain pending.
Database concurrency and queued-export policy persistence also remain pending.
The three missing P2 proofs remain missing.

## Verification

The isolated run passed 163 tests across six files.
The new adapter file contributes 33 tests.
The configuration also checks prepared requests, budgets, mocked analysis safeguards, delivery identity, and transcription holds.
The isolated TypeScript check passed.

```sh
./node_modules/.bin/vitest run --config tests/p2-anthropic-adapter/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-anthropic-adapter/tsconfig.json
```

No production access, external model call, media processing, rendering, deployment, merge, or publication occurred.
All transport responses, provider models, and usage measurements are synthetic.

## Preservation

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
The initial record contains 757 existing files outside the unrelated training directory.
Final checksum checks confirmed that all 757 existing files remain unchanged.
This task adds one disconnected source module and this test folder only.
Existing runtime wiring, database schema, saved-edit logic, approval logic, and hold logic remain unchanged.
Continuous-range and exact-render identity checks remain unchanged.
The Git index remains empty. The P2 plan remains untracked and uncommitted.
No PR or transcription-hold state changed. Remote states remain unchecked.
Duplicate prevention remains deferred.

## Recommended next step

Implement a disconnected Google adapter with injected mocked transport only.
Test inclusive prompt-token and cache-token accounting explicitly.
Keep runtime integration, mixed routes, activation, and export-policy persistence outside that task.

Suggested prompt:

> Read the adapter design and Anthropic adapter README. Confirm the branch and existing changes.
> Implement a disconnected Google adapter with injected mocked transport only.
> Preserve complete context and existing budgets. Use the prepared-request helpers.
> Test request identity, cancellation, zero retries, truncation, candidate coverage, and inclusive cache-token accounting.
> Represent missing usage explicitly. Keep runtime wiring unchanged and the policy disabled.
> Do not change the database schema or enable mixed-provider routing.
> Do not access production, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve saved edits, approvals, continuous ranges, exact-render identity checks, and unrelated changes.
> Defer duplicate prevention. Use ASD-STE100 Simplified Technical English.
> Recommend the next step and provide its prompt.
