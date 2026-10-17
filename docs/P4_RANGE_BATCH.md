# Registered candidate range batches

`runCandidateRangeBatch()` acquires one local source copy through the existing source lease.
It discovers keyframes, plans merged ranges, extracts ranges, and publishes each result sequentially.
The caller supplies retained candidates, handles, clock origin, duration, extraction settings, limits, and expiry.
No production worker invokes this batch yet.

The batch verifies original dimensions before extraction.
It never writes range dimensions into the source record.
Each range receives a `CANDIDATE_RANGE` registry record before upload.
Stored-byte verification precedes `READY` publication.
Ranges use `RENDER_SOURCE` retention and the caller's expiry date.
Visual quality remains `NOT_REVIEWED`.

## Exact coverage and registry mapping

Extraction retains exact fractional timestamps and absolute media clocks.
The registry stores only integer-millisecond intervals.
The batch therefore registers the integer interval fully contained within each extracted range.
It rounds the start upward and the end downward.
It refuses empty contained intervals.
It checks that every requested candidate remains inside registered coverage.

For example, an extracted interval from 1001/3 through 2002/3 milliseconds registers coverage from 334 through 667 milliseconds.
Publication evidence retains the exact interval and the decoded-content proof.
The mapping preserves the source clock offset, including nonzero origins.
The verified mapping hash binds that mapping to extraction evidence.
Canonical JSON hashing preserves both proofs across PostgreSQL JSONB key reordering.
This mapping does not grant visual approval or permission to delete the original.

Range identity includes the exact interval, source clock origin, extraction mode, threads, and toolchain checksum.
Different fractional intervals cannot share an identity merely because their integer coverage matches.
Operational limits do not change range identity.

## Coverage manifest and reuse

The batch publishes a JSON coverage manifest after all ranges succeed.
The manifest contains the complete plan, candidate coverage, range artifact IDs, checksums, and mappings.
It uses `LOCAL_EVIDENCE` with `RENDER_SOURCE` retention.
Candidate membership belongs to the manifest, so range records can serve later plans.

Repeated batches rebuild local files and verify existing stored artifacts before reuse.
They preserve original publication ownership and avoid duplicate uploads.
The source lease removes all local files before returning persistent records.
The batch returns source acquisition and publication download results for later transfer accounting.
The existing publication and lease protocols retain uncertain ownership after failed operations.
Interrupted batch recovery remains unfinished.

## Verification and remaining work

Two mapping tests verify contained fractional coverage and invalid mapping refusal.
Forty-three database tests passed with the range batch fixture included.
That fixture verified one source acquisition, merged candidates, exact mapping, stored bytes, manifest links, and repeated reuse.
It also verified artifact cleanup while retaining the original source.
Lint, type checks, and the worker build passed.

Production candidate selection, measured settings, export integration, and human visual comparison remain unfinished.
The caller still supplies source duration and clock origin.
Production integration must derive those values from authoritative probe evidence.
The batch does not prove that callers supplied every retained candidate.
The batch alone does not permit earlier original deletion.
The separate [deletion proof](P4_EARLY_ORIGINAL_DELETION.md) reads retained candidates from the database.
