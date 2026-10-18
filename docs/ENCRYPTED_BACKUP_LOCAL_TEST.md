# Local encryption and restore test

Status: PASS. Final run: 2026-09-10T15:10:37.427Z.

## Scope

This test used disposable synthetic data in a new local PostgreSQL cluster. It did not access production, start application workers, use cloud APIs, or upload files to Dropbox. All payloads and private keys stayed under `/private/tmp/`, outside the repository and sync folders. PR #106 was not changed. No commit was made.

## Tool installation

`age` and `age-keygen` v1.3.2 were installed at `/usr/local/bin/`. Homebrew installation failed because the Mac Command Line Tools were outdated. The official Darwin AMD64 release archive was used instead. Its SHA-256 matched the GitHub release asset digest:

`1d1e4bc66e1427edad7739ae7616157de0e79db8b6d2a1497d7d9925fb06a539`

Source: [age v1.3.2 release](https://github.com/FiloSottile/age/releases/tag/v1.3.2). This check used the published digest, not independent Sigsum verification. PostgreSQL dump and restore tools: 17.10.

## Repeat the test

From the repository root:

```sh
node_modules/.bin/tsx scripts/test-encrypted-backup.ts --local
```

The script accepts no input paths or database URLs. It creates its own cluster and database names. It blocks external network access with the existing macOS rehearsal runtime. It does not load production environment files. It removes its databases, server, keys, and plaintext and encrypted payloads after the run. Only local test evidence and copied schema files remain.

Script SHA-256: `4f9bc6963d5567f4130a384f2100c9ae8eca9e97eb9a14db37579ef10fb7b067`.

## Results

All 18 checks passed:

- External, child-process, and unlisted localhost network access refused.
- Recovery uses a separate local key copy after original key removal.
- Custom archive listing contains billing data.
- Database archive, private manifest, and synthetic binary encrypt and recover with exact SHA-256 matches.
- Recovered manifest matches archive and database snapshot.
- Fresh database restore preserves all public table rows, billing, captions, editor state, journals, migrations, sequences, constraints, functions, triggers, and indexes.
- Restored database refuses direct gate deletion.
- Restored audit history cannot be deleted.
- Restored foreign key rejects missing project.
- Valid rollback-only edit succeeds; fixture snapshot stays unchanged.
- Populated restore target refused.
- Wrong key refused; output removed.
- Damaged ciphertext refused; partial plaintext removed.
- Truncated ciphertext refused; partial plaintext removed.
- Truncated dump fails atomic restore.
- Failed atomic restore leaves no public tables.
- Failed restore target cannot be reused.
- Disposable keys and all plaintext and encrypted payloads removed.

The comparison covered all 47 public tables and 29 migration records. Populated fixtures included transcripts, caption edits, processing and export jobs, billing history, source-copy journal, media gates, a media session, and its audit event. Extension names and versions also matched. The binary fixture contained 192 KiB of random data.

ESLint and TypeScript checks passed. The existing unrelated `AGENTS.md` edit has trailing whitespace; it was left unchanged.

Local machine report: `/private/tmp/encrypted-backup-rrhIqy/results.json`. Temporary evidence can be removed by the operating system. This document preserves the result.

## Limits and remaining checks

- No Dropbox upload/download test was run. A local file copy does not prove cloud recovery.
- The saved recovery key was a second local fixture file. Password-manager recovery and independent key custody remain untested. All fixture keys were removed.
- Production database identity, version, size, permissions, and restore time remain unverified.
- Local disk encryption and enough space for production data remain unverified.
- Cleanup operation, object, and approval tables were empty in this fixture. Their schema was compared, but this test does not prove every cleanup state transition.
- No production roles, cluster-wide grants, media archive extraction, application restart, or full disaster recovery was tested.
- No production backup, migration, deployment, cleanup, processing, or release approval follows from this local PASS.

## Next step

The Dropbox round-trip test passed on 2026-09-10 at 19:05 CDT:

- Dropbox folder: `Pulpit Engine Backup Test - 2026-09-10`.
- Dropbox showed the folder and each uploaded file as “Only you.”
- The folder contains only `payload-0.age`, `payload-1.age`, and `payload-2.age`.
- Dropbox reported all three uploads as complete.
- A new ZIP was downloaded through the Dropbox web interface.
- The ZIP contained only the three expected encrypted files.
- All three downloaded encrypted-file SHA-256 values matched the upload source.
- The saved local test key decrypted all three files.
- The downloaded database archive restored into a new empty local PostgreSQL database.
- The restored schema and record snapshot matched the source snapshot.
- The restored database contained captions, billing history, processing history, and cleanup audit evidence.
- External network access was blocked during local decryption and restore.
- The local ZIP, test key, plaintext, encrypted staging files, and test databases were removed after the PASS result.

The private Dropbox test folder and its three encrypted synthetic files remain in Dropbox. No shared link was created. No production system was accessed.

The next release checks are real recovery-key custody, production database size and restore capacity, the production backup approval, and the isolated production-data restore proof.
