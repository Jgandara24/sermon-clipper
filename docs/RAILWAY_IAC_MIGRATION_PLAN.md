# Plan: move railway.json and railway.worker.json to `.railway/railway.ts`

Date: 2026-10-31. Status: in progress. The file is on `main` and applied; the plan shows no changes. Section 5 is the corrected order, sections 7 and 8 what the apply and the first worker cutover showed.

## 1. Why this has a deadline

Railway deprecated Config as Code. It reads `railway.json` and `railway.toml` until **2026-12-01**, then stops ("hard cutoff"). Infrastructure as Code (`.railway/railway.ts`) replaces it.

The two files are load-bearing. The service settings in the Railway dashboard (from `railway config pull --json`) hold almost nothing: both services say builder `RAILPACK`, with no start command, no pre-deploy command, no restart policy. Everything that matters comes from the files:

| Service | From its config file today | What happens if the file stops being read |
|---|---|---|
| web (`railway.json`) | Nixpacks, `npm run build`, `npm run start`, pre-deploy `npm run db:migrate:deploy`, healthcheck `/api/health` with 300 s, restart on failure ×10 | Railpack builds it, **migrations stop running before deploys**, the 300 s healthcheck window goes back to the default, and `NIXPACKS_NODE_VERSION=24` is ignored |
| worker (`railway.worker.json`) | `Dockerfile.worker` (ffmpeg, whisper.cpp, fonts), restart on failure ×10, required mount `/models` | Railpack builds it **without ffmpeg or whisper.cpp**, so every transcription fallback and every render fails |

So doing nothing breaks production on 2026-12-01, at the next deploy after it.

## 2. What `railway config migrate` produced (dry run)

Run in this branch with `--variables=unmanaged --show`. It wrote nothing.

- It found **only the web service**. It did not find `railway.worker.json`, because it looks for the default file names only. The live worker deployment does read `/railway.worker.json`.
- For the web it generated builder, build, start, pre-deploy, healthcheck, healthcheck timeout, replicas and the custom domain. It **dropped the restart policy** (`ON_FAILURE`, 10 retries).
- It exported `partial = "web"`, which would make this repository own only the web service.

`railway config migrate status` says "No services in production read Config as Code". That is wrong: both latest deployments list a config file (`/railway.json`, `/railway.worker.json`). Do not trust that status line.

The CLI help and the docs disagree on one point. The help says `migrate --apply` "only touches the filesystem" and services keep reading Config as Code until `migrate cutover`. The docs say `--apply` also clears the services' config-file settings. Treat `--apply` as a production change until checked.

## 3. The draft file

`.railway/railway.ts` on this branch declares both services:

- web: the migrated settings plus the restart policy written by hand.
- worker: written by hand from `railway.worker.json`: builder `DOCKERFILE`, `dockerfilePath: "Dockerfile.worker"`, restart on failure ×10, `requiredMountPath: "/models"`.
- `partial = "sermon-clipper"`, owning both app services. Postgres, `postgres-volume` and `worker-volume` stay out of the file, so this file does not own or delete them.
- `variables: { managed: false }`: variables stay in the dashboard, as now. Moving them into code is a separate decision.

The field names come from the type file of the `railway` npm package 3.16.0 (`dist/index-*.d.ts`: `BuildConfig`, `DeployConfig`, `IntentServiceConfig`).

## 4. The plan, read-only, 2026-10-31

`railway config plan` against the draft (the `railway` SDK 3.16.0 is now a dev dependency):

```
Plan: 0 to add, 4 to change, 0 to destroy
  ~ Update web build.buildCommand, build.builder
    └ build.buildCommand (null → "npm run build")
    └ build.builder (null → "NIXPACKS")
  ~ Update web deploy.healthcheckTimeout, deploy.preDeployCommand, deploy.restartPolicyMaxRetries and 2 more
    └ deploy.healthcheckTimeout (null → 300)
    └ deploy.preDeployCommand (null → ["npm run db:migrate:deploy"])
    └ deploy.restartPolicyMaxRetries (null → 10)
    └ deploy.restartPolicyType (null → "ON_FAILURE")
    └ deploy.startCommand (null → "npm run start")
  ~ Update worker build.builder, build.dockerfilePath
    └ build.builder (null → "DOCKERFILE")
    └ build.dockerfilePath (null → "Dockerfile.worker")
  ~ Update worker deploy.requiredMountPath, deploy.restartPolicyMaxRetries, deploy.restartPolicyType
    └ deploy.requiredMountPath (null → "/models")
    └ deploy.restartPolicyMaxRetries (null → 10)
    └ deploy.restartPolicyType (null → "ON_FAILURE")
```

- **Nothing is added, nothing is destroyed.** The four changes copy into the service settings the values each service already deploys with from its config file (checked against the manifests of deployments `602afa69` web and `c5017a0a` worker). Today those settings are empty and the file fills them in.
- **The first draft detached the worker's volume.** Declaring the mount as `{ mountPath: "/models" }` was not enough; the plan showed `volumeAttachments.worker-volume ... → null`, a destructive change. The draft now declares the existing volume with `volume("worker-volume", ...)` at its current size, region and alerts and mounts it at `/models`. This file now owns that volume, so leaving it out later would delete it.
- The plan ran although both services still read their config files. The docs say Railway blocks plans in that state; it did not.
- Still unknown: what Railway does with an omitted setting on a declared service. The plan shows no other change, which suggests it leaves them alone.

## 5. Steps, in order (corrected after the apply)

1. **Add the SDK.** Done: `railway` ^3.16.0 as a dev dependency (pull request #126).
2. **Plan, read-only.** Done, section 4.
3. **Merge the file.** Done: pull request #126, `85dc57b`. A push does not apply IaC.
4. **Apply first, with the config files still read.** Done on 2026-10-31 (section 7). The files override the dashboard while Railway reads them, so the apply changed no build: both redeploys matched the builds before it. This fills the service settings before any service stops reading its file, so no deploy ever runs on empty settings.
5. **Plan shows no changes.** Done after removing the restart policy and `requiredMountPath` from the file (section 7): "Your Railway configuration is already up to date." Re-run `railway config plan --detailed-exit-code` before each next step; exit 0 means no changes.
6. **Web: delete `railway.json` in a pull request.** Do this first (section 8). The web's config file setting is empty, and Railway reads `railway.json` from the repository root by default, so removing the file is the web's cutover. The merge deploy reads the service settings. Check `nodejs_24`, the pre-deploy migration step, the healthcheck and the commit on `/api/health`. Rollback: revert the pull request.
7. **Worker: clear its config file setting by hand, after step 6.** `railway config migrate cutover` cannot do it (section 7). Clear the Railway Config File field (`/railway.worker.json`) in the worker's Settings, or send the `serviceInstanceUpdate` with `railwayConfigFile: ""` that the cutover sends, then redeploy the worker. Check the build log for `Dockerfile.worker`, the ffmpeg and whisper-cli stages, the volume mount and `[worker] polling`, and that the deployment lists no config file. Rollback: set the field back to `/railway.worker.json`.
8. **Remove `railway.worker.json`** and the DEPLOYMENT.md text about both files, after steps 6 and 7.

Do steps 6 and 7 before **2026-11-24**, a week ahead of the cutoff.

## 6. Decisions for Jake

1. **Who owns variables.** Unmanaged (recommended now): the dashboard stays the source, nothing moves. Managed: variables become code with `preserve()` for secrets; more review, more risk.
2. **Nixpacks or Railpack for the web.** Keep Nixpacks for the migration (recommended): one change at a time. Railpack is Railway's current default and a later, separate change.
3. **The GitHub action** `railwayapp/config`, which plans on pull requests and applies on merge. Useful later; not needed for the migration.

## 7. What the apply showed, 2026-10-31

- **`railway config migrate cutover` cannot cut over either service.** In CLI v5.71.0 (`src/commands/config/migrate.rs`, `fetch_cac_instances` and `is_cac_config_file`), the cutover keeps a service only when its `railwayConfigFile` setting names a file called exactly `railway.json` or `railway.toml`. The worker's is `/railway.worker.json`, so the cutover answers "Service worker is not managed by Config as Code"; the web's is empty (Railway reads the root `railway.json` by default), so it is skipped too. `migrate status` uses the same test and wrongly reports that no service reads Config as Code. The deployments show both files are read.
- **Apply with the files in place changed no build.** Two applies each redeployed both services on `85dc57b`. The web built with Nixpacks on `nodejs_24`, ran `db:migrate:deploy` and passed its healthcheck; the worker built from `Dockerfile.worker` and mounted its volume. Both deployments still list their config file.
- **Two kinds of field never stick.** After each apply, the plan still showed the restart policy (`ON_FAILURE`, 10 retries) on both services and `requiredMountPath: "/models"` on the worker, although Railway answered "applied". Railway's `environment.config`, which the plan compares against, holds neither. The service instances report `ON_FAILURE` and 10 retries for the web, the worker and the never-configured Postgres alike, so that is most likely Railway's default, which it does not store; the CLI does not treat it as a default and plans it again forever. The CLI compiles `requiredMountPath` only for databases (`src/iac/compiler.rs`, `database_deploy`). The file now leaves both out, and the plan shows no changes.
- **What the worker loses:** only the `requiredMountPath` guard, which fails a deploy when no volume is mounted at `/models`. The volume mount itself is stored and declared.
- **Docs gap.** Railway's docs say plans are blocked for services still managed by `railway.json` or `railway.toml`. Ours were not, most likely because of the same detection limit. A later CLI or server change could start blocking them until steps 6 and 7 are done.

## 8. The failed worker cutover, 2026-10-31 22:42 UTC

The first try cleared the worker's config file setting before `railway.json` was gone. Railway then read the repository-root `railway.json`, which is the web's file, for the worker too. Deployment `d09ff42f` built from `Dockerfile.worker` but took the web's `npm run start` and its pre-deploy `prisma migrate deploy`, which failed ("Could not find Prisma Schema": the worker image has no `prisma/` folder). The setting went straight back to `/railway.worker.json`. The failed deploy never replaced the running worker (`d1737fc1`), and the worker heartbeat stayed recent.

The lesson: an empty config file setting does not mean "no config file". Railway reads a root `railway.json` or `railway.toml` for every service of the repository whose setting is empty. So `railway.json` goes first (step 6), and the worker's setting is cleared after it (step 7).
