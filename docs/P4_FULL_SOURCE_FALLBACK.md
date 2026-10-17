# Explicit full-source export fallback

Plan item 24 requires an explicit, metered, and exception-visible full-source fallback.
Range exports remain the normal input when `P4_RANGE_EXPORTS_ENABLED=true`.
A fallback reads the complete stored original for one clip version.

## Activation

`P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED` controls the fallback and defaults to false.
Only the exact value `true` enables it.
The fallback also requires `P4_RANGE_EXPORTS_ENABLED=true`.
No production setting changed during implementation.

## Request

Only a platform operator can request a fallback.
The request uses `POST /api/operator/clips/{id}/full-source-export` with a reason of 1 to 500 characters.
The route keeps the continuous-range, final-render, and rate-limit checks of the normal export route.

`enqueueFullSourceFallbackExportInTransaction()` takes the source lock used by range producers.
It refuses when an approved range covers the saved interval.
It refuses when the original is no longer stored.
It never converts an existing export job.
One transaction creates the export job, an open review exception, and the fallback record.
Concurrent matching requests return one job and one exception.

## Database guards

`export_full_source_fallbacks` stores the operator, reason, reason code, interval, edit version, and source byte count.
Insertion requires a queued, unstarted, unpinned job in the same workspace and source.
It also requires an open `full_source_export_fallback` exception in the same workspace.
Rows are immutable except for the referential removal of a deleted requester.
The exception cannot be deleted while its fallback record exists.
A fallback job cannot later receive a range pin.

## Worker behavior

While range exports are active, an original-input job without a fallback record fails terminally.
The error code is `FULL_SOURCE_FALLBACK_REQUIRED`.
The refusal happens before any source download.
Completion repeats the same check.
Queued legacy original jobs must therefore finish or be canceled before range activation.

A fallback job must match its recorded source, workspace, edit version, and interval.
Otherwise it fails with `FULL_SOURCE_FALLBACK_CHANGED`.
Region checks, output QC, and completion checks still apply.

## Metering and visibility

Download, render, and upload cost facts carry these details:
`exportInput: "FULL_SOURCE_FALLBACK"`, the fallback ID, and the exception ID.
Retries record new facts with their attempt numbers.
`qcDetails.mediaInput` also names the fallback and exception.
The route records one `export_full_source_fallback_requested` warning event per new fallback.
The operator exception list shows the open exception.
Successful completion does not resolve the exception.

Cost facts still use the safe recorder.
A failed cost write creates a `cost_fact_record_failed` event instead of failing the export.

## Verification

Two database cases passed in a disposable PostgreSQL cluster.
They cover both switches, covered-range refusal, invalid reasons, concurrent requests, and existing jobs.
They also cover the missing original, immutability, range-pin conflict, and exception deletion.
The generated-media case refused an unrecorded original job without a download.
It then rendered a fallback job and verified three tagged cost facts and the open exception.

Seven route tests cover operator authority, reasons, attribution, reuse, and refusal codes.
All 103 source-media-lease database cases and 40 other export database cases passed.
The repository migration proof passed with all 45 migrations.
Lint, type checking, the worker build, and all 2,791 unit tests passed.

## Operator page control — 2026-10-17

The operator project page now shows a "Full-source export fallback" section.
It appears only when both switches are on and the original is still stored.
It lists scheduled clips with no bound render and status `NOT_STARTED`.
Each form requires a reason and a confirmation box.
The Server Action proves platform-operator authority before it reads the form.

The API route and the Server Action share `requestFullSourceFallback()`.
It keeps the continuous-range, final-render, and rate-limit checks.
It records one `export_full_source_fallback_requested` event per new fallback.
A repeated request returns the existing fallback without a second event.

Four action tests and seven route tests passed.
A database case verified covered-clip and missing-clip refusals, reuse, and one event.
The production build passed. No browser test has exercised the page.

## Remaining limits

No production activation, real storage transfer, or billing reconciliation has run.
The fallback rate in real services remains unmeasured.
