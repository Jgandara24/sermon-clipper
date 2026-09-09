# Transcript replacement checks

`Transcript` belongs to `SourceVideo`. Several projects can refer to the same source.
Replacing that transcript changes the segment IDs used by all those projects.
A word ID is the segment UUID followed by its word index.

## Current checks

- ANALYZE checks durable work on the project it will rebuild.
- TRANSCRIBE checks durable work on every project that uses its source. It checks
  before storage/provider work and again before replacing the transcript.
- The SRT upload route checks the same source scope before receiving the body and
  after the body arrives, then under the source lock before committing its staged
  input and queue entry. A refusal returns `REANALYSIS_BLOCKED` with status 409.
- Durable work includes human edits, approval records, export jobs in any state,
  delivered/in-flight/blocked posts, and review snapshots. Machine initial edits
  do not count. A review's cleared live link does not remove its snapshot check.
- The TRANSCRIBE commit locks the project with `FOR NO KEY UPDATE`, then the source.
  It checks that the project still uses the captured source and workspace. It compares
  the source timestamp/revision, transcript ID, and transcript timestamp with the input.
  A changed input returns terminal `TRANSCRIPT_CHANGED` and preserves project state.
  The lock covers the database commit only, not the storage or provider call.
- Source rows have a `transcriptRevision`. A successful TRANSCRIBE commit advances
  it with the transcript, its segments, and a queued ANALYZE job. A failed or refused
  transaction does not. The follow-up key includes the new transcript UUID as well as
  the project and TRANSCRIBE job IDs. A retry cannot reuse a completed analysis for
  older words. Existing job history is preserved.
- Each generated clip keeps the revision used by ANALYZE. ANALYZE locks the project
  and source, then checks the captured transcript ID, timestamp, and revision before
  deleting the old pool. A stale result returns terminal `TRANSCRIPT_CHANGED`.
- Database triggers make the first edit, approval, and export take the same source
  lock. They read the clip revision again after a lock wait. If the durable write
  commits first, the worker sees it and refuses. If replacement commits first, the
  old request refuses. Edit, approval, and export routes return status 409 with
  `CLIP_TRANSCRIPT_CHANGED`. No approval notification is sent on that refusal.
- Durable post writes and review inserts also take the source lock. A detached
  review uses its project snapshot. Its existing history remains append-only.
  A review for a removed historical clip can still be recorded; it carries no
  live word references. Posts without a clip use their project link.
- Existing clips cannot be assigned a newer revision. A worker must rebuild the
  clip from the current transcript. Database guards refuse new clips with an old
  revision, including revision 0 from a worker that omits the field.

The checks do not grant source-reuse permission or select a different provider.
They do not clear a transcription hold. The P2 sandbox slot command still requires
a separate source record for its test service.

## Local regression evidence

The regression tests use real local database rows and synthetic SRT text. They cover
saved work on a sibling service, work saved while the input is being read, an edit
saved while an SRT body is arriving, untouched shared projects, and unrelated work
on another source. They also run two transcript jobs against the same input version:
one commits and queues ANALYZE; the other refuses without overwriting the result.

The original failures were a missed sibling edit, an SRT route that reached body
validation instead of returning 409, and a raw unique-key error for competing jobs.
No production job or paid provider call was used to reproduce these failures.

The next regression suite uses separate database connections and actual lock waits.
Seven tests first failed: late edit/approval/export requests returned 200; uncommitted
first writes did not protect the transcript; and analysis saved results from old words.
Those tests pass with the shared lock and revision checks. Further cases cover
analysis deleting an old clip, detached reviews, blocked posts, current requests after
a rebuild, an untouched stale sibling, and an old worker attempting a revision-0 insert.
The post test also checks that its project foreign-key check can finish while ANALYZE
waits on the source. ANALYZE uses `FOR NO KEY UPDATE` on the project for that reason.
Prior-service fill and missed-slot rescheduling acquire project/source locks before
their retention writes and read again after waiting.

The TRANSCRIBE handoff suite first reproduced five failures: a retry reused completed
analysis; enqueue failure left the initial words committed; replacement reused the
old queue entry without attempting a new insert; a changed project source was missed;
and a project-first writer did not stop a competing transcript commit. All seven
handoff tests pass after the repair. They run actual TRANSCRIBE and local heuristic
ANALYZE handlers, test the rebuilt clip revision, and preserve completed job history
and per-attempt cost facts. Failure injection covers both initial and replacement
transactions. Two lock tests check project-first ordering and a source-first durable
post's compatible project foreign-key check. Saved human work still refuses a retry
before storage is read.

## Migration and deployment

Migration `20260909150000_source_write_boundary` adds the counters and database guards.
Existing sources and clips start at revision 0. This is a rollout baseline, not a
backfill of historical transcript identity or proof of caption accuracy. Saved editor
documents and their pinned versions are unchanged.

The migration and matching API/worker code must be deployed together after active
workers are drained. Do not leave an old TRANSCRIBE worker running: old code does not
advance the source revision. An old ANALYZE worker also cannot create clips after the
source advances. A code-only rollback to an old worker is unsafe; retain the compatible
write checks or plan the rollback with workers stopped. Test this release procedure in
an isolated environment before any production deployment. No production migration,
worker restart, or deployment was performed for these local tests.

## Limits and further work

These are P1.7 corrections. They retain one transcript per source, not a history of
transcript versions.

- Revision advancement is part of the TRANSCRIBE worker. Direct database transcript
  changes, disabled triggers, and old workers are outside this guarantee. Existing
  historical mappings are not verified or repaired by the migration.
- Transactions that compete for other rows can still receive a database deadlock
  or serialization refusal. The transaction must roll back; do not bypass its guard
  to retry. The controlled 409 tests cover current edit, approval, and export routes
  under their normal READ COMMITTED transactions.
- SRT bytes are staged under a new immutable key. The pointer and queue changes now
  commit together, and an age-based sweep recovers unreferenced objects. The route
  still selects one project to analyze. See [SRT_UPLOAD_SAFETY.md](SRT_UPLOAD_SAFETY.md)
  for failure recovery, job-claim scope, and cleanup limits.
- Untouched shared projects remain allowed by the existing policy. This does not
  prove that every sibling's machine-generated editor state is rebuilt after a
  source transcript changes. A sibling's stale clip is refused until it is rebuilt.
  There is no automatic shared-project rebuild in this change. Use a separate upload
  for the P2 test.
- A late conflict can occur after paid work has completed. It stops persistence;
  it cannot reverse a provider charge. A job that refuses queues no new analysis.
- The atomic handoff covers transcript persistence and insertion of its follow-up,
  not the provider call or the runner's later terminal-state update. If the worker
  retries after an uncertain commit or lost success response, it can call the provider
  again and replace the transcript again. Each committed replacement has a new queued
  follow-up; actual per-attempt cost facts remain separate from that transaction.
  This is not an exactly-once provider-result checkpoint. Earlier queued analysis
  jobs remain in history and can still run; ANALYZE reads the current words at start
  and refuses if those words change while it works. The job key is a traceable enqueue
  identity, not a promise to analyze a retained historical transcript.
- Existing transcripts, held services, and human review results are not repaired
  by deploying these checks. They require separate review.

A policy for rebuilding untouched shared projects remains separate work. Manual
caption and exact-MP4 checks remain pending. TRANSCRIBE does not settle a hold;
the existing ANALYZE hold checks still apply.
