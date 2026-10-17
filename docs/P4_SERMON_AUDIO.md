# Exact sermon audio extraction

`extractSermonAudio()` trims one selected corridor from existing mono 16 kHz FLAC analysis audio.
It requires explicit corridor evidence, detector version, confidence, encoder settings, and resource limits.
It does not select a corridor or approve its semantic boundaries.

The extractor converts integer millisecond boundaries into exact sample indices.
It checks the input checksum, byte count, format, clock origin, and measured sample coverage.
The output remains mono 16 kHz FLAC with a zero-based audio clock.
A second decode compares the selected input PCM checksum with the output PCM checksum.
The measured output sample count must equal the requested corridor duration.
The extractor checks the input checksum again after processing.
It removes its temporary directory after failure.

Evidence records the source offset, duration, sample count, input identity, output identity, detector version, confidence, and toolchain.
The evidence checksum binds these facts.
Callers retain ownership of successful local output until publication or cleanup.

`runAnalysisDerivativeBatch()` accepts an optional sermon request.
It creates sermon audio while the original source lease remains active.
The batch registers `SERMON_AUDIO` through the existing conditional publication protocol.
The artifact records byte count, checksum, retention class, expiry, and analysis-artifact identity.
The source lease removes all local output before returning.
Artifact cleanup handles expired sermon audio through the shared registry.

The batch now links sermon trim proof to verified parent analysis-audio mapping.
The parent proof compares the stored FLAC with a separate normalized source audio decode.
The sermon artifact records verified mapping with both evidence checksums.
This verifies audio timing and sample derivation, not semantic sermon-boundary accuracy.
The production PROBE and transcription paths do not yet invoke this optional batch path.
Corridor selection, representative acceptance, and single-artifact Scribe submission remain unfinished.

Three generated-audio tests and 38 source-media-lease database tests passed.
Tests verify exact samples, source offset, changed-input refusal, resource limits, registry publication, one acquisition, and retention cleanup.
Type checking, focused lint, and the worker build passed.
The test corridor is synthetic and does not establish sermon-boundary accuracy.
