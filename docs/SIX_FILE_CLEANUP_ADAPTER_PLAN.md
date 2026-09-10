# Six-file cleanup: production adapter plan

Status: adapter design with local fixture, protocol, and journal schema work complete for draft review. See `SIX_FILE_CLEANUP_STAGE2_SCHEMA.md` for database evidence. Production access, remote write tests, and deployment remain outside this work.

## Review result

The local review found three defects:

- A premature completion flag could report success. Missing audit entries and removed retirement markers were also accepted on replay.
- Backup and reference checks could become stale between preflight and deletion.
- A pending state write could replace a newer record change.

The fixes validate the journal, audit entries, and retirement markers. The command repeats checks after saved intent and before deletion. State writes compare the current file hash with the hash captured at read time. A changed state causes refusal. These protections apply to the local fixture model and its cooperating operations.

The original 35 tests did not cover these cases. Six additional regression tests reproduced the defects before the fixes.

This command still uses synthetic media and JSON records. It is not a production cleanup tool. It cannot reopen a fixture from another process. Its directory lock remains after a process kill. Do not describe its exception-recovery tests as a crash-recovery proof.

## Scope

Keep the real six-key manifest private. It identifies two failed test projects and exactly three media fields per source. Do not infer scope from names, prefixes, source dates, or bucket listings during execution.

Preserve project and source rows, transcripts, segments, billing history, completed jobs, and P2/P3 evidence. Preserve original historical dates. Do not enable general retention deletion or delete projects through cascade operations.

## Stage 1: contracts and private manifest

Implement a separate cleanup protocol with injectable database and storage interfaces. Keep production execution unavailable while building the protocol.

The manifest must bind the operator, account, bucket, endpoint, workspace, project IDs, source IDs, six exact keys, and field names. Bind file lengths, SHA-256, ETags, modification times, relevant metadata, and the backup manifest hash. Include schema version, operation ID, creation time, and approval expiry.

Canonicalize structured fields before hashing. Do not sort or alter object keys themselves. Reject duplicate keys, additional fields, additional objects, expired approval, and mismatched identities. Normalize HEAD and LIST timestamp precision explicitly. Preserve the raw timestamps as evidence.

For resume, use the immutable manifest already recorded for the operation. Do not create a new operation for an uncertain deletion. Expired approval permits inspection only; further destructive work requires renewed approval.

## Stage 2: PostgreSQL journal and source retirement

The local Stage 2 migration now adds seven journal tables. The full writer-retirement behavior below remains the integration target.

The operation stores immutable scope, operator, backup evidence, approval, state, and timestamps. Each object stores its source field, identity, durable intent, confirmed absence, committed field update, and attempt history. Use unique operation/key and event IDs. Enforce valid states and immutable scope in the database.

Add a source-level retirement state that blocks new processing, source writes, new project references, copy operations, and schedule use. It must survive a process exit. Keep it after cleanup. Any restoration or renewed use requires a separate reviewed transition.

Audit all entry points before implementation: job enqueue and claim, FINALIZE, PROBE, TRANSCRIBE, source-copy registration, uploads, retention, project creation, and schedule operations. A check without a shared lock is insufficient. Existing in-flight writers must finish or stop before cleanup reaches deletion.

Use short transactions to reserve scope and commit state. Do not hold a database transaction open across a long storage request. Use an exclusive operation owner and durable intent. On owner loss, require reconciliation before another owner can send a deletion. Do not rely on an expiring lease alone: an old process could still send a request.

The implementation must prove that all source writers use the protection before production activation. Until then, require a separately approved maintenance procedure that stops every relevant writer and prevents restart. Neither approach is implemented by the local JSON fixture lock.

## Stage 3: storage and backup adapters

Add a narrowly scoped R2 adapter with explicit credentials, exact endpoint and bucket checks, and no implicit environment fallback. Disable hidden retries for deletion. Bound requests, bytes, and time. Distinguish a confirmed missing object from access denial, timeout, or provider failure.

Before relying on conditional DELETE, prove that R2 enforces the condition on disposable objects. A supported SDK argument does not prove provider behavior. Do not test DELETE against a production key, even with an intentionally wrong ETag.

If conditional deletion is unavailable, refuse unattended execution until the reviewed writer exclusion covers all storage writers. A HEAD request followed by DELETE is not atomic. Never silently fall back to unconditional deletion.

The backup adapter must verify source and backup SHA-256 and size. Store a private metadata manifest with original keys and record values. Verify the chosen destination and ensure it is outside cleanup scope. Backup creation requires separate copy/download authorization.

## Stage 4: execution and reconciliation

1. Verify operator status and explicit approval for the immutable scope.
2. Reserve both sources and establish writer exclusion. Confirm no active or retrying jobs and no unexpected references.
3. Verify all six files and all backup receipts before the first deletion.
4. Persist intent for one exact object before sending its deletion request.
5. Confirm absence using the reviewed storage adapter. Treat ambiguous results as pending reconciliation.
6. In one database transaction, compare the original field value, clear only that field, update the timestamp, and append audit evidence.
7. Continue only while the exclusion, manifest, backup evidence, and references remain valid.
8. Mark completion only when all six object states and audit entries agree. Verify preserved records and keep-list objects.

If deletion succeeds and the database transaction fails, keep intent and source retirement. Resume must verify the backup, scope, and confirmed absence before clearing the field. If the database commit succeeds but its response is lost, read the journal. Do not duplicate the audit event or delete again.

A new object at a completed key causes refusal. Missing journal evidence causes refusal. Recovery must never clear a changed source field. Record partial completion explicitly.

## Stage 5: operator privacy

Keep exact keys, backup paths, checksums, and raw provider errors in private operation records. The existing OperationalEvent table is not proof that every reader is operator-only.

Review every API, UI query, log export, and event serializer that can expose this data. Require platform-operator authorization. Test that ordinary owners, members, and unauthenticated callers cannot read cleanup details. Do not reuse a best-effort event helper for the mandatory recovery journal.

Generic user-facing source availability can be designed separately. It must not expose the private cleanup manifest.

## Stage 6: disposable tests and release gates

Start with local contracts and fixtures. A later, separately authorized stage can create isolated PostgreSQL and storage fixtures.

Required proofs:

- Database uniqueness, immutable scope, valid transitions, and atomic record/audit commits.
- Enqueue and claim races, writer exclusion, stale owners, and retirement after completion.
- Actual process termination before deletion, after deletion, and around database commit.
- Resume from another process with persistent identity and no automatic unsafe lease takeover.
- Provider conditional-delete enforcement, wrong-key refusal, timeout, access denial, and lost responses.
- Backup verification and restore into disposable storage and records.
- Preservation of transcripts, segments, billing, jobs, historical dates, and P2 evidence.
- Operator-only authorization and redacted error output.
- Migration, rollback, and old-worker compatibility. Old code must not bypass retirement after rollback.

Do not enable production execution until these gates pass and the exact operation receives approval. Keep PR #106 in draft. Commit or push only when separately requested. Keep the P2 plan and unrelated changes uncommitted.

## Backup choices

| Choice | Benefit | Limit | Approval needed |
| --- | --- | --- | --- |
| Encrypted independent local disk, outside sync folders | Simple for six files; separates recovery data from the production bucket | Disk loss remains possible; verify available space and encryption | Exact destination, download scope, custodian, and retention |
| Private storage under a separate account or provider | Separates storage and access failures; supports a second recovery location | Requires credentials, access review, and current cost approval | Destination, access scope, cost limit, retention, and copy scope |
| Separate private bucket in the same account | Protects against accidental deletion of the six production keys | Shared account access can still affect both copies | Bucket creation if needed, scope, access, cost, and retention |
| Existing similar recordings only | No new copy | Exact restoration is unproved; these recordings also support P2 | Not sufficient as a verified backup without content and recovery proof |
| No backup | No backup work | Permanent loss of the selected media may be unrecoverable | Explicit acceptance of permanent loss |

Recommended first choice: an existing encrypted independent local disk, if one is available. Keep the verified backup through cleanup review. Use a second independent copy if loss of that disk is unacceptable. Do not place the only backup in a temporary directory or this repository's sync folder.

The six files total approximately 977 MB in the prior private inventory. That is historical planning evidence, not a fresh production measurement. Allow additional working space for verification and restoration. No destination capacity, encryption, availability, provider price, or billing saving was verified in this local review.

A backup retention period and a person responsible for recovery remain user decisions. Do not automatically delete backups after a timer. Use separate approval after restoration and cleanup evidence are accepted.

## Next action

Review the completed local fixture, protocol, and journal work in draft PR #106. The next implementation section is shared writer admission and recovery. Keep remote adapters and production execution unavailable.

## Stage 1 implementation

Implemented in `scripts/lib/cleanup-protocol.ts`. Refusal tests are in `tests/cleanup-protocol.test.ts`.

The module defines database and storage reader interfaces. It also defines future journal and exact-object writer contracts. It implements no writers. Its inspection path calls only reader methods. The fixture command is unchanged.

The strict version 1 manifest binds the operation, operator, workspace, account, bucket, endpoint, two project/source pairs, six field/key pairs, file identities, metadata, backup hash, and preserved-record hash. It accepts only `local-disposable` and `fixture` identities. Real provider support requires a separately reviewed schema and adapter change.

Canonical hashing sorts JSON property names recursively. Arrays remain ordered. Storage key strings retain their exact characters, including Unicode and percent escapes. Reordering the six items changes the hash. Duplicate keys, invalid field sets, extra properties, and extra items cause refusal.

HEAD and LIST timestamps must agree to the second. Both raw values remain in the manifest and hash. The approval window is positive and no longer than thirty minutes. Boundary expiry fails approval validation before any adapter call. A future creation time or invalid clock also causes refusal.

New-operation inspection refuses an existing operation ID. Resume requires a stored manifest with the same canonical content and verified hash. Changed operator, backup, scope, or approval times require refusal. This stage does not implement approval renewal. That requires a separate approval record linked to the immutable operation during Stage 2.

Expired manifests can be inspected. Missing objects and cleared fields are reported only in resume inspection. They do not prove that a deletion is complete. Unknown storage results cause refusal. Backup verification and source blockers remain required. Every report returns `eligibleForFutureExecution: false`.

The injected fixtures model authenticated operator status, references, jobs, holds, and backup verification. Those booleans and fingerprints are not independent production proofs. Stage 2 must calculate them from actual records; Stage 3 must verify backup bytes and storage behavior. No environment loader, credentials, network client, or production factory exists in this module.

The local journal constraints and writer inventory are now available. Remaining work includes approval use and renewal, writer integration, and ownership recovery. Do not activate or deploy any of those changes under Stage 1 authorization.

## Stage 2 design prepared

See `docs/SIX_FILE_CLEANUP_STAGE2_DESIGN.md` for the proposed tables, transitions, local writer inventory, gate ordering, and test matrix. The design has a local schema implementation and disposable PostgreSQL evidence. No production migration was applied. The design includes existing source-write triggers and direct job writers, not only queue helpers.
