# P2 copied-source sandbox service handoff

This command connects a completed copied source to one sandbox service. It queues one `FINALIZE`
job. It does not run that job.

## Safety limits

- The default command is read-only. It reads the database and prints a plan.
- Apply needs the saved plan, its exact SHA-256 token, the exact sandbox workspace UUID, and
  `--queue-finalize`.
- The plan expires after 30 minutes.
- The source must come from one completed, unexpired `SourceCopyOperation`.
- The source must be fresh and unused. It cannot have a transcript, audio, thumbnail, SRT override,
  or an existing service.
- The operator must have the platform operator marker. The named import user must have active
  `IMPORT_MEDIA` permission in the sandbox.
- The sandbox must allow processing and have enough minutes for the source duration.
- Automatic publishing, automatic schedule arming, and source deletion must be off.
- One database transaction creates the service, the queued `FINALIZE` job, and a private staff
  audit event. The event has no workspace scope, so the church operations page cannot show it.
- A source row lock prevents two confirmed plans from creating two services.
- The command imports no worker code and does not call a job runner.

## Read-only plan

Run this only with an approved local or isolated sandbox database URL. Do not use a production URL.

```sh
npm run prepare:sandbox-service -- \
  --operator <operator-user-uuid> \
  --import-user <sandbox-import-user-uuid> \
  --workspace <sandbox-workspace-uuid> \
  --source-video <copied-source-video-uuid> \
  --name "P2 copied-source sandbox service" \
  --date 2026-05-20 \
  --occurrence UNMATCHED > /private/path/p2-sandbox-service-plan.json
```

The source recording has the old service date. The sandbox service uses the confirmed source date,
`2026-05-20`. This corrects the known date mismatch for the new service only.

Review the JSON. Check the workspace, source, name, date, occurrence, copy operation, expiry, project
ID, and job ID. Copy the `confirmation` value.

## Confirmed apply

Repeat all plan arguments exactly. Add the saved plan and all confirmation options:

```sh
npm run prepare:sandbox-service -- \
  --operator <operator-user-uuid> \
  --import-user <sandbox-import-user-uuid> \
  --workspace <sandbox-workspace-uuid> \
  --source-video <copied-source-video-uuid> \
  --name "P2 copied-source sandbox service" \
  --date 2026-05-20 \
  --occurrence UNMATCHED \
  --apply \
  --plan /private/path/p2-sandbox-service-plan.json \
  --queue-finalize \
  --confirm <exact-confirmation-token> \
  --confirm-sandbox <sandbox-workspace-uuid>
```

After apply, keep all workers stopped. Verify that there is one service, one `QUEUED` `FINALIZE`
job, and no job `startedAt` value. Starting processing is a separate manual approval.
