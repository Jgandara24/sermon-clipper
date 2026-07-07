# Phase 8 Completion Audit

Date: 2026-07-07

Status: not complete until the live production evidence checklist below is filled from a deployed
environment using real provider credentials.

Phase 8 is complete only when the production system proves the full Phase 6/7 church workflow can
be safely deployed, operated, billed, and used by real churches outside local development.

## Requirement Audit

| Requirement | Repo evidence | Verification | Status |
| --- | --- | --- | --- |
| Real authentication with email OTP and/or Google OAuth | Email OTP uses hashed challenges, DB-backed sessions, SendGrid delivery, rate limiting, and production readiness failures for missing email config. Google OAuth is intentionally absent. | `npm run verify`; live OTP request and code verification with `SENDGRID_API_KEY` configured. | Built locally; live delivery proof required. |
| Workspace access, roles, and permissions | Central role-permission checks guard app pages, API routes, uploads/imports, clip edits, exports, templates, billing, approval requests, and navigation. Workspace invitations support joining existing churches. | `npm run test:integration`; invite and accept a real `/join/:token` link in production. | Built locally; live join proof required. |
| S3/R2-compatible production storage | `STORAGE_PROVIDER=s3` supports AWS S3 and Cloudflare R2 through the storage provider interface. Production readiness fails if storage stays local. | `/api/health`; upload/process/export/download against the production bucket. | Built locally; live bucket proof required. |
| Secure short-lived URLs for media access | Uploads, source video, thumbnails, exports, and downloads use HMAC-signed URLs; S3/R2 mode redirects to presigned object URLs. | `npm run smoke:production -- --base-url <url>`; browser source preview and MP4 download in production. | Built locally; live media proof required. |
| Real approval notifications | Approval requests can send email through SendGrid and SMS through Twilio, with attempts persisted. | Send approval to a real email/SMS recipient in production and confirm notification attempt records. | Built locally; live provider proof required. |
| Review link expiration, revocation, and auditability | Review links expire, can be revoked after approved content changes, and write approval audit events for request/view/notification/revocation/decision activity. | `npm run test:e2e`; view and approve a real `/review/:token` link in production. | Built locally; live review proof required. |
| Reliable workers outside the web process | `worker:prod` runs processing and export queues; jobs have attempts, delayed retries, heartbeats, stale-job recovery, and terminal failure states. | `npm run test:integration`; run a separate production worker and confirm upload/export events. | Built locally; live worker proof required. |
| Billing and usage enforcement | Stripe Checkout, Customer Portal, signed webhooks, plan state, idempotent invoice grants, usage reservations, refunds, and overage prevention are implemented. | Stripe live/test-mode checkout and webhook event delivery in production; ledger and workspace plan inspection. | Built locally; live billing proof required. |
| Production observability | Operational events record uploads, billing ledger mutations, processing/transcription/analysis/export outcomes, approval delivery, auth events, and stale-worker recovery. | Open `/app/settings/operations` as owner/admin after live workflow. | Built locally; live operations proof required. |
| Repeatable deployment configuration | `docs/DEPLOYMENT.md`, `/api/health`, `worker:prod`, migrations, required env vars, storage, domain, secrets, smoke checks, and rollback steps are documented. | Follow the runbook against a real deployment. | Documented; live run proof required. |
| Production-critical E2E coverage | CI runs DB-free verification, real-Postgres integration tests, and the Playwright Phase 6/7 browser workflow. | GitHub Actions jobs pass; local `npm run verify`, `npm run test:integration`, and `npm run test:e2e` pass. | Built locally; current CI proof required after push. |

## Live Launch Evidence Checklist

Record the following before declaring Phase 8 complete:

| Evidence item | Required proof |
| --- | --- |
| Deployment URL | Production URL using HTTPS and the intended domain. |
| Commit SHA | Git commit deployed to production. |
| Health check | Output from `curl -fsS <url>/api/health` showing no failed readiness checks and the deployed commit SHA. |
| Production smoke | Output from `npm run smoke:production -- --base-url <url> --commit-sha <sha>` showing `ok` or only accepted warnings. |
| Web process | Deployment platform confirms the web process is running the deployed commit. |
| Worker process | At least one separate worker process is running with stable `WORKER_ID`. |
| Database | `npm run db:migrate:deploy` applied successfully against production. |
| Auth email | A real user receives and verifies an email OTP through SendGrid. |
| Workspace create | The real user creates a workspace. |
| Workspace join | A second real user accepts an invitation through `/join/:token`. |
| Upload | A sermon video uploads to the configured S3/R2 bucket. |
| Processing | FINALIZE, PROBE, TRANSCRIBE, and ANALYZE complete or fail recoverably with visible events. |
| Clip ranking | Ranked church-aware clips appear with scripture/church scoring where applicable. |
| Branding | A brand template is applied in the editor. |
| Approval notification | A real approval email and/or SMS is delivered. |
| Review approval | The secure `/review/:token` link is viewed and approved. |
| Export | An approved clip exports through the worker. |
| Download | The MP4 downloads through a short-lived signed URL from production storage. |
| Billing | Stripe Checkout/Portal and webhook handling update the workspace plan and grant minutes. |
| Usage limits | Insufficient minutes or plan limit conditions are blocked without negative balances. |
| Observability | `/app/settings/operations` shows upload, processing, approval, export, billing, and worker events. |
| CI | `verify`, `integration`, and `e2e` jobs pass for the deployed commit. |

Generate a launch-specific evidence file with the deployed URL and current commit:

```sh
npm run create:launch-evidence -- --base-url https://clips.example.org --verified-by "Launch operator"
```

Then fill every item in `docs/phase8-launch-evidence.json` with real production evidence, change
each status to `passed`, and verify it:

```sh
npm run verify:launch-evidence -- --file docs/phase8-launch-evidence.json
```

The health and production smoke items can be collected automatically:

```sh
npm run collect:launch-evidence -- --base-url https://clips.example.org --commit-sha <deployed-git-sha>
```

If `--commit-sha` is omitted, the collector uses the evidence file's top-level `commitSha` for the
smoke check. The collector prints the full launch-evidence validation result after writing automated
health and smoke evidence. Add `--require-complete` during final launch verification if the command
should exit non-zero while any evidence item is still missing or failed.

Record each manual evidence item with the checked item key instead of editing JSON by hand:

```sh
npm run record:launch-evidence -- --list
npm run record:launch-evidence -- --item workspaceCreate --evidence "Created production workspace as owner@example.org."
```

By default, verification also checks that the evidence file's `commitSha` matches the current Git
`HEAD`. Use `--commit-sha <sha>` when verifying evidence for a specific deployed revision from a
different local checkout.

## Completion Rule

Do not mark Phase 8 complete from local tests alone. Local verification proves the code path; Phase
8 completion requires the live launch evidence above because the objective explicitly depends on
real churches, production storage, provider-backed notifications, deployed workers, and billing.
