# Six-file cleanup: local command and backup plan

## Status

Local fixture implementation only. Production execution is disabled.

The command creates its own temporary directory. It creates six small synthetic files and six verified backups. It then removes the six synthetic files and updates local JSON records. It preserves a separate P2 evidence file.

The command does not import Prisma, the application environment, or a storage SDK. It does not read `.env`. It has no production mode, remote adapter, bucket option, database option, or input-path option. It refuses ambient database and storage connection variables. It does not contain production storage keys or account IDs.

The real six-key list remains in the private cleanup plan. Do not copy those keys into this public repository.

## Commands

```sh
npx tsx scripts/cleanup-six-files.ts --fixture
npx tsx scripts/cleanup-six-files.ts --fixture --interrupt after-delete
npx vitest run tests/six-file-cleanup.test.ts
```

Supported interruptions: `before-intent`, `after-intent`, `after-delete`, `before-commit`, and `after-commit`.

An injected interruption throws an exception. The command creates a new store instance and resumes from disk. It then repeats the completed operation to check replay. It prints the temporary evidence directory. It retains the backups, manifest, record file, and P2 evidence there. Unit tests remove only their own disposable directories.

This is exception recovery. It is not a test of a process kill or machine failure. A killed process can leave the lock directory. The command refuses that lock. There is no automatic lock removal or command to reopen an arbitrary directory.

## Exact scope and checks

Each manifest contains two source IDs and three fields per source: `storage_key`, `audio_key`, and `thumbnail_key`. This makes exactly six keys. The manifest binds each key to its source, field, byte count, and SHA-256 hash. It also binds the run ID, fixture bucket, operator, and preserved-record hash.

Validation rejects unknown fields, duplicate keys, extra keys, path traversal, production identities, and changed confirmation hashes. The disk adapter maps keys to flat hashed filenames. It rejects unowned directories and symbolic links. File writes use exclusive temporary files, file sync, rename, and directory sync.

Before deletion, the command checks all six files and backups. It checks source links, reference counts, active jobs, and preserved records. A failure on the sixth item stops deletion of the first item. Each deletion checks the bytes and hash again.

The preserved local records model transcripts, transcript segments, billing history, job history, and P2/P3 evidence. The local model does not query real application tables. Reference counts in this model are fixture inputs, not a production census.

## Concurrency

A directory lock covers the entire operation. A second cleanup request fails while that lock exists. The fixture processing entry point uses the same lock. Cleanup saves a local retirement marker before deletion. Later fixture processing requests for either source fail.

These controls apply only to cooperating fixture operations. They do not block production workers or an unrelated process with filesystem access. Setup and fault-injection helpers can modify fixture files deliberately.

A production adapter must first provide effective exclusion for all source writers, job claims, and new references. A source-row lock alone does not establish this. The reviewed production queue does not use that lock for job claims. The FINALIZE handler can recreate a missing URL source.

The fixture retirement marker is not an existing production database field. Any production retirement mechanism needs separate design and review. This change adds no migration or application behavior.

## Audit and failure recovery

For each file:

1. Save an `INTENT` entry before deletion.
2. Verify the current file and remove it.
3. Clear only the matching source field.
4. Save the `DONE` state and `REMOVED` audit entry together.

The local record store commits the field update and audit entry in one atomic JSON replacement. It updates the source timestamp. A final `COMPLETE` audit entry closes the operation. Each entry contains an operator, timestamp, manifest hash, stable event ID, and object key when applicable. The manifest retains the original metadata.

A successful six-file run has thirteen audit entries: six `INTENT`, six `REMOVED`, and one `COMPLETE`. Replay adds none. These are local operation records. The earlier production proposal of two summary events does not replace a durable per-key recovery journal.

If deletion succeeds but the record write fails, the source field remains unchanged and the saved `INTENT` remains. Resume checks the same manifest, preserved records, references, and backup. It can then reconcile the absent file. A missing file without saved intent causes refusal. A completed file that reappears also causes refusal.

Tests cover intent-write failure, delete failure, record-write failure, lost record-write response, all five interruption points, and interruption after three completed files. Tests also cover changed references, active jobs, changed files, missing backups, concurrent cleanup, processing exclusion, surviving locks, and CLI refusal. Filesystem failure tests inject errors at the store boundary; they do not simulate hardware failure.

## Backup plan for the real six files

No production backup is created by this command.

Before approval, choose a recovery destination and retention period. Prefer an independent private destination. Keep the recovery copy until cleanup and restore checks pass and its removal is separately approved.

After separate authorization:

1. Repeat the exact-key and application reference checks.
2. Capture each key, size, ETag, modification time, content type, and relevant metadata.
3. Save the two source rows and related record identifiers for recovery. Preserve historical dates and P2 evidence.
4. Copy or download only the six approved files to the chosen private destination.
5. Calculate SHA-256 for each original and backup. Verify byte counts and hashes. ETags alone are insufficient.
6. Save a manifest with the original keys and destination paths. Keep credentials out of it.
7. Test restoration with disposable storage and fixture records. Do not overwrite production keys during that test.
8. Freeze the approved manifest. Repeat identity checks before deletion.

A later restoration would recreate the original keys, verify the files, and restore only the appropriate source fields. It must refuse any key or record that another operation has replaced. Keep transcripts, billing rows, job history, and evidence unchanged throughout restoration.

The local fixture backups demonstrate byte verification. They share one disk and are not an independent disaster-recovery backup. Existing similar production recordings are not verified backups.

## Remaining production approval checks

- Decide backup destination, retention, and recovery responsibility, or explicitly accept permanent loss.
- Implement and review the production adapter and durable recovery journal. The fixture JSON store is not a PostgreSQL transaction test.
- Prove production writer exclusion and retirement behavior. Do not stop services or change settings under this local authorization.
- Verify R2 conditional deletion on separately approved disposable objects before relying on it. No remote write tests ran here.
- Test the complete production adapter against disposable database and storage fixtures. Include lost responses and partial failure.
- Confirm operator authorization and keep audit records private.
- Repeat all live checks immediately before separately approved execution.
- Obtain approval for exact file deletions, record changes, audit records, and any required operational controls.

Cloudflare documents irreversible deletion: https://developers.cloudflare.com/r2/objects/delete-objects/

The R2 S3 compatibility table does not explicitly establish `If-Match` support for `DeleteObject`: https://developers.cloudflare.com/r2/api/s3/api/

No deployment, production copy, production deletion, remote write test, or processing run is part of this change. Keep PR #106 in draft. Keep the P2 sandbox plan uncommitted.

## Local review corrections

The review added six regression tests. They exposed premature completion, missing audit or retirement evidence, stale pre-delete checks, and overwritten record changes.

The command now validates journal phases, audit identities, and retirement markers before replay. It repeats the full checks after intent and after deletion. Each state write checks the file hash captured at read time. A newer state causes refusal instead of replacement.

These checks still rely on the local operation lock for cooperating writers. They are not a multi-process database concurrency proof. The production implementation and backup choices are specified in `docs/SIX_FILE_CLEANUP_ADAPTER_PLAN.md`.
