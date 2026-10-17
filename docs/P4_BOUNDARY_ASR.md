# Local boundary sampling

`sampleAmbiguousBoundaries` provides a separate local whisper.cpp role for Pass A.
It does not select the production caption provider or call Scribe.
It does not choose a corridor or resolve ambiguity.
The caller supplies one or two explicitly ambiguous corridor edges and their evidence checksums.

Each window must contain its requested edge and stay within the available analysis audio.
The sampler rejects repeated edges and overlapping windows.
Explicit limits bound each window and their combined duration.
The combined duration must remain shorter than the available audio.
The sampler never substitutes complete-service audio after a failure.
No duration or threshold default comes from this module.

The model descriptor requires the `BOUNDARY_ASR` role.
The existing verifier checks model bytes and license evidence.
Production use also requires the `/models` volume and production approval evidence.
The caller must keep model files read-only during inference.
The sampler records the local executable checksum.
It uses the existing CLI flags confirmed by the installed `whisper-cli --help` output.
The CLI supports FLAC input and full JSON token output.

The sampler extracts each window from local 16 kHz mono FLAC.
The existing extractor verifies exact sample counts and decoded PCM equality.
Each inference process receives only its extracted window.
Each process has an explicit timeout and standard-output limit.
A shared byte budget bounds accepted JSON files across both windows.
The sampler checks JSON file size before reading its contents.
This check does not impose a filesystem quota while the process writes its file.
The worker still needs an external temporary-storage quota.

Results retain native segment text and subword token probabilities.
They preserve special tokens and do not label token probabilities as word confidence.
Timestamp mapping adds the exact extracted source offset.
Malformed probabilities, missing native fields, and timestamps outside the window cause failure.
Evidence includes source identity, analysis identity, window identity, model identity, executable identity, and extraction proof.
Local paths stay outside the result.
Wall measurements remain separate from the deterministic evidence checksum.
Child CPU time remains unknown.

Success and failure remove temporary extracted audio and JSON outputs.
The caller must register returned evidence before using it to make a corridor decision.
Automatic ambiguity detection and representative evaluation remain unfinished.
No production model or threshold was selected.

Tests use generated FLAC, dummy model bytes, and a simulated local executable.
They verify sample mapping, probability preservation, limits, model checks, deterministic fixture results, failures, and cleanup.
These tests do not measure real recognition quality or production resource use.

## Source batch and preparation

The source batch accepts an optional internal boundary-sampling request.
It requires an initial corridor, window limits, model settings, and a separate resolution callback.
It runs after local evidence and before sermon extraction or Scribe.
It uses the existing analysis audio and source lease without another original download.

The batch first registers sampling evidence as `LOCAL_EVIDENCE` with `ANALYSIS` retention.
The document links the registered analysis artifact and its checksum.
The resolver receives the verified artifact identity and a separate copy of the sampling evidence.
Sampling evidence still reports unresolved boundaries.
The resolver must return a structured decision with its reason.

A resolved boundary must remain inside its sampled window.
An edge without a sample must retain its initial position.
The batch rejects unsupported boundary changes before sermon extraction.
It registers the accepted decision with the initial corridor and sampling artifact references.
The final corridor evidence checksum binds this complete decision document.
Sermon extraction and the Scribe submission use that final corridor.

An unresolved decision also receives a registered document.
The preparation coordinator creates one open human-review exception and stops without automatic retry.
The exception includes sampling and decision artifact identifiers.
Repeated requests stop at the matching open exception before provider checks or source acquisition.
The failed source session also remains protected.
Resolving the review exception does not automatically recover that session.
The coordinator never substitutes complete-service transcription.

Both documents use byte limits, verified publication, normal analysis retention, and the existing cleanup path.
Their immutable bytes exclude local paths and measured wall times.
Repeated identical execution reuses both artifacts and the completed Scribe submission.
Repeated local sampling and resolution still receive computation records.
Child CPU time and computation prices remain unknown.

Tests supply simulated inference and a simulated resolver.
The controlled PROBE entry does not yet supply this request.
Automatic coarse-region detection, real resolvers, a vendor escalation adapter, and representative quality checks remain unfinished.

Eight selected database cases passed for this integration.
They covered final-corridor use, one Scribe submission, repeated artifact reuse, review gating, invalid decisions, byte limits, and cleanup.
The final review-gate test verified a non-retryable result before another original download.
All 23 selected sampler, model-verification, and measurement tests passed.
Lint, application type checking, the worker build, and whitespace checks passed.

## Real synthetic speech experiment

The adapter also passed one local test with whisper.cpp 1.9.1 and verified `base.en` model bytes.
It recognized all seven expected words from a 4539 ms window.
The generated audio fixture used the installed Samantha voice.
The [report](../evaluation/p4-boundary-asr-fixture-2026-10-16.json) retains model, mapping, token, checksum, and resource evidence.
Temporary model files and extracted windows were removed afterward.

Repeat the experiment with a new output directory:

```bash
python3 scripts/evaluate-boundary-asr-fixture.py OUTPUTS/P4_BOUNDARY_ASR_NEW
```

The script rejects an existing output directory before downloading model bytes.
It checks pinned license evidence and downloaded model identity before inference.
The native resource measurement covers the complete adapter process tree, including Node.js and media tools.
The result does not establish representative boundary recall or production resource budgets.

Boundary decision publication now records immutable `boundaryStatus` metadata.
The visual-escalation ledger accepts only decisions that explicitly record `AMBIGUOUS`.
Older artifacts without that metadata do not authorize escalation.
An explicit `prepareVisualEscalation` callback enables one ledger-controlled escalation after an unresolved local decision.
The default path still stops for human review.
