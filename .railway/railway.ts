// DRAFT, not applied. docs/RAILWAY_IAC_MIGRATION_PLAN.md says how this file goes live.
// Railway reads railway.json and railway.worker.json until 2026-12-01; this file replaces both.
// `railway config migrate` generated the web service; it did not find railway.worker.json, so
// the worker is written by hand from railway.worker.json and the live deployment manifest.
import { defineRailway, github, project, service, volume } from "railway/iac";

// One partial owns both app services and the worker's volume. Postgres and its volume stay
// unmanaged by this file.
export const partial = "sermon-clipper";

export default defineRailway(() => {
  const source = github("Jgandara24/sermon-clipper", { branch: "main", checkSuites: false });

  // From railway.json.
  const web = service("web", {
    source,
    build: { builder: "NIXPACKS", buildCommand: "npm run build", buildEnvironment: "V3" },
    start: "npm run start",
    preDeploy: "npm run db:migrate:deploy",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    // `migrate` dropped these two from railway.json; written by hand.
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
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

  // From railway.worker.json.
  const worker = service("worker", {
    source,
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile.worker", buildEnvironment: "V3" },
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10, requiredMountPath: "/models" },
    volumeMounts: { "/models": models },
    replicas: { "us-west2": 1 },
  });

  return project("sermon-clipper", {
    variables: { managed: false },
    resources: [web, worker, models],
  });
});
