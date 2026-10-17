# One verified sermon audio submission

`transcribeVerifiedSermonAudio()` consumes local sermon FLAC while its caller holds the source lease.
It verifies the analysis mapping and sermon trim evidence chain before provider work.
It checks the submitted file checksum and byte count before and after the request.
It requires the Scribe v2 adapter and passes no keyterms.
It calls the provider exactly once.
It does not retry, select a secondary provider, or expand the submitted audio.

The Scribe adapter now labels `.flac` uploads as `audio/flac`.
Its existing request keeps `scribe_v2`, word timestamps, diarization, audio events, and `no_verbatim=false`.

The consumer rejects provider and normalized display timestamps outside the submitted corridor.
It maps display words back to source time.
It preserves the provider clock and records its source offset separately.
The result contains validated complete transcript provenance and capability facts.
Provenance includes source checksum, submitted audio checksum, measured duration, source interval, offset, provider, and model.
Request identity remains explicitly unavailable because the adapter does not capture it yet.
Submission evidence also retains detector version, corridor confidence, and both mapping evidence checksums.

The function is an internal building block, not a production entry point.
Production integration still needs durable request admission, cost records, transcript persistence, and recovery rules.
The caller must await the request before releasing its lease or deleting local files.
The current production transcription handler still uses its previous path.
No paid request or production setting changed during implementation.

Generated-media tests use a real source, verified analysis FLAC, exact sermon extraction, and an injected provider response.
They verify one submission, correct FLAC MIME type, source-time mapping, provenance, proof refusal, and failure without retry.
They also reject provider timestamps outside the corridor.

## Registered submission and cost recording

`transcribeRegisteredSermonAudio()` now connects the verified consumer to the durable submission ledger.
It binds local audio bytes, source identity, and source interval to the registered artifact.
It records each actual provider invocation through the existing cost recorder.
Cost facts include submitted duration, audio bytes, source offset, artifact ID, and submission ID.
The price uses the configured base Scribe rate without keyterm charges.
Provider failures retain their attempt cost facts.
Completed-result reuse makes no provider call and creates no additional request cost fact.

The ledger stores the complete validated result before returning success.
The registered consumer validates stored provenance identity, offset, and duration before returning reused results.
It returns source-level results.
`persistSermonSubmission()` now saves these results and queues project analysis atomically.
Costs use workspace ownership and source identity because projects can share one source.
No production entry point invokes this function yet.
