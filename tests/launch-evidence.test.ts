import { describe, expect, it } from "vitest";
import { launchEvidenceItems, validateLaunchEvidence } from "@/lib/deployment/launch-evidence";

function completeEvidence() {
  return {
    deploymentUrl: "https://clips.example.org",
    commitSha: "fe09434",
    verifiedAt: "2026-07-07T20:00:00Z",
    verifiedBy: "Launch operator",
    items: Object.fromEntries(
      launchEvidenceItems.map((item) => [
        item.key,
        { status: "passed", evidence: `${item.label} proof captured in production.` },
      ]),
    ),
  };
}

describe("launch evidence validation", () => {
  it("passes when every Phase 8 launch item has proof", () => {
    const result = validateLaunchEvidence(completeEvidence());

    expect(result.status).toBe("ok");
    expect(result.checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("fails when the deployment URL is not HTTPS", () => {
    const evidence = completeEvidence();
    evidence.deploymentUrl = "http://clips.example.org";

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "deploymentUrl", status: "fail" })]),
    );
  });

  it("fails when an evidence item is missing proof", () => {
    const evidence = completeEvidence();
    evidence.items.export = { status: "passed", evidence: "" };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "export", status: "fail" })]));
  });

  it("fails when an evidence item is not marked passed", () => {
    const evidence = completeEvidence();
    evidence.items.billing = { status: "failed", evidence: "Stripe webhook did not arrive." };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "billing", status: "fail" })]));
  });
});
