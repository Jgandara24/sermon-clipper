# PR #106 package review

Reviewed against main `1d77d399a10ab70591974c3a8b4dc110a34e4109`, from PR head `f640d5e`.

Scope: P2 slot preparation, source copy, shared-transcript protection, SRT staging and handoff, sandbox census, local timing tools, pinned release rehearsal, and local cleanup protocol/journal. Production access and cleanup activation were excluded. The P2 manual plan and unrelated files remain uncommitted.

## Standards review

- Fixed source-copy lock order. Apply now locks the project before the source, as transcription and analysis do. A concurrent PostgreSQL regression failed with the old order and passed with the correction.
- Corrected the SRT document. Transcript replacement and ANALYZE enqueue now commit together. Provider work and the runner's terminal update still have separate retry limits.

No additional concrete documented-standard violations were confirmed in the reviewed security and isolation paths.

## Specification review

- Fixed sandbox preparation using stale machine clips. The selected clip and the next reserve must match the current source transcript revision. A stale next reserve is refused rather than skipped. Three tests failed before the fix and passed afterward.
- Corrected the stale SRT handoff statement noted by both review axes.

The planned cleanup writer integration, remote provider proofs, and human media checks remain explicitly outside the completed local subset. Their absence is not a claim that the cleanup feature is ready for activation.

## Database review

- Fixed mandatory audit atomicity. A prior transaction's event previously satisfied a later transition. The database now stamps each event with its transaction ID and requires the current transaction. The regression reproduced the old acceptance.
- Fixed unused gate backfill blocking normal source deletion. Only an unused generation-0 ACTIVE gate without sessions or gate audit can follow its deleted source. Direct gate deletion and deletion of recovery history remain refused. The prior foreign key failed the compatibility test.
- Added an abort constraint. Owned gates, HELD operation reservations, and unresolved source sessions must be resolved before ABORTED can commit.

The cleanup migration has not been deployed. Its SQL was corrected in place. Do not edit the checksum of a migration already deployed in another environment; reconcile any such environment separately before release.

## Validation

- Source-copy integration: 20 passes in an owned local PostgreSQL cluster.
- Sandbox integration: 26 passes in an owned local PostgreSQL cluster.
- Journal: 62 local PostgreSQL checks, including SQL and Prisma failure recovery, dump/restore, competing claims, audit rollback, and source-deletion compatibility.
- Schema validation and generated client checks use no database connection. Full TypeScript, lint, unit, and PR CI results are recorded on the review commit.

All local test clusters were removed. Linux CI applies the candidate migration and runs the application integration suite. The macOS journal and pinned rehearsal tests retain their separate local evidence and limits. A passing build does not establish production writer exclusion or media quality.

## Decisions and production checks for the operator

1. Before a remote storage test, identify an isolated private bucket/account, limited credentials, and a cost limit. No remote write test is authorized by this review.
2. Before cleanup, choose the backup destination, retention period, and person responsible for restoration. Verify exact backup bytes and the private six-key scope. Production deletion requires separate approval.
3. Before release, approve a coordinated maintenance window and verify all old writers and web callbacks are stopped. Verify production database backup/restore, deployment restart controls, and the rollback procedure. No code-only rollback is safe after new transcript revisions or retirement state.
4. After an approved release, complete the caption/audio review and the three P2 proofs. Preserve the source-date mismatch note and transcription-hold checks. Processing, rendering, publishing, and the 30-day phase each retain their existing authorization limits.

No operator decision is needed to complete this local review commit. Cleanup adapter and writer integration remain engineering work; they do not require the operator to approve each local step. They must be complete before cleanup activation.
