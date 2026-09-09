# P2 sandbox slot setup

Use this staff command to prepare one test slot while automatic schedule arming
stays off. It supports the P2 replacement and exact-render tests. It does not
prove either test passed.

The command is not exposed through an app page, API route, or worker job. It needs
database access and the ID of an existing platform operator. A workspace owner
without that marker is refused. The command does not grant the marker.

## Read the plan first

Run in the confirmed worker environment with the correct database and storage
configuration. Keep global publishing and automatic schedule arming off. The
command checks its own environment. It cannot prove a separate worker uses the
same values. Check the deployed worker before any production apply.

```sh
npm run prepare:sandbox-slot -- \
  --operator <platform-operator-user-id> \
  --workspace <sandbox-workspace-id> \
  --project <test-project-id> \
  --clip <selected-clip-id> \
  --date YYYY-MM-DD
```

This command reads data and checks source storage. It writes no audit event or
other row. It prints the workspace, service, selected clip, next eligible reserve,
date, timezone, source/transcript identity, and a confirmation token. No selector
score or analysis summary is printed.

Review those exact facts. Verify the workspace is the intended sandbox. A name,
Page setting, or CLI option cannot prove this. The command does not verify Meta
access, Page identity, caption accuracy, source decoding, or final render quality.

## Apply only after a separate instruction

Repeat the same command and add:

```sh
--apply --confirm <token-from-the-read-only-plan> \
  --confirm-sandbox <same-sandbox-workspace-id>
```

The service reads the facts again inside a serializable database transaction.
A changed clip range, chosen reserve, transcript, workspace, project, or date
invalidates the token. A failure or conflicting concurrent write requires a new
read-only plan. Do not retry with guessed or modified tokens.

Apply creates one FACEBOOK slot with status NOT_STARTED and no bound export. It
records a platform-scoped audit event in the same transaction. The event is not
in the church operations feed. If the audit fails, the slot insert rolls back.

If the project already has an expiry, setup can extend it to protect the source
until 14 days after the new slot. It never shortens the expiry. A null expiry
stays null. The source lock coordinates this change with cleanup.

The command does not save captions, create review decisions, clear holds, enqueue
processing or rendering, change settings, publish, or start the human-reference
phase. A repeated apply cannot create a second slot for the service.

## Required service state

- The human-reference phase has not started.
- The service is READY and belongs to the exact workspace supplied.
- The source object exists, belongs to that workspace, and has not expired.
- The source record belongs to this service alone. A shared source also shares
  its transcript, so it cannot isolate the P2 test from another service's processing.
- The transcript is nonempty and names the configured primary provider.
- No open transcription fallback hold exists.
- No queued, running, waiting, or retrying processing job exists for the service.
- No existing service slot, saved human edit, approval, export, or editorial
  review exists. Use a fresh test service; preserve historical evidence.
- The selected clip is retained, unused, and inside the source duration.
- At least one other eligible same-service reserve remains. The lowest eligible
  rank is named in the plan. Hidden, superseded, and scheduled clips cannot fill it.
  If that next reserve is outside the source duration, setup stops. It does not
  skip ahead to a clip that the real REPLACE action would not select.
- The date is today or later in the church's timezone, is not Sunday, and has no
  other non-MISSED slot in this workspace.

These checks do not assess editorial quality. Review source words first and keep
correction notes. After slot setup, separately approved caption changes and manual
rendering can proceed through the normal app. Watch the exact final file before
ACCEPT or REPLACE. A genuine replacement reason is required.

## Verification

The tests use local fixtures. They do not supply the three production P2 proofs.
They cover operator denial, workspace scoping, disabled automation, primary
transcription, holds, missing media, active jobs, reserve eligibility, date rules,
stale plans, duplicate/concurrent apply, audit rollback, and retention.

The source test uses an injected existence check. A real S3 HEAD check, source
playback, a controlled production apply, and the three P2 proofs remain separate
manual or approved operational checks.
