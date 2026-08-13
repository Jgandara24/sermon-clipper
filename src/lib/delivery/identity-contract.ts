export type DeliveryIdentityReason =
  | "slot_project_missing"
  | "slot_clip_missing"
  | "slot_export_missing"
  | "slot_clip_identity_mismatch"
  | "slot_export_identity_mismatch"
  | "clip_workspace_mismatch"
  | "clip_project_mismatch"
  | "export_workspace_mismatch"
  | "export_clip_mismatch";

type BoundDeliveryIdentity = {
  slot: {
    workspaceId: string;
    projectId: string | null;
    clipId: string | null;
    exportJobId: string | null;
  };
  clip: { id: string; workspaceId: string; projectId: string };
  exportJob: { id: string; workspaceId: string; clipId: string };
};

/**
 * Verifies identity facts that database foreign keys cannot express across workspace, project,
 * clip, and exact export rows. Every delivery consumer must fail closed on the same chain.
 */
export function verifyBoundDeliveryIdentity(
  input: BoundDeliveryIdentity,
): { ok: true } | { ok: false; reason: DeliveryIdentityReason } {
  const { slot, clip, exportJob } = input;
  if (!slot.projectId) return { ok: false, reason: "slot_project_missing" };
  if (!slot.clipId) return { ok: false, reason: "slot_clip_missing" };
  if (!slot.exportJobId) return { ok: false, reason: "slot_export_missing" };
  if (clip.id !== slot.clipId) return { ok: false, reason: "slot_clip_identity_mismatch" };
  if (exportJob.id !== slot.exportJobId) {
    return { ok: false, reason: "slot_export_identity_mismatch" };
  }
  if (clip.workspaceId !== slot.workspaceId) {
    return { ok: false, reason: "clip_workspace_mismatch" };
  }
  if (clip.projectId !== slot.projectId) return { ok: false, reason: "clip_project_mismatch" };
  if (exportJob.workspaceId !== slot.workspaceId) {
    return { ok: false, reason: "export_workspace_mismatch" };
  }
  if (exportJob.clipId !== slot.clipId) return { ok: false, reason: "export_clip_mismatch" };
  return { ok: true };
}
