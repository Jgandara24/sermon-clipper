# Transcript replacement checks

`Transcript` belongs to `SourceVideo`. Several projects can refer to the same source.
Replacing that transcript changes the positional word IDs used by all those projects.

## Current checks

- ANALYZE checks durable work on the project it will rebuild.
- TRANSCRIBE checks durable work on every project that uses its source. It checks
  before storage/provider work and again before replacing the transcript.
- The SRT upload route checks the same source scope before receiving the body and
  after the body arrives. A refusal returns `REANALYSIS_BLOCKED` with status 409.
- Durable work includes human edits, approval records, export jobs in any state,
  delivered/in-flight/blocked posts, and review snapshots. Machine initial edits
  do not count. A review's cleared live link does not remove its snapshot check.
- The TRANSCRIBE commit locks the source row. It compares the source timestamp,
  transcript ID, and transcript timestamp with those read before processing.
  A changed input returns terminal `TRANSCRIPT_CHANGED` and preserves project state.
  The lock covers the database commit only, not the storage or provider call.

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

## Limits and further work

These are scoped P1.7 corrections. They do not provide versioned transcript ownership.

- The source lock coordinates transcript replacements and source-row changes. It
  does not coordinate every editor, approval, export, review, or schedule writer.
  A write that begins after the final durable-work assessment needs a shared write
  boundary or transcript-version check. The tests do not claim to close that gap.
- The SRT object's write, source pointer update, and queue changes are still separate
  operations. SRT uploads still use one source key and select one project to analyze.
  Atomic upload replacement and shared-project rebuild policy remain further work.
- Untouched shared projects remain allowed by the existing policy. This does not
  prove that every sibling's machine-generated editor state is rebuilt after a
  source transcript changes. Use a separate upload for the P2 test.
- A late conflict can occur after paid work has completed. It stops persistence;
  it cannot reverse a provider charge. A job that refuses queues no new analysis.
- Existing transcripts, held services, and human review results are not repaired
  by deploying these checks. They require separate review.

Before a broader source-reuse feature, define a source-level write boundary and
versioned word ownership. Keep these open engineering tasks separate from the
manual caption and exact-MP4 checks.
