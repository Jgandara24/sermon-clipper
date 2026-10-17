# Coordinated sermon preparation

`prepareSermonSource()` connects the current P4 components under one source acquisition.
The caller supplies a selected corridor, detector evidence, explicit settings, retention dates, and the Scribe provider.
The coordinator checks project ownership before acquiring the source.
It does not select a corridor or choose production settings.

The shared batch builds and registers analysis audio, the uncropped proxy, local evidence, and configured representative frames.
It then extracts and registers the sermon audio.
An awaited consumer submits that audio through the durable ledger and records request cost facts.
It measures transcript structure while the selected audio remains local.
The consumer returns persistent evidence without local file paths.

The source lease completes all local readers and writers before cleanup.
Only after cleanup does the coordinator persist the transcript and queue project analysis.
This order prevents analysis handoff before preparation cleanup completes.
Original source dimensions remain unchanged.

Repeated preparation reuses registered artifacts, completed submissions, transcripts, and analysis jobs.
It makes no second Scribe request for the same completed submission.
It currently reacquires the source and rebuilds local derivatives before those reuse checks.
Avoiding that repeated local work still needs retained-artifact orchestration.
A completed durable response remains available if final transcript persistence fails.
Uncertain submission or source-session outcomes still require recovery support.

PROBE invokes this coordinator only when `P4_SERMON_PREPARATION_ENABLED` is exactly `true`.
Automatic corridor selection, measured model choices, production activation, recovery, and representative acceptance remain unfinished.
The example environment keeps this switch false.

All 44 source-media-lease database tests passed.
The coordinator test used real generated media and an injected Scribe response.
It verified publication before submission, one acquisition, post-cleanup handoff, complete persistence, and repeated-result reuse.
It also checked unchanged original dimensions and one request cost fact across repeated preparation.
No paid request ran.

## Storage transfer accounting — 2026-10-16

The coordinator now requires explicit storage provider, transfer prices, and attempt settings.
It records source downloads, conditional artifact uploads, and publication verification downloads.
Repeated preparation records its repeated downloads without recording uploads that artifact reuse skips.
Provider transfer counts preserve cache hits and known partial failures.
Unknown failed transfers remain unpriced with `transferBytesKnown: false`.
The records include project and source identifiers.
The wrapper preserves storage identity checks and conditional upload behavior.

Four transfer tests passed.
The generated-media database test checks one upload per artifact and verification downloads on both preparation runs.
Local derivative computation and storage request charges still need accounting before production PROBE integration.

## Local stage measurements — 2026-10-16

Preparation now records elapsed time for five local stages:

- Analysis audio and proxy construction.
- Local evidence construction.
- Representative frame extraction.
- Sermon audio extraction.
- Transcript structure construction.

Each record identifies the project, source, operation, attempt, and outcome.
Failed operations retain their original error and receive a failed measurement.
Repeated preparation records the local work that it repeats.
The stage intervals exclude artifact publication and paid transcription.
They include local validation and subprocess waits within each stage.

These records remain unpriced.
They leave `cpuTimeMs` null because Node.js CPU counters exclude FFmpeg and other child processes.
Machine billing and child-process CPU measurements remain unfinished.
Storage request charges also remain unfinished.

The measurement unit test and focused generated-media database test passed.
Lint, type checking, and the worker build passed.
The database test verified ten computation records across two preparation runs.

## Controlled PROBE entry — 2026-10-16

`P4_SERMON_PREPARATION_ENABLED=true` selects preparation before the legacy PROBE download.
This path requires `processingConfig.sermonPreparation` with version `sermon-preparation-v1`.
The object requires `derivatives`, `localEvidence`, `sermon`, `structureAudio`, `structureBoundaries`, and `retention`.
Each field uses the existing preparation schema.
Retention requires future ISO timestamps for `analysisExpiresAt` and `previewExpiresAt`.
No model, threshold, corridor, or retention default comes from this path.
The configured primary provider must be Scribe.

Missing settings, a missing uploaded SRT file, or preparation failure stops the job without automatic retry.
One open `SERMON_PREPARATION_REQUIRED` exception records the project and job.
The path never queues legacy TRANSCRIBE or silently submits the complete service.
An uploaded SRT now uses its own derivative-first path; see below.
A source with existing human work fails the reanalysis check before acquisition or provider work.

Preparation registers its artifacts without assigning sermon audio to the legacy `audioKey`.
It does not assign a representative frame to the legacy `thumbnailKey`.
Proxy preview integration exists; see the proxy preview notes.
The switch stays false in `.env.example`.
Production activation still requires representative acceptance, measured policy, complete accounting, and recovery support.

All 46 source-media-lease database tests passed after this integration.
The PROBE test used generated media and an injected provider.
It verified completed-submission reuse without another provider call or legacy transcription job.
Two refusal tests verified missing settings and uploaded SRT handling before source acquisition.
Lint, type checking, and the worker build passed.

## Optional OCR in preparation — 2026-10-16

`prepareSermonSource` now accepts an optional `ocr` request from an internal caller.
The request supplies model settings, document limits, and a representative-selection callback.
The source batch completes OCR publication before it extracts sermon audio or submits Scribe work.
Invalid selections stop preparation before a paid request, transcript creation, or analysis handoff.
OCR uses the existing source acquisition and storage accounting.
The coordinator records successful and failed OCR wall time with project attribution.
Repeated preparation records repeated OCR computation while reusing its registered artifact and completed Scribe submission.

Project JSON does not accept executable callbacks or OCR settings.
The controlled PROBE entry still needs an approved automatic selector and model configuration.
Automatic selection, production activation, and representative quality evidence remain unfinished.

Seven selected database cases passed with generated media and simulated OCR and Scribe responses.
They verified OCR publication before Scribe, one original download per run, completed-submission reuse, and failed-selection accounting.
The failed-selection case created no Scribe submission, transcript, or analysis job.
Artifact registration, retry reuse, document limits, and cleanup regression cases also passed.
Lint, application type checking, the worker build, and whitespace checks passed.
The temporary database stopped before its directory was removed.

## Optional boundary sampling — 2026-10-16

An internal caller can supply `boundaryAsr` with ambiguous windows and a resolution callback.
Preparation registers sampling evidence and the resulting decision before extracting the final sermon corridor.
Only a resolved decision can reach Scribe.
Unresolved decisions create one human-review exception and stop without automatic retry.
The exception retains the registered evidence identifiers.
The controlled PROBE entry still needs automatic detection and approved model configuration.
See [local boundary sampling](P4_BOUNDARY_ASR.md).

## Optional visual boundary resolution — 2026-10-16

An explicit boundary request can now prepare one visual escalation after local sampling leaves ambiguity.
The durable ledger controls dispatch and repeated-result reuse.
Preparation registers the final visual decision before extracting the final corridor or calling Scribe.
Continued ambiguity, refused budgets, invalid responses, and uncertain requests stop for human review.
The exception records the escalation identifier when available.
No real vendor adapter or production activation was added.
See [visual escalation](P4_VISUAL_ESCALATION.md).

## Uploaded SRT path — 2026-10-16

A project with `srtOverrideKey` no longer stops controlled PROBE.
`prepareSrtSource()` checks the project, the reanalysis rule, and the stored SRT object before acquiring the original.
One source acquisition builds and registers analysis audio, the 480p proxy, and local evidence.
No sermon corridor, sermon audio, Scribe request, or other speech provider runs.
After the source lease ends, the path queues the existing `transcribe:{projectId}` TRANSCRIBE job.
That job parses the uploaded SRT; it needs no audio key and no provider.
Cost facts use the scope `srt_preparation`.

A missing SRT object stops the job with one open `SERMON_PREPARATION_REQUIRED` exception and no acquisition.

Two database cases passed with generated media.
The present case verified one acquisition, three registered derivative kinds, no sermon audio or submission, and a completed session.
It then ran the queued TRANSCRIBE job and verified an `srt_upload` transcript and unchanged original dimensions.
A test spy failed any speech-provider resolution; none occurred.
The missing case verified refusal before acquisition and no TRANSCRIBE job.

The SRT transcript uses the legacy persistence path.
Since 2026-10-17 it records complete capability and provenance facts; the text and cue timing are `user-supplied`.
