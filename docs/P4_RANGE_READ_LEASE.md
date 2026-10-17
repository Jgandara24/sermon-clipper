# Protected range reads

`withMaterializedRange()` now protects range materialization and rendering against artifact cleanup.
It acquires a `P4_RANGE_RENDER` source session before storage access.
The initial audit records the artifact identity and requested source interval.
No database transaction remains open during download or rendering.

## Admission and storage checks

Admission locks the workspace-owned source and checks its active gate.
It refuses sources with unfinished sessions.
It requires a ready, verified, visually accepted render-source artifact that covers the requested interval.
It checks expiry against the database clock.
A validated running export pin can retain access beyond ordinary artifact expiry.
It requires a matching accepted [review record](P4_ARTIFACT_REVIEWS.md) and pins the review revision in its audit.
It also checks the artifact namespace, source checksum, publication checksum, byte count, and storage location.

The lease does not require the original storage key.
It downloads only the pinned range object.
The storage provider receives the recorded object identity for conditional download.
The lease verifies downloaded bytes and marks the local file read-only before calling its consumer.
The consumer receives original source dimensions and transfer results.

## Cleanup and settlement

Artifact cleanup and original cleanup already refuse unfinished source sessions.
The read session therefore protects its range through the awaited callback and local cleanup.
Successful work removes local files and records `COMPLETE`.
A failed acquisition can also complete after all download work and local cleanup settle.
A failed callback or failed local cleanup records `UNCERTAIN`.
Retries cannot reclaim that session by age.

The implementation currently serializes source reads with other source work.
Concurrent read sessions and interrupted-session recovery remain unfinished.
The review service now refuses changes during unfinished source sessions.
Retention mutation APIs must also respect the source-session protocol.

## Renderer connection

`renderPinnedRangeExport()` combines the read lease with verified local range rendering.
It checks that the render interval matches the pinned request before downloading.
It returns artifact identity, mapped timestamps, session ID, and download accounting data.
It has no original-source fallback.

The production export worker still uses its existing input path.
Artifact selection, persisted review evidence, fallback accounting, and controlled deployment remain unfinished.
No production artifact received visual approval.

## Verification

Forty-six database tests passed.
New read-lease tests verified reads after original removal and removal of the original database storage key.
They verified that active reads block artifact cleanup and overlapping source work.
They also verified workspace checks, coverage checks, review refusal, failed downloads, uncertain callbacks, and local cleanup.
The read-protocol fixture uses simulated approval and fixture bytes.
Separate generated-media renderer tests verify actual rendering and content mapping.
