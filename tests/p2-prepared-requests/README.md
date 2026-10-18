# P2 pure request preparation and output budgets

This task implements pure helpers from the [adapter design](../../docs/P2_LIVE_ADAPTER_DESIGN.md).
It adds no application runtime wiring, provider transport, configuration, or database schema change.
The complete-message policy remains disabled by default.
Existing application paths do not import these helpers.

## Prepared requests

`src/lib/analysis/complete-message/prepared-request.ts` provides these functions:

| Function | Purpose |
|---|---|
| `snapshotJson` | Copies and freezes JSON without retaining mutable caller references. |
| `prepareRequest` | Records the exact route, canonical body, input reservation, and output limit. |
| `preparedIdentity` | Captures the identity that the caller must retain separately before dispatch. |
| `verifyPreparedRequest` | Checks the body, route, schema version, reservations, and retained identity. |
| `reservePreparedRequest` | Applies the existing serial work budget to a verified request. |

Preparation requires an explicit classification or scoring stage, provider, model, and schema version.
Supported provider labels are `anthropic` and `google`. Those labels install no provider capability.
The injected meter must explicitly support the exact route.
It receives the complete frozen body and route metadata.
It must include provider-specific overhead. The helper supplies no estimated tokenizer.

The caller supplies the complete provider body, including its response schema and wrappers.
A later provider builder must check that body fields agree with the recorded route and output limit.
These generic helpers do not interpret provider-specific body fields.
The transport must later send the same prepared `bodyJson` without reconstruction or modification.

Canonicalization sorts object keys and preserves array order and text.
The helper rejects cycles, getters, non-JSON values, sparse arrays, and structures deeper than 64 levels.
The depth limit prevents uncontrolled recursion. It changes no analysis budget.
It copies repeated references independently and safely retains ordinary JSON property names.

SHA-256 checks cover the canonical body and its route and reservation metadata.
The retained identity also rejects substitution with a different, internally valid prepared request.
Digests detect inconsistency. They do not authenticate an untrusted caller or prevent duplicate work.
Do not reconstruct the expected identity from a later replacement request.

Input reservations must be positive safe integers through 12,000 tokens.
Classification output limits cannot exceed 1,024 tokens.
Scoring output limits cannot exceed 2,048 tokens.
The existing budget still enforces aggregate counts, pending requests, and time limits.
A stopped reservation never permits dispatch.

## Complete scoring batches

`src/lib/analysis/complete-message/output-budget.ts` provides `planScoringBatches`.
Each packet contains a whole candidate, its context, and its evidence.
The helper copies and freezes every packet before calling an injected meter.
It preserves packet order, repeated packets, and all supplied content.
It performs no semantic selection, overlap removal, or duplicate prevention.

The batch meter supplies two bounds:

- Complete request input, including wrappers, schemas, prompts, and repeated context.
- Complete response output, including every score, note, title, summary, and excerpt.

The planner appends whole packets while both bounds fit.
If the next packet exceeds either limit, it starts another batch.
If one complete packet cannot fit, the entire plan fails.
It returns no partial plan and never truncates a candidate, context, or evidence.
It retains the 25-candidate scoring limit.

Every batch reserves the full existing 2,048-token output cap, even when its output bound is smaller.
Planning checks the remaining 60-request, 120,000-input-token, and 24,000-output-token budgets.
It uses the existing reservation functions for this projection.
Planning does not advance the caller's real budget or reserve execution time.
Execution must reserve each prepared request again against the current budget and clock.

The helpers trust the injected meter's bounds.
They cannot prove that a sample response represents the maximum possible output.
Before live integration, define bounded response fields and a reviewed provider-specific accounting method.
Reject unknown capacity instead of treating missing evidence as zero tokens.
The existing runtime batch builder remains unchanged and retains its documented capacity limitation.

## Isolated verification

The final run passed 109 tests across five files.
The isolated TypeScript check passed.

```sh
./node_modules/.bin/vitest run --config tests/p2-prepared-requests/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-prepared-requests/tsconfig.json
```

The configuration selects the new helper tests, existing Stage 2 work tests, and adapter-readiness tests.
All provider and worker services remain mocked where required.
No real provider client, database, media probe, renderer, or publication service ran.

Tests cover immutable envelopes, route changes, request substitution, invalid JSON, and exact reservation boundaries.
They cover both input-driven and output-driven splitting, aggregate exhaustion, pending work, and expired analysis time.
A combined test plans, prepares, and reserves each whole batch without dispatch.
Ten packets split into batches of six and four under controlled output bounds.
The tests preserve all packet context and reserve 4,096 output tokens for those two batches.
Test counts and byte estimates are not real provider token measurements.

Existing readiness tests still characterize queued-export policy changes.
This task changes no export-policy behavior or persistence.
Source boundaries, saved edits, approvals, holds, continuous ranges, and exact-render identity rules remain unchanged.

## Local preservation

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
The initial file record contains 750 existing files outside the unrelated training directory.
Final checksum checks confirmed that all 750 existing files remain unchanged.
This task adds two pure source modules and this isolated test folder only.
The adapter design, earlier tests, Stage 5 checklist, and unrelated changes remain unchanged.
The Git index remains empty. The P2 plan remains untracked and uncommitted.
No policy, PR, or transcription-hold state changed. Remote states remain unchecked.
Duplicate prevention remains deferred.

## Recommended next step

Implement a disconnected Anthropic adapter with injected mocked transport in a separate task.
Use these helpers for prepared identity and reservation checks.
Define bounded response fields and failure-usage handling before any runtime connection.
Keep real token calibration, activation, database changes, and export-policy persistence outside that task.

Suggested prompt:

> Read the adapter design and pure-helper README. Confirm the branch and existing changes.
> Implement a disconnected Anthropic adapter with injected mocked transport only.
> Use the prepared-request helpers and preserve existing budgets and complete context.
> Define bounded response validation and explicit unknown-usage failures.
> Test exact request bodies, route identity, cancellation, zero retries, truncation, and cache accounting.
> Keep application runtime wiring unchanged and the policy disabled. Do not change the database schema.
> Do not access production, call external models, process media, render, deploy, or merge.
> Keep PR #106 in draft, the P2 plan uncommitted, and the transcription hold open.
> Preserve saved edits, approvals, continuous ranges, exact-render identity checks, and unrelated changes.
> Defer duplicate prevention. Use ASD-STE100 Simplified Technical English.
> Recommend the next step and provide its prompt.
