# Local video evidence

`extractVideoEvidence()` reads a local proxy and returns source-time facts.
It uses FFmpeg scene, black-frame, freeze, and signal-statistics filters.
The [FFmpeg filter reference](https://www.ffmpeg.org/ffmpeg-filters.html) defines their metadata fields and parameters.
The implementation also checks the installed filter interfaces.

The caller supplies every detection threshold, minimum duration, thread count, timeout, and metadata buffer limit.
No production defaults follow from the test fixtures.
The input includes a checksum, byte count, and explicit artifact-to-source mapping.
The detector checks the input checksum before and after processing.
It permits only regular local files and file/pipe protocols.
It preserves artifact timestamps before converting them into source time.
It rejects frames outside the declared source interval.

## Returned facts

Scene facts contain source timestamps and scene scores.
Black-frame facts contain intervals that satisfy the caller's minimum duration.
Freeze facts contain detected static-image intervals.
Motion facts contain the mean absolute luma difference between successive decoded frames.
The filter converts pixels to eight-bit YUV before measuring these differences.
This metric does not identify people, camera movement, or semantic activity.

Each decoded frame contributes one motion sample.
The detector does not reduce frame frequency.
The result records frame count and first and last observed timestamps.
Trailing black and freeze intervals stop at the last observed frame timestamp.
Their `endReason` is `LAST_OBSERVED_FRAME`.
The detector does not extend those intervals across an unobserved source tail.
It does not infer the duration of the last video frame.

The result includes detector version, configuration hash, toolchain hash, and input identity.
The configuration hash includes detection settings and thread count.
Timeout and buffer limits do not change content identity.
Malformed metadata, missing metrics, changed inputs, and buffer overflow cause errors.
They do not produce empty success results.

## Verification and limits

Seven real-media tests use generated black, white, and moving frames.
They test scenes, black intervals, static intervals, motion differences, and source offsets.
They also test nonzero artifact timestamps, changed identity, interval bounds, explicit duration thresholds, and buffer overflow.
These fixtures do not establish sermon recall or production thresholds.

The detector currently returns facts in memory.
The caller must budget metadata and result memory for the entire input.
Streaming extraction and production resource measurements remain unfinished.
No production worker calls this detector yet.
Region persistence remains unfinished.
[Sparse frame hashes](P4_FRAME_HASHES.md) now provide local similarity facts and representative grouping.
[Audio evidence](P4_AUDIO_EVIDENCE.md) now provides local silence and waveform facts.

The optional [local evidence batch](P4_LOCAL_EVIDENCE.md) now persists these facts in a registered JSON artifact.
Individual detector functions still return their facts in memory.
