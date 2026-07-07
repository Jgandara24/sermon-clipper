import { describe, expect, it } from "vitest";
import { applyAutomatedLaunchEvidence } from "@/lib/deployment/launch-evidence-collection";
import { createLaunchEvidenceTemplate, validateLaunchEvidenceItemProof } from "@/lib/deployment/launch-evidence";

function template() {
  return createLaunchEvidenceTemplate({
    deploymentUrl: "https://clips.example.org",
    commitSha: "abc1234",
    verifiedAt: "2026-07-07T20:00:00Z",
    verifiedBy: "Launch operator",
  });
}

describe("launch evidence collection", () => {
  it("marks health and smoke evidence passed when automated checks pass", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 200,
        ok: true,
        payload: {
          status: "ok",
          deployment: { commitSha: "abc1234", commitSource: "SERMON_CLIPPER_COMMIT_SHA" },
          checks: [
            { name: "database", status: "ok", message: "Database is reachable." },
            { name: "worker_heartbeat", status: "ok", message: "Worker worker-1 heartbeat is recent." },
          ],
        },
      },
      smoke: {
        status: "ok",
        checks: [{ name: "health", status: "ok", message: "Deployment readiness is ok." }],
      },
    });

    expect(evidence.verifiedAt).toBe("2026-07-07T21:00:00Z");
    expect(evidence.items.healthCheck?.status).toBe("passed");
    expect(evidence.items.healthCheck?.evidence).toContain("Deployment commit: abc1234");
    expect(validateLaunchEvidenceItemProof("healthCheck", evidence.items.healthCheck?.evidence ?? "")).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
    expect(evidence.items.productionSmoke?.status).toBe("passed");
    expect(evidence.items.productionSmoke?.evidence).toContain(
      "npm run smoke:production -- --base-url https://clips.example.org --commit-sha abc1234",
    );
    expect(evidence.items.productionSmoke?.evidence).toContain("Production smoke status: ok");
    expect(validateLaunchEvidenceItemProof("productionSmoke", evidence.items.productionSmoke?.evidence ?? "")).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
  });

  it("marks health failed when readiness reports failed checks", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 503,
        ok: false,
        payload: {
          status: "fail",
          checks: [{ name: "storage", status: "fail", message: "Storage provider is not configured." }],
        },
      },
      smoke: {
        status: "fail",
        checks: [{ name: "health", status: "fail", message: "Deployment readiness is failing." }],
      },
    });

    expect(evidence.items.healthCheck?.status).toBe("failed");
    expect(evidence.items.healthCheck?.evidence).toContain("Failed readiness checks: 1");
    expect(evidence.items.productionSmoke?.status).toBe("failed");
  });

  it("marks health failed when readiness is degraded", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 200,
        ok: true,
        payload: {
          status: "degraded",
          deployment: { commitSha: "abc1234", commitSource: "SERMON_CLIPPER_COMMIT_SHA" },
          checks: [{ name: "deployment_commit", status: "warning", message: "Commit metadata missing." }],
        },
      },
      smoke: {
        status: "ok",
        checks: [{ name: "health", status: "ok", message: "Deployment readiness is ok." }],
      },
    });

    expect(evidence.items.healthCheck?.status).toBe("failed");
    expect(evidence.items.healthCheck?.evidence).toContain("Readiness status: degraded");
  });

  it("marks production smoke failed when smoke reports warnings", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 200,
        ok: true,
        payload: {
          status: "ok",
          deployment: { commitSha: "abc1234", commitSource: "SERMON_CLIPPER_COMMIT_SHA" },
          checks: [
            { name: "database", status: "ok", message: "Database is reachable." },
            { name: "worker_heartbeat", status: "ok", message: "Worker worker-1 heartbeat is recent." },
          ],
        },
      },
      smoke: {
        status: "warning",
        checks: [{ name: "health", status: "warning", message: "Deployment readiness is degraded." }],
      },
    });

    expect(evidence.items.productionSmoke?.status).toBe("failed");
    expect(evidence.items.productionSmoke?.evidence).toContain("Production smoke status: warning");
  });

  it("marks health failed when deployment commit is missing", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 200,
        ok: true,
        payload: {
          status: "ok",
          checks: [
            { name: "database", status: "ok", message: "Database is reachable." },
            { name: "worker_heartbeat", status: "ok", message: "Worker worker-1 heartbeat is recent." },
          ],
        },
      },
      smoke: {
        status: "ok",
        checks: [{ name: "health", status: "ok", message: "Deployment readiness is ok." }],
      },
    });

    expect(evidence.items.healthCheck?.status).toBe("failed");
    expect(evidence.items.healthCheck?.evidence).toContain("Deployment commit: missing");
  });

  it("marks health failed when deployment commit does not match evidence commit", () => {
    const evidence = applyAutomatedLaunchEvidence({
      evidence: template(),
      collectedAt: "2026-07-07T21:00:00Z",
      health: {
        baseUrl: "https://clips.example.org",
        httpStatus: 200,
        ok: true,
        payload: {
          status: "ok",
          deployment: { commitSha: "fffffff", commitSource: "SERMON_CLIPPER_COMMIT_SHA" },
          checks: [
            { name: "database", status: "ok", message: "Database is reachable." },
            { name: "worker_heartbeat", status: "ok", message: "Worker worker-1 heartbeat is recent." },
          ],
        },
      },
      smoke: {
        status: "ok",
        checks: [{ name: "health", status: "ok", message: "Deployment readiness is ok." }],
      },
    });

    expect(evidence.items.healthCheck?.status).toBe("failed");
    expect(evidence.items.healthCheck?.evidence).toContain("Deployment commit: fffffff");
  });
});
