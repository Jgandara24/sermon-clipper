# Early original deletion

Plan item 23 permits deleting the large original before last scheduled date + 14 days.
Deletion requires passed range-derivative coverage proof for every retained candidate.
The 14-day retention date remains the fallback in every other case.

## Activation

`P4_EARLY_ORIGINAL_DELETION_ENABLED` controls early deletion and defaults to false.
It also requires `P4_RANGE_EXPORTS_ENABLED=true` and `P4_SERMON_PREPARATION_ENABLED=true`.
Without those settings, exports and previews still read the original.
`SOURCE_RETENTION_DELETION_ENABLED=true` is still required for actual deletion.
Without it, a passed proof is report-only.
No production setting changed during implementation.

## What the deletion removes

Early deletion removes only `SourceVideo.storageKey` and its storage object.
Extracted audio, thumbnails, SRT overrides, derived artifacts, and all records remain.
The ordinary reaper still purges the remaining media after the fallback date.

## Retained candidates

The proof reads candidates from the database, not from a batch manifest.
A retained candidate is any clip of a project that shares the source, unless its status is `SUPERSEDED`.
Hidden clips count, because an operator can show them again.
A superseded clip still counts while a slot that is neither `SUCCEEDED` nor `MISSED` binds it.
Each candidate's interval comes from its latest saved edit.

## Proof rules

`assessEarlyOriginalDeletion()` refuses deletion unless every rule passes:

- The original key exists, and every sharing project has a retention date.
- The latest retention date has not passed. After that date, the ordinary reaper owns deletion.
- No sharing project has an unfinished processing job other than the running cleanup job.
- No clip of those projects has a queued, waiting, retrying, or running export.
- No full-source fallback for the source has an open exception.
- At least one retained candidate exists.
- Each candidate is inside one `CANDIDATE_RANGE` artifact that is `READY`, `VERIFIED`, `ACCEPTED`, and `RENDER_SOURCE`.
- That artifact's latest review is `ACCEPTED` and matches its artifact, source, and mapping checksums.
- That artifact expires no earlier than the fallback date.
- All covering ranges share one source checksum.
- A `READY` `SOURCE_PROXY` with that source checksum exists and expires no earlier than the fallback date.

Each refusal returns one reason code.
The cleanup job records refusals as `early_original_deletion_refused` events.

## Concurrency

`attemptEarlyOriginalDeletion()` runs in one transaction.
It takes the source retention lock first, then a share lock on the cleanup gate.
It refuses when the gate is not active or a source session is unfinished.
It then locks the sharing projects, their clips, and the source's range and proxy artifacts with `FOR UPDATE`.
Range and fallback producers take the same source lock.
New clips, edits, export jobs, and reviews need foreign-key locks that conflict with these row locks.
They therefore wait until the deletion commits, or the deletion waits for them.
The proof reads every fact after it holds these locks.

The transaction removes the object, clears the key, and writes the `early_original_deleted` event.
That event contains the complete proof and its SHA-256.
A failed transaction keeps the key.
A repeated attempt treats an already-absent object as removed.

## Scan, cleanup, and editor

When the switch is on, the cleanup scan also finds active projects with a stored original and a ready range.
The project CLEANUP job runs the proof for an active project.
Expired projects keep the existing reaper path.

With preparation on, the clip editor now plays the registered proxy instead of the original.
Crop and caption positions are frame fractions, so the proxy's smaller size does not change them.
This change is type-checked but has no browser test.

## Verification

Three new database cases passed in a disposable PostgreSQL cluster.
The main case covered every switch, both date rules, an uncovered reserve, a bound superseded clip, and an out-of-range edit.
It also covered an unfinished export, an open fallback, unfinished processing, a later rejected review, report-only mode, and deletion through the CLEANUP job.
After deletion, range exports still worked, and a new fallback request was refused.
All derived artifacts remained in storage.
The two race cases held a concurrent export producer or clip edit open.
Each deletion waited, then refused with the original intact.

All 106 lease cases and 194 cases across eight lease and retention database files passed.
Two scan unit tests, lint, type checking, the worker build, and 2,793 unit tests passed.
The temporary database stopped before its directory was removed.

## Remaining limits

The source checksum check compares registered artifacts; it does not rehash the stored original.
An edit saved after deletion can move outside its range; that export then fails with `EXPORT_RANGE_UNAVAILABLE`.
Measured candidate handles must keep that rare.
No production activation, real R2 deletion, or representative visual approval has run.
