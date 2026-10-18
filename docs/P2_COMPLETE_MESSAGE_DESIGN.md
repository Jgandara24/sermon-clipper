# P2 complete-message design

Date: 2026-09-19. Status: local proposal. This document changes no runtime behavior.

Choose the shortest continuous range that preserves the complete message.
A full sentence alone does not prove a complete message.
Longer clips must supply needed context, development, or resolution.

## Scope and local state

The checked branch is `codex/p2-sandbox-preparation`.
The checked HEAD is `86d1691`: `Fix PR106 lock ordering, stale sandbox clips, and journal invariants`.
The working directory already contains tracked changes and untracked files.

Tracked changes affect `AGENTS.md`, `docs/P2_SOURCE_COPY_COMMAND.md`, `package.json`, and `tests/integration/source-copy.integration.test.ts`.
Untracked work includes sandbox-service code, tests, backup work, release notes, the P2 plan, and training files.
Preserve all existing work. Keep this design separate from those changes.

Keep PR #106 in draft. This task does not check its remote state or change it.
Keep `docs/P2_SANDBOX_TEST_PLAN.md` uncommitted.
Keep the demo transcription hold open. This task does not access its live record.
Defer duplicate prevention and overlap optimization.
Do not start processing, rendering, publication, deployment, merging, or the 30-day phase.

The [P2 test plan](P2_SANDBOX_TEST_PLAN.md) owns the six-clip evidence.
Read section 1 and its six-row table for exact findings.
Its 2026-09-14 readiness review records historical checks.
This design does not repeat that table or replace its findings.

## Design requirements from the six clips

- Clip 1 proves that a short clip can preserve the message. Keep its 56.620-second range as a reference.
- Clip 2 needs an ending before announcements. Its proposed 37.590-second range still needs exact boundaries and meaning review.
- Clip 3 supports a shorter, distinct thought. Its proposed 32.230-second range ends before the next subject.
- Clip 4 needs more than a completed sentence. Jake prefers 1:32.000–4:04.000, or 152 seconds.
- Clip 5 has no agreed complete range. Return an unresolved result instead of inventing an endpoint.
- Clip 6 needs earlier context and a complete ending. Jake prefers 8:47–10:30, or 103 seconds.

Jake's displayed-clock preferences do not establish exact cuts or final render quality.
Extended ranges still need complete transcript coverage and exact boundary checks.
Series context needs judgment. Announcements must not enter a clip through padding or extension.

Preserve the original transcript, word identifiers, timestamps, and audio.
Keep recognition corrections separate from readable-caption edits.
For example, clip 5's spoken extra article is an editorial issue.
Clip 3's extra article remains unresolved.
Name correction and filler detection remain separate work.

## Current local duration rules

| Step | Local code | Current behavior |
|---|---|---|
| Generation | `src/lib/jobs/handlers/analyze.ts` | Requests 20,000–90,000 milliseconds. |
| Windows | `src/lib/analysis/chunking.ts` | Uses 20-, 55-, and 90-second targets at segment ends. Caps the pool at 500. |
| Padding | `refineBoundaries` in `chunking.ts` | Adds up to 150 milliseconds per edge. Clamps to source bounds. |
| Classification and scoring | `src/lib/analysis/pipeline.ts` | Limits Stage B to 25 candidates. Completeness contributes to a weighted score. |
| Length preference | `src/lib/analysis/computed-subscores.ts` | Favors 50 seconds. Gives 103 seconds about 21 points and 152 seconds zero points. |
| Retained pool | `src/lib/analysis/candidate-limit.ts` | Defaults to 18. Reads the project limit separately from the scheduled count. |
| Manual trim | `src/lib/editor/trim.ts` | Uses a 3,000-millisecond minimum. Restricts handles to source bounds. |
| Saved state | `src/lib/editor/types.ts`; `src/app/api/clips/[id]/edit-state/route.ts` | Accepts nonnegative integer endpoints. Adds no 90-second maximum or complete range validation. |
| Render plan | `src/lib/exports/render-plan.ts` | Uses the saved continuous source range and its duration. |
| Renderer | `src/lib/export/render.ts` | Uses the range duration. Defaults to a 900,000-millisecond process timeout. |
| Output checks | `src/lib/qc/render-output.ts` | Allows duration drift of `max(1 second, expected duration × 0.05)`. |
| Publication | `src/lib/integrations/facebook.ts`; `src/lib/delivery/eligibility.ts` | Posts through `/{pageId}/videos`. Checks delivery evidence without a local clip-duration maximum. |

The generator's limit precedes padding. A 90-second candidate can become 90.300 seconds.
The editor's handle rules do not prove server-side range validation.
The render plan does not prove successful longer rendering.
The publication code does not prove current platform eligibility.
This local design makes no claim about current external platform limits.
Check official platform rules for the actual endpoint before a later publication proposal.

The current output tolerance permits 7.600 seconds of drift for a 152-second clip.
That tolerance cannot prove preservation of its final words.
The heuristic completeness score uses word count. It cannot establish complete meaning.
Current model prompts score excerpt text without adjacent transcript context.
Although `AnalysisContext` carries `fullText`, those prompts do not include it.
The sermon filter uses keywords and restores all candidates when every candidate fails.
It cannot supply a strict announcement boundary.

## Proposed duration policy

These values define an initial local design, not platform rules or measured production capacity.

| Item | Proposed limit | Reason |
|---|---|---|
| Automatic generation minimum | 20,000 milliseconds before padding | Preserves the current automatic minimum. |
| Standard candidate range | 20,000–90,000 milliseconds | Preserves useful short candidates. |
| Extended candidate range | Above 90,000 through 180,000 milliseconds | Covers the 103- and 152-second proposals with a bounded maximum. |
| Final generated range | At most 180,000 milliseconds, including padding | Prevents padding from exceeding the supported generation limit. |
| Boundary padding | 0–150 milliseconds per edge | Uses only known safe space outside required words. |
| Manual trim minimum | Retain 3,000 milliseconds | Avoids an unrelated editor restriction. |
| Existing manual clip maximum | Retain existing behavior initially | The automatic maximum must not silently invalidate saved edits. |

Use integer milliseconds and require `0 <= startMs < endMs <= sourceDurationMs`.
Require a known, positive source duration for the new automatic path.
Do not infer the source endpoint from the last candidate.
Refuse invalid source metadata before selection.

First select all required words. Then add safe padding within the source and approved region.
Reduce padding before refusing a complete 180-second message.
Never remove required words to meet the maximum.
If the required message exceeds 180 seconds, return `message_exceeds_limit` for human review.
Do not split that message automatically.
If the required message is shorter than 20 seconds, return `below_generation_minimum`.
Do not add unrelated speech to meet the minimum.

Keep manual saving, generation, and publication policies distinct.
A later server validator must reject invalid ranges independently of editor controls.
Any new manual duration maximum requires a separate compatibility decision.
Publication needs endpoint-specific limits and exact reviewed output.
If a destination cannot accept the complete range, report the conflict. Do not silently shorten the message.

## Selection and meaning checks

A candidate must contain its claim, needed context, required development, and resolution.
Include objections with the speaker's response when omission changes the meaning.
Include the earlier statement when a comparison or pronoun depends on it.
Do not require every sermon example when the message already stands alone.

Use three results: `complete`, `incomplete`, and `uncertain`.
Only `complete` candidates enter quality ranking in the proposed path.
Keep reason codes and supporting segment identifiers for every decision.
A high quality score must not rescue an incomplete message.
A model's `complete` result remains a selection judgment, not human approval or transcription proof.

Proposed flow:

1. Validate transcript order, timestamps, source bounds, and transcript revision.
2. Keep the existing short-window proposals as inputs.
3. Add a separate message-boundary adapter that proposes complete spans from transcript blocks.
4. Supply adjacent context and region labels to that adapter.
5. Require the adapter to name existing segment or word boundaries and supporting text.
6. Check those references against the original transcript. Reject invented times, text, or identifiers.
7. Check the entire proposed span for missing coverage, unresolved dependencies, and excluded regions.
8. Apply safe padding and repeat duration, word-boundary, source, and region checks.
9. Rank complete candidates. Keep existing overlap functions and thresholds unchanged.
10. Record uncertain candidates separately for review. Do not fill the requested count with incomplete candidates.

Segment boundaries and punctuation supply clues, not meaning proof.
A segment can contain the end of one message and the start of another.
Use word boundaries when reliable timestamps support them.
Otherwise return `boundary_uncertain` instead of inventing a precise cut.
Treat missing context and missing transcript coverage as `uncertain`.
Do not treat every silent gap as missing speech.

An approved region label must block announcements, worship, or other excluded material.
An uncertain region requires review.
Keep necessary series context when it supports the message.
Do not remove an internal announcement and join the remaining audio.
The existing continuous-range rule still applies.

In the later implementation, remove the 50-second preference for supported complete-message candidates.
Use a neutral duration contribution within the supported band.
Keep external platform eligibility separate from this score.
Compare shorter and longer complete ranges through clarity and usefulness.
Do not reward duration alone.
Keep legacy scoring unchanged when the new policy is off.

## Work and cost bounds

Use a versioned policy with the new path off by default.
Record the policy version with selection evidence.
Do not rebuild existing projects or edit saved ranges when policy settings change.

The following budgets are initial test parameters. Later measurements must support any production values.

| Work | Initial bound |
|---|---|
| Message search block | 360 seconds, plus up to 30 seconds of context on each side |
| Block step | 180 seconds |
| Selection pool | 500 candidates total |
| Pool allocation | Up to 250 short proposals and 250 message proposals; transfer unused capacity |
| Detailed scoring | At most 25 complete candidates |
| Retained clips | Existing project candidate limit; no forced minimum output count |
| Model requests | At most 60 per analysis, including retries and scoring |
| Model input per request | At most 12,000 tokens |
| Total model input | At most 120,000 tokens, counting repeated context and retries |
| Total model output | At most 24,000 tokens |
| Model time | At most 60 seconds per request and 300 seconds per analysis |

Overlapping search blocks let a message cross a block boundary.
This block overlap supports context coverage. It adds no duplicate-prevention requirement.
If context ends before a dependency resolves, return `uncertain`.

Pack whole transcript segments within request limits.
Do not truncate text or split a required message to meet a token budget.
If a segment cannot fit, record `context_budget_exceeded`.
Use provider token accounting before dispatch. Refuse dispatch when the reserved request exceeds the remaining budget.
Use a fake clock and fake token meter in local tests.

Sample candidate admission across source-time sections and both duration bands.
Keep chronological ordering before the existing overlap rules.
Report dropped counts, duration bands, source coverage, retries, and incomplete searches.
Keep rejected or incomplete ranges out before existing overlap thinning can remove a complete alternative.
Do not promise that every complete message survives a bounded pool.

When a budget stops the search, report `analysis_incomplete`.
Keep partial results as local review evidence only in the first implementation.
Do not replace a saved pool with partial results or start a fallback provider silently.

## Disposable transcript tests

Create invented transcript objects in memory. Use fresh identifiers and timestamps for each test.
Use an operating-system temporary directory only when a test requires files.
Delete disposable files after each test.
Do not read production transcripts, credentials, databases, storage, or media.
Do not call transcription services, models, workers, FFmpeg, or publication APIs.

Each fixture contains segments, word times, source duration, region labels, and expected meaning dependencies.
Keep expected dependencies outside the selector input.
Stub the adapter's responses separately from the expected result.
Test malformed and contradictory adapter responses as well as valid responses.

| Fixture | Invented situation | Required result |
|---|---|---|
| `short_complete` | A 56.620-second claim, objection, response, and resolution | Retain the short range. Do not extend it automatically. |
| `announcement_boundary` | A 37.590-second message followed by announcements and a trailing conjunction | Stop before announcements. Padding must not include their first word. |
| `distinct_next_thought` | A 32.230-second message followed by a new subject | Keep the first message. Do not append the new subject. |
| `sentence_not_message` | A sentence ends at 67 seconds. The message resolves at 152 seconds. | Reject the early ending. Admit the 152-second span. |
| `unresolved_message` | The transcript ends before the explanation resolves | Return `uncertain`. Supply no invented endpoint. |
| `earlier_context` | A comparison needs 15 seconds of earlier context. Its complete span lasts 103 seconds. | Include the earlier context and resolution. |
| `objection_reversal` | The speaker rejects an objection after a full sentence | Reject the objection alone. Preserve the response. |
| `long_without_need` | A complete 45-second message precedes unrelated examples | Keep the shorter complete proposal available. Give length no extra reward. |
| `caption_correction` | Spoken repetition, a recognition error, and a name spelling issue | Preserve source text and times. Keep correction categories separate. |
| `no_punctuation` | Lowercase text has clear message dependencies | Evaluate dependencies without requiring punctuation or capitals. |
| `unknown_word_edge` | A message ends within a segment without usable word times | Return `boundary_uncertain`. |
| `internal_excluded_region` | An announcement interrupts the required message | Refuse automatic selection. Do not join separated ranges. |

Add these boundary and budget cases:

- Test 19,999, 20,000, 90,000, 90,001, 103,000, 152,000, 180,000, and 180,001 milliseconds.
- Test a 179,900-millisecond message with 300 milliseconds of requested padding.
- Keep all words and use at most 100 milliseconds of padding in that case.
- Test exact source start and end, zero duration, reversed bounds, missing duration, and timestamps beyond the source.
- Test overlapping word times, absent word times, timestamp conflicts, missing coverage, and valid silence.
- Test required context across a search-block boundary and beyond the available context.
- Test invented adapter identifiers, unsupported quotes, duplicate identifiers, malformed results, timeout, and exhausted retries.
- Test 500 and 501 admitted proposals, 25 and 26 scoring candidates, and exact token-budget boundaries.
- Place complete short and long messages near the beginning, middle, and end of an invented 50-minute transcript.
- Verify source coverage, deterministic admission, and bounded work. Do not assert new overlap behavior.
- Exhaust each budget with fake counters. Verify the stop reason and preservation of the existing pool.
- Verify that changing caption text does not move endpoints or remove spoken words.

Later pure render-plan tests can use synthetic words and a fake caption measurer.
For 103- and 152-second ranges, verify the unchanged source range and exact `outputDurationS`.
Verify caption and title timing against the complete output timeline.
These tests must not render media.

Test output checks with fabricated probe facts.
Show that the current five-percent tolerance can accept missing final words.
Before release, define a stricter duration check tied to frame timing and final required word coverage.
Keep human review of the exact render as a separate requirement.

Fixture tests prove selection rules and bounds.
Stubbed model responses do not prove model judgment on unseen speech.
Synthetic timestamps do not prove actual audio boundaries.
Do not report these tests as any of the three missing P2 proofs.

## Implementation stages

| Stage | Proposed work | Completion evidence |
|---|---|---|
| 1 | Build an isolated test helper and disposable transcript fixtures. Keep application imports unchanged. | Tests cover meaning dependencies, duration, padding, invalid input, and budgets. |
| 2 | Build pure policy and adapter validation functions. Use mocked responses only. | Short, extended, uncertain, and rejected cases behave as specified. |
| 3 | Integrate behind the disabled policy. Add context-aware classification and neutral duration scoring. | Mocked integration tests verify existing paths and preserve existing data. |
| 4 | Validate editor saves, render planning, and output checks for the new policy. | Synthetic tests cover source limits, versioning, continuity, caption timing, and duration evidence. |
| 5 | Measure real selection and rendering after separate authorization. | Fresh transcript review, exact boundary checks, cost measurements, and human render review. |
| 6 | Consider release and publication separately. | Resolve existing release requirements and verify current endpoint limits. Collect the missing P2 proofs. |

Stages 1–4 need a later implementation instruction. This design task implements none of them.
Stage 3 must preserve transcription holds, reanalysis refusal, saved edits, approvals, and exact-render identity checks.
Use a disposable local database only after a task explicitly includes those integration tests.
No stage changes duplicate prevention or overlap thresholds.

Turning the policy off stops new selection through that path.
It must not delete longer clips or rewrite their saved state.
Any release plan must preserve support for previously saved ranges.
Keep backup custody and restore decisions as existing release requirements.

## Recommended next step

Implement Stage 1 only in a separate local task.
Use the disposable fixtures to test the proposed limits before connecting the design to application code.
Review the failures and budget measurements before Stage 2.

Suggested prompt:

> Read `AGENTS.md`, `docs/P2_COMPLETE_MESSAGE_DESIGN.md`, and `docs/P2_SANDBOX_TEST_PLAN.md`.
> Confirm the local branch and existing changes.
> Implement Stage 1 only with an isolated test helper and disposable synthetic transcripts.
> Test message completeness, duration limits, padding, source bounds, missing context, and work budgets.
> Keep application code, imports, and runtime behavior unchanged.
> Use mocked adapter responses, clocks, and token counts.
> Run only the isolated local tests. Report their results and limits.
> Do not access production, call external models, process media, render, publish, deploy, or merge.
> Keep PR #106 in draft. Keep the P2 plan uncommitted.
> Preserve unrelated changes and keep the transcription hold open.
> Defer duplicate prevention and overlap changes.
> Use ASD-STE100 Simplified Technical English. Recommend the next step and provide its prompt.

## Verification for this design task

This task read the handoff, P2 plan, local changes, and relevant application code.
It added this design document only.
It ran no application tests, transcript processing, model calls, or media operations.
File checks confirmed that the 16 existing changed source, test, and document files stayed unchanged.
The tracked diff and Git index stayed unchanged.
The P2 plan remains untracked. The design contains no trailing whitespace.
Historical test counts remain historical evidence.
The proposed fixture tests remain future work.
