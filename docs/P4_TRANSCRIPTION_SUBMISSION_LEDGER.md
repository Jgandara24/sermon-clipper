# Durable sermon transcription submissions

`runSermonSubmissionOnce()` records request admission before calling its submission callback.
Admission requires the active source lease owner and a ready, verified, unexpired sermon-audio artifact.
The request identity binds artifact bytes, source bytes, interval, mapping proof, language, model, and request settings.
The settings specify Scribe v2, no keyterms, and `no_verbatim=false`.

The ledger starts each admitted request in `STARTED`.
It stores a successful result and checksum before changing the state to `COMPLETED`.
A matching completed request returns the stored result without calling the provider callback.
The service checks that result's checksum before reuse.
A matching running or uncertain request cannot run again.
An unfinished request also blocks different requests for the same source.

Callback errors change the request to `UNCERTAIN`.
A process crash can leave `STARTED`, which also blocks automatic retry.
If completion commits before its reply disappears, the error path cannot overwrite that completed record.
Recovery requires a separate reviewed procedure; this implementation does not infer failure from elapsed time.

The database rejects request-identity changes and terminal-record changes.
It rejects direct deletion while the owning source exists.
Source ownership controls eventual record deletion.
Artifact cleanup retains audio for `STARTED` and `UNCERTAIN` submissions.
Completed submissions no longer add this audio-retention hold.

Migration `20261016130000_sermon_transcription_submissions` adds the ledger and database guards.
Migrations must precede workers that use its cleanup checks.
Production entry points do not yet invoke this ledger.
`transcribeRegisteredSermonAudio()` now connects the verified consumer and request cost recorder.
`persistSermonSubmission()` now saves completed results with atomic analysis handoff.
Production orchestration and recovery support remain unfinished.
The callback contract remains internal and does not authorize arbitrary provider requests.
