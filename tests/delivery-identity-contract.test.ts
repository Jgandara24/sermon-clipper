import { describe, expect, it } from "vitest";
import { verifyBoundDeliveryIdentity } from "@/lib/delivery/identity-contract";

const valid = {
  slot: { workspaceId: "workspace-a", projectId: "project-a", clipId: "clip-a", exportJobId: "export-a" },
  clip: { id: "clip-a", workspaceId: "workspace-a", projectId: "project-a" },
  exportJob: { id: "export-a", workspaceId: "workspace-a", clipId: "clip-a" },
};

describe("bound delivery identity contract", () => {
  it("accepts one exact workspace, project, clip, and export chain", () => {
    expect(verifyBoundDeliveryIdentity(valid)).toEqual({ ok: true });
  });

  it.each([
    ["missing project binding", { slot: { ...valid.slot, projectId: null } }, "slot_project_missing"],
    ["missing clip binding", { slot: { ...valid.slot, clipId: null } }, "slot_clip_missing"],
    ["missing export binding", { slot: { ...valid.slot, exportJobId: null } }, "slot_export_missing"],
    ["slot clip mismatch", { slot: { ...valid.slot, clipId: "clip-b" } }, "slot_clip_identity_mismatch"],
    ["slot export mismatch", { slot: { ...valid.slot, exportJobId: "export-b" } }, "slot_export_identity_mismatch"],
    ["clip workspace mismatch", { clip: { ...valid.clip, workspaceId: "workspace-b" } }, "clip_workspace_mismatch"],
    ["clip project mismatch", { clip: { ...valid.clip, projectId: "project-b" } }, "clip_project_mismatch"],
    ["export workspace mismatch", { exportJob: { ...valid.exportJob, workspaceId: "workspace-b" } }, "export_workspace_mismatch"],
    ["export clip mismatch", { exportJob: { ...valid.exportJob, clipId: "clip-b" } }, "export_clip_mismatch"],
  ])("refuses %s", (_label, override, reason) => {
    expect(verifyBoundDeliveryIdentity({ ...valid, ...override })).toEqual({ ok: false, reason });
  });
});
