# P2 separate source copy — staff command

This command is local code for review. It has not accessed production media or
run against production. A release and an exact copy apply need separate approval.
It does not start processing, create a service, render, publish, change settings,
clear holds, or start the 30-day phase.

## Scope and authority

Use `npm run --silent prepare:source-copy -- --help` for arguments.
The command uses the database credentials supplied by the operator. It is not a
public endpoint and must not be exposed through the app. The named operator must
have the platform marker and active source IMPORT_MEDIA membership. A named
active target member must have IMPORT_MEDIA permission. The target must allow
imports and have sufficient minutes for the source duration. These checks do not
reserve minutes or authorize a later run. Confirm target consent separately.

The default is read-only. It reads database facts and source object bytes to
calculate SHA-256. It writes no rows, audit events, source objects, or jobs.
Reading source bytes can incur transfer charges. A plan is not a HEAD-only check.
No `.env` file is loaded by the command. Use the reviewed runtime deliberately.

## Plan and apply

```sh
npm run --silent prepare:source-copy -- \
  --operator <operator-uuid> --import-user <target-member-uuid> \
  --workspace <sandbox-uuid> --project <source-project-uuid> \
  --date 2026-05-20 --occurrence UNMATCHED --max-bytes 400000000 \
  > /private/local/path/source-copy-plan.json
```

The occurrence shown is an example, not a scheduling decision. Choose the correct
PRIMARY, SECONDARY, or UNMATCHED mapping before approval. The plan records the
old service date and the requested new date. It does not edit the old service.
Keep the manifest private: it contains workspace IDs and storage keys. Do not
commit it or put it in public PR evidence. Plan output includes a confirmation hash.

After review and separate approval, within 30 minutes:

```sh
npm run --silent prepare:source-copy -- --apply \
  --manifest /private/local/path/source-copy-plan.json \
  --confirm <exact-plan-hash> --confirm-sandbox <exact-sandbox-uuid>
```

The hash identifies the reviewed manifest; it is not an authentication credential
or a substitute for operator approval. Modified facts, a changed object version/modification time, or a different storage
backend invalidate the plan. Source/trial access and plan expiry are checked again
after storage reads and before registration. Local flags do not prove that all remote workers are off.

Apply persists a private `SourceCopyOperation` before storage work. It serializes
attempts for that operation, locks source retention and relevant access rows,
checks current facts, and conditionally copies to a fresh UUID-based key. The
source must still match its ETag. The destination must not exist. The copied
bytes must match the planned byte count and SHA-256 and carry the operation ID.
Only then does a transaction register one SourceVideo and mark the journal complete.

No transcript, word ID, derivative, SRT override, clip, approval, slot, export,
review, or hold is copied. The date and occurrence remain in the private manifest
until a separately reviewed service-creation action uses them. The command does
not supply a processing-start action.

## Storage support and bounds

- Amazon S3 default endpoint: destination `If-None-Match: *`.
- Cloudflare R2 account endpoint: `cf-copy-destination-if-none-match: *`.
- Both use `x-amz-copy-source-if-match`. Other custom endpoints are refused.
- Hashing uses bounded conditional GET reads, not ETag as a content checksum.
  It checks size, ETag, version, modification time, and ownership before/after.
- Maximum object size is 500 MB decimal. Each inspection/copy has a 60-second
  deadline; the apply transaction has a five-minute ceiling. SDK retries are off.
- The manifest shows expected byte volumes for plan and first apply. USD pricing
  is NOT_CONFIGURED. Retries and failures can add reads and request costs. These
  are byte estimates, not a billed-cost ledger or a measured production bill.
- Application media decode and caption accuracy are not checked here.

Provider references:
[Cloudflare R2 destination conditions](https://developers.cloudflare.com/r2/api/s3/extensions/),
[Cloudflare R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
R2 does not advertise full-object SHA-256 through the S3 checksum fields, which is
why this adapter hashes actual bytes. No remote storage contract test has run.
The tests check emitted HTTP conditions with an in-process transport.

## Recovery and retention

If copy succeeds but registration or the response fails, the journal stays
PREPARED and the object may exist. Repeat the same approved manifest within its
valid period. A matching owned object is verified and reused. A conflicting
object or row is refused. A completed missing object is refused, not recreated.
Concurrent serializable requests may require a retry; they cannot create two
copies for the same operation. Creating a new plan creates a new operation, so
never use a new plan as a blind retry.

After the 30-minute plan deadline, stop and review the existing journal/object.
Do not create another copy to bypass the deadline. The journal records a 24-hour
`retainUntil` review deadline. **No automatic cleanup or retention deletion is
implemented.** An expired pending copy needs a separate reviewed recovery or
cleanup action. This is a release limit, not a claim that storage expires itself.
This command has no delete/move method and cannot remove old or referenced media.

## Release checks still open

1. Review this command and the additional journal migration
   `20260910030000_source_copy_operations`. Review required CI on the final head.
2. Resolve the Wednesday service occurrence, sandbox member consent/session,
   target entitlement, transfer price/budget, and 24-hour recovery/cleanup owner.
3. Test the exact storage provider conditions and timeout behavior in a separate
   disposable bucket, with no production recording. No such test has run.
4. Rehearse all old executors stopping, including web inline callbacks. Verify
   replica/restart/automatic-deploy behavior and actual process exit.
5. Rehearse the migration chain, backup restore, and compatible rollback in an
   isolated environment. The existing revision migration test is not proof of
   the new journal migration's complete release procedure.
6. Approve and verify matching API/worker/migration deployment before production
   copy apply. Processing, captions, replacement, exact MP4 acceptance, and sandbox
   publication remain later separate P2 actions.

Keep draft PR #106 in draft. Keep `docs/P2_SANDBOX_TEST_PLAN.md` uncommitted.
