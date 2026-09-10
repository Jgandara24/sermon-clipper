# Source revision upgrade test

The test in `tests/integration/source-revision-upgrade.integration.test.ts` checks
an upgrade with existing data. A fresh database test alone does not show that old
transcripts, editor documents, and review records survive a migration.

## Procedure

The test creates a new database on a local PostgreSQL server. Its name starts with
`source_upgrade_` and ends with a generated UUID. The configured database is used
only to create and remove that new database. It is not reset or migrated.

1. Deploy the 26 migrations through `20260905230000_agentic_editor_wave_2`. This is
   the migration chain on main `1d77d39`.
2. Create synthetic rows with the old columns. There is one untouched service and
   one service with saved human work. Both have a transcript, segment words, a clip,
   an editor document, and completed job history. The protected service also has a
   detached review snapshot. Editor documents include valid pinned word IDs and
   a legacy caption override.
3. Capture all old values, including JSON documents, word IDs, timestamps, review
   identity, and terminal job state. Confirm that no revision columns exist yet.
4. Apply `20260909150000_source_write_boundary` with `prisma migrate deploy`.
5. Confirm that all captured values remain equal. The two new revision columns
   start at 0. Review decision and checksum updates still refuse.
6. Run the current TRANSCRIBE handler against the protected service. It must refuse
   before reading storage. Saved work and its word IDs must remain unchanged.
7. Run current TRANSCRIBE and ANALYZE handlers against the untouched service. Use
   synthetic SRT and the local heuristic provider. Confirm a new transcript, a
   queued analysis job, rebuilt clips at revision 1, and a successful current edit.
   Old clip edits and an old-style clip insert that omits the revision must refuse.
   The completed old analysis job must remain unchanged.
8. Disconnect the fixture client, remove only the generated database, and confirm
   that it no longer exists. Remove the temporary migration directory.

The test uses parameterized SQL for old rows. It does not generate an old Prisma
client or start an old worker. It copies the schema and migration files to a
temporary directory. `migrate deploy` applies that directory's SQL chain; it does
not generate a schema diff or replace the repository's generated client.

## Run locally

Use a known local PostgreSQL server and a test account with `CREATEDB` permission.
Set `DATABASE_URL` explicitly before the command. Only `postgres`/`postgresql`
loopback URLs are accepted. The only permitted query parameter is `schema=public`.
Remote hosts and query parameters that can change connection routing are refused
before the test creates a database client. Do not use a production connection.

```bash
npm run test:integration -- tests/integration/source-revision-upgrade.integration.test.ts
```

For a machine-readable result, add `--reporter=json --outputFile=<local-report-path>`.
The test also runs in the existing integration CI job. A failure to remove its
database fails the test run. Cleanup never uses `FORCE`, resets an existing database,
or removes databases by a name pattern. If CREATE returns an uncertain error, the
test does not assume ownership and does not attempt a blind delete.

This fixture pins the 26-to-27 migration boundary. If later schema changes require
additional fields in the current generated client, update the rehearsal deliberately
and retain the populated old-data checks. Do not rewrite an applied migration.

## Results and limits

On 2026-09-09, all four cases passed on local PostgreSQL 17. The old values remained
equal and cleanup passed. This is engineering evidence from synthetic records.
It does not verify historical caption accuracy, audio alignment, or human acceptance.

- Revision 0 is a rollout baseline. It does not identify or repair the transcript
  that a historical clip originally used.
- The review guard refuses changes to a recorded decision. Its existing deletion
  and tenant-erasure policy is unchanged; this test does not claim that all SQL
  deletes are blocked.
- The old-style insert test proves that an ANALYZE insert without the new revision
  refuses after a source advances. Old TRANSCRIBE code does not advance the counter
  and remains outside the guarantee. No old worker binary was run.
- The test does not measure production-sized table locks or migration duration.
  It does not rehearse worker drain, the deployment platform, a production release,
  or rollback. It creates no MP4, makes no external provider call, and publishes nothing.
- A production release still needs matching migration, API, and worker code after
  old workers are drained. A code-only rollback to an old worker is unsafe. See
  [TRANSCRIPT_REPLACEMENT_SAFETY.md](TRANSCRIPT_REPLACEMENT_SAFETY.md).

Manual P2 caption review, exact-MP4 acceptance, and the three production proofs
remain pending. No production setting, hold, or service was changed by this test.
