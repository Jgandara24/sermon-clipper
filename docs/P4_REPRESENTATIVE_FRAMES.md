# Registered representative images

`extractRepresentativeFrames()` extracts selected full frames from the shared proxy.
The caller supplies source timestamps, lossless WebP settings, execution limits, and output-size limits.
The function supplies no production sampling or grouping thresholds.

The extractor maps source timestamps to artifact timestamps.
It selects exact existing frames on an integer millisecond clock.
Missing frames cause errors instead of substitution with nearby frames.
Repeated, unordered, out-of-range, and excessive requests also cause errors.
A request can contain at most 1000 frames.

## Pixel verification

One FFmpeg process produces lossless WebP images and SHA-256 proofs of the selected BGRA frames.
The extractor decodes each WebP and compares its BGRA checksum and dimensions with the proxy-frame proof.
It rejects any mismatch.
The extractor preserves the complete proxy frame without resizing or cropping.
This proof covers the proxy pixels, not the original recording's visual quality.

The extractor records each encoded file's checksum, byte count, dimensions, source timestamp, and decoded-pixel checksum.
It checks the proxy input identity before and after extraction.
Every child process has explicit time and output limits.
Handled failures remove only the directory created by that extraction call.
The size limits reject oversized completed outputs.
They do not impose an operating-system disk quota during encoding.

## Source-batch integration

Evidence settings accept an optional `representatives` configuration.
The batch selects the first sample from each computed frame group.
It extracts those images before releasing the source lease.
No additional original acquisition occurs.

Each image receives a `SPARSE_FRAME` registry record before upload.
The record uses `ANALYSIS` retention and the caller's analysis expiry date.
Publication verifies stored bytes before marking the image ready.
Publication evidence records the proxy artifact, sampled timestamp, dimensions, and pixel-equality proof.

The source interval uses a one-millisecond marker at the sampled timestamp.
That marker identifies an instant; it does not claim a one-millisecond frame duration.
Source mapping remains `DECLARED`, and visual quality remains `NOT_REVIEWED`.
The returned batch result links current group and sample indices to the published artifact.
Grouping membership stays separate from immutable image identity.
Identical images can therefore serve later grouping results without replacing earlier publication evidence.

The lease removes local image files before returning persistent records.
Repeated batches verify and reuse existing image artifacts without uploading them again.
They still rebuild local outputs before reuse checks.

## Verification and limits

Six generated-media tests passed.
They verify exact timestamps, nonzero clocks, pixel equality, dimensions, checksum identity, limits, and failure cleanup.
Forty-two database tests passed with representative publication added to the complete source-batch fixture.
That fixture verified retention, stored checksum, source ownership, original dimensions, one original acquisition, and repeated reuse.

No person, face, or OCR inference runs yet.
No production worker calls this representative path.
Grouping thresholds, model accuracy, runtime budgets, and production integration still require evidence.
A representative image does not establish the content of every frame between samples.
