# Verified local candidate ranges

`extractCandidateRange()` now extracts one explicit source interval from local media.
The caller supplies source identity, original dimensions, duration, clock origin, and resource limits.
The caller selects `stream-copy`, `prefer-stream-copy`, or `lossless-mezzanine` explicitly.
The older `extractLosslessCandidateRange()` entry point still requires `lossless-mezzanine`.
No production worker calls this function yet.

## Media and timestamps

The extractor writes a NUT container.
Stream-copy mode keeps the encoded source streams.
Lossless mode writes FFV1 video and PCM float64 audio.
It preserves original video dimensions and absolute media timestamps.
It does not reset the range clock to zero.
It supports one video stream and at most one audio stream.
Additional video or audio streams require explicit selection before extraction.

Video boundaries use exact source time-base ticks.
Fractional milliseconds remain exact throughout conversion.
Audio boundaries use the first sample at or after each interval boundary.
The extractor keeps the audio sample clock and does not resample audio.
It accepts decoded integer samples through 32 bits and floating-point samples through 64 bits.
Unsupported decoded sample formats cause errors.

The function reads local source bytes before and after processing.
A changed checksum, byte count, or original dimension causes an error.
Every process has explicit time and output limits.
Completed file and proof limits reject excessive outputs.
Those limits do not impose an operating-system disk quota during encoding.

## Content proof

The extractor independently decodes the selected original interval and completed range.
It compares raw video frame checksums and PCM float64 audio checksums.
The proof also compares frame timestamps, durations, dimensions, audio clocks, and channel layouts.
Audio proof blocks use 1024 samples, with no tail padding.

Matching short files cannot pass the coverage check.
The first video timestamp must equal the requested start.
Consecutive frame durations must cover the interval without gaps.
The last frame must end at the requested end.
Unproven coverage causes an error and removes the owned output directory.

The returned evidence records file identity, exact interval, original dimensions, clocks, frame counts, and audio sample counts.
It also records decoded-content and toolchain checksums.
Visual quality remains `NOT_REVIEWED`.
The caller owns successful output files, normally through a source lease directory.

## Tests and remaining work

Ten generated-media tests verify content identity, fractional clocks, nonzero origins, dimensions, limits, and failure cleanup.
The coverage tests reject false source durations and starts between video frames.
The planning and extraction test files contain 27 tests.

Copy-first mode accepts copied media only after all decoded-content and coverage checks pass.
Its tests include aligned H.264 and PCM packets, with both original codecs preserved.
Fractional and nonzero timestamp tests also pass in copy-only mode.
Unsafe copy-only requests fail without encoding a replacement.
Copy-first mode records a rejected copy before an explicit lossless fallback.
It deletes the rejected local output before the fallback starts.
Timeouts, size limits, and detected resource errors do not trigger the fallback.
The result records requested mode, accepted mode, and attempt outcomes.
These records remain local until artifact publication integrates them.
Both paths decode source and output media for verification.
Stream copying avoids encoding, but it does not remove verification cost.
Production cost and resource measurements remain necessary.
Variable frame timing can fail the strict coverage proof and needs further support.
Negative source clock origins remain unsupported.
Sources without audio during the selected interval can also require separate handling.
The [range batch](P4_RANGE_BATCH.md) now registers ranges and preserves exact extraction evidence.
Human visual comparison, color metadata review, and export integration remain unfinished.
The batch registers contained integer coverage and binds it to exact fractional mapping evidence.
No result from this function permits original deletion.
