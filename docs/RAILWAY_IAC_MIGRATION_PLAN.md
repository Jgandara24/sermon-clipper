# Plan: move railway.json and railway.worker.json to `.railway/railway.ts`

Date: 2026-10-31. Status: proposed. Nothing applied, nothing deployed. `railway config plan` ran clean on 2026-10-31. Branch `claude/railway-iac-plan`.

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

## 5. Steps, in order

1. **Add the SDK.** Done on this branch: `railway` ^3.16.0 as a dev dependency; the lockfile gains only its three entries (no `@emnapi` loss).
2. **Plan, read-only.** Done, section 4: four expected changes, no add, no destroy. Re-run it right before step 4; any change beyond those four means stop.
3. **Pull request with the file.** Commit `.railway/railway.ts` and the plan output. Merge. A push does not apply IaC, so this deploy still reads the old files.
4. **Cutover, one service at a time, worker first.** The worker has no traffic and a restart policy. Run `railway config migrate cutover --service worker`, then `railway config apply`, then redeploy the worker. Check the build log: `Dockerfile.worker`, ffmpeg present, `/models` mounted, worker heartbeat in `/api/health`.
5. **Then the web.** `cutover --service web`, `apply`, redeploy. Check the build log for `nodejs_24`, the pre-deploy migration step, the healthcheck and the commit on `/api/health`.
6. **Remove the old files** in a last pull request after both services run from IaC (`railway.json`, `railway.worker.json`, and the DEPLOYMENT.md text about them).

Rollback for steps 4 and 5: `railway config migrate undo` restores the config-file paths saved by the cutover; redeploy.

Do steps 1 to 5 before **2026-11-24**, a week ahead of the cutoff.

## 6. Decisions for Jake

1. **Who owns variables.** Unmanaged (recommended now): the dashboard stays the source, nothing moves. Managed: variables become code with `preserve()` for secrets; more review, more risk.
2. **Nixpacks or Railpack for the web.** Keep Nixpacks for the migration (recommended): one change at a time. Railpack is Railway's current default and a later, separate change.
3. **The GitHub action** `railwayapp/config`, which plans on pull requests and applies on merge. Useful later; not needed for the migration.
