// DRAFT, not applied. docs/RAILWAY_IAC_MIGRATION_PLAN.md says how this file goes live.
// Railway Infrastructure as Code for both services. It replaced railway.json and
// railway.worker.json (both deleted, 2026-10-31; docs/RAILWAY_IAC_MIGRATION_PLAN.md).
// A push does not apply it: change it in a pull request, `railway config plan`, then
// `railway config apply`.
import { defineRailway, github, project, service, volume } from "railway/iac";

// One partial owns both app services and the worker's volume. Postgres and its volume stay
// unmanaged by this file.
export const partial = "sermon-clipper";

export default defineRailway(() => {
  const source = github("Jgandara24/sermon-clipper", { branch: "main", checkSuites: false });

  // From the former railway.json.
  const web = service("web", {
    source,
    build: { builder: "NIXPACKS", buildCommand: "npm run build", buildEnvironment: "V3" },
    start: "npm run start",
    preDeploy: "npm run db:migrate:deploy",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    // No restart policy here: the former railway.json's ON_FAILURE x10 is Railway's default, which Railway
    // does not store, so declaring it leaves a change in every plan (RAILWAY_IAC_MIGRATION_PLAN.md).
    replicas: { "us-west2": 1 },
    domains: ["app.pulpitengine.com"],
  });

  // The existing volume with the whisper model, declared as it is today (5000 MB, us-west2), so
  // the worker keeps it mounted at /models. Without it the plan detaches the volume.
  const models = volume("worker-volume", {
    sizeMB: 5000,
    region: "us-west2",
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  // From the former railway.worker.json.
  const worker = service("worker", {
    source,
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile.worker", buildEnvironment: "V3" },
    // Restart policy left to Railway's default (ON_FAILURE x10), as for the web. No
    // requiredMountPath: Railway keeps it only for databases. The volume mount below is stored.
    volumeMounts: { "/models": models },
    replicas: { "us-west2": 1 },
  });

  return project("sermon-clipper", {
    variables: { managed: false },
    resources: [web, worker, models],
  });
});
