# Sparse frame hashes

`extractFrameHashes()` samples existing video frames from a local proxy.
The caller supplies the sampling interval, frame limit, thread count, timeout, and output buffer limit.
The extractor checks input checksum and byte count before and after processing.
It permits only local files and file/pipe protocols.
It does not create duplicate frames to meet a requested frame rate.

Sampling uses integer millisecond timestamps.
Each selected timestamp maps into the declared source interval.
The extractor rejects missing, unordered, or out-of-range timestamps.
It reads one frame beyond the requested frame limit to detect overflow.
An exceeded limit causes an error instead of a partial success result.

## Hash facts

The extractor scales each selected frame to nine by eight grayscale pixels with area filtering.
It compares each pixel with its right neighbor to produce a 64-bit difference hash.
A comparison sets its bit when the left pixel exceeds the right pixel.
The result stores the hash as 16 hexadecimal characters.

Each sample also contains mean grayscale brightness and a SHA-256 checksum of the resized grayscale pixels.
That checksum does not identify the original full-resolution frame.
The source-file checksum remains separate.
Results include algorithm version, configuration hash, toolchain hash, settings, and source mapping.

Difference hashes can collide.
Uniform black and white frames have the same difference hash but different mean brightness.
Grayscale hashes also discard color information and fine details.
These facts do not establish slide identity, semantic similarity, or video eligibility.

## Representative grouping

`groupFrameHashes()` groups consecutive sampled points.
The caller supplies maximum hash distance, mean-brightness difference, and group duration.
No production thresholds follow from the fixture tests.
Every sample receives exactly one group.
The first sample represents its group.
Later samples compare with that representative, which prevents gradual similarity changes from joining distant endpoints.

The result identifies representative indices and member indices.
It records algorithm version, configuration identity, and input identity.
Groups describe sampled points, not continuous source intervals.
The grouping function does not run inference or skip safety checks.
Representative image extraction now has a [registered batch path](P4_REPRESENTATIVE_FRAMES.md).
Measured inference policies remain unfinished.

## Verification and limits

Ten hash and grouping tests passed.
They cover known bit patterns, frame timestamps, brightness collisions, source offsets, and nonzero artifact clocks.
They also test sampling drift, frame limits, changed bytes, output limits, and grouping behavior.
Five process tests verify binary bytes, output overflow, and child termination.
Output overflow now preserves its error code instead of appearing as a timeout.

The extractor buffers sampled pixels and metadata within the caller's limit.
It still decodes the input video to select frames.
Sampling reduces stored measurements, not necessarily decoder work.
Production resource measurements remain necessary.
No production worker calls these functions yet.
Inference integration remains unfinished.

The optional [local evidence batch](P4_LOCAL_EVIDENCE.md) now persists these facts in a registered JSON artifact.
Individual detector functions still return their facts in memory.
