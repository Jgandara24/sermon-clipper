# Direct multipart upload

P4 milestone 19 remains incomplete.
The S3 provider now exposes a multipart storage adapter.
The upload routes and browser still use the existing relay.
No production storage request ran during this work.

## Storage adapter

`src/lib/storage/multipart.ts` defines the upload plan and optional storage capability.
`src/lib/storage/s3-multipart.ts` implements create, part signing, inspection, completion, and abort.
The adapter sends control requests only.
A future browser caller will send file bytes directly to signed storage URLs.

The server must supply a durable, authorized session with an exclusive object key.
The plan includes session ID, object key, total bytes, and explicit part size.
The adapter does not select a production part size.
Local storage does not expose this capability.
The shared cache forwards the capability and invalidates entries after completion attempts.

The plan permits at most 10,000 parts and 5 TiB in total.
All parts use the planned size, except the final remainder.
Part size ranges from 5 MiB through 5 GiB minus 5 MiB.
This upper bound follows the stricter R2 request limit.
See [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) and [upload methods](https://developers.cloudflare.com/r2/objects/upload-objects/).

Signed URLs include `content-length`, part number, upload ID, and a bounded expiry.
The browser must supply the exact planned bytes through a Blob or File body.
The browser must not set the forbidden `Content-Length` request header itself.
The signer does not calculate a checksum from an absent body.
Multipart ETags are storage identifiers, not source SHA-256 checksums.

Completion lists the stored parts through authenticated storage requests.
It verifies part numbers, sizes, order, pagination, and complete coverage.
It submits storage-reported ETags instead of trusting browser reports.
It then checks the completed object's ETag, size, and session metadata.
Changed parts between inspection and completion cause a provider failure through their ETags.
Uncertain completion leaves recovery to the durable session owner.

The multipart client disables automatic SDK retries.
A lost create response must not create another upload without reconciliation.
Abort targets only the exact unfinished upload.
Abort does not delete an object that already completed.

## Remaining integration

Persist upload ownership, storage identity, immutable plan, provider upload ID, state, expiry, and completion evidence.
Create the durable record before the remote initiation request.
Reconcile uncertain initiation by the exclusive key before allowing another initiation.
Serialize completion, cancellation, and expiry cleanup through durable claims.
Preserve remote completion evidence when source registration fails.
Make repeated completion return the same source.

Authorize each control route through the workspace and upload record.
Keep existing plan limits and upload rate limits.
Do not let relay completion consume an unfinished multipart session.
Keep relay behavior for local storage and explicit S3 fallback only.

Add bounded browser part uploads, progress, cancellation, and explicit retry handling.
Configure bucket CORS for the application origin and direct PUT requests.
Verify CORS and signed byte limits against an isolated R2 fixture.
Record transfer and request costs without attributing browser bytes to server egress.
Abort expired unfinished uploads and verify the bucket lifecycle backstop.
The object-prefix cleanup sweep does not remove unfinished multipart parts.

## Verification

Local tests cover layout limits, exact signing, paginated inspection, completion checks, and uncertain outcomes.
A local HTTP server verifies that the SDK sends one create request after a transient failure.
Cache tests verify optional capability forwarding and invalidation after successful or uncertain completion.
These tests do not prove R2 behavior, browser CORS, durable recovery, or complete intake.

## Durable sessions — 2026-10-16

Migration `20261016150000_multipart_uploads` adds durable upload records.
The record stores workspace ownership, storage identity, exclusive object key, filename, byte plan, expiry, and provider upload ID.
Database rules preserve this identity and restrict state changes.
Records prevent workspace deletion while upload audit retention remains unresolved.
No upload route uses this service yet.

`src/lib/uploads/multipart-session.ts` registers the plan before remote initiation.
Registration checks the workspace upload limit and reuses identical requests.
Conflicting requests cannot change the registered plan.
Conditional database updates select one owner for each provider operation.
The database transaction does not stay open during provider requests.

Initiation records the provider ID before it permits signed part URLs.
Part URLs expire no later than the upload record.
Expired sessions cannot sign parts or complete uploads.
Cancellation can still abort an expired session.

Completion checks part coverage before claiming the operation.
An incomplete upload stays writable.
The storage adapter checks parts again during remote completion.
The service then creates one source and records completion in one database transaction.
Repeated completion returns that same source.
Deleted sources do not return through upload retries.

Cancellation refuses active completion and uncertain operations.
Uncertain provider results retain their operation stage.
Claimed states also prevent retries when uncertainty recording fails.
Elapsed time alone never resets a claim.
Automatic reconciliation remains unfinished.

The final object key uses `src/<workspaceId>/multipart-<sessionId>`.
The service avoids copying large completed objects from temporary storage.
The durable record owns any completed object before source registration succeeds.
Cleanup must consult these records before deleting that object.
The service does not yet implement cleanup or remote reconciliation.

Database tests use injected storage operations and a disposable PostgreSQL cluster.
They cover concurrent registration, initiation, completion, cancellation, identity guards, and failed source registration.
They also cover workspace isolation, storage changes, plan limits, expiry, and repeated completion.
No real provider request or production migration ran.

## HTTP and browser integration — 2026-10-16

The upload page now supports direct multipart uploads through the durable session service.
Creation requires `P4_DIRECT_MULTIPART_UPLOAD_ENABLED=true` and explicit part-size and lifetime settings.
The example configuration keeps this feature disabled.
Recovery, cleanup, accounting, and real R2 acceptance must pass before production activation.

The presign route keeps the existing plan limit, rate limit, and required rate-counter event.
For enabled S3 uploads, it registers a session and returns its ID and byte plan.
It does not initiate remote storage before the browser receives that session ID.
Invalid configuration and registration failures do not silently use the relay.
Local storage keeps the relay.
An explicit `transport: "relay"` request also selects the relay.

The multipart control route supports start, sign, complete, and abort.
Each action requires `IMPORT_MEDIA` access and uses the authenticated workspace ID.
Strict request schemas reject caller-supplied ownership, byte plans, and completion lists.
Signed URL responses use `Cache-Control: no-store`.
Provider error details never enter response messages.
Existing sessions remain accessible after the creation feature switch turns off.

The relay PUT and completion routes reject multipart session IDs.
The browser sends one Blob part at a time to the signed storage URL.
Storage PUT responses do not require a JSON body.
The browser sends no application credentials with those requests.
The component preserves the attempt while the same selected file remains in place.
A completion retry uses the same upload ID without resending uploaded bytes.

The browser does not yet persist attempts across page reloads.
A retry after a part failure currently resends parts from the start of that session.
The control route supports cancellation, but the page still needs its cancellation control.
The page also needs byte-progress reporting and real browser CORS acceptance.
These limits do not justify production activation.

All 39 route and browser-flow tests passed with injected fetch and service operations.
The tests cover permission checks, strict inputs, explicit relay behavior, empty storage responses, and lost completion responses.
They do not establish actual browser-to-R2 transfer behavior.

## Expired-session cleanup — 2026-10-16

The worker retention scan now calls `purgeExpiredMultipartUploads`.
The sweep selects expired `NEW` and `UPLOADING` records for the current storage identity.
Each batch processes at most 100 records by default.
It uses the same cancellation claim as the upload control route.
Concurrent workers cannot both send cancellation for one claimed upload.
One failed cancellation does not prevent cleanup of other selected records.

The sweep preserves completed uploads, unexpired uploads, and records for other storage identities.
It also preserves active claims and uncertain operations.
Worker events report their review count without exposing signed URLs or provider error details.
Turning off upload creation does not turn off cleanup of existing sessions.
Local storage skips this multipart sweep.

The S3 adapter now inspects remaining parts after cancellation.
It also checks that no completed object exists at the exclusive upload key.
Remaining parts, a completed object, or a failed check leave cancellation uncertain.
Missing upload responses alone do not prove that no completed object exists.
The adapter never deletes a completed object during cancellation.

In-flight parts can require repeated cancellation checks.
See [S3 cancellation semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html).
These checks record current provider evidence.
They do not replace an accepted bucket lifecycle policy or reconciliation of uncertain requests.
Recovery after worker termination and uncertain cancellation remains unfinished.

All 15 durable-session database cases and 45 multipart storage tests passed.
The database cases include cleanup bounds, storage isolation, active claims, uncertain outcomes, and concurrent workers.
The tests used a disposable PostgreSQL cluster and injected storage operations.
No production cleanup or provider cancellation ran.

## Confirmed completion recovery — 2026-10-16

A repeated completion request now inspects an uncertain completion before any new provider mutation.
The S3 adapter reads the exact object key and checks its session metadata, size, and ETag.
An absent object remains uncertain.
Access errors and mismatched metadata also preserve uncertainty.
The adapter does not repeat completion, abort, or upload bytes during recovery.

Recovery accepts only `UNCERTAIN` records whose operation stage is `COMPLETING`.
It does not reset an active `COMPLETING` claim based on its age.
A confirmed completed object remains recoverable after the upload session expires.
The transaction locks the upload record and creates one source.
Concurrent recovery returns the same source.
A failed database transaction leaves the upload uncertain and creates no source.

Migration `20261016160000_multipart_completion_recovery` adds retained recovery evidence.
The evidence includes session ID, storage identity, key, byte count, ETag, and observation time.
Database rules bind this evidence to the upload record and prevent later changes.
The evidence records a storage identity check, not a source SHA-256 or media-quality proof.
Normal source processing still owns those later checks.

Completion retries reach recovery through the existing authenticated control route.
Recovery does not recreate a source that another operation deleted.
Worker termination during a claim still requires separate reconciliation.
Uncertain initiation, uncertain cancellation, and active claims remain unresolved by this change.
A missing remote object does not authorize a new paid or mutating operation.

All 22 database cases and 108 focused storage, route, cache, and browser tests passed.
Tests cover concurrent recovery, expired sessions, changed evidence, active claims, and database rollback.
No production migration, remote upload, or remote recovery ran.

## Lost initiation response recovery — 2026-10-16

A repeated start request can now recover an uncertain initiation.
The adapter first checks that no completed object exists at the session key.
It then lists unfinished uploads under that key and requires exactly one exact-key match.
Similar prefixes do not count as matches.
An empty, ambiguous, or truncated result does not authorize a new initiation.

The application owns an exclusive UUID object key for each immutable upload record.
Recovery uses that key ownership to identify the unfinished provider upload.
The provider listing does not expose unfinished object metadata.
Completion still checks the completed object's session metadata and byte count.
See [S3 upload listing](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html).

Migration `20261016170000_multipart_initiation_recovery` retains initiation recovery evidence.
The transaction locks the upload record and records the one recovered provider ID.
Concurrent callers reuse that ID.
The database preserves the evidence through later completion or cancellation.
No second provider initiation request runs.

Recovery accepts only uncertain initiation records.
It does not reset an active `STARTING` claim based on elapsed time.
Expired recovered uploads cannot sign new parts.
Their recorded provider IDs allow the normal expiry sweep to cancel them.
The recovery function does not extend the original expiry.

All 28 database cases and 114 focused storage, cache, route, and browser tests passed.
Tests include concurrent recovery, ambiguous evidence, expired sessions, and retained evidence after completion.
Uncertain cancellation and worker termination during active claims still require reconciliation.
No production migration or provider recovery ran.

## Confirmed cancellation recovery — 2026-10-16

Repeated cancellation now checks an uncertain cancellation through provider reads.
Recovery requires `NoSuchUpload` for the exact provider upload ID.
It also requires an absent completed object at the exclusive key.
An empty but live upload does not prove cancellation.
A completed object or failed storage check leaves the record uncertain.

Recovery accepts only `UNCERTAIN` records with operation stage `ABORTING`.
It preserves active claims and never resets them based on elapsed time.
The transaction locks the upload record and records cancellation once.
Concurrent callers reuse the final aborted state.
No new provider cancellation or object deletion runs during recovery.

Migration `20261016180000_multipart_cancellation_recovery` adds retained cancellation recovery evidence.
The evidence binds the session, storage identity, object key, and provider upload ID.
It records the observed absence of both the upload and completed object.
Database rules preserve the evidence after recovery.
The existing authenticated abort route reaches this recovery path on repeated requests.

All 33 database cases and 119 focused tests passed.
The tests cover concurrent recovery, retained evidence, active claims, access failures, and incomplete absence evidence.
No production migration or provider cancellation ran.

Recovery still does not repeat a cancellation when unfinished parts remain.
The worker still preserves claims left active by process termination.
Bucket lifecycle acceptance and real R2 behavior remain unverified.
These limits keep direct multipart production activation incomplete.

## Observed recovery for interrupted claims — 2026-10-16

Positive provider evidence can now confirm `STARTING`, `COMPLETING`, and `ABORTING` claims directly.
This extends recovery to process termination before local confirmation.
It does not reset a claim or infer success from elapsed time.
Missing or uncertain provider evidence leaves the claim unchanged.
No second create, complete, or abort request runs during recovery.

The original request can still receive its provider response after recovery finishes.
Its final database write now checks the current state.
It reuses matching confirmation instead of overwriting recovery evidence.
Completion locks the record before creating a source.
A late completion response therefore cannot create another source.
A conflicting provider ID or completed ETag fails instead of replacing confirmed evidence.

Migration `20261016190000_multipart_observed_claim_recovery` permits evidence-backed confirmation of active claims.
Recovery evidence remains immutable and bound to the same upload identity.
The earlier rule against age-based claim resets still applies.

The worker retention scan now runs a bounded recovery scan before expiry cleanup.
Each scan inspects up to 100 pending records for the current storage identity.
A saved cursor advances past unresolved records so later records receive checks.
The cursor wraps after the scan reaches the end.
The scan reports recovered, pending, and failed checks without provider response details.
The expiry sweep can then cancel recovered uploads whose original expiry passed.

All 37 database cases passed.
Three cases delayed the original provider response while another client confirmed the same outcome.
They covered initiation, completion, and cancellation without duplicate provider mutations.
Another case verified cursor progress past an unresolved claim and recovery after simulated process termination.
These tests use injected providers and do not prove real R2 response ordering.

Unconfirmed provider outcomes still require evidence or further reconciliation.
Recovery does not repeat cancellation when unfinished remote parts remain.
Real R2 acceptance, lifecycle policy verification, and complete request accounting remain unfinished.

## Browser progress and cancellation — 2026-10-16

The upload page now shows progress for confirmed multipart bytes.
The percentage advances after each successful storage response.
It does not estimate bytes from elapsed time.

The page also provides a cancellation control during upload and after an upload error.
Cancellation stops local fetch requests and waits for the local upload promise to settle.
It then calls the authenticated abort route for the same session.
The page clears the attempt only after the server confirms `ABORTED`.
A failed cancellation keeps the attempt and shows the returned error.
Confirmed completed uploads cannot use this cancellation control.

All 45 route and browser-flow unit tests passed.
An isolated Chromium test verified 37% progress and cancellation during a delayed part-signing response.
The test observed one abort action and no completion action.
It used real application rendering and authentication with intercepted upload responses.
It did not send bytes to R2 or prove real bucket CORS behavior.

Part retries still resend from the start of the same session.
Attempts do not yet survive page reloads.
Real R2 acceptance, request accounting, and unresolved remote cancellation remain unfinished.

## Reuse stored parts during retries — 2026-10-16

Upload retries now inspect stored parts before sending file bytes.
The authenticated `list` action checks workspace ownership, session state, and expiry.
The storage adapter validates the remote part numbers and planned sizes.
The response includes part numbers and byte counts without provider ETags.
It uses `Cache-Control: no-store`.

The browser verifies the returned part list against its registered byte plan.
It rejects duplicate numbers, unknown numbers, and incorrect sizes.
It sends only missing parts from the same selected File.
Progress includes bytes already confirmed in storage.
Completion still performs its own storage inspection.

This handles a part that reached storage before its response was lost.
A retry reuses that part instead of sending it again.
The component still clears the attempt when the user selects another file.
Resume across page reloads still requires file identity and durable browser state.

All 53 focused route and browser-flow tests and 38 database cases passed.
The retry test verified one transfer for each part after an injected lost response.
Database tests verified part-list ownership, expiry, state, and removal of provider ETags from responses.
No production storage request ran.

## Multipart control-request measurements — 2026-10-16

The shared storage factory now records each multipart control SDK call as a cost fact.
Measurements cover initiation, completion, cancellation, part listings, upload listings, and object inspection.
Paginated listings record one measurement for each page request.
Each fact includes its upload ID, measurement ID, operation, duration, outcome, and available HTTP status.
Canonical durable-upload keys supply workspace attribution.
Provider messages and signed URLs do not enter these facts.

The shared factory disables automatic SDK retries for this client.
The measurement records an SDK call attempt, not independently verified provider billing.
A failed HTTP response remains a failed request measurement even when recovery expects that response.
Signing a part URL does not record a storage request.

Request prices remain null when their operations have no configured price.
The configuration section below describes explicit price estimates.
Control requests record no file-byte count or child CPU time.
Browser upload bytes do not become server egress facts.
A recording failure never repeats or changes the provider operation.

All 74 selected storage and cost tests passed.
A factory test verified workspace attribution through the actual storage factory.
Adapter tests covered pagination, failures, signing, and measurement failures.
No real storage request ran in these tests.

Browser PUT attempts, repeated or partial transfer bytes, and provider billing remain incomplete.
Process termination before measurement persistence can still leave a telemetry gap.
These measurements do not satisfy the full P4 cost acceptance requirement.

## Configured request-price estimates — 2026-10-16

`STORAGE_MULTIPART_REQUEST_PRICING_JSON` accepts explicit prices in USD per request.
The configuration requires an internal `evidenceId` and a `pricesPerRequestUsd` object.
Supported operations are `CreateMultipartUpload`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListMultipartUploads`, `ListParts`, and `HeadObject`.
Each operation accepts an optional finite, nonnegative number.
An omitted operation remains unpriced; an explicit zero records a zero price.
Monthly free allowances do not establish a zero unit price.

The factory validates configuration before it creates the S3 provider.
Invalid JSON, unknown fields, invalid evidence IDs, and invalid prices raise `MULTIPART_REQUEST_PRICING_INVALID`.
The error does not expose configuration contents.
Each request fact retains the configured evidence ID and price availability.
These estimates do not verify provider billing.
The factory reads configuration when it creates the shared provider.

No production prices or R2 credentials were configured during this work.
R2 acceptance still requires an isolated test environment.
Browser transfer measurements and provider billing verification remain unfinished.

All 17 focused tests passed.
Lint, application type checking, and the worker build passed.
