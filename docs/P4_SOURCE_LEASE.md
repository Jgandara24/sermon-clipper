# P4 source materialization lease

`withMaterializedSource()` admits one derivative batch through the existing cleanup journal.
It checks workspace ownership and requires a retained source key.
It locks the source row before creating or reading its cleanup gate.
It admits work only through an `ACTIVE` gate.
An unfinished `P4_DERIVATIVE_BUILD` session blocks another batch for that source.
The check includes `ACTIVE` and `UNCERTAIN` sessions.

Admission creates a session and its audit event in one transaction.
The database requires a matching audit event in the same transaction.
The wrapper then checks storage identity and downloads one source file.
It calculates the file checksum and verifies its byte count.
The batch receives that one file, source dimensions, transcript revision, and transfer facts.
The wrapper makes the source file read-only.
Multiple derivative operations can read that same file within the callback.

The callback must await every child process and remote write before returning.
The wrapper removes its temporary directory before completing the session.
It records completion and audit evidence in one transaction.
An acquisition failure before callback work can complete after local cleanup succeeds.
A callback failure leaves an `UNCERTAIN` session because this layer cannot prove remote cleanup.
A temporary-file cleanup failure also leaves uncertainty.
A settlement failure leaves the existing session protected.
The wrapper reports the original failure and any additional settlement failure.

Session age does not prove that its owner stopped.
No timeout transfers ownership or clears an unfinished session.
An interrupted process therefore requires recovery evidence before another batch can start.
The recovery command remains unfinished.
Do not manually mark a session complete without proving that its work stopped.

## Retention integration

The ordinary retention worker now checks cleanup gates and unfinished sessions before deleting source media.
It holds the source row lock and a shared gate lock during its decision and deletion.
Journal transitions and new session admission cannot cross that gate lock.
A protected source produces a visible skip reason.
Normal retention can continue after the session completes and all referencing projects expire.
The existing deletion-enable flag still controls deletion.

The lease service has no production derivative-worker caller yet.
The retention protection is connected to the existing cleanup handler.
The service does not choose encoding settings.
Its callback can call `publishMediaArtifact` to register and verify output objects.
The lease cannot complete while it owns undeleted pending publications.
It records `UNCERTAIN` and returns an error when such publications remain.
Its callback can now run the [local analysis derivative builder](P4_ANALYSIS_DERIVATIVES.md).
It does not prove one acquisition across separate completed batches.
The coordinated derivative batch verifies ready artifacts before reuse.
It still builds local outputs before that verification.

## Local verification

Twenty-four lease tests use real PostgreSQL connections and local files.
They check shared batch acquisition, competing admission, both retention races, workspace ownership, failure states, and immutable audit requirements.
They also verify that age alone cannot release an unfinished session.
The race test confirms that retention holds the gate lock during deletion.
Nine existing retention tests also pass.

These tests retain immutable session history until their disposable database is removed.
They require `P4_LEASE_TEST_DATABASE=1` and a local database named `p4_lease`.
Do not run them against a shared database.
The completed run used a private temporary PostgreSQL cluster with TCP disabled.
No production database, remote storage, or paid provider participated.

Artifact cleanup now uses its own journaled source session.
Source admission refuses every unfinished session, including uncertain cleanup sessions.
See [artifact cleanup](P4_ARTIFACT_CLEANUP.md) for deletion rules and recovery limits.
