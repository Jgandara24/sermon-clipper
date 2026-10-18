# PR #106 recovery and restore decisions

Status: deferred by Jake on 2026-09-10. Complete these decisions before a
production backup, migration, deployment, or six-file cleanup. They do not block
the current local P2 work. No production access, deployment, merge, setting change,
or processing run occurred. PR #106 remains draft. The P2 sandbox plan remains
uncommitted.

## What is already proved

- The local encryption and restore test passed 18 checks with synthetic data.
- The private Dropbox round-trip test passed. Dropbox showed the folder and all
  three encrypted test files as “Only you.”
- A fresh Dropbox download decrypted and restored into a new local PostgreSQL
  database. Schema and record hashes matched.
- PR #106 is open and draft. Its `verify`, `integration`, `e2e`, and
  `worker-image` checks pass at commit `86d1691`.

These results prove the test process. They do not prove the production database
size, production PostgreSQL version, production roles, or production restore time.

## Decisions for Jake

Record each answer before a production backup is authorized.

### D1. Recovery-key owner

Recommended answer: `Jake Gandara is the recovery-key owner and release recovery
operator for PR #106.`

If another person must be able to recover the service, name that person now. The
person must receive the procedure and an independent private-key copy through an
approved secure method.

### D2. Primary private-key location

Choose the exact password manager and vault. Recommended answer:

`Store the PR #106 age private key in <password manager>, vault <vault name>, item
Pulpit Engine PR106 Recovery Key. Do not store it in Dropbox, Git, the repository,
chat, email, or a shell command.`

The item must include the private key as a secure file or secure note. It must also
include the public recipient, creation date, owner, and purpose. It must not include
production database credentials.

### D3. Independent recovery copy

Recommended answer:

`Keep one second key copy on an encrypted removable drive. Store the drive in a
different physical location. Label it with the item name, not the key value.`

The second copy must not use the same Dropbox or password-manager account as its
only protection. A second item in the same vault is not independent.

### D4. Key recovery proof

Recommended answer:

`Before the production backup, remove the working key file. Retrieve the key from
the password manager. Decrypt a small verification file. Repeat the test with the
independent copy. Mark the backup usable only after both tests pass.`

This is a release gate. The disposable key used for the synthetic test was removed
and does not satisfy this decision.

### D5. Production backup location and access

Recommended answer:

`Use Dropbox/Pulpit Engine Backups/PR106/<UTC timestamp>-<backup ID>. Require Only
you, no members, and no shared link. Upload only encrypted files and a redacted
receipt. Do not reuse the synthetic test folder.`

The exact account and folder must be checked again before upload. The production
private key must never enter Dropbox.

### D6. Restore host

Recommended answer:

`Use a new isolated local PostgreSQL host with its data and working directory on an
encrypted external APFS volume. Block outgoing network access. Do not load the app
environment or start workers, publishers, callbacks, or schedules.`

The current internal Mac disk is not approved. It has about 10 GiB free. If an
external encrypted volume is not available, choose a separate isolated host and
approve that host before any production-data transfer.

### D7. Restore capacity rule

Let `D` be the measured custom dump size. Let `R` be the production database size.
Recommended answer:

`Require free restore-host space of at least 2D + 2R + 20 GiB, and never less than
50 GiB. Stop if the measured free space is below this amount.`

This covers the encrypted download, decrypted dump, restored database, restore
work/WAL, and an operating reserve. Dropbox's available space does not count as
restore-host space.

### D8. PostgreSQL compatibility and roles

Recommended answer:

`Use dump and restore tools with the same major version as production. Restore the
database schema and data. Record required extensions, owners, roles, and grants
separately. Recreate reviewed application roles from platform configuration. Do not
export login password hashes.`

The local test used PostgreSQL 17.10. Production must be checked before this answer
can be applied.

### D9. Recovery and maintenance targets

Recommended starting answer for the current pre-release service:

`Accept no writes after the approved shutdown begins. Require the isolated restore
proof to complete within 60 minutes. Reserve a 90-minute maintenance window. Stop
and roll back if the release cannot meet the window.`

Change these numbers if a 90-minute service interruption is not acceptable. The
small synthetic restore does not prove this time.

### D10. Backup and key retention

Recommended answer:

`Keep the encrypted production backup and both recovery-key copies until P2 release
acceptance and the 30-day rollback period are both complete. Review them 30 days
after deployment. Do not delete them automatically.`

Dropbox's 30-day recovery feature does not set the stored file's retention period.
Permanent deletion needs a separate approval.

### D11. Six media files

Recommended answer:

`Defer the six-file media backup. It is not required to review or merge PR #106.
Require it before any approved production cleanup deletes those six objects.`

The database backup preserves records, transcripts, billing history, and journal
evidence. It does not contain the media bytes.

## Read-only facts required after these decisions

These checks require separate authorization to access production. They were not run
during this review:

- Confirm the production database identity and PostgreSQL major version.
- Measure `pg_database_size` and estimate the custom dump size.
- List required extensions, application roles, ownership, and grants without
  reading password hashes.
- Confirm the current web and worker revisions, replica counts, restart policy,
  automatic deployment state, and shutdown method.
- Confirm the selected restore host, encrypted-volume state, and free space.
- Run one timed production-data restore from a fresh Dropbox download on the
  isolated host. Compare migrations, schema, counts, hashes, and constraints.

Do not approve deployment from estimates. Use the measured values to apply D7 and
D9. A failed check stops the release and does not authorize a cleanup.

## Reply template

Jake can record the decisions with this text:

```text
D1 key owner: Jake Gandara / <other named person>
D2 primary key store: <password manager>, <vault name>
D3 independent key copy: <encrypted device and storage location>
D4 test both saved key copies before production backup: yes / no
D5 production Dropbox folder and Only-you access rule: approve / revise
D6 restore host: encrypted external APFS volume / <isolated host>
D7 capacity rule 2D + 2R + 20 GiB, minimum 50 GiB: approve / revise
D8 match PostgreSQL major version and recreate reviewed roles: approve / revise
D9 restore target 60 minutes; maintenance window 90 minutes: approve / revise
D10 retain through acceptance and 30-day rollback period: approve / revise
D11 defer six-file media backup until cleanup approval: approve / revise
```

These answers approve planning choices only. They do not authorize production
access, backup execution, shutdown, migration, deployment, cleanup, merge,
processing, publication, or the 30-day phase.
