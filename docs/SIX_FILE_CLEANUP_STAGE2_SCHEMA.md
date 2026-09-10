# Stage 2 local journal schema

Status: implemented and tested for draft PR #106. Not deployed. Cleanup execution remains disabled. No application writer changed. The P2 sandbox plan remains uncommitted.

## Files

- `prisma/schema.prisma`: seven journal models and parent relations.
- `prisma/migrations/20260910140000_cleanup_journal/migration.sql`: tables, constraints, indexes, triggers, and ACTIVE gate backfill.
- `scripts/test-cleanup-journal.ts`: disposable PostgreSQL tests.

The migration is one transaction. Existing sources receive ACTIVE gates. New source creation does not yet create a gate. This is an incomplete rollout boundary. A missing gate refuses session admission.

## Database rules

The database requires six objects for each operation. They must identify two sources and two projects, with three distinct media fields for each source. It checks the workspace, project relation, original field value, manifest item, content hash format, and HEAD/LIST timestamp agreement.

The manifest text, JSON value, and SHA-256 must agree. The database checks version 1. Stage 1 `canonicalManifest` still owns recursive canonical ordering and full protocol validation. SQL does not replace that validation. The storage identity fingerprint is SHA-256 over PostgreSQL JSONB text for the identity. A future adapter must compute it through SQL consistently; it must not substitute the manifest hash.

Scope fields cannot change. State changes require the next revision and a matching audit event in the same transaction. The database stamps the audit transaction ID; an event saved by a prior transaction cannot satisfy this rule. Audit history cannot be updated, deleted, or truncated. Recovery-bearing parent links use RESTRICT. One exception permits a generation-0 ACTIVE gate with no sessions or gate audit to follow its deleted source. Direct gate deletion remains refused. Actor IDs are snapshots, not live account foreign keys.

Approvals bind to an immutable manifest hash. A grant can last at most 30 minutes. Revocation needs its own audit event. Authority, current expiry, scope at use, and renewal remain adapter checks.

Session admission locks the source gate. It requires ACTIVE and the current generation. Open or uncertain sessions block retirement. READY and APPLYING require reservations for all six keys and retirement of each exact source. Uncertainty retains the reservations. Any object that has passed PLANNED requires retired sources.

A partial unique index allows only one HELD reservation for an exact storage identity and key. The reservation has either an operation owner or a session owner. ABORTED requires no owned gate, held operation reservation, or unresolved source session. Owner replacement is disabled. A timeout cannot transfer ownership.

Object transitions require intent, then nonempty absence evidence, then record commit. The source field must be NULL at record commit. A missing audit event rolls the transaction back, including its source change. COMPLETE requires all six record commits. Restoration is explicitly refused until a separate restoration adapter exists.

The object table uses a UUID primary key plus unique `(operation_id, ordinal)`. Transition times are in audit rows. Session heartbeat and provider attempt records remain later work. These are implementation differences from the earlier table proposal.

## Local test method

Run from the repository root:

```sh
node node_modules/tsx/dist/cli.mjs scripts/test-cleanup-journal.ts --local
```

The script accepts no database URL or path. It does not load application code or `.env`. It creates its own cluster and random databases. Child processes receive a restricted environment. The macOS sandbox allows only the new local port. External, inherited-child, and unlisted local connections must fail with an OS permission error before tests start. There is no unsandboxed fallback.

The script applies the repository migration SQL in order. It tests both a populated baseline and an empty database. It also runs Prisma deployment from a separate schema tree with no `.env`. It verifies failed migration rollback, refusal to redeploy with unresolved failure history, explicit resolution, corrected deployment, and unchanged repeat deployment. It uses synthetic rows and does not copy or delete media. Its failure tests simulate database state transitions, not provider responses.

The final run on 2026-09-10 passed 62 checks. Local evidence is at `/private/var/folders/x6/3gq8t6x96_768_8r0627k00w0000gn/T/cleanup-journal-XWL2FT/results.json`. The ownership file records no remaining databases. These include invalid scope, invalid hashes, cross-workspace references, immutable history, approval limits, session drain, two simultaneous key claims, required audit rollback, partial recovery state, completion, dump/restore, and failed migration rollback. It also confirms that a role with no table grants cannot read the journal. The script removes its databases and stops its PostgreSQL server after the run.

The full unit suite passed: 1,880 tests in 151 files, including 74 cleanup tests. Prisma client generation, schema validation, and TypeScript checks passed. Lint passed with four existing warnings after excluding ignored `tmp/` files. The normal lint command found errors in those local scratch files; they are excluded from the PR. Application access-control tests remain pending.

## Remaining checks before release

1. Review this migration and its Prisma mapping. Prisma deploy and migration-ledger failure recovery passed in the owned local cluster. Measure backfill lock time and test concurrent source creation.
2. Implement shared writer admission and gate creation. Cover every writer in `SIX_FILE_CLEANUP_STAGE2_DESIGN.md`. Test gate-first lock order, competing admissions, source attachment, retry, and stale recovery. Existing application writers can still change sources without journal checks.
3. Implement the database adapter. Lock and recheck source/project references. Validate preserved records, live operator authority, approval expiry/revocation, canonical manifests, and exact backup receipts. Use the complete journal state vocabulary; Stage 1 still has a narrower stored-state contract.
4. Add session-owned reservation release rules, immutable provider attempt evidence, and recovery tests across process death. Database evidence objects do not prove that a provider request succeeded. No automatic owner takeover is allowed.
5. Test application privacy for anonymous users, members, owners, former operators, logs, and exports. The database owner can read these tables. The no-grant role test is not proof of platform-operator authorization or API privacy.
6. Test complete preservation of billing, jobs, segments, dates, and P2 evidence. This run checks synthetic transcript preservation; it is not a complete preservation proof.
7. Review source/workspace deletion compatibility. Unused gates now follow source deletion, with a database regression test. Gates with history and source records in cleanup scope remain protected. Define journal retention and account erasure before release.
8. Complete backup choice, storage adapter tests, delayed-request recovery, restoration, and old-code rollback refusal. A database dump restore does not prove media restoration. Do not remove the journal or restart old writers after retirement.

No production connection, processing run, PR readiness change, merge, or deployment is part of this step. The local implementation is included in draft PR #106. The P2 plan and unrelated local files remain excluded.
