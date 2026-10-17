# Pinned range inputs for exports

`ExportRangeInput` now records the exact range input prepared for an export job.
It binds the job to an artifact, review, source checksum, artifact checksum, mapping checksum, edit version, and source interval.
The database rejects updates and direct deletion while the export job exists.
Deleting the parent job can remove its pin.

`pinExportRangeInput()` accepts a transaction client.
`enqueueRangeExportJob()` now creates the job and pin in one transaction.
`enqueueRangeExportJobInTransaction()` supports callers that need a larger transaction.
Matching concurrent requests reuse one job.
Failed pin validation rolls back the new job.
The producer refuses existing jobs without range pins.
`prepareExportRangeInput()` supports controlled local preparation of an existing unclaimed job.
Live queue producers must use the atomic enqueue function.

The service locks the workspace-owned source and export job.
It reloads clip metadata after acquiring those locks.
It reads the job's saved editor version and derives the requested interval from that document.
It refuses wrong workspaces, changed sources, uncovered intervals, unavailable artifacts, and missing review evidence.
New pins require a queued job with zero attempts.
Repeated matching requests return the same pin.
Conflicting requests cannot replace it.

The database also checks artifact readiness, coverage, checksums, review ownership, and review freshness when inserting a pin.
Source sessions prevent preparation during unfinished source work.

## Activation boundary

The [export worker](P4_RANGE_EXPORT_WORKER.md) now consumes range pins behind explicit activation.
Its claim query excludes pinned jobs while `P4_RANGE_EXPORTS_ENABLED` is false.
Pinned jobs remain queued by default.
The shared queue now selects approved ranges when range exports are enabled.
This covers manual exports, scheduled exports, reserve replacements, and prior-service fills.
Selection requires full interval coverage and current approval.
The selector prefers the smallest stored artifact, then its ID.
Missing coverage stops job creation.
The manual export route returns `EXPORT_RANGE_UNAVAILABLE` with HTTP 409.

Fallback exceptions and controlled activation remain unfinished.
A generated-media integration test now verifies a complete worker run with persisted review and pin records.
Unfinished pinned jobs now [retain their ranges](P4_PINNED_RANGE_RETENTION.md) without changing artifact expiry.
A matching running job can read its retained range after ordinary expiry.

## Local verification

Database tests verify saved intervals, stable retries, checksum binding, immutable pins, wrong-workspace refusal, and started-job refusal.
They also verify that the worker leaves pinned jobs unclaimed.
Clean installation, populated upgrade, and repeated deployment checks passed in disposable local databases.
The test review decisions remain simulated.
No production range received approval or deployment.
