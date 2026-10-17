# Rendering from verified local ranges

`renderCandidateRangeExport()` now renders a locally materialized candidate range.
The caller supplies a pinned artifact record, source identity, original dimensions, and the existing render parameters.
The renderer does not select an artifact or download storage objects.
The caller must authorize access.
The [range read lease](P4_RANGE_READ_LEASE.md) now protects materialization through `renderPinnedRangeExport()`.
Production export jobs do not invoke this path yet.

## Required evidence

The renderer requires `READY`, `VERIFIED`, `ACCEPTED`, and `RENDER_SOURCE` artifact states.
It refuses deleted, expired, wrong-source, and uncovered artifacts.
It verifies publication bytes, extraction evidence, mapping evidence, source dimensions, and local file identity before rendering.
It never falls back to the original source.

Range evidence now uses canonical JSON hashes, independent of object-key order.
This matters because PostgreSQL JSONB changes object-key order.
Extraction evidence uses `verified-candidate-range-v3`.
Mapping evidence uses `contained-range-mapping-v2`.
The renderer refuses older evidence versions.
Those artifacts require fresh extraction and publication before this renderer can accept them.

## Rendering clocks and audio

Candidate ranges preserve absolute media timestamps.
The renderer maps source times through verified range mapping and enables FFmpeg's absolute timestamp seeking.
Caption timestamps remain on the output timeline.
The existing crop, scale, caption, video encoding, audio gain, and output-duration settings still apply.

The shared audio filter now trims at the selected clip end before loudness normalization.
This bounds normalization input to the requested clip rather than the remaining input recording.
AAC encoding remains lossy, so final audio checksum equality is not a quality requirement.

## Verification

Three generated-media renderer tests passed.
They compare a direct-source render with a range render using a nonzero source clock.
Decoded video frames, captions, and pre-encode selected audio samples match exactly.
Final decoded audio sample counts match.
The generated fixture also passes waveform alignment and gain checks after AAC encoding.
These signal bounds are fixture checks, not production quality approval.

The test renders successfully after removing its generated original file.
It also verifies JSONB-style key reordering and refusal of unapproved, changed, expired, or uncovered ranges.
The approval state in this fixture is simulated.
No production artifact received visual approval.

The related renderer, extraction, and mapping selection passed 23 tests.
The database selection passed 43 tests after canonical evidence hashing changed.
Lint, type checks, and the worker build passed.

Production artifact selection, review evidence, fallback metering, and export-job integration remain unfinished.
Human visual and audio review remains necessary before production approval.
