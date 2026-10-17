# Retention for pinned export ranges

Unfinished export jobs now hold their pinned range artifacts beyond ordinary artifact expiry.
The protected states are `QUEUED`, `WAITING`, `RETRYING`, and `RUNNING`.
The artifact expiry value remains unchanged.

Cleanup excludes ranges held by those jobs before creating its deletion plan.
It checks again before deleting each object.
The final check locks linked export jobs, which serializes retry and cancellation changes with deletion.
Completed, failed, canceled, or expired jobs do not hold artifacts indefinitely.
Other project, source-session, and expiry checks still apply.

## Reads for active exports

A range read request can include an explicit export job ID.
Admission requires that job to be running and its pin to match the request exactly.
The checks include workspace, source, saved edit version, artifact, checksums, interval, and review ID.
A later accepted review cannot silently replace the review named by the pin.

Only a validated running export can read its expired pinned range.
Ordinary reads still reject expired artifacts.
The read lease returns the retention hold to the trusted renderer wrapper.
The local renderer accepts that hold only as internal lease evidence.
Public callers must never supply it directly.

The source read session protects the object after admission, including when the export state changes during rendering.
The existing cleanup path releases the object after the session settles and all retention conditions permit deletion.
The worker consumes pinned inputs only when `P4_RANGE_EXPORTS_ENABLED` is true.
The default remains false.

## Verification

Fifty-one database tests and 11 render tests passed.
Tests verified all four protected job states, expired-range reads for a matching running job, and ordinary-read refusal.
They verified cleanup after completion and refusal after the exact review changed.
Lint, type checks, and the worker build passed.

Production worker consumption, atomic enqueue integration, fallback accounting, and interrupted-session recovery remain unfinished.
