# Registered artifact cleanup

`cleanupExpiredMediaArtifacts()` deletes expired registered artifacts while preserving their records.
It requires a workspace, source ID, owner ID, and explicit batch limit.
It accepts at most 200 artifacts per call.
No production worker calls this service yet.
The existing retention switch and cleanup handler remain unchanged.

## Eligibility and ownership

The service requires an active source gate and no unfinished source session.
Every project that references the source must have expired.
Each selected artifact must be `READY`, undeleted, and past its own expiry date.
A null expiry prevents deletion.
The key must match the source's immutable artifact namespace and identity hash.
The service does not delete original recordings or unrelated storage keys.

Admission creates a `P4_ARTIFACT_CLEANUP` source session.
Its immutable audit event records every possible deletion before storage work starts.
New source batches now refuse every unfinished session, including cleanup sessions.
Artifact registration and publication also refuse unfinished cleanup sessions.
The service holds source, gate, session, and artifact locks during each deletion decision and storage operation.
It checks project and artifact expiry again under those locks.

## Storage and deletion proof

Publication now records a storage-location identity.
Local identity includes the resolved storage root.
S3 identity includes the endpoint, region, and bucket.
The identity contains no credentials.
The cache forwards the underlying identity.

Cleanup refuses a different storage location before creating its session.
Historical publication evidence without that identity cannot authorize this cleanup path.
An empty wrong bucket or directory therefore cannot prove deletion.
For an existing object, cleanup compares its current identity and size with publication evidence.
Changed bytes cause an error.
The service removes the object and checks absence before recording deletion evidence.
Local storage now propagates access and path errors instead of treating every error as absence.

The artifact record retains its key, checksum, byte count, publication proof, and deletion proof.
A repeated successful cleanup finds no eligible undeleted record.

## Failure and remaining work

Storage errors, changed objects, and unconfirmed absence leave the cleanup session `UNCERTAIN`.
New work cannot reclaim that session by age.
A deletion response can fail after storage removed the object.
That case retains the original record and audit intent for recovery.
The service does not retry that uncertain deletion automatically.
Recovery remains unfinished.

The service relies on all artifact writers following the source-session and immutable-key protocol.
Its storage removal does not implement an atomic comparison against external writers that bypass this protocol.
The inspected [R2 API reference](https://developers.cloudflare.com/r2/api/s3/api/) does not establish conditional deletion for this implementation.
Live storage verification and production integration remain necessary.

## Verification

Forty-two lease, registry, and retention tests passed against disposable PostgreSQL and local storage.
Six cleanup tests cover successful deletion, active projects, extended retention, wrong storage locations, changed objects, and uncertain outcomes.
They also verify admission refusal during source work and the requirement to confirm absence.
Thirty-five storage tests passed, including storage identity and error handling.
No production objects were deleted.
