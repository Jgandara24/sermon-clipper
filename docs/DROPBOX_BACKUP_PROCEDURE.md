# Dropbox backup procedure for PR #106

Status: local synthetic encryption and restore test passed on 2026-09-10. The encrypted synthetic Dropbox upload, fresh download, and local restore test also passed. See [test evidence](ENCRYPTED_BACKUP_LOCAL_TEST.md). No production access occurred. No production key was created. Production execution remains unapproved. PR #106 remains in draft. The P2 plan remains uncommitted.

## 1. Purpose and scope

Create a recoverable production database backup before the approved PR #106 migration. Store only encrypted backup files in Dropbox. Test recovery from a fresh Dropbox download into a new isolated database.

The six recording files are a separate optional backup. Keep their cleanup deferred. A database dump does not contain the stored recording bytes.

No backup or restore test authorizes merge, deployment, source copy, processing, rendering, publishing, hold changes, or the 30-day phase. Production restoration requires a separate incident plan and approval.

## 2. Known facts and limits

The read-only Dropbox account check on 2026-09-10 found:

- Dropbox Plus: 2 TB total, 1.42 TB used, about 580 GB free. Values are rounded.
- The existing `ai-workspaces` and `sermon-clipper` folders show “Only you.” This does not establish permissions for a new backup folder.
- Default sharing: “Anyone with link” and “Can edit.” No setting was changed.
- Recovery and version history: 30 days. Extended Version History is not selected.

The recovery period applies to deleted files and earlier versions. It is not an expiry date for stored backup files. Permanently deleted files cannot be recovered. See [Dropbox retention rules](https://help.dropbox.com/account-settings/data-retention-policy).

`age` and `age-keygen` v1.3.2 are now installed. The local test used PostgreSQL 17.10. See the test evidence for installation and hash verification. The Mac reports about 10 GiB free on its data volume. Production database size, restored database size, local encryption state, and independent key recovery remain unverified.

## 3. Folder and access plan

Proposed Dropbox location:

`Dropbox/Pulpit Engine Backups/PR106/<UTC timestamp>-<unique backup ID>/`

This is a proposed path, not an existing or approved destination. Create it at the account root, outside `ai-workspaces`, after authorization. Use a new directory for each backup. Never overwrite an earlier backup.

- [ ] Confirm the exact Dropbox account and destination with Jake.
- [ ] Create the separate folder and verify “Only you.”
- [ ] Inspect its members and existing links. Require no other members and no shared link.
- [ ] Do not use “Copy link,” invite members, or change global sharing defaults.
- [ ] Check folder access again after upload.

Expected Dropbox contents:

- `database.dump.age`: encrypted PostgreSQL archive.
- `manifest.json.age`: encrypted verification and recovery details.
- `media.tar.age`: optional encrypted six-file bundle, only under separate authorization.
- A short receipt with backup ID, UTC time, encrypted file sizes, and encrypted-file SHA-256 values. Do not put connection details, record IDs, real object keys, or secrets in this receipt.

## 4. Encryption and key recovery

Use `age` public-key file encryption. It supports a public recipient for encryption and a separate private identity for decryption. Confirm the installed version and use the official distribution. See [age documentation](https://github.com/FiloSottile/age).

- [x] Install or verify `age` before execution (v1.3.2 installed for the local test; verify again before production use). Do not substitute ZIP password protection.
- [ ] Generate a dedicated recovery key outside Dropbox and all other sync folders, on verified encrypted storage.
- [ ] Save the private key in Jake's password manager using its secure file or note feature.
- [ ] Keep a second recovery copy in an independent secure location that Jake approves.
- [ ] Keep password-manager and account recovery information available independently of this Mac.
- [ ] Record the public recipient in the private manifest. The private key must never enter Git, Dropbox, logs, shell arguments, or chat.
- [ ] Verify recovery using the saved key copy, not only the original key file.

The operator must confirm key custody before a real backup is marked usable. Dropbox access alone cannot decrypt the backup. Losing all private-key copies makes recovery impossible.

## 5. Local storage and tool checks

Use a new private working directory outside Dropbox, iCloud, the repository, and other sync or automatic-upload locations. Use encrypted local storage and restrictive file permissions. Do not use the repository's `tmp/` folder for production data.

Before exporting, estimate and record space for:

| Space item | Required measurement |
| --- | --- |
| Original dump | Estimated archive size; replace with actual size after export |
| Encrypted upload file | Allow for the archive plus encryption overhead |
| Fresh download | A second encrypted copy for the round-trip test |
| Decrypted restore input | A separate complete archive |
| Restored database | Table data, indexes, and large objects |
| Temporary growth | Restore work, PostgreSQL WAL, optional media extraction |
| Operating reserve | Agreed free space that must remain unused |

- [ ] Confirm these amounts fit on each destination volume, not only in Dropbox.
- [ ] If they do not fit, use a reviewed encrypted external volume or another approved isolated restore host. Do not delete unrelated files to make room.
- [ ] Confirm production PostgreSQL major version. Select compatible dump and restore tools, preferably the same major version for the initial proof.
- [ ] Record required extensions, runtime versions, and the reviewed application commit.
- [ ] Use explicit reviewed connection details through a private credential file. Do not place passwords in command arguments or copy `.env` into the backup folder.
- [ ] Require complete database read privileges. Do not accept a partial dump caused by row filters or missing table access.

Do not approve this Mac for production-data restoration based on the current 10 GiB free-space reading.

## 6. First test: disposable data only

Run this test before handling production data. It needs no production credentials.

1. Create a new owned local PostgreSQL cluster. Block external network access for its database and test processes. Do not start application workers.
2. Apply the reviewed schema. Seed synthetic transcript, billing, job, and journal records.
3. Capture expected schema, row counts, record hashes, and representative constraint results.
4. Create a custom-format PostgreSQL dump. Check the process exit status and archive listing.
5. Encrypt the dump and its manifest outside Dropbox.
6. Decrypt with the recovery key retrieved from its saved location. Compare the decrypted dump hash with the original.
7. Restore into a second new empty database. Use `pg_restore --exit-on-error --single-transaction`. Do not use `--clean`, an existing database, or a production connection.
8. Compare the restored records, migration ledger, extensions, and constraints with the expected results. Do not run migrations after restoration to hide a missing schema object.
9. Test a wrong key and a damaged encrypted copy. Both must fail without producing a usable restore target.
10. Test a truncated dump. Restoration must fail. Remove only the owned failed target; create a fresh database for the next attempt.
11. Remove only test resources created by this run. Keep a redacted result report.

A later, separately authorized Dropbox round-trip test can upload the encrypted synthetic fixture, download it through Dropbox into a new local directory, and repeat steps 6–8. Local encryption alone is not proof of Dropbox upload or download.

The local encryption and restore test passed: 18 checks. The private Dropbox
round-trip test also passed. See [test evidence and limits](ENCRYPTED_BACKUP_LOCAL_TEST.md).
Local key recovery used a disposable file copy, not a password manager.

## 7. Production backup: approved release step

Run only after approval identifies the source database, destination folder, key custodian, and restore location.

- [ ] Verify the production identity and current app/worker revisions with read-only checks.
- [ ] Confirm the approved release controls have stopped old writers, including web callbacks, and prevented restart. Stopping them is a separate production action.
- [ ] Capture the final pre-migration backup while writes remain stopped. Capture verification counts and hashes under the same stable state. Do not compare a moving database with an older dump.
- [ ] Use a complete custom-format `pg_dump` archive. Check success and inspect its table of contents. Do not filter out billing, transcripts, jobs, or journals.
- [ ] Record UTC start/end, server/tool versions, extensions, schema, migration history, data counts, archive size, SHA-256, and compatible code revision in the encrypted manifest.
- [ ] Document required roles, grants, and ownership separately. A database dump is not a complete cluster or infrastructure backup. Do not export login password hashes by default.
- [ ] Keep storage credentials and other required recovery secrets in approved secret storage. Record references to them, not their values, in the manifest.
- [ ] Encrypt the archive and manifest. Require successful exit status. Verify decryption and original archive hash before upload.
- [ ] Upload only the final encrypted files into the approved private Dropbox folder. Do not upload partial output or plaintext.
- [ ] Verify upload completion and actual file sizes through Dropbox. A local filename or sync icon alone is insufficient.
- [ ] Download the encrypted files through Dropbox into a fresh directory outside sync folders. Do not reuse the local upload source as the downloaded test copy.
- [ ] Compare downloaded encrypted-file hashes with the local receipt. Decrypt with the recovered key. Compare plaintext archive and manifest hashes with the original values.
- [ ] Perform the isolated restore test in section 8 before migration begins.

If writes resume or the release is delayed, keep this backup as historical evidence. Take a new final backup for the actual maintenance window. Recovery will not include writes made after the backup snapshot.

PostgreSQL custom archives are restored with `pg_restore`. The dump represents one database; shared cluster objects need separate planning. See [PostgreSQL dump guidance](https://www.postgresql.org/docs/17/backup-dump.html).

## 8. Production-data restore proof

Use only the backup downloaded from Dropbox. Production remains untouched.

- [ ] Create a new empty database on the approved isolated host. Verify host identity and owned database name before any restore command.
- [ ] Block outgoing connections. Do not load production application environment files or start workers, publishers, scheduled tasks, or provider clients.
- [ ] Inspect the archive and required extensions before restoration. Do not restore an untrusted archive with unrestricted host access.
- [ ] Restore with `--exit-on-error --single-transaction`. Preserve the archive's schema and data.
- [ ] If `--no-owner --no-privileges` is used for a portable local test, label the result “data/schema restore only.” It does not verify production roles or permissions. Prove the reviewed role/grant mapping separately before release approval.
- [ ] Compare schema, migration ledger, table counts, IDs, dates, transcript/segment hashes, billing/job history, and journal records with the encrypted manifest.
- [ ] Verify foreign keys and journal constraints with rollback-only checks. Confirm both known valid and known invalid operations behave as expected.
- [ ] Record elapsed restore time and required space. Confirm they fit the approved maintenance window.
- [ ] Record that external media bytes, provider credentials, and full application restart were not proved by a database restore.
- [ ] Remove the restored production-data database and decrypted working files after evidence review. Remove only exact resources from this run's ownership record.

Deletion on an SSD is not proof of secure erasure. Use encrypted local storage from the start. Do not rely on deleting plaintext after it was placed on unencrypted or synced storage.

See [PostgreSQL restore options and warnings](https://www.postgresql.org/docs/17/app-pgrestore.html).

## 9. Optional six-file recording backup

This step is not required to continue local P2 engineering. Run it only before separately approved six-file cleanup.

- [ ] Use the reviewed private manifest with the six exact keys. Do not infer keys from folder names or dates.
- [ ] Preserve original source dates, transcripts, billing, job history, and P2/P3 evidence. Retain the May 20, 2026 source-date note and the old date mismatch where applicable.
- [ ] Download only the approved media. Record byte counts, SHA-256, opaque ETags, raw timestamps, and relevant metadata.
- [ ] Package files with safe relative archive names. Keep the mapping to real storage keys inside the encrypted manifest.
- [ ] Encrypt locally, upload, download afresh, and verify hashes as above.
- [ ] Extract only into a new disposable directory. Refuse traversal paths, absolute paths, and links.
- [ ] Compare all six restored files byte-for-byte or by SHA-256 and byte count. Test restoration of only the expected record fields in disposable records.
- [ ] Do not write to production storage or clear any production source field during this test.

## 10. Acceptance, retention, and failure handling

A backup is PASS only when the downloaded copy decrypts with the saved recovery key and the isolated restore matches its recorded evidence. Encryption success, a Dropbox listing, or a database archive listing alone is insufficient.

On failure, stop the release or cleanup action that depends on the backup. Preserve the encrypted original and private failure evidence. Keep the backup marked NOT VERIFIED. Do not overwrite it, delete production data, or assume a retry succeeded.

Retain the backup through release acceptance and the agreed rollback period. Do not delete automatically. Review retention after the P2 results are accepted; record the owner and next review date. Permanent removal requires separate approval. Keep the recovery key while any backup still requires it.

## 11. Execution record

| Item | Value before execution |
| --- | --- |
| Backup ID and UTC date | Not assigned |
| Scope | Database; six media files deferred |
| Dropbox destination | Proposed path in section 3; not created |
| Backup and recovery owner | Jake to confirm |
| Key locations | To confirm privately; never put the key here |
| Local encrypted working volume and free space | Not approved; current Mac has about 10 GiB free |
| Source database size and identity | Not checked in production |
| Restore host/database | New isolated target; not created |
| Retention review date | To confirm |
| Local encryption/restore fixture | PASS: 18 checks; see linked evidence |
| Dropbox fixture round trip | PASS: private “Only you” folder, three encrypted files, fresh web download, matching hashes, successful local restore |
| Production backup and downloaded-copy restore | NOT RUN |
| Production roles and full recovery plan | NOT VERIFIED |
| Release/deletion permission | NOT GRANTED |

Next step: confirm real recovery-key custody and production restore capacity before any production backup approval. Production access remains disabled.
