# Registered local evidence

`buildLocalEvidenceDocument()` combines the local detectors into one deterministic JSON document.
It reads analysis audio and the shared proxy from the current source lease.
It does not acquire another original copy.
Sequential detector passes avoid simultaneous decoder processes.

The document contains these facts:

- Scene timestamps and scores.
- Silence intervals.
- Black-frame intervals.
- Freeze intervals.
- Motion measurements.
- Waveform measurements and sample counts.
- Sparse frame hashes and representative groups.

The document also records source identity, source interval, source clock origin, and derivative identity.
Each detector retains its version, configuration hash, toolchain hash, and content settings.
Execution limits do not enter document bytes or content identity.
Changing a timeout or successful frame budget therefore does not create a different document.
Changing detection settings changes configuration identity.

## Batch integration

`runAnalysisDerivativeBatch()` accepts explicit evidence settings as its optional sixth argument.
Without those settings, its existing audio-and-proxy behavior remains unchanged.
No default thresholds or production settings were added.

The batch publishes audio and proxy records before building the evidence document.
It creates the document inside the lease-owned derivative directory.
It checks the serialized document size against the caller's limit.
That limit controls output size, not total process memory.
The current detectors still buffer their metadata and result arrays.

`20261016073500_local_evidence_artifact` adds `LOCAL_EVIDENCE` to the artifact-kind constraint.
The publisher registers the document's storage key before upload.
It records its checksum, bytes, derivation version, configuration identity, and source interval.
The document uses `ANALYSIS` retention and the caller's analysis expiry date.
Publication evidence links the audio and proxy records and records fact counts.
Storage checksum verification must pass before the document becomes `READY`.
Its source mapping remains `DECLARED`.
The document does not establish sermon boundaries or video eligibility.

The batch returns persistent artifact records and transfer results.
The source lease removes local document and media files before returning.
A repeated batch verifies existing evidence bytes and reuses the original registry record.
It still rebuilds local media and evidence before reuse checks.
Earlier lookup remains a separate optimization.

## Failure and verification

If evidence exceeds its output limit, the batch preserves completed media records.
It records the source session as `UNCERTAIN` and removes local files.
The recovery service must reconcile that unfinished batch.
The local [artifact cleanup service](P4_ARTIFACT_CLEANUP.md) now supports registered evidence artifacts.
Recovery and production cleanup integration remain unfinished.
No production worker uses this evidence path yet.

Twenty-seven database tests passed against a disposable PostgreSQL cluster.
The batch test used real FFmpeg outputs and checked all seven fact categories.
It verified one original acquisition, publication ownership, checksums, expiry, repeated reuse, and local cleanup.
A separate test verified document-limit failure and retained media ownership.
These fixtures do not establish detector recall, semantic accuracy, or production resource budgets.

Explicit representative settings now enable [registered image extraction](P4_REPRESENTATIVE_FRAMES.md) from selected frame groups.
The images share the existing source lease and retain separate registry records.
