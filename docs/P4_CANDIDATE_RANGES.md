# Candidate range planning

`planCandidateRanges()` plans source ranges for retained candidates.
Callers supply the source checksum, duration, candidates, handles, and source-clock keyframe timestamps.
The function supplies no production handle defaults.

The planner adds handles and clamps them to source bounds.
It moves each start to the preceding keyframe.
It moves each end to the next keyframe or source end.
Exact keyframe boundaries stay unchanged.
Missing preceding keyframes cause errors.

The planner merges overlapping and touching padded ranges.
Each candidate keeps its requested interval, handled interval, padded interval, and merged range index.
Planned relative offsets describe where a candidate belongs within that range.
They do not prove the mapping of an extracted file.

The result includes total range duration and a deterministic SHA-256 plan identity.
Candidate input order does not change that identity.
The identity covers source bytes, duration, handles, keyframes, ranges, and coverage.
The planner rejects duplicate candidate IDs, invalid intervals, and invalid keyframe clocks.

Nine tests cover padding, merging, coverage, source bounds, exact timestamps, deterministic identity, and safe integer arithmetic.
The coverage test checks 40 interval layouts with 30 candidates each.

Local keyframe discovery now uses `discoverSourceKeyframes()`.
An explicit [lossless extraction path](P4_RANGE_EXTRACTION.md) now verifies decoded content and requested video coverage.
Verified stream copying now shares the extraction checks.
Production integration remains unfinished.
A keyframe flag alone does not prove safe stream copying across open GOPs.
Extracted files still need checksum, duration, coverage, dimensions, mapping, and visual-quality verification.
No worker uses this planner yet.
This plan never permits original deletion.

## Local keyframe discovery

The scanner reads packet timestamps and keyframe flags from the first video stream.
It checks local source bytes before and after scanning.
Callers supply an explicit source clock origin and duration.
The scanner preserves original dimensions and records the stream time base.
Its evidence includes the source checksum, byte count, packet count, toolchain checksum, and discovered timestamps.
Operational limits do not change evidence identity.

The scanner uses exact integer arithmetic for timestamp conversion.
It rejects missing timestamps, discarded packets, corrupt packets, duplicate keyframes, and timestamps outside the source.
It preserves fractional-millisecond keyframes as reduced fractions.
The planner uses those exact fractions for padding, merging, candidate offsets, and total duration.
Integer timestamps remain numbers.
Fraction timestamps use decimal-string `numerator` and `denominator` fields, measured in milliseconds.
No planning step converts fractions to floating-point seconds.
Equivalent fractions produce the same plan identity.
The scanner and planner now use version 2 identities.

Every scan has explicit time, output-size, and packet-count limits.
The packet-count limit rejects completed scan output; it does not stop the scan early.
Four generated-media tests verify discovery, original dimensions, nonzero origins, planning integration, checksum refusal, and limits.
Together with nine planner tests and four exact-clock tests, 17 tests passed.
The generated-media test includes 30000/1001 frame-rate footage and fractional keyframe positions.
The exact-clock tests check arithmetic near the safe integer limit and JSON serialization.
No production worker calls the scanner yet.

Extraction must preserve these exact seek positions in the source time base.
The integer-millisecond artifact registry still needs explicit mapping evidence for fractional range boundaries.
Rounding an exact plan into a registry interval does not prove extracted content coverage.
