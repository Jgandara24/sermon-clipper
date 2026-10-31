import { describe, expect, it } from "vitest";
import { successEventMetadata } from "@/lib/jobs/runner";

describe("successEventMetadata", () => {
  it("keeps job facts and handler metadata for the success event", () => {
    expect(
      successEventMetadata("ANALYZE", 2, {
        keptCount: 6,
        targetClipCount: 6,
        providerKind: "claude",
      }),
    ).toEqual({
      type: "ANALYZE",
      attempt: 2,
      keptCount: 6,
      targetClipCount: 6,
      providerKind: "claude",
    });
  });

  it("drops the internal candidate ceiling from the church-visible event copy", () => {
    // The frozen candidate rule: no church-facing surface exposes the configured ceiling or a
    // hidden override. Workspace-scoped success events render on /app/settings/operations,
    // which church OWNER/ADMIN roles can open.
    const metadata = successEventMetadata("ANALYZE", 1, {
      candidateLimit: 12,
      keptCount: 6,
    });

    expect(metadata).toEqual({ type: "ANALYZE", attempt: 1, keptCount: 6 });
    expect(metadata).not.toHaveProperty("candidateLimit");
  });

  it("drops the selection steps snapshot from the church-visible event copy, and keeps the rest", () => {
    // The snapshot's reasons (environment, workspace, no-detector) describe the operator's settings
    // and the worker's runtime; the job row keeps it for staff (docs/SELECTION_STEPS_SETTINGS_PLAN.md).
    const metadata = successEventMetadata("ANALYZE", 1, {
      keptCount: 6,
      selectionSteps: { sermonSpan: { on: false, reason: "environment" } },
    });
    expect(metadata).toEqual({ type: "ANALYZE", attempt: 1, keptCount: 6 });
    expect(metadata).not.toHaveProperty("selectionSteps");
  });

  it("handles handlers that return no metadata", () => {
    expect(successEventMetadata("PROBE", 1, undefined)).toEqual({ type: "PROBE", attempt: 1 });
  });
});
