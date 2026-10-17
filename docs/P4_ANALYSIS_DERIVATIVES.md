# Coordinated analysis derivatives

`buildAnalysisDerivatives()` creates analysis audio and a source proxy from one materialized source.
One FFmpeg process creates both outputs.
The source lease owns the input file and output directory.
The build does not acquire another source copy.

The analysis output uses 16-bit FLAC, one channel, and 16,000 samples per second.
The proxy uses H.264, a 480-pixel height, and AAC audio.
Scaling preserves the complete frame and its display aspect ratio.
The video output preserves frame timestamps instead of requesting a new frame rate.
The builder does not write `SourceVideo.width` or `SourceVideo.height`.
It refuses a source whose probed dimensions contradict known original dimensions.

## Explicit settings

The caller must supply CRF, encoder preset, proxy audio bitrate, FLAC compression level, thread count, and timeout.
The function supplies no production defaults for those settings.
The settings in tests apply only to generated fixtures.
Measured resource and quality evidence must determine production settings.

Artifact configuration identity includes output settings, derivation version, and a hash of FFmpeg version output.
The timeout does not affect content identity.
Results include each file's SHA-256 checksum, byte count, format facts, and local path.
They also include encoding wall time, original probe facts, and the source presentation origin.
The wall time excludes output inspection.
The builder does not claim measured child CPU time, peak memory, or peak disk use.

## Source time

The builder preserves input timestamps and subtracts the common container origin once.
Both audio outputs share timestamp-aware resampling.
The filter preserves leading silence and pads the source's trailing silence.
Audio duration must match the normalized source duration within one analysis sample and probe rounding.

Nonzero-origin MP4 files can report the timeline endpoint as container duration.
The builder therefore uses stream endpoints when their clocks and durations are available.
It refuses incomplete duration clocks for a nonzero-origin source.
It does not add the origin as extra audio duration.
It keeps observed container and stream start times in the returned facts.

Derivation `analysis-audio-proxy-v2` also performs a separate source audio decode.
It applies the recorded normalization filter and compares PCM checksums with the stored FLAC decode.
It checks the exact FLAC sample count and zero-based clock.
The registered audio interval stops at the last complete millisecond within the source duration and measured audio samples.
The evidence binds source bytes, audio bytes, source origin, normalization filter, samples, and toolchain.
The batch registers analysis audio with verified mapping evidence.

The proxy still keeps declared mapping and unreviewed visual quality.
Audio proof does not establish proxy visual quality.
The additional source decode uses the same local materialization and adds no remote download.
It does add local processing work, which needs representative resource measurements before production activation.
The builder does not make source regions or video eligibility decisions.

## Failure and integration

The builder accepts only a regular local source file.
FFmpeg and ffprobe permit only file and pipe protocols for these reads.
Every child process has a timeout and an output limit.
The builder settles all inspection readers before cleanup.
It removes its output directory after a handled failure.
The source lease removes the successful outputs when its callback finishes.
The callback must therefore publish or consume those files before returning.

No production PROBE caller uses the builder yet.
`runAnalysisDerivativeBatch()` connects the source lease, builder, and publication service.
The caller supplies encoding settings and separate analysis and preview expiry dates.
The batch acquires the original once, builds both outputs, and publishes them before releasing the lease.
Publication records own their storage keys before each upload starts.
The batch stores format facts, original dimensions, settings, source clock, and toolchain identity in publication evidence.
It returns persistent records and transfer results instead of temporary file paths.
It leaves original dimensions unchanged.

A repeated batch verifies existing output identity and bytes before reuse.
It preserves the original publication owner and evidence.
It does not upload existing ready objects again.
This implementation still rebuilds local derivatives before reuse checks.
Avoiding that repeated encoding requires earlier configuration lookup and a retained-artifact reader.
A changed ready object causes an error without replacement.

A failed second upload preserves the first ready artifact and the second pending record.
The source session records `UNCERTAIN`.
Recovery and production cleanup integration remain incomplete.
The local [artifact cleanup service](P4_ARTIFACT_CLEANUP.md) now has verified deletion tests.
These gaps prevent production integration.
No local file from these tests entered production storage.

## Verification

Six real-media tests passed in `tests/analysis-derivatives.test.ts`.
They verify output formats, checksums, dimensions, settings identity, and owned-output cleanup.
Colored strips at both source edges remain visible in the proxy.
A shifted-timestamp fixture checks nonzero-origin normalization.
A delayed-audio fixture checks silence before the tone and activity afterward.
These fixture checks do not replace human review of real sermon quality.

The source-lease database suite also built real outputs under one acquisition.
It verified that original source dimensions remained unchanged and temporary outputs disappeared after lease completion.
The database suite also tests complete batch publication and repeated batches.
It tests a failed second upload and rejects changed ready objects.
All twenty-four source-session tests passed.
ESLint, the full project type check, and the worker build passed.

The batch also accepts explicit settings for a [registered local evidence document](P4_LOCAL_EVIDENCE.md).
That path measures all seven local fact categories before the source lease ends.
