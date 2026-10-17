# Export-worker range inputs

The export worker now reads `ExportRangeInput` before selecting media.
A pinned job can render through the protected range read lease without an original storage key.
The worker checks that the pin matches the saved edit version and source interval.
The lease then checks exact artifact, review, mapping, checksum, workspace, and running-job evidence.

`P4_RANGE_EXPORTS_ENABLED` controls activation and defaults to false.
Only the exact value `true` enables range jobs.
Disabled workers leave pinned jobs unclaimed.
Direct attempts to run disabled pinned jobs fail explicitly.
Migrations and operational acceptance must precede activation.
No production setting changed during implementation.

## Rendering and accounting

The worker downloads only the pinned artifact for a range job.
It records range transfer bytes and cache results through the existing cost recorder.
It measures range rendering separately from download preparation.
Original source dimensions still determine the crop.
The range renderer uses current authoritative dimensions from read-lease admission.

The existing output probe, duration checks, caption checks, checksum, upload, and file registration still run.
QC details now identify the artifact and review used for range exports.
They identify original input for existing jobs without range pins.

A pinned-input failure is terminal and visible as an export error.
It never causes an original-source download.
An explicit, operator-requested fallback now exists; see [full-source fallback](P4_FULL_SOURCE_FALLBACK.md).
While range exports are active, an original job without that record fails before download.
The original-input path still serves unpinned jobs while range exports are disabled.

## Verification

Fifty-one database tests passed.
They include disabled queue exclusion and enabled queue claiming for pinned jobs.
Thirty-three worker and renderer tests passed.
Worker wiring tests mock media and storage services.
They verify missing-original handling, protected range consumption, output QC, disabled activation, and failure without fallback.
Separate generated-media tests verify real range rendering and source parity.
Lint, type checks, and the worker build passed.

A generated-media integration test now exercises the complete worker with persisted review and range input records.
It removes its generated original before claiming the range export.
The worker renders, checks, uploads, and registers the output.
The test verifies the output checksum, dimensions, audio, duration, and successful job state.
It verifies exact download and upload bytes, render duration, and completed read-session cleanup.
All 36 source-media-lease database tests passed in a disposable local database.
Type checking and focused lint passed.

The review decision remains simulated.
The shared queue now selects approved covering ranges when range exports are enabled.
Manual, scheduled, replacement, and prior-service export producers use that queue.
Missing coverage fails before a new job becomes visible.
Existing original-input jobs remain unchanged.
Actual human review, production activation, explicit fallback accounting, and interrupted recovery remain unfinished.
