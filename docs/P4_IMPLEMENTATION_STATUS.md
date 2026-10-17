# P4 implementation status

Inspection date: 2026-10-16.
Objective: complete P4 in [the implementation plan](AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md#13-p4--derivative-first-sermon-understanding-and-media-region-index).
P4 remains incomplete.
The request covers all 25 milestone items and all 17 acceptance checks.

## Current evidence

The local schema now includes `MediaRegion` and `DerivedMediaArtifact`.
Wave 3 also adds nullable transcript capabilities and provenance.
The migration passed disposable local database checks.
Production deployment remains unverified.
The source has an existing transcript revision guard and a cleanup journal.
New storage records must preserve both protections.
Project reanalysis must not delete source facts.
Source deletion must not discard the only record of an undeleted storage object.

The repository contains dated P0 cost measurements.
`evaluation/proxy-cost-baseline-2026-08-13.json` records Cloudflare R2 and zero contracted storage egress cost.
That report does not establish current production configuration.
It also records a failed YouTube cost gate.
No new production query ran during this inspection.

`OUTPUTS/P4_IMPLEMENTATION_DRAFT.md` contains 14 provisional implementation batches.
It maps the measured P0 costs and synthetic benchmarks to their limits.
`docs/P2_STAGE5_READINESS_CHECKLIST.md` records missing real selection and exact-render evidence.
The current inspection found no representative human region-label dataset under `evaluation/`.
The assistant requested the dataset location from Jake.
An unlocated dataset is not proof that no dataset exists elsewhere.

The synthetic benchmarks prove limited fixture behavior.
They do not prove sermon boundaries, model recall, visual quality, or production resource budgets.
No bitrate, detector threshold, cache capacity, model, or encoding format follows from those fixtures alone.

## Contract implementation

These modules have no production caller:

- `src/lib/media-artifacts/types.ts` defines artifact identity, registration facts, and source-time conversion.
- `src/lib/media-regions/types.ts` defines overlapping source facts and versioned detector identity.
- `src/lib/transcription/provenance.ts` defines explicit transcript capabilities and submitted-audio provenance.

Artifact identity includes source bytes, source ID, kind, derivation version, configuration hash, and source interval.
Region identity also includes detector-input identity and slide subtype.
Transcript changes therefore can produce distinct region facts without deleting earlier facts.
Neither identity depends on a project ID.

Mapping conversion accepts an explicit artifact clock origin and a source interval.
It rejects timestamps outside that interval.
It rejects unsafe integer arithmetic.
The conversion does not prove that media contains the declared source interval.
Registration keeps declared mapping separate from verified mapping.
A verified mapping requires an evidence hash, but the hash alone does not validate its evidence.

Transcript provenance separates word confidence from subword-token confidence.
Each capability records native, derived, unavailable, or user-supplied status.
Derived fields require algorithm and input identity.
Submitted duration and source offset must agree with the source interval.
These contracts do not yet persist provider responses or alter transcription.

## Wave 3 local implementation

`20261016052924_agentic_editor_wave_3` adds the two source-owned tables and transcript metadata columns.
The migration preserves generated transcript search fields, their index, and unrelated workspace defaults.
Historical transcript metadata stays null.
Database checks enforce intervals, checksums, byte counts, allowed kinds, slide subtypes, and mapping evidence presence.
The database rejects changes to region facts and artifact identity.

Artifact records restrict source deletion.
The database rejects artifact-record deletion without recorded storage-deletion evidence.
This guard does not prove that storage deletion occurred.
The future cleanup adapter must produce that proof.
The existing six-file cleanup journal does not yet process these artifact records.

Artifact and region registration services check workspace ownership and lock the source row.
They also check an existing cleanup gate under a shared lock.
Concurrent identical registrations return one record.
Conflicting output facts fail instead of replacing an existing record.
Registration retries preserve later retention, mapping, and review decisions.
Deleted artifact identities cannot return through registration while their records remain.
No production worker calls these services yet.

Run the migration proof with:

```bash
npx tsx scripts/verify-wave3-migration.ts OUTPUTS/P4_WAVE3_MIGRATION_NEW.json
```

The command creates its own PostgreSQL cluster and disables TCP listening.
It uses a private Unix socket and disposable databases.
It tests clean installation, populated upgrade, historical data, generated search, source revisions, defaults, and repeated deployment.
It stops its server and removes its temporary directory afterward.
An uncertain server state preserves the directory for inspection.
An existing output report causes an error instead of replacement.
The command needs local PostgreSQL tools on `PATH`.
It does not connect to production or run application workers.

## Artifact publication prerequisite

Storage providers now expose optional `uploadFileIfAbsent`.
The local provider copies bytes into a private directory before atomic publication.
Concurrent writers cannot replace the first complete object.
The S3 provider sends `PutObject` with `IfNoneMatch: "*"`.
It streams the file and supplies its size.
It does not retry with an unconditional upload or switch to multipart upload.
Provider size errors remain errors.
The cache preserves the optional capability and invalidates its entry after each upload attempt.

Cloudflare documents atomic conditional `PutObject` operations in its [R2 API reference](https://developers.cloudflare.com/r2/api/s3/api/).
That documentation does not establish conditional multipart completion for this implementation.
The new method therefore uses one `PutObject` operation.
Existing upload methods retain their current behavior.
No production artifact publisher calls this method yet.

Nine publication tests passed with 24 cache and conditional-download tests.
Tests cover concurrent local writers, failed copies, conflicting objects, optional capability, and S3 request construction.
S3 tests use a mock client.
They do not prove live R2 behavior.
ESLint, application type checking, and the worker build passed.

`20261016063000_artifact_publication` adds `PENDING` and `READY` publication states.
Historical registrations remain `PENDING` because they lack publication proof.
A composite foreign key binds each publication session to the artifact source.
Database rules preserve completed publication evidence.

`publishMediaArtifact` checks the workspace, active session owner, purpose, and gate generation.
It records `PENDING` before uploading bytes.
It downloads the stored object with its inspected identity and verifies its checksum and size.
It checks session ownership again before recording `READY`.
Publication readiness does not prove source-time mapping or visual quality.
A repeated successful call verifies the existing object before returning its record without another upload.
Another active session can reuse a ready artifact after identity and checksum verification.
Reuse preserves the original publication owner and evidence.
Pending artifacts cannot transfer between sessions.
Changed ready objects cause an error without replacement.

Failures preserve pending records and their cleanup ownership.
Lease settlement records `UNCERTAIN` when pending publications remain, even when the callback catches an upload error.
Twenty-four lease tests and nine registry tests passed against a disposable PostgreSQL database.
They include publication ordering, stored corruption, owner rejection, database constraints, and caught-error settlement.
The current migrations also passed clean-install, populated-upgrade, and repeated-deployment checks.
The migration report does not test publication recovery or production deployment.

`runAnalysisDerivativeBatch` now connects source acquisition, coordinated encoding, publication, and lease settlement.
The batch persists observed media facts, explicit settings, source clock, and encoding wall time.
It uses separate analysis and preview retention dates from its caller.
It returns transfer facts for caller cost accounting.
The batch still rebuilds local outputs before checking published artifacts for reuse.
It has no production worker caller.
Interrupted-publication recovery and worker integration remain incomplete.
A process crash can leave a local staging directory.
The future recovery service must handle that directory with its owning publication record.
The publisher reserves registry ownership before remote publication.
The separate registration function still describes already-created bytes.

## Local video evidence

`extractVideoEvidence` now produces scene, black-frame, freeze, and motion facts from a local proxy.
The caller supplies thresholds and resource limits.
The detector checks input bytes and maps observed timestamps into source time.
It records detector, configuration, and toolchain identity.
It does not classify service content.
Seven generated-media tests passed.
See [the video evidence notes](P4_VIDEO_EVIDENCE.md) for scope and limits.
`extractAudioEvidence` now measures silence and waveform levels from the mono 16 kHz FLAC.
Seven generated-audio tests verify source offsets, waveform values, sample counts, interval bounds, and format rejection.
See [the audio evidence notes](P4_AUDIO_EVIDENCE.md) for precision and resource limits.
`extractFrameHashes` now measures sparse grayscale difference hashes, brightness, and thumbnail checksums.
`groupFrameHashes` selects representatives from consecutive samples with caller-supplied limits.
Ten tests verify timestamps, collisions, sampling, limits, and grouping.
See [the frame-hash notes](P4_FRAME_HASHES.md) for algorithm and inference limits.
The optional evidence stage now stores all seven fact categories in a registered `LOCAL_EVIDENCE` JSON artifact.
The batch uses its existing source lease and local derivatives.
Twenty-seven database tests verify the combined path, deterministic reuse, and document-limit failure.
See [the registered-evidence notes](P4_LOCAL_EVIDENCE.md) for publication and retention behavior.
A [local artifact cleanup service](P4_ARTIFACT_CLEANUP.md) now deletes expired ready artifacts under journaled source ownership.
It records deletion intent before storage work and requires observed absence before recording deletion proof.
Storage-location identity prevents an empty wrong bucket from authorizing deletion.
Forty-two database tests and 35 storage tests passed.
Uncertain cleanup blocks new work until recovery.
The optional [representative image stage](P4_REPRESENTATIVE_FRAMES.md) now publishes lossless WebP images for selected frame groups.
It verifies decoded pixels against exact proxy frames and registers every image for retention.
Six extraction tests and 42 database tests verify the combined path.
Semantic region persistence, inference, recovery, and production integration remain unfinished.

## Local model review

The [model review](P4_LOCAL_MODEL_REVIEW.md) records four candidates across person, face, OCR, and audio roles.
The review checks primary code and weight-license evidence separately.
The [candidate inventory](../evaluation/p4-model-candidates-2026-10-16.json) pins source revisions and records known artifact identities.
Published Git LFS checksums do not count as downloaded-byte verification.
No model weights were downloaded or activated.

`verifyLocalModel` now checks mounted file paths, license-review metadata, expected sizes, and SHA-256 values.
Production use also requires `/models` and explicit approval evidence.
Eleven tests verify rejection of missing, changed, unreviewed, and unconfined models.
The verifier does not select models or authenticate approval authors.
Accuracy evaluation, resource measurements, pinned runtimes, and production selection remain unfinished.

## Milestone coverage

Numbers match the binding plan exactly.
Rows were reconciled with the dated sections below on 2026-10-16.
“Contract only” means the runtime requirement remains incomplete.

| Item | Required result | Current state | Evidence needed for completion |
|---|---|---|---|
| 1 | Deploy source-owned regions and artifacts | Local migration and registration tested | Production deployment evidence |
| 2 | Persist transcript capabilities and provenance | Local schema and contracts tested | Provider adapters and saved response evidence |
| 3 | Confirm free-egress storage and resolve migration | Dated R2 evidence | Current configuration and contract evidence; migration proof if necessary |
| 4 | Cache at `getStorageProvider()` | Local factory cache and conditional transfers tested | Production capacity measurements, abandoned-cache recovery, controlled deployment |
| 5 | One source lease per project batch | Local journal-backed lease and retention protection tested | Coordinated worker integration, interrupted-session recovery, production evidence |
| 6 | Coordinated PROBE derivatives | Local audio/proxy build tested under one lease | Registered publication, interrupted-build recovery, reuse, and PROBE integration |
| 7 | Preserve original dimensions | Existing source fields | Proxy-build and export regression tests |
| 8 | Add scene, silence, black, freeze, motion, waveform, and frame hashes | All seven categories persist through the tested local evidence batch | Resource measurements, cleanup, production integration |
| 9 | Evaluate local models and licenses | License review and verifier tested; all five candidates passed downloaded-byte checks and synthetic or public fixtures | Labeled accuracy tests, representative resource measurements, approved selection |
| 10 | Limit expensive inference to sparse representatives | Hashing, grouping, representative images, and registered OCR on explicit selections tested | Automatic static-text selection, face/person inference on representatives, measured thresholds and recall |
| 11 | Conservative continuous sermon corridor | Caller-supplied corridor only; no automatic coarse regions | Automatic selection, human boundary labels, recall evidence, measured handles |
| 12 | Local edge sampling and bounded escalation | Registered whisper.cpp sampler, one-reservation escalation ledger, review exceptions, and simulated Anthropic adapter tested | Automatic ambiguity detection, real resolver, verified provider settings, real API acceptance, representative quality |
| 13 | Sermon-only FLAC and source offset | Registered extraction with verified sample mapping tested | Automatic corridor input and production activation |
| 14 | One mapped base Scribe v2 request | Registered single submission, durable ledger, cost facts, and switch-gated PROBE entry tested with injected responses | Production activation and captured real request evidence |
| 15 | Transcript refinement and deterministic boundaries | Measured silences, sentences, and paragraphs persisted | Transcript-based precise service-region classification in source time |
| 16 | Persist regions and slide subtypes | Local registration and consecutive scripture groups tested | OCR-based subtype classification, detector integration, worker reanalysis survival |
| 17 | Proxy playback, timeline, boundary strip | Registered proxy playback verified in local Chromium; registered timeline and boundary images shown to operators | Remote playback, transfer accounting, representative acceptance |
| 18 | Boundary salvage | Deterministic slide boundary policy tested | Required-speech evidence, candidate and export integration |
| 19 | Browser-to-R2 multipart upload | Adapter, durable sessions, routes, browser flow, recovery, and cleanup tested; default disabled | Real R2 CORS and transfer acceptance, reload resume, complete accounting |
| 20 | PERC retrieval and deletion experiment | Proven on a synthetic 90-second RTMPS feed: recording, explicit MP4, verified download, and confirmed deletion of every resource | Production intake code, real church encoders, long services, and repeated-run reliability |
| 21 | Padded merged candidate ranges | Registered range batches, exact mapping, copying, and lossless fallback tested | Production mode selection, authoritative retained candidate integration, measured handles |
| 22 | Verify range quality and mapping | Registered frame, sample, clock, and contained-coverage checks tested | Variable timing, color metadata, production integration, human visual comparison |
| 23 | Earlier original deletion after proof | Locked coverage proof, refusal rules, report-only mode, CLEANUP integration, and race cases tested in disposable PostgreSQL | Production activation, real R2 deletion, representative visual approval, measured handles |
| 24 | Render final clips from ranges | Gated range input, atomic range exports, shared queue selection, region checks, generated-media worker run, explicit metered fallback, and operator page control tested | Production activation, browser acceptance of the operator control, real fallback rate and billing reconciliation |
| 25 | Register every artifact and cleanup path | Local registration and deletion guards tested | Worker registration, byte accounting, retention, actual storage deletion tests |

## Acceptance evidence

No acceptance check receives completion credit from contract tests alone.

| Check | Authoritative proof still required |
|---|---|
| One remote acquisition | Instrumented complete service run, including concurrent consumers |
| Transcript analysis avoids video pixels | Call-path inspection and integration instrumentation |
| One sermon-only paid corridor | Captured provider submission and labeled source boundaries |
| Stored and tested source offset | Persisted metadata plus extracted-media and word-time comparisons |
| No silent full-service or per-clip fallback | Failure-path integration tests and request counts |
| One uncropped 480p playback proxy | Browser playback and registered shared artifact |
| No final MP4 for reserve candidates | Export queue census before and after selection |
| Original dimensions remain authoritative | PROBE and crop regression tests with differing proxy dimensions |
| Complete artifact metadata and deletion | Registry census and storage deletion integration tests |
| Regions survive reanalysis | Database integration test with shared-source projects |
| Published per-version slide recall | Representative human labels and per-class measured results |
| Zero known forbidden overlap | Labeled candidate and export overlap checks |
| Preserve speech over forbidden visuals | Transcript retention and video exclusion tests |
| One unresolved escalation creates an exception | Budget, request-count, retry, and exception persistence tests |
| Final rendering reads candidate ranges | Instrumented render input and explicit fallback evidence |
| No material visual loss | Human source/range/final-file comparisons |
| Production upload avoids web byte relay | Controlled browser upload and server transfer evidence |

## Verification and next work

`tests/media-index-contracts.test.ts` and `tests/transcript-provenance.test.ts` passed 46 tests.
ESLint passed for all five new TypeScript files.
Tests cover input identity, invalid records, overlapping regions, clock bounds, integer precision, and capability provenance.
Those contract tests do not test storage, database persistence, provider calls, or rendered media.

Nine additional database tests passed in `tests/integration/media-index.integration.test.ts`.
They check concurrent registration, conflicting facts, workspace ownership, original dimensions, source ownership, and deletion safeguards.
They also check retained registration decisions, legacy metadata, and generated transcript search.
The tests create no storage objects.
Their fixture deletion records do not establish real storage-deletion proof.

The migration verifier passed clean installation, populated upgrade, and repeated deployment on 2026-10-16.
Its report is `OUTPUTS/P4_WAVE3_MIGRATION_2026-10-16.json`.
ESLint and the full project type check passed for the new implementation.
The combined database run passed 33 tests across media-index, retention-cleanup, and source-write-boundary suites.
The contract and cleanup regression run passed 120 tests across four suites.
The disposable integration database and storage directory were removed after those checks.

The [storage cache](P4_STORAGE_CACHE.md) now connects through `getStorageProvider()` behind explicit capacity configuration.
Local tests cover shared acquisition, content identity, byte eviction, caller copies, corruption, cleanup, and transfer accounting.
Mocked S3 tests cover conditional requests and response identity.
The cache remains disabled by default.
It does not complete the source lease or coordinated derivative build.
The storage and export regression run passed 80 tests.
The factory tests passed three tests.
Five URL-import database tests passed with caching enabled for disposable fixture media.
ESLint, the full project type check, and the worker build passed after the final cache changes.
The disposable cache-test database, storage files, and cache directory were removed.

The [source lease](P4_SOURCE_LEASE.md) now uses existing journal sessions and atomic audit records.
One callback batch receives one materialized source file.
Competing batches fail before downloading.
Ordinary retention now respects open sessions and holds the cleanup gate during source deletion.
Callback uncertainty remains visible and blocks automatic ownership transfer.
The lease service still needs a coordinated derivative-worker caller.
Eight lease integration tests and nine retention integration tests passed in a disposable PostgreSQL cluster.
They cover competing admissions, both deletion races, gate locking, failure states, and required audit records.
ESLint and the full project type check passed.
The worker build passed after the retention integration change.

The [analysis derivative builder](P4_ANALYSIS_DERIVATIVES.md) now creates both outputs in one FFmpeg process.
Six real-media tests passed, including nonzero timestamps, delayed audio, preserved image edges, and checksum checks.
The source-lease database suite passed nine tests, including a real derivative build with one acquisition.
ESLint, the project type check, and the worker build passed.
Persistent artifact publication and PROBE integration remain unfinished.

Next, reconcile the provisional batches with current P2 evidence and the human-label dataset.
The measured planning requirement remains in section 13 of the binding plan.
Wave 3 is ready for local review; worker activation and production deployment remain separate steps.
Add artifact cleanup ownership without bypassing the current cleanup journal.
Do not deploy worker consumers before the web migration.
Keep original deletion disabled until range coverage and visual quality have direct proof.

## Candidate range planning

The [candidate range planner](P4_CANDIDATE_RANGES.md) now merges ranges after explicit handles and keyframe padding.
Nine tests verify coverage, invalid-input refusal, stable identity, and source-bound arithmetic.
Actual range extraction, media proof, worker integration, and original deletion remain unfinished.

Local keyframe discovery now checks source identity and normalizes explicit clock origins.
Four generated-media tests passed, including planner integration.
The scanner and planner now preserve fractional-millisecond timestamps as exact reduced fractions.
Seventeen tests verify discovery, planning, exact arithmetic, and stable identity.
Extraction and fractional artifact mapping remain unfinished.

## Local range extraction

The [lossless range extractor](P4_RANGE_EXTRACTION.md) now writes local FFV1 and PCM ranges with source clocks.
It compares decoded source and output content, then checks requested video coverage.
Five generated-media tests passed; the related planning and extraction selection contains 22 passing tests.
Stream-copy safety, publication, export integration, and original deletion remain unfinished.

The range extractor now supports verified stream copying and explicit copy-first fallback.
Ten generated-media extraction tests passed, including copied H.264 and PCM streams.
Copy failures remain visible in returned attempt evidence.
Artifact publication, production measurements, and export integration remain unfinished.

## Registered candidate range batches

The [range batch](P4_RANGE_BATCH.md) now publishes verified ranges and a coverage manifest under one source lease.
Fractional ranges register only their fully covered integer interval.
Two mapping tests and 43 database tests passed.
The database fixture verified stored bytes, reuse, retention cleanup, and preservation of the original source.
Production integration, interrupted recovery, and earlier original deletion remain unfinished.

## Local range rendering

The [range renderer](P4_RANGE_RENDER.md) now checks approval, source identity, mapping evidence, coverage, and local bytes.
It preserves caption timing while seeking absolute range timestamps.
Canonical proof hashes now survive JSONB object-key reordering.
The shared audio filter trims before normalization.
Twenty-three related tests and 43 database tests passed.
Production selection, read leases, fallback metering, and export integration remain unfinished.

## Protected range materialization

The [range read lease](P4_RANGE_READ_LEASE.md) now pins approved range artifacts without acquiring the original.
`renderPinnedRangeExport()` connects that lease to verified local rendering.
Forty-six database tests passed, including cleanup exclusion and original-absent reads.
Production input selection, review evidence, recovery, and fallback accounting remain unfinished.

## Recorded artifact reviews

The [review service](P4_ARTIFACT_REVIEWS.md) now records immutable decisions tied to exact artifact and mapping checksums.
Read leases require matching accepted review evidence and pin its revision.
The database prevents direct quality changes without review evidence.
Local tests use simulated reviewers; actual human comparison and production deployment remain unfinished.

## Pinned export range inputs

The [export range pin](P4_EXPORT_RANGE_PINS.md) now binds a queued job to exact media, review, mapping, and edit-version evidence.
The worker leaves pinned jobs queued until range-input consumption is implemented.
Production enqueue transactions, retention reconciliation, worker consumption, and fallback accounting remain unfinished.

## Pinned range retention

Unfinished export pins now protect range artifacts from cleanup.
A running job can read an expired range only through its exact artifact and review pin.
Fifty-one database tests and 11 render tests passed.
Worker input consumption, atomic enqueue integration, fallback accounting, and recovery remain unfinished.

## Gated worker range inputs

The [export worker](P4_RANGE_EXPORT_WORKER.md) now consumes pinned ranges behind `P4_RANGE_EXPORTS_ENABLED`.
It preserves output QC and records range download and render costs.
Pinned failures never download the original source.
Fifty-one database tests and 33 worker/render tests passed.
Complete service-run evidence, atomic enqueue, actual reviews, fallback policy, and production activation remain unfinished.

## Atomic range export creation — 2026-10-16

`enqueueRangeExportJob()` creates an export job and its immutable range input in one transaction.
`enqueueRangeExportJobInTransaction()` supports a larger caller transaction.
Concurrent matching requests reuse one job.
Failed pin validation and caller failures roll back job creation.
Existing original-media jobs cannot become range jobs through this producer.
The worker activation setting remains false by default.
Production routes do not yet use this producer.

All 35 source-media-lease database tests passed in a disposable local PostgreSQL database.
Type checking, focused lint, and the worker build passed.
Tests use simulated review decisions.
A complete worker run with real media and persisted range inputs remains the next verification step.
P4 remains incomplete.

## Complete generated-media range worker test — 2026-10-16

The integration test now creates real video and audio, then publishes a verified candidate range.
It records a simulated review and atomically creates the export job and range input.
It removes only its generated original and clears that fixture's original storage key.
The enabled worker claims, renders, checks, uploads, and registers the range export.
The test verifies successful job completion, checksum, dimensions, audio, and duration.
It also verifies exact transfer bytes, render duration, and completed read-session cleanup.

All 36 source-media-lease database tests passed in a disposable local PostgreSQL database.
Type checking and focused lint passed.
The harness stopped and removed its database.
No production media received review or deletion approval.
Production route integration, fallback accounting, recovery, and representative acceptance evidence remain unfinished.
P4 remains incomplete.

## Shared export queue range selection — 2026-10-16

The shared export queue now selects approved ranges when `P4_RANGE_EXPORTS_ENABLED` is true.
Manual exports, scheduled exports, reserve replacements, and prior-service fills use this queue.
Selection uses the saved edit interval and requires full coverage.
It prefers the smallest eligible artifact, then its ID.
Pin admission rechecks the latest review and media identity.
Missing coverage prevents job creation and rolls back the caller's transaction.
The manual export route returns HTTP 409 with `EXPORT_RANGE_UNAVAILABLE`.
The selector never creates an original-input job as a fallback.
Existing original-input jobs keep their previous behavior.

All 37 source-media-lease database tests passed.
All 38 focused queue, route, and coordinator tests passed.
Production activation remains off.
Representative acceptance evidence, explicit fallback accounting, and recovery remain unfinished.
P4 remains incomplete.

## Deterministic transcript structure — 2026-10-16

The new transcript boundary derivation maps submitted-audio word timestamps onto the stored source interval.
It preserves overlapping words and derives sentence and paragraph spans with explicit boundary reasons.
Paragraph breaks use measured acoustic silence and configured changes between known speakers.
It never labels transcript gaps as acoustic silence.
Canonical provenance binds input words, settings, audio identity, and acoustic evidence.
Callers must supply settings; no production thresholds changed.

Eight boundary tests and nine provenance tests passed.
Type checking and focused lint passed.
Production transcript integration, persistence, and precise forbidden-region classification remain unfinished.
See [transcript boundaries](P4_TRANSCRIPT_BOUNDARIES.md) for the contract and limits.

## Preserved Scribe provider evidence — 2026-10-16

The Scribe parser now retains original provider entries before display normalization.
Evidence includes audio events, original timestamps, speaker labels, and nullable log probabilities.
Source offset mapping preserves the original submitted-audio clock.
The transcription transaction stores this evidence in `Transcript.providerEvidence` with its words and analysis handoff.
Historical transcripts keep null evidence.

Thirty provider, offset, and selection tests passed.
Eight transcript database tests passed.
Clean installation, populated upgrade, and repeated deployment checks passed in disposable databases.
Type checking, focused lint, and the worker build passed.
No paid request or production migration ran.
Full submission provenance, capability persistence, structural persistence, and precise region classification remain unfinished.
See [provider evidence](P4_TRANSCRIPT_PROVIDER_EVIDENCE.md).

## Scribe display capability facts — 2026-10-16

Stored provider evidence now distinguishes native labels from derived display timestamps and confidence.
Missing log probabilities no longer appear as native confidence in capability facts.
The derivation versions bind their input evidence and source offset by checksum.
Incomplete speaker labels remain explicitly unavailable.
The complete capability/provenance pair remains null until submission provenance exists.

Twenty-four focused tests and eight transcript database tests passed.
Type checking and focused lint passed.
Full submission provenance, structural persistence, and precise region classification remain unfinished.

## Registered sermon-only FLAC — 2026-10-16

The shared analysis batch can now extract and register one explicitly selected sermon corridor.
The extractor preserves mono 16 kHz FLAC and verifies exact sample count and decoded PCM equality.
Evidence records source offset, duration, checksum, detector version, confidence, and toolchain.
Publication and cleanup use the shared artifact registry inside the original source lease.
The source mapping remains declared until its parent analysis mapping receives independent proof.

Three generated-audio tests and 38 source-media-lease database tests passed.
Type checking, focused lint, and the worker build passed.
The disposable database stopped and its harness removed it.
Production corridor selection, PROBE integration, and single-artifact Scribe submission remain unfinished.
See [sermon audio](P4_SERMON_AUDIO.md).

## Verified analysis and sermon audio mapping — 2026-10-16

Analysis derivation v2 now compares stored FLAC samples against a separate normalized source audio decode.
It verifies the measured sample count, zero-based clock, source identity, and output identity.
The registered audio interval cannot extend beyond measured samples or the source duration.
Analysis audio now carries verified mapping evidence.
Sermon audio links its exact trim proof to that parent evidence.
Proxy mapping and visual review status remain unchanged.
The extra decode uses the same local source and adds no remote acquisition.
Its representative resource cost still needs measurement before production activation.

Nine generated-media tests and 38 source-media-lease database tests passed.
Type checking, focused lint, and the worker build passed.
Production corridor selection, PROBE integration, and Scribe submission remain unfinished.

## Verified sermon audio submission consumer — 2026-10-16

The new internal consumer verifies audio mapping evidence and submitted bytes before one Scribe request.
It uses no keyterms, retries, secondary providers, or larger-audio fallback.
It validates returned timestamps and maps words back onto source time.
It returns complete source/audio provenance and capability facts for atomic persistence.
The Scribe adapter now sends FLAC files with `audio/flac`.

Seventeen provider and generated-media submission tests passed.
Type checking, focused lint, and the worker build passed.
Tests injected the provider response; no paid request ran.
Durable request admission, cost recording, production persistence, and recovery remain unfinished.
The production transcription path remains unchanged.
See [sermon transcription](P4_SERMON_TRANSCRIPTION.md).

## Durable sermon submission ledger — 2026-10-16

The new ledger records request admission before provider callbacks.
Matching completed requests reuse checksummed results.
Running and uncertain requests cannot automatically run again.
Unfinished requests also block different requests for the same source.
Database guards protect request identities and terminal results.
Artifact cleanup retains audio for running and uncertain requests.

Forty database tests passed, followed by the new concurrent-request test.
Clean installation, populated upgrade, and repeated deployment checks passed in disposable databases.
Historical data, search, source revision, and workspace defaults remained unchanged.
Type checking, focused lint, and the worker build passed.
Direct Scribe-consumer integration, cost recording, transcript persistence, and recovery remain unfinished.
See [submission ledger](P4_TRANSCRIPTION_SUBMISSION_LEDGER.md).

## Registered Scribe submission with cost evidence — 2026-10-16

The registered submission service now combines artifact identity checks, verified local audio, the durable ledger, and Scribe.
Each actual provider invocation records its submitted duration, bytes, outcome, source offset, artifact ID, and submission ID.
Failed requests retain cost facts and cannot automatically repeat.
Completed requests reuse persisted results without another provider call or request cost fact.
The service validates stored source/audio provenance before returning results.

All 43 source-media-lease database tests passed.
Generated media tests used injected Scribe responses for successful and failed requests.
Type checking, focused lint, and the worker build passed.
No paid request or production activation ran.
Project transcript persistence, production orchestration, and recovery remain unfinished.

## Atomic sermon transcript persistence — 2026-10-16

Completed registered submissions can now save transcript words, capabilities, complete provenance, and provider evidence.
The same transaction advances the source revision and queues project analysis.
A failed analysis handoff rolls back the transcript and revision.
Repeated saves reuse the current transcript and analysis job.
New transcript writes refuse changed source metadata or transcript revisions after request admission.
The existing durable-work reanalysis rule still applies.

All 43 source-media-lease database tests passed.
The two registered-submission tests then passed with the additional source-change check.
Tests cover complete persistence, rollback, repeated saves, wrong workspaces, stale revisions, and changed source metadata.
Type checking and focused lint passed.
Production orchestration, corridor selection, recovery, and representative acceptance remain unfinished.
See [sermon transcript persistence](P4_SERMON_TRANSCRIPT_PERSISTENCE.md).

## Persisted measured transcript structure — 2026-10-16

Completed sermon submissions can now produce measured silence, sentence, and paragraph structure.
The builder uses the durable response and selected audio checksum with explicit detector settings.
Persistence validates the structure against saved words and audio identity.
It saves structure with complete capabilities, provenance, words, and analysis handoff in one transaction.
Repeated saves cannot silently change the structure.
Historical transcripts keep null structure.

All 43 source-media-lease database tests and 24 boundary, provenance, and audio tests passed.
Migration checks passed for clean installation, populated upgrade, and repeated deployment.
Historical data, search, source revision, and workspace defaults remained unchanged.
Type checking, focused lint, and the worker build passed.
Production orchestration, corridor selection, semantic region classification, and recovery remain unfinished.

## Coordinated sermon preparation — 2026-10-16

The new coordinator runs derivative publication, local evidence, selected sermon audio, durable submission, and transcript structure under one source lease.
It persists the transcript and queues analysis only after local cleanup completes.
The caller must supply the corridor, evidence, settings, retention, and provider.
The coordinator does not make unmeasured production selections.

All 44 source-media-lease database tests passed.
The generated-media coordinator test verified one acquisition, one provider call, publication order, cleanup order, persistence, and repeated-result reuse.
Repeated preparation still rebuilds local derivatives before reuse checks.
Production PROBE integration, automatic corridor selection, recovery, and representative acceptance remain unfinished.
See [sermon preparation](P4_SERMON_PREPARATION.md).

## Preparation transfer accounting — 2026-10-16

Preparation now records source downloads, conditional artifact uploads, and publication verification downloads.
Explicit caller settings provide storage prices and attempt numbers.
Cache hits use actual transfer counts.
Unknown failed transfers remain unpriced.
Local derivative computation and storage request charges still need accounting before production PROBE integration.

## Preparation computation measurements — 2026-10-16

Preparation records elapsed time and outcomes for derivative construction, local evidence, representative frames, sermon audio, and transcript structure.
Repeated preparation records each repeated local operation.
CPU use remains unknown because Node.js CPU counters exclude child processes.
The computation records remain unpriced until machine billing exists.
Production PROBE integration and complete resource accounting remain unfinished.

## Controlled PROBE entry — 2026-10-16

PROBE now selects the preparation coordinator through `P4_SERMON_PREPARATION_ENABLED=true`.
The example environment keeps this switch false.
The project must supply validated preparation settings and one explicit sermon corridor.
Failures create one open review exception and stop automatic retries.
The path never queues legacy transcription after a preparation failure.
Human work prevents reanalysis before acquisition or paid requests.
SRT intake and preview integration remain unfinished.
Production activation, automatic corridor selection, complete accounting, and recovery remain unfinished.

## Registered proxy previews — 2026-10-16

Church and operator candidate pages now select registered proxies when preparation is enabled.
Signed registry references preserve workspace ownership checks for source-owned artifact keys.
Playback checks publication, retention, storage identity, and object identity before serving media.
Original deletion does not prevent proxy selection.
Playback accounting and browser acceptance remain unfinished.
See [proxy playback](P4_PROXY_PREVIEW.md).

## Proxy browser verification — 2026-10-16

Chromium verified generated-media playback through both church and operator candidate pages.
The test published real derivatives and deleted only its generated original.
Both pages played the registered 480p proxy through HTTP 206.
Playback stopped at the candidate boundary without creating an export.
The operator belonged to a separate workspace.
Local browser playback is verified for this fixture.
Remote playback, transfer accounting, and representative production acceptance remain unfinished.

## Timeline and boundary images — 2026-10-16

The shared batch now builds and registers timeline and boundary images from its local proxy.
Explicit requests control source timestamps, layout, and resource limits.
Each image includes registered cell-time evidence and preview retention.
The builder rejects missing exact frames and oversized output.
Automatic sampling, operator display, and representative acceptance remain unfinished.
See [proxy views](P4_PROXY_VIEWS.md).

## Observed-frame view sampling — 2026-10-16

Timeline and boundary requests now support automatic sampling within an explicit source interval.
The sampler uses observed proxy frame times from local evidence.
It records target distances and refuses sparse, repeated, or distant selections.
Publication binds the sampling evidence to the local evidence artifact and checksum.
Semantic boundary selection, operator display, and representative acceptance remain unfinished.

## Operator source images — 2026-10-16

The operator project page now opens retained timeline and boundary images on request.
The display lists source timestamps and excludes detector confidence.
Signed image delivery checks artifact ownership, kind, version, expiration, and storage identity.
Automatic sermon boundary selection and representative production acceptance remain unfinished.

## Slide boundary policy — 2026-10-16

A deterministic policy now trims short edge slides at supplied safe cuts.
It preserves required speech and rejects middle slides, ambiguous regions, and forbidden service content.
The policy records a versioned input checksum and never claims semantic approval.
Production candidate and export integration remain unfinished.
See [slide boundary policy](P4_SLIDE_BOUNDARY_POLICY.md).

## Registered region export checks — 2026-10-16

Pinned range exports now refuse registered forbidden, ambiguous, and unknown regions.
The worker checks before acquisition, after rendering, and during transactional completion.
Completion shares the source lock used by region registration.
The check never treats missing region facts as proven detector coverage.
Legacy exports and publication after later evidence changes still need integration.
See [region export policy](P4_REGION_EXPORT_POLICY.md).

## Current regions at delivery — 2026-10-16

Delivery now reloads current source regions for the exact pinned range export.
Forbidden evidence registered after rendering can stop publication eligibility.
The shared rule still requires the global switch, matching export identity, and human review.
Legacy exports and changes after publication assessment remain unfinished.

## Transactional range publication claim — 2026-10-16

Pinned range publication now combines the final region check, exact slot claim, and intent record in one transaction.
The source lock serializes that check with region registration.
Intent failure rolls back the slot claim.
Concurrent workers produce one intent for the slot.
Changes after claim commit and legacy publication remain unfinished.

## Review exceptions after publication claim — 2026-10-16

New forbidden regions now create review exceptions for overlapping pinned publications after claim.
The transaction preserves publication status and remote identifiers.
Concurrent repeated registration creates one exception for each post and region.
Resolved exceptions stay resolved when the same region returns.
Ten database cases and 21 focused tests passed.
Remote retraction, legacy publication checks, and representative acceptance remain unfinished.

## Direct multipart storage adapter — 2026-10-16

The S3 provider now supports multipart initiation, signed parts, inspection, completion, and abort.
The adapter checks stored part sizes and completed object identity.
The cache preserves the capability and invalidates entries after completion attempts.
The multipart SDK client does not retry uncertain operations automatically.
Upload routes and browser integration still use the relay.
Durable sessions, recovery, CORS acceptance, accounting, and cleanup remain unfinished.
See [direct multipart upload](P4_MULTIPART_UPLOAD.md).

## Durable multipart sessions — 2026-10-16

An additive migration now records upload ownership, immutable byte plans, provider IDs, expiry, and completion evidence.
The service claims initiation, completion, and cancellation through conditional database updates.
Completion creates one source and preserves its identity for repeated requests.
Uncertain operations stop automatic retries.
HTTP routes, browser uploads, reconciliation, cleanup, and production acceptance remain unfinished.
See [durable multipart sessions](P4_MULTIPART_UPLOAD.md#durable-sessions--2026-10-16).

## Multipart routes and browser flow — 2026-10-16

The upload page now uses direct multipart transfer when explicit S3 rollout settings enable it.
The control routes authorize workspace access and use the durable upload record.
Relay routes reject multipart sessions.
The browser preserves the upload ID after a lost completion response.
All 39 route and browser-flow tests passed.
The default remains disabled pending recovery, cleanup, accounting, and real R2 acceptance.
Browser progress, cancellation, and resume across page reloads remain unfinished.

## Expired multipart cleanup — 2026-10-16

The worker retention scan now cancels expired multipart uploads through their durable records.
It preserves active claims, uncertain operations, completed uploads, and other storage identities.
Cancellation checks remaining parts and completed-object presence before reporting success.
All 15 database cases and 45 storage tests passed.
Uncertain-operation recovery and bucket lifecycle acceptance remain unfinished.

## Confirmed multipart completion recovery — 2026-10-16

Repeated completion now recovers an uncertain operation when remote object metadata proves the completed session identity.
The transaction creates one source and retains recovery evidence.
Recovery makes no provider mutation and preserves unproven outcomes.
All 22 database cases and 108 focused tests passed.
Uncertain initiation, uncertain cancellation, and worker termination during active claims still need reconciliation.

## Lost multipart initiation recovery — 2026-10-16

Repeated start requests can now adopt one unfinished upload at the session's exclusive object key.
Recovery records the provider ID and retained evidence without another initiation request.
Ambiguous listings and active claims remain unresolved.
Expired recovered uploads enter the existing cleanup path.
All 28 database cases and 114 focused tests passed.
Uncertain cancellation, worker termination during active claims, and real R2 acceptance remain unfinished.

## Confirmed multipart cancellation recovery — 2026-10-16

Repeated cancellation now resolves uncertainty only when provider reads confirm the upload and completed object are absent.
The transaction retains immutable cancellation evidence.
All 33 database cases and 119 focused tests passed.
Remaining remote parts, interrupted active claims, and real R2 acceptance still need work.

## Observed multipart claim recovery — 2026-10-16

Provider evidence can now confirm interrupted claims without resetting them or repeating provider requests.
Late responses reuse the confirmed result and preserve recovery evidence.
The worker scans pending uploads with a bounded cursor before expiry cleanup.
All 37 database cases passed, including delayed-response conflicts and simulated process termination.
Unconfirmed outcomes, remaining remote parts, complete accounting, and real R2 acceptance remain unfinished.

## Browser upload progress and cancellation — 2026-10-16

The upload page now shows confirmed byte progress and provides multipart cancellation.
Failed cancellation preserves the attempt until the server confirms its result.
All 45 route and browser-flow tests passed.
An isolated Chromium test verified progress and cancellation without a completion request.
The browser test used intercepted storage responses; real R2 acceptance remains unfinished.

## Multipart part reuse on retry — 2026-10-16

Retries now inspect stored parts and send only missing parts from the same selected file.
The server checks ownership, state, expiry, and planned part sizes.
All 53 focused tests and 38 database cases passed.
Resume across page reloads, full accounting, and real R2 acceptance remain unfinished.

## Multipart control-request measurements — 2026-10-16

The shared S3 factory now records multipart control SDK calls with workspace attribution and measured duration.
Request prices remain unpriced, and browser bytes do not count as server egress.
All 74 selected storage and cost tests passed.
Browser PUT attempts, partial transfers, provider billing, and full cost acceptance remain unfinished.

## Multipart request-price configuration — 2026-10-16

Multipart control requests now accept explicit per-operation USD price estimates and an internal evidence ID.
Omitted prices remain unpriced, and invalid configuration prevents S3 provider creation.
The facts retain the evidence ID without claiming verified provider billing.
No production prices or R2 credentials were configured.
R2 acceptance still requires an isolated test environment.
Full cost acceptance remains unfinished.

All 17 focused tests passed.
Lint, application type checking, and the worker build passed.

## Original-file export region checks — 2026-10-16

Original-file exports now check known forbidden regions before download, after rendering, and during completion.
Completion binds the check to retained render boundaries and takes the source lock.
Missing render evidence and changed boundaries stop completion.
Original-file checks include every retained source identity because these exports lack a pinned source checksum.
Original-file publication checks and late publication exceptions remain unfinished.

All 34 focused unit tests and nine selected database cases passed.
Database cases covered forbidden facts before rendering, during rendering, and before completion.
They also covered missing evidence, changed boundaries, successful original exports, and existing range exports.
Lint, type checking, and the worker build passed.
Tests used generated media and temporary databases without external provider requests.

## Original-file publication region checks — 2026-10-16

Original publications now require stored render boundaries and a clear region check.
The final transaction locks the source, checks regions, claims the exact slot, and records intent.
Late forbidden evidence creates review exceptions without changing remote publication history.
Historical exports without render boundaries need a new render before publication.
Missing historical boundaries also cause review exceptions for matching publications already claimed or completed.
Production activation and complete detector coverage remain unverified.

All 83 focused unit tests and 76 database cases passed.
Database cases covered concurrent claims, rollback, missing evidence, late exceptions, and non-overlapping intervals.
The publisher and editorial-program regression suites used injected provider calls.
Lint, type checking, and the worker build passed.
No real provider request or production activation occurred.

## Slide-recall evaluation tool — 2026-10-16

The new evaluation command reports duration-weighted slide recall and precision for each detector version and configuration.
Reports include per-source and per-subtype results, review references, and input checksums.
The tool rejects missing run sources, conflicting identities, overlapping labels, and labels outside reviewed intervals.
It excludes unreviewed time and never grants production approval.
Fourteen synthetic unit tests, lint, and application type checking passed.
The command test verified report creation and overwrite refusal.
Real detector recall remains unmeasured because representative labels and completed detector runs remain unavailable.
Cache recovery still needs reliable ownership evidence before it can remove abandoned directories.

## Full unit-suite regression check — 2026-10-16

The first complete run found 26 failures across three test files.
The fixtures lacked valid source identities, region queries, or the publication transaction interface.
The corrected fixtures exercise the real region checks and publication claim path.
The publisher test still verifies that intent precedes the provider call.
The editorial-review test now checks the exact refusal reason.
No production check was weakened to pass these tests.

All 2,728 tests across 207 files passed in the complete rerun.
The final editorial-review assertion also passed its 17-test focused suite.
These results exclude database and browser suites.
They do not prove production activation, representative detector quality, or the remaining P4 acceptance requirements.

## Consecutive scripture slide groups — 2026-10-16

The new batch service stores input slide facts and derived `VERSE_SLIDESHOW` groups atomically.
Groups require consecutive scripture slides and an explicit maximum gap.
Another slide subtype or an excessive gap breaks the group.
Immutable derivation evidence retains parent identities, configuration, source identity, and confidence aggregation.
The additive migration preserves historical facts with null derivation evidence.
All 25 focused tests and 15 database cases passed.
Production detector integration and representative slide classification evidence remain unfinished.

## Verified OCR bytes and isolated execution — 2026-10-16

The pinned Tesseract English model now has a verified SHA-256 checksum.
Its downloaded bytes matched the recorded Git blob and expected size.
Pinned license evidence also matched its existing checksums.
An isolated 854×480 text fixture produced an exact normalized OCR result.
The run measured 320.3867319971323 ms wall time and 36032512 peak resident bytes.
Temporary model bytes were removed after evaluation.
All 11 model-verification tests and script syntax and overwrite checks passed.
This single generated frame does not establish representative quality or per-service cost.
Production approval remains false.

## Bounded OCR for selected representatives — 2026-10-16

The new sparse OCR adapter verifies representative selections, local image bytes, and mounted model identity.
It enforces frame, input-byte, output-byte, and child-process limits.
Results preserve native confidence and pixel geometry with source and selection evidence.
Measured wall times remain separate from deterministic evidence hashes.
The real adapter reproduced all five words from the generated fixture.
No production caller or model activation was added.
Automatic static-text selection, registered OCR artifacts, and downstream classification remain unfinished.

All 27 focused tests passed.
Lint, type checking, the worker build, and whitespace checks passed.

## Registered sparse OCR artifacts — 2026-10-16

The internal source batch now runs explicit OCR requests within its existing source lease.
It registers bounded OCR documents with local evidence and selected frame artifact references.
Publication verifies stored bytes before marking each document ready.
Identical retries reuse the artifact without another upload.
The cleanup service removes expired OCR objects and retains deletion evidence.
Measured wall times stay outside immutable document bytes.
The measurement service records OCR wall time under `analysis_classification`.
Child CPU time and computation prices remain unknown.

All 29 focused tests and five selected database cases passed.
Database tests used generated media and a simulated OCR executable.
They verified registration, one source download, retry reuse, missing representatives, invalid selections, document limits, and cleanup.
The existing derivative batch also passed its database regression case.
Lint, type checking, and the worker build passed.
The temporary database stopped before its directory was removed.
Automatic selection, production coordinator configuration, and downstream classification remain unfinished.
Production model approval and representative acceptance remain unverified.

## Optional OCR preparation handoff — 2026-10-16

The preparation coordinator now accepts explicit internal OCR requests.
It completes OCR publication before sermon extraction and the Scribe request.
It measures OCR wall time and storage transfers through existing project accounting.
Invalid selections stop preparation without a paid request, transcript, or analysis handoff.
The controlled PROBE entry still needs approved automatic selection and model configuration.
Production model activation and representative quality evidence remain unfinished.

Seven selected database cases passed with generated media and simulated OCR and Scribe responses.
They verified OCR publication before Scribe, one original download per run, completed-submission reuse, and failed-selection accounting.
The failed-selection case created no Scribe submission, transcript, or analysis job.
Artifact registration, retry reuse, document limits, and cleanup regression cases also passed.
Lint, application type checking, the worker build, and whitespace checks passed.
The temporary database stopped before its directory was removed.

## Separate local boundary sampler — 2026-10-16

The new sampler accepts one or two explicitly ambiguous corridor edges with evidence checksums.
It extracts exact local audio windows and runs whisper.cpp separately from caption-provider selection.
It rejects repeated edges, overlapping windows, excessive durations, and complete-service sampling.
Results preserve native subword probabilities and source-time mapping without claiming resolved boundaries.
Model verification requires the new `BOUNDARY_ASR` role and existing production approval rules.
Temporary audio and JSON files are removed after success or failure.

All 27 selected sampler, model-verification, and existing whisper-provider tests passed.
The tests used generated FLAC, dummy weights, and simulated inference.
Lint, application type checking, and the worker build passed.
The installed CLI help confirmed FLAC input and the requested output flags.
No production model, provider setting, or threshold changed.
Source-batch integration, artifact registration, automatic ambiguity detection, and representative recognition evaluation remain unfinished.
See [local boundary sampling](P4_BOUNDARY_ASR.md).

## Registered boundary sampling and decisions — 2026-10-16

The source batch now runs optional boundary sampling within its existing source lease.
It registers sampling evidence before invoking a separate resolution callback.
It registers the decision before extracting the final sermon corridor or calling Scribe.
Resolved boundaries must stay inside sampled windows.
Unsampled edges must retain their initial positions.
Unresolved decisions create a human-review exception with registered evidence references and disable automatic retries.
Repeated requests stop at the matching open exception before provider checks or source acquisition.
The failed source session remains protected until explicit recovery.

All eight selected database cases passed after the final review-gate change.
They verified registration, exact final corridor use, one Scribe submission, artifact reuse, accounting, and cleanup.
They also verified unresolved decisions, unsupported boundary changes, and document limits.
The first review-gate test found that the retained failed session blocked repeated attempts.
The new exception preflight now gives the repeated request the intended non-retryable review result.
All 23 selected sampler, model-verification, and measurement unit tests passed.
Lint, application type checking, the worker build, and whitespace checks passed.
The tests used generated media and simulated recognition and resolution.
Temporary database servers stopped before their directories were removed.

Automatic coarse-region detection, a real boundary resolver, bounded paid escalation, and production configuration remain unfinished.
Representative quality evidence and production acceptance remain unverified.
See [local boundary sampling](P4_BOUNDARY_ASR.md).

## Real boundary-ASR fixture — 2026-10-16

The local boundary adapter now has a successful run with whisper.cpp 1.9.1 and verified `base.en` model bytes.
The downloaded model matched its pinned Git LFS identity and the existing caption benchmark checksum.
Pinned runtime and model license evidence identify MIT licensing.
The adapter recognized all seven words in a 4539 ms synthetic window.
The report retains exact source mapping and native token probabilities.
The complete adapter process tree used 5644.497775938362 ms wall time and 297275392 peak resident bytes.
Temporary model files were removed after execution.
Script syntax and overwrite-refusal checks passed.
Production settings and model approval remain unchanged.
Representative recognition quality, boundary recall, and per-service resource budgets remain unverified.
See [the retained report](../evaluation/p4-boundary-asr-fixture-2026-10-16.json).

## Durable visual escalation reservation — 2026-10-16

A new source-owned ledger permits one visual boundary request per source.
Admission requires an active source lease, registered ambiguity evidence, retained source images, and an explicit token-price budget.
Integer arithmetic reserves the maximum charge before the provider callback runs.
Exact completed retries reuse results; changed and uncertain requests cannot dispatch again.
Over-limit responses remain recorded but cannot clear the boundary.
Database guards preserve reservation identity, budget, result evidence, and history.
Artifact cleanup holds source evidence while an escalation remains started or uncertain.

The new migration applied successfully in disposable PostgreSQL.
No production migration or real provider request occurred.
Vendor request construction, SDK retry controls, automatic escalation integration, and final visual-decision registration remain unfinished.
Production model choice, representative quality, and billing acceptance remain unverified.
See [visual escalation](P4_VISUAL_ESCALATION.md).

All 14 selected database cases and 14 selected unit tests passed for this change.
The database cases covered nine escalation paths and five boundary-sampling regression paths.
Retention tests preserved expired evidence after uncertain outcomes.
Lint, application type checking, the worker build, and whitespace checks passed.
The temporary database stopped before its directory was removed.

## Visual escalation handoff before Scribe — 2026-10-16

The source batch now connects an explicit visual request preparer to unresolved local boundary decisions.
It restricts images to registered outputs from the current batch and supplies the owning source identities itself.
The durable ledger controls dispatch and response reuse.
A validated visual result receives a registered final-decision artifact before sermon extraction or Scribe.
The artifact links the initial decision, sampling evidence, escalation identifier, and exact result checksum.
Resolved local decisions skip visual preparation and dispatch.

Continued ambiguity, refused budgets, invalid images, invalid decisions, and provider failures stop for human review.
Review exceptions include the escalation identifier when a reservation exists.
Later requests stop at the exception before another source acquisition or provider request.
No complete-service transcription fallback was added.

All 20 selected database cases and 14 selected unit tests passed.
The database cases covered nine ledger paths and eleven boundary handoff paths.
They verified one visual submission, one Scribe submission, repeated-result reuse, final-decision publication order, and cleanup.
Failure cases verified human review without another request.
Lint, application type checking, the worker build, and whitespace checks passed.
The temporary database stopped before its directory was removed.
All provider responses were simulated.

A real vendor adapter, approved production configuration, representative quality, and billing acceptance remain unfinished.
See [visual escalation](P4_VISUAL_ESCALATION.md).

## Bounded Anthropic visual adapter — 2026-10-16

The new adapter prepares immutable representative-frame requests without network work.
Frames carry verified bytes and source timestamps.
The adapter requires explicit model identity, context-ceiling evidence, token prices, and byte and time limits.
It reserves the complete configured input-context allowance rather than treating an estimate as a hard bound.
The ledger retains that ceiling evidence and checks the complete prepared configuration before dispatch.

The HTTP path sends one request, refuses redirects, and performs no automatic retries.
It rejects truncated responses, changed models, unexpected cache usage, missing usage, and malformed decisions.
Local validation retains constraints that the provider's structured-output grammar does not support.
The adapter derives detector identity and evidence checksums locally.
It does not ask the model to invent provenance.

All 17 selected unit tests and ten selected database cases passed.
The final source-timestamp handoff also passed its focused database rerun.
The handoff used generated WebP frames and an injected HTTP response.
It verified reservation before dispatch, final-decision publication before Scribe, and response reuse.
Lint, application type checking, the worker build, and whitespace checks passed.
Temporary databases stopped before their directories were removed.
No real API request or production configuration change occurred.

Exact production model choice, context and price verification, real API acceptance, and representative quality remain unfinished.
See [the adapter notes](P4_ANTHROPIC_VISUAL_ADAPTER.md).

## Composite images in visual escalation — 2026-10-16

The Anthropic adapter now accepts registered timeline images and boundary strips.
A shared schema validates their source-time cell maps during image creation and request preparation.
It checks cell order, geometry, timestamps, source intervals, and empty-cell counts.
The source batch supplies registered publication evidence to the preparation callback.
The prepared request binds the image bytes and cell map into its checksum.
The prompt identifies empty cells and limits each cell to one sampled instant.

All 25 selected unit tests passed.
Generated-image tests verified both image types and unchanged request content after caller mutation.
Eleven boundary database cases passed on the first run.
The composite case initially failed because its fixture requested a timestamp between actual video frames.
The corrected composite case passed its focused rerun with actual frame timestamps.
It verified registered cell maps, one simulated visual request, final-decision publication, and reuse before Scribe.
Type checking, targeted lint, the worker build, and whitespace checks passed.
Both temporary databases stopped before their directories were removed.
No real provider request ran.

Production configuration, real API acceptance, and representative quality remain unfinished.

## YuNet evaluation — 2026-10-16

The isolated face experiment downloaded and verified the reviewed YuNet model.
It checked the pinned license documents, Git LFS pointer, model checksum, and byte count.
One public portrait produced one detection at its largest tested size.
The model missed both smaller versions and produced no detection on the blank control.
The retained report records native detections, misses, resource measurements, and package identities.
Temporary weights and the isolated Python environment were removed.
All 11 model-verification tests and the script checks passed.

This evidence does not approve the model or establish representative accuracy.
The misses make small-face evaluation a required next check before selection.
See [the model review](P4_LOCAL_MODEL_REVIEW.md#yunet-public-portrait-experiment).

## YOLOX evaluation — 2026-10-16

The isolated person-model experiment verified the reviewed weights and pinned decoder before execution.
The model detected one person in the two larger portrait fixtures.
It missed the smallest portrait and returned no detections on the blank control.
The report retains native scores, source-coordinate mappings, package identities, and resource measurements.
Temporary weights, decoder code, and the isolated runtime were removed.
Script checks passed for syntax, output protection, detector selection, and child process outcomes.

Representative quality and production approval remain unfinished.
See [the person-model evaluation](P4_LOCAL_MODEL_REVIEW.md#yolox-public-portrait-experiment).

## YAMNet evaluation — 2026-10-16

The candidate inventory records the generation-pinned YAMNet weights, size, MD5, and locally computed SHA-256.
`scripts/evaluate-audio-event-fixture.py` ran in an isolated Python 3.9 venv with the pinned packages.
All three upstream synthetic expectations passed.
Clean synthetic speech scored 0.994 for Speech.
Speech over steady tones scored 0.08 for Speech.
That result requires representative speech-over-music testing before selection.
The venv, weights, and temporary outputs were removed.
See [the YAMNet experiment](P4_LOCAL_MODEL_REVIEW.md#yamnet-synthetic-experiment--2026-10-16).

## Explicit full-source fallback — 2026-10-16

Platform operators can now request one metered original-input export when no approved range exists.
The request creates the job, an open review exception, and an immutable fallback record in one transaction.
While range exports are active, original jobs without that record fail before download.
Cost facts and QC details name the fallback and exception.
`P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED` defaults to false.

All 103 source-media-lease and 40 other export database cases passed in disposable PostgreSQL.
Seven route tests, lint, type checking, the worker build, and 2,791 unit tests passed.
The migration proof passed with all 45 migrations.
Two existing lease tests needed queue isolation fixes; they failed before this change.
No production setting changed.
See [full-source fallback](P4_FULL_SOURCE_FALLBACK.md).

## Early original deletion — 2026-10-16

The CLEANUP job can now delete only the original before the 14-day fallback date.
A locked proof must cover every retained candidate with an approved, unexpired range.
Unfinished exports, unfinished processing, open fallbacks, and a missing proxy refuse deletion.
The proof is stored with the key change in one transaction.
`P4_EARLY_ORIGINAL_DELETION_ENABLED` defaults to false.
The clip editor plays the registered proxy when preparation is enabled.

Three new database cases and 194 cases across eight database files passed.
Lint, type checking, the worker build, and 2,793 unit tests passed.
No production setting changed.
See [early original deletion](P4_EARLY_ORIGINAL_DELETION.md).

## PERC experiment harness — 2026-10-16

No PERC code or Cloudflare Stream credentials existed.
`scripts/perc-experiment.ts` now proves retrieval and deletion on a synthetic RTMPS feed once credentials exist.
It requests the MP4 download explicitly, which Pulpit Engine's failed attempt appears to have missed.
Deletion and absence checks run for every created resource after any failure.
Ten simulated tests, plan mode, refusal checks, lint, and type checking passed.
No real Cloudflare request has run, so item 20 remains unproven.
See [the PERC experiment](P4_PERC_EXPERIMENT.md).

## First PERC run — 2026-10-16

One approved run used a Sermon Clipper-owned Cloudflare account.
Token verification, live-input creation, and confirmed live-input deletion passed.
Cloudflare closed the RTMPS push after 2518 ms, so no recording existed.
No Cloudflare resource remains.
The cause is not proven; the push now logs redacted verbose ffmpeg output.
See [the PERC experiment](P4_PERC_EXPERIMENT.md#first-real-run--2026-10-16).

## PERC retrieval and deletion proven — 2026-10-16

After Jake chose one shared Cloudflare account and the full storage was cleared, a second approved run succeeded.
A 90-second synthetic feed produced one recording, an explicit MP4 in about 15 seconds, and a verified 88.067-second file.
The recording, MP4 record, MP4 URL, and live input were all confirmed absent afterward.
The client now accepts Cloudflare's bodyless `DELETE` response.
This proves the experiment, not production PERC intake.
See [the second run](P4_PERC_EXPERIMENT.md#second-real-run--2026-10-16).

## Uploaded SRT preparation — 2026-10-16

Controlled PROBE now prepares uploaded-SRT projects instead of stopping them.
One acquisition builds the shared derivatives; no speech provider runs.
The existing TRANSCRIBE job then parses the SRT.
Two database cases, 136 cases across four database files, lint, and the worker build passed.
The full unit suite passed 2,803 of 2,804 tests.
`tests/analysis-derivatives.test.ts` timed out at 5 seconds under full-suite load; it passed twice alone in about 8.7 seconds.
See [sermon preparation](P4_SERMON_PREPARATION.md#uploaded-srt-path--2026-10-16).

## P4 audit — 2026-10-16

P4 remains incomplete. No acceptance gate has production evidence.

Locally implemented and tested, but still needing production deployment or activation:
items 1, 2, 4, 5, 6, 8, 13, 14, 17, 19, 21, 22, 23, 24, and 25.
Item 7 has local evidence: proxy builds and preparation leave original dimensions unchanged.
Item 20 is proven on a synthetic feed only.

Items blocked on representative human labels:
9 (model selection), 10 (thresholds), 11 (automatic corridor), 12 (ambiguity detection),
15 (precise service regions), 16 (slide subtypes), and the recall, overlap, and visual-loss gates.

Items blocked on production access or Jake's approval:
1 (Wave 3 deployment), 3 (current R2 configuration), 19 (real R2 CORS and transfer),
23 (real R2 deletion), every production activation switch, and real Scribe and Anthropic requests.

All four items listed here as implementable without external input were completed on 2026-10-17.

## Four local gaps closed — 2026-10-17

**Regions survive reanalysis.** A database case registered two source regions.
It replaced the transcript twice through the real TRANSCRIBE path, rebuilt clips, and deleted one sharing project.
The regions stayed identical, and the sibling project's export check still refused the forbidden interval.

**SRT capability facts.** New SRT transcripts store complete capabilities and provenance.
Provenance marks the text and cue timing `user-supplied` with the SRT file's SHA-256.
Word timestamps are `derived` by `srt-cue-even-word-interpolation-v1` from that same file.
Confidence, speakers, audio events, silences, sentences, and paragraphs are `unavailable` with reasons.
No capability field is strictly user-supplied, because SRT word times are interpolated.
Historical transcripts keep null facts.

**Reserve export census.** With range exports active, the scheduled render coordinator created one range-pinned export for the scheduled clip.
Two reserves had none, and a repeat run created nothing.
After the slot was rebound to a reserve, only that reserve gained one export.
This is local evidence for the reserve gate; production census evidence remains outstanding.

**Operator fallback control.** See [full-source fallback](P4_FULL_SOURCE_FALLBACK.md#operator-page-control--2026-10-17).

177 cases across eight database files passed in disposable PostgreSQL.
All 2,811 unit tests, lint, type checking, the worker build, and the production build passed.
The production build reported one existing warning in the legacy PROBE upload loop, `src/lib/jobs/handlers/probe.ts:193`.
