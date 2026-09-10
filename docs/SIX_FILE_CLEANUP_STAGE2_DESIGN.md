# Stage 2: cleanup journal and source retirement

Status: design with a local schema implementation. See `SIX_FILE_CLEANUP_STAGE2_SCHEMA.md` for the implemented subset, test evidence, and remaining limits. No application writer or production setting changed.

This design follows the local writer review. Controls not listed as complete in the schema report remain planned. The current command remains limited to disposable fixtures.

## Outcome and preserved data

Retire exactly two sources and remove exactly the six approved media objects. Preserve the source rows, project rows, original dates, transcripts, segments, billing history, job history, and P2/P3 evidence.

Retirement must prevent a new job from recreating deleted media. It must also prevent new references that make the media necessary. A terminal project status alone does not provide either protection.

The real manifest and IDs remain private. This public document contains no production keys or account IDs.

## Local writer inventory

Paths below are repository-relative. Each row identifies an entry point or implementation inspected locally.

| Entry point | Current behavior | Required retirement control |
| --- | --- | --- |
| `src/lib/jobs/queue.ts`: enqueue, claim, retry, stale recovery | Creates jobs and conditionally claims queued/retrying rows; claims do not take a source lock | Resolve source under the gate. Refuse new work for a non-ACTIVE source. Register an execution session atomically with claim. Prevent retry/recovery from bypassing retirement. |
| `src/lib/jobs/runner.ts`; `src/worker/run-jobs.ts` | Runs processing handlers, export handlers, and periodic work | Carry the session identity through execution and record terminal completion only after side effects finish. |
| `src/app/actions/projects.ts`; `src/app/api/videos/[id]/srt/route.ts` | Web `after()` callbacks also run pending jobs | Use the same guarded runner. Stopping only the dedicated worker is insufficient. |
| `src/lib/jobs/handlers/finalize.ts` | Downloads URL media, uploads a deterministic source key, changes the source row, and enqueues PROBE | Hold a durable writer session through upload and registration. Do not recreate retired URL sources. |
| `src/lib/jobs/handlers/probe.ts` | Uploads audio and thumbnail before updating their source fields; enqueues TRANSCRIBE | Keep its session through both uploads, field commit, and follow-on job decision. |
| `src/lib/jobs/handlers/transcribe.ts` | Performs transcription work, then locks project/source, replaces transcript records, and directly creates ANALYZE work | Guard both admission and final transaction. Retired sources keep their transcript history. Direct job creation must use the same gate. |
| `src/lib/jobs/handlers/analyze.ts` | Locks project then source; replaces clips and creates schedule work | Guard admission and all final record writes. Respect existing transcript revision checks. |
| `src/lib/transcription/srt-upload.ts` | Writes SRT bytes before its project/source transaction; directly creates transcription work | Register a session before staging bytes. Block retirement until staging and registration or exact cleanup are reconciled. |
| `src/lib/transcription/srt-storage.ts` | Removes unreferenced staged SRTs under a source lock | Make the sweep cooperate with cleanup ownership. Do not delete an object with unresolved cleanup or backup ownership. |
| `src/app/api/uploads/[uploadId]/route.ts` and `complete/route.ts` | Writes temporary media; completion moves media to a permanent key before creating a source row | Register a pending upload/key reservation before permanent writes. Refuse keys owned by retirement or cleanup. Do not infer source ID from the upload ID. |
| `src/lib/project-service.ts`: URL and uploaded-source creation | Creates projects and directly creates FINALIZE jobs; uploaded-source creation can attach an existing source | New sources get gates in their creation transaction. Existing-source attachment locks its gate and rechecks ACTIVE. Guard direct job writes. |
| `src/lib/channel-import-service.ts`; `src/lib/integrations/channel-poller.ts` | Provides another import entry point | Route imports through guarded creation. Do not bypass gates with a channel retry. New independent sources remain allowed. |
| `src/lib/operations/source-copy.ts` | Locks operation/source and performs copy before registering a destination source | Reserve both source use and destination key. Guard planning and apply; reconcile uncertain copies before retirement. Align its existing lock order. |
| `src/lib/exports/queue.ts`, `runner.ts`, and `handler.ts` | Enqueues/claims exports; reads source media and uploads exports | Guard queue and claim, register source-use sessions, and block retirement until all uses and commits finish. |
| `src/app/api/clips/[id]/edit-state/route.ts`; `src/lib/approval.ts`; `src/lib/review/service.ts` | Saves edits, approval decisions, and review evidence | Treat new durable work as a cleanup blocker. Gate creation and updates that change source use. Preserve existing history and append-only review rules. |
| `prisma/migrations/20260909150000_source_write_boundary/migration.sql` | Existing triggers lock source rows for clip, edit, approval, export, post, and review writes | Extend retirement invariants without reversing lock order. Triggers do not replace admission before external effects. |
| `src/lib/review/render-coordinator.ts` | Automatically requests and binds scheduled renders | Refuse new render work from non-ACTIVE sources. |
| `src/lib/review/replace-scheduled-clip.ts`; `prior-service-fill.ts` | Changes slots, queues exports, and extends retention | Gate all affected old/new sources in sorted order before existing row locks. Recheck slot and source mapping. |
| `src/lib/operations/sandbox-slot.ts`; `src/lib/schedule/reschedule-missed.ts` | Creates or moves schedule intent and retention dates | Refuse new use of a retired source. Existing scheduled or published evidence is a cleanup blocker. |
| `src/lib/integrations/facebook-publisher.ts` | Claims posts and sends provider requests; recovers stale claims | Check source gate before new publish intent. An in-flight publish or unresolved claim blocks cleanup. Do not alter published history. |
| `src/lib/retention.ts`; `src/lib/jobs/handlers/cleanup.ts` | Deletes exports and source objects; source cleanup holds a source row lock | Retention must defer all objects reserved by the explicit cleanup operation. Do not enable the global source-deletion switch. |
| `src/lib/storage/types.ts`, `s3-provider.ts`, `local-disk-provider.ts` | Exposes generic upload, stream write, move, and remove without source identity | Add a guarded source-media adapter above these primitives. Raw keys alone cannot establish retirement permission. |
| Local preparation and rehearsal scripts | Can invoke storage or raw SQL directly | Keep fixture scripts isolated. Require explicit guards in operational CLIs. Inventory one-off runners before release. |

This inventory covers direct source/storage mutations and relevant queue/reference entry points found in local code. It is not proof about deployed revisions, external scripts, active credentials, or other accounts. Repeat the inventory on the release candidate and inspect operational runners before activation.

Media reads need a defined response after retirement. Preserve transcript and history views. New preview/download requests for removed media should return a controlled unavailable result. Existing signed URLs and downloads do not prove recovery or current availability.

## Proposed tables

The local migration uses these seven table names. This table remains the full design target; the schema report records implementation differences.

| Table | Key fields | Required constraints |
| --- | --- | --- |
| `cleanup_operations` | UUID `id`; canonical manifest text; SHA-256; schema version; operator UUID snapshot; workspace UUID; backup-manifest hash; preserved-record hash; state; owner ID; ownership generation; timestamps | Immutable manifest/scope/identity after insert. Unique operation ID. Valid states. Restrict deletion of live parent source/workspace records while unresolved. |
| `cleanup_objects` | operation ID; ordinal; source ID; project ID; field name; raw key; file identity and metadata; state; intent time; absence evidence; record-commit time | PK `(operation_id, ordinal)`; unique `(operation_id, key)` and `(operation_id, source_id, field_name)`; ordinal 0–5; only three permitted media fields; immutable identity. |
| `cleanup_approvals` | UUID; operation ID; immutable manifest hash; approver UUID snapshot; issued/expires times; scope; revoked time | Positive bounded lifetime. Append a new approval to renew; never edit manifest expiry to renew an operation. Validate operator authority at issue and use. |
| `source_media_gates` | source ID PK; state; generation; cleanup operation ID; timestamps | One row per source. FK with RESTRICT. States ACTIVE, QUIESCING, RETIRED, RESTORING. Non-ACTIVE changes require a journaled transition. No cascade deletion of recovery state. |
| `source_media_sessions` | UUID; source ID; generation; owner instance; job/operation reference; purpose; state; heartbeat; terminal evidence | New sessions require ACTIVE under gate lock. Terminal means all side effects are resolved. Expired heartbeat is not terminal. |
| `media_key_reservations` | storage identity; exact raw key; owner operation/session; state | At most one unresolved owner for each exact key in a storage identity. Covers pre-source uploads and copy destinations. Release only after reconciliation. |
| `cleanup_audit_events` | event UUID; operation ID; optional object ordinal; action; actor snapshot; timestamp; ownership generation; redacted result; event sequence | Append-only. Unique logical transition ID. Mandatory insert in the same transaction as each journal transition. Private operator access only. |

Use UUIDs for row identity, UTC timestamps, BIGINT for byte counts and generations, and checked lowercase SHA-256 text. Store full ETags as opaque strings. Keep raw HEAD/LIST timestamps and the explicit normalized comparison value. Never parse an ETag as a content hash.

Retain canonical manifest text as well as queryable JSON. JSONB alone does not preserve the canonical byte representation. Validate the hash over the canonical text at admission. The database rejects later scope mutation. Restrict keys to the approved manifest, not a prefix match.

Use RESTRICT rather than CASCADE for recovery-bearing links. Actor ID snapshots survive account deletion and role revocation. An optional live actor link may use SET NULL. Document workspace erasure handling separately; do not silently erase journals.

A deferred constraint trigger must verify exactly six objects, two distinct sources/projects, and three distinct fields per source before PREPARED becomes valid. Ordinary row CHECK constraints cannot enforce this whole-operation count. Validate cross-workspace relationships and all original field values under locked reads.

The existing `OperationalEvent` helper can send alerts and its safe wrapper can swallow insertion errors. Do not use it for mandatory journal durability. A generic summary may be added later through an outbox, after privacy review. It cannot replace per-object audit events.

## State transitions

Operation: PREPARED → QUIESCING → READY → APPLYING → COMPLETE.

An uncertain external result moves the operation to NEEDS_RECONCILIATION. Resume returns to APPLYING only after identity, ownership, approval, backup, and side-effect reconciliation. An operation can be ABORTED only before any irreversible effect and after all reservations and sessions are resolved.

Object: PLANNED → INTENT_RECORDED → ABSENCE_CONFIRMED → RECORD_COMMITTED.

Unknown deletion results remain INTENT_RECORDED with an immutable attempt entry. A retry must inspect the same key. It must not create a fresh operation or assume a provider timeout means absence.

`ABSENCE_CONFIRMED` requires a reviewed adapter result. Access denial, timeout, and network failure are not absence. Field clearing, object RECORD_COMMITTED, and the corresponding audit event commit together. If the original field changed, refuse the entire transaction.

COMPLETE requires all six RECORD_COMMITTED items, matching audit evidence, no unresolved request, and preserved-record verification. Completion never depends only on a Boolean flag.

Source: ACTIVE → QUIESCING blocks new admissions. Existing sessions may finish under their registered identity. Cleanup waits until every existing use is terminal and reconciled. It then changes both sources to RETIRED before sending the first delete. RETIRED blocks later recreation and new references.

An abort before deletion may return sources to ACTIVE only after proving that no media or record changed. After any deletion, keep sources RETIRED until separately approved restoration. Restoration uses RESTORING, exact-key reservations, verified backup data, and its own journal. Never reactivate merely because a lease expired.

## Lock order and execution ownership

Adopt a shared source-gate admission helper. Resolve the complete source set first, including both sides of replacement/copy. Lock gate rows in ascending UUID order before existing operation, project, source, job, and slot row locks.

Within a gate-protected path, use one documented order: operation, projects, source rows, jobs/exports, then slots; sort IDs within each group. Recheck mappings after acquiring locks. If the resolved set changed, roll back and retry discovery. Do not acquire a new earlier gate from inside an existing transaction.

Existing source-write triggers can acquire source locks during SQL writes. Do not add a gate lock inside those triggers after an application row lock and assume the order is safe. Acquire gates at transaction entry. Test direct SQL refusal and old-client behavior separately. Keep the existing transcript and append-only constraints.

The current code has project-first paths and a source-copy path that locks source before project. Do not add a source-first cleanup transaction beside them and assume safety. Refactor affected callers together and prove opposite-order race tests before activation. Gate acquisition from a transaction-client helper must require an already-established context; it must not silently nest transactions.

Writer admission and job claim occur in one short transaction under the gate. Save a durable session before an external upload, download needed for processing, render, or publish. Keep sessions through final field and follow-on queue decisions. Existing sessions can finish during QUIESCING, but no new session may enter.

No database transaction remains open for a long storage request. Cleanup ownership and source retirement persist across these requests. A generation number fences database commits; it does not fence an already-issued R2 request.

If an owner disappears, mark reconciliation required. Do not automatically transfer destructive authority after a heartbeat timeout. Prove the prior process cannot issue requests and resolve outstanding requests before takeover. If that cannot be proved, remain blocked. Conditional deletion alone does not solve a delayed request that can match recreated bytes.

Before production activation, prove coverage of every writer. Until coverage is complete, only a separately approved full writer shutdown could establish exclusion. Include web callbacks, workers, one-off CLIs, restart policies, and external credential holders. This design does not authorize shutdown or credential changes.

## Approval and protocol changes

The Stage 1 manifest includes an approval expiry. Freeze that initial manifest permanently. Stage 2 adds append-only approval grants referencing its hash. A renewed grant authorizes future destructive requests without changing file scope. This requires an explicit versioned protocol change and regression tests; do not silently reinterpret Stage 1 behavior.

Recheck current operator authority before every destructive request. Expiry or revocation stops further DELETE requests. Read-only inspection remains possible for authorized operators. Do not silently perform database reconciliation under a revoked grant: request a narrowly scoped reconciliation approval if a prior deletion already succeeded.

A passing manifest or backup receipt is not authorization by itself. Bind approvals to the exact operation, storage identity, six objects, record changes, and operational controls.

## Required test matrix

This matrix defines the full release target. The schema report lists the local checks that have passed. All other cases remain pending.

| Area | Required case | Passing evidence |
| --- | --- | --- |
| Schema | Wrong field; duplicate key; wrong workspace; seventh item; missing sixth item; mutated manifest; illegal transition | Disposable PostgreSQL rejects each invalid commit. No partial valid operation remains. |
| Admission | Queue, direct job creation, upload completion, source attachment, copy, export, schedule, and publish race with QUIESCING | Exactly one admission order wins. Retirement sees the winning session/reference or the writer refuses. |
| Drain | A PROBE upload has completed but source registration is pending | No deletion until the session finishes and fresh references are checked. |
| Drain | SRT staging or source copy returns an uncertain response | Reservation remains. Retirement cannot assume no object was created. |
| Deadlock | Replacement uses two sources in opposite discovery order; copy conflicts with analysis; retention conflicts with SRT | Sorted gates prevent inversion. Retry is bounded and produces no side effects. |
| Existing work | QUEUED, RETRYING, WAITING, RUNNING processing; queued/running exports; publish in progress | Cleanup refuses or drains under the reviewed procedure. Historical terminal rows remain unchanged. |
| Recovery | Kill the process before intent, after intent, after DELETE, and before/after database commit | A new process reads the same journal. No unrecorded deletion or duplicated event occurs. |
| Recovery | Old owner resumes after timeout; provider response is delayed | New owner cannot delete until prior authority and requests are reconciled. |
| Recovery | Object reappears; key points elsewhere; reference added; approval expires | Refusal preserves new data and partial journal evidence. |
| Audit | Force audit insert failure while clearing a key | Field and state updates roll back. Intent remains available for reconciliation. |
| Preservation | Full transcript/segment hashes, billing rows, jobs, historical dates, source/project IDs, P2 keep-list | Before/after evidence matches except the explicitly approved media fields and timestamps. |
| Retirement | Re-run FINALIZE; recover stale job; attach source; render; replace; publish after COMPLETE | All new uses refuse. No media recreation or new job/slot occurs. |
| Privacy | Anonymous, member, owner, former operator, cross-workspace operator without required scope | Denied callers receive no key, backup path, manifest, raw error, or existence leak. |
| Privacy | Logs, error telemetry, event export, cost rollup, browser payload, API response | Private cleanup details appear only in approved operator surfaces. |
| Backup | Wrong hash, truncated backup, stale receipt, restore onto a changed key | Refusal. A clean disposable restore reproduces exact bytes and intended fields. |
| Migration | Empty database and populated baseline upgrade | Existing IDs, transcripts, dates, job states, and media fields remain unchanged. Gates backfill ACTIVE without starting cleanup. |
| Migration | Backfill races with source creation; migration interrupted then resumed | Exactly one gate per source; no missing gate can admit work. Rollout remains closed until coverage is complete. |
| Rollback | Old app/worker starts with non-ACTIVE gates | Release control refuses startup. Old code cannot bypass retirement. |
| Rollback | Candidate disabled before cleanup versus rollback after first deletion | Before cleanup, compatible code rollback is possible after verification. After deletion, restore media and reconcile records before any incompatible rollback. |

Use database assertions and actual process termination for Stage 2 recovery tests. The existing JSON fixture exception tests do not satisfy these cases. R2 condition enforcement and provider response behavior remain Stage 3 remote tests, requiring separate authorization.

## Migration and rollout design

1. Review the schema and full writer-gate API locally. Generate migration SQL only in a later authorized implementation task.
2. Test additive schema creation against disposable databases. Add gates for new sources in the same transaction as source creation. Backfill existing sources under a reviewed concurrency procedure.
3. Keep cleanup execution disabled while deploying compatible readers and writers. Missing gates must refuse work or be initialized atomically under the reviewed migration protocol; never mean permission to proceed.
4. Verify all web, worker, CLI, retention, and integration paths use the new protocol. Old instances must be stopped before any source becomes non-ACTIVE.
5. Verify backup restoration, private authorization, database recovery, and separately approved storage conditions.
6. Obtain approval for the exact operation and any shutdown requirements. Only then permit retirement and deletion.

No gate state changes during backfill except creating ACTIVE rows. Do not auto-expire projects, clear holds, enqueue jobs, publish, or start a program.

## Rollback rules

Before retirement or deletion, a code rollback can leave unused additive tables in place. Verify there are no non-ACTIVE gates, unresolved sessions, approvals in use, or storage requests before allowing old writers.

After retirement begins, prefer a forward fix or a compatible rollback version that enforces gates. An older image that ignores gates is not safe. Keep journal tables and source retirement through code rollback.

After media deletion, a database restore alone cannot recover media. Restore verified media to reserved keys, reconcile source fields and operation history, and verify the keep-list before reactivation. Restoring an old full database can overwrite unrelated production changes; prefer scoped recovery. Full restore requires a separately reviewed outage and loss-window plan.

Do not drop journal tables or retirement protections as a down migration while any recovery obligation exists. Do not claim rollback is tested until disposable migration, kill/restart, and restore evidence is collected.

## Implementation order and remaining decisions

Implement next: schema constraints and local disposable PostgreSQL tests. Keep application writers and production execution unchanged until their gate integration receives review.

Then implement gate/session admission across the inventory, private operator queries, and persistent recovery. Finish with storage adapter proof and an approved backup/restore rehearsal.

Remaining user decisions: independent backup destination, retention period, custodian, acceptable maintenance window if needed, and eventual exact execution approval. No decision is needed to continue local schema design and fixture tests.

PR #106 remains draft. The P2 sandbox plan remains uncommitted. This document does not authorize a commit, deployment, production migration, processing run, publication, or merge.
