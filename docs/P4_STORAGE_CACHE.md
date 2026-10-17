# P4 source storage cache

The shared `getStorageProvider()` factory can now wrap storage with `CachedStorageProvider`.
`STORAGE_CACHE_MAX_BYTES=0` keeps caching disabled.
A positive value also requires `STORAGE_CACHE_ROOT`.
Choose capacity from measured source sizes, concurrent work, and available disk space.
No production capacity follows from the small test fixtures.

## Behavior

Each materialization checks current object identity before cache lookup.
S3 identity uses ETag, version ID when available, and byte count.
The download uses `IfMatch` and the inspected version ID.
The response must match that identity.
An identity failure never triggers an unconditional retry.
Local storage uses SHA-256 and byte count.
Both providers enforce the declared size during conditional transfers.

The cache calculates a SHA-256 checksum after each acquisition.
Concurrent callers for the same key and identity share that acquisition within one process.
Every caller receives a separate file copy.
The cache verifies that copy against the acquired checksum.
Caller deletion or modification cannot alter cached bytes.
Missing or changed source objects cannot return an old cached version.

The cache reserves declared bytes before acquisition.
It evicts the least recently used object that has no active reader.
Active downloads and copies retain their entries until completion.
Oversized objects and capacity pressure use an uncached download.
Providers without usable object identity also bypass caching.
Empty objects do not occupy cache entries.
These bypasses return explicit transfer facts.

Writes, moves, and removals through the wrapper invalidate affected entries.
External changes require fresh object identity on the next request.
Failed acquisitions remove partial cache files.
Corrupted copies fail verification and remove the invalid entry after its last reader finishes.
A later request can acquire the source again.

## Costs and cleanup

The acquisition owner reports transferred bytes and a cache miss.
Other successful callers report zero transferred bytes and a cache hit.
FINALIZE, PROBE, TRANSCRIBE, and export processing preserve these facts where they record downloads.
FINALIZE now records its storage acquisition before media probing.
This prevents a later PROBE hit from hiding the first storage transfer.
Known cache-copy failures also retain their transfer facts.
Partial failed acquisitions still use the existing failure-accounting path when exact transferred bytes remain unknown.

Each cache instance creates its own temporary directory under the configured root.
`closeStorageProvider()` waits for downloads and copies before removing that directory.
Normal worker shutdown calls this function.
Other long-running callers must close their cache when their work ends.
Abrupt process termination can leave the owned directory behind.
Automatic recovery of abandoned cache directories remains unfinished.
Do not share a cache root across hosts without an ownership and recovery design.

Capacity limits cached file bytes within one process.
They do not limit caller copies, filesystem allocation, or other processes.
They do not establish measured peak disk usage.
This cache is not the source lease required by P4 item 5.
The separate [source lease service](P4_SOURCE_LEASE.md) now provides batch ownership through the cleanup journal.
The cache also does not coordinate the derivative build required by item 6.

## Verification

Real local-file tests cover concurrent acquisition, independent copies, eviction, changed content, deleted sources, and failed transfers.
They also cover corruption, pinned entries, capacity bypass, shutdown, and transfer-cost facts.
Factory tests verify explicit activation, zero-capacity behavior, and the required directory.
Mocked S3 tests verify conditional requests, response identity, precondition failures, and bounded transfers.
No test contacts S3 or proves production cache performance.

Run the focused storage tests with:

```bash
npx vitest run tests/storage-cache.test.ts tests/storage-cache-factory.test.ts tests/storage-s3-identity.test.ts tests/storage-provider.test.ts tests/storage-read-range.test.ts
```
