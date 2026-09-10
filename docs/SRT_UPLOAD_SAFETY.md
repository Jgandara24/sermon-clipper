# SRT upload safety

An SRT upload changes the transcription input for a source. It does not save caption
edits or clear a transcription hold. Several services can share that source.

## Commit rules

The upload route keeps its existing permission, size, syntax, and source-wide
durable-work checks. The replacement step adds these rules:

- Write each valid upload to a new UUID key under `srt/<workspace>/<source>/`.
  Never overwrite the current input. Existing fixed keys remain readable.
- Refuse known running work, other active pipeline stages, active sibling work,
  and jobs with a positive billing reservation. Return `SRT_PROCESSING_ACTIVE`.
- Lock the selected project, then the source. Check the original source timestamp,
  SRT key, and transcript revision again after waiting. A changed source returns
  `SRT_SOURCE_CHANGED`. A human edit during staging returns `REANALYSIS_BLOCKED`.
- Check that the staged object still exists under that lock. A missing object returns
  `SRT_UPLOAD_MISSING`. A stage older than 15 minutes returns `SRT_UPLOAD_EXPIRED`.
  These refusals use status 409 and commit no pointer or queue change.
- Only supersede this project's QUEUED/RETRYING TRANSCRIBE jobs with no positive
  reservation. Set them to CANCELED with `SRT_SUPERSEDED`. Keep their IDs, ledger
  links, and history. Never delete completed or running job rows.
- Cancel those queued requests, change the pointer, and insert one new TRANSCRIBE
  job in the same transaction. A failed insert rolls back all three changes.
  The normal request background callback is registered only after success.

The cancellation and `claimNextJob` use competing conditional updates on the same
job rows. If the worker claims first, the upload refuses. If cancellation commits
first, the waiting claim no longer matches and does not run the old job.

The existing one-project behavior remains. The oldest project is selected with a
stable ID tie-break. No automatic sibling rebuild is added. An unbound source can
still accept its pointer without creating a job, as before.

## Cleanup and interruption

After a failure, cleanup checks current references under the source lock before
removing the new object. This includes an uncertain transaction response: a COMMIT
can succeed before its response is lost. Cleanup preserves the committed input.
A database outage leaves the object for a later sweep instead of deleting blindly.

The worker retention interval now scans managed SRT keys. It can recover both a
failed cleanup and a process crash that left no database row for the staged object.

- Keep every referenced input. Check all source SRT, video, audio, and thumbnail
  pointers, including shared pointers.
- Keep objects while the owning source has a RUNNING job, so a reader that captured
  the former pointer can finish or fail its own source-version check.
- Keep fresh objects for 24 hours. A new upload cannot commit a stage older than
  15 minutes. Source locking also protects the final existence check and commit.
- Keep objects with an absent/invalid modification time, and ignore names outside
  the managed UUID key format. Unknown age is not permission to delete.
- Remove old unreferenced keys, including the legacy fixed SRT key, under the source
  lock. A failed removal is retried by a later sweep.

Cleanup warnings have no workspace or project link. Their storage keys remain in
platform operations. Warning severity does not dispatch an email. Event recording
is best effort; the storage prefix remains the recovery index if the database is down.

Current referenced inputs still follow the existing source-retention rules. No
production retention switch or other setting was changed for this repair.

## Local evidence and limits

The integration tests use local Postgres and local storage with synthetic SRT text.
Auth and `after` are mocked. No background callback or paid provider runs in these
upload tests. Seven requirements failed on the old route before the repair.

The tests cover pointer and enqueue failures, running and sibling jobs, reservations,
an edit during staging, competing uploads, both claim orders, uncertain COMMIT,
cleanup waiting for a pointer commit, missing/expired staging, missing object ages,
shared references, and private cleanup failure/recovery. Local storage tests do not
prove a production S3 outage or a production release procedure.

This route does not globally pause workers or prevent another caller from enqueuing
independent work. The conditional transition protects the queued jobs it supersedes.
The TRANSCRIBE worker still checks its captured source before replacing words; a late
conflict can occur after provider work and cannot reverse a provider charge.

TRANSCRIBE now commits the transcript, revision, and ANALYZE queue entry in one
transaction. Provider calls and the runner's terminal-state update remain outside
that transaction. A retry after an uncertain response can repeat provider work.
Existing historical word mappings and human caption verdicts remain unverified.
See [TRANSCRIPT_REPLACEMENT_SAFETY.md](TRANSCRIPT_REPLACEMENT_SAFETY.md).
