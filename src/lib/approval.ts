import { randomBytes } from "node:crypto";
import { ClipApprovalState, type PrismaClient } from "@prisma/client";

export function createReviewToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isClipApprovedForExport(approvalState: ClipApprovalState | string | null | undefined): boolean {
  return approvalState === ClipApprovalState.APPROVED;
}

export function approvalExportBlockMessage(approvalState: ClipApprovalState | string | null | undefined): string {
  if (approvalState === ClipApprovalState.CHANGES_REQUESTED) {
    return "Changes were requested. Update the clip and send it for approval again before exporting.";
  }
  if (approvalState === ClipApprovalState.IN_REVIEW) {
    return "This clip is still in review. Export unlocks after approval.";
  }
  return "Send this clip for approval before exporting.";
}

export function approvalStateAfterEditorSave(
  approvalState: ClipApprovalState | string | null | undefined,
): ClipApprovalState | null {
  if (approvalState === ClipApprovalState.APPROVED) return ClipApprovalState.DRAFT;
  return null;
}

export async function requestClipApproval(params: {
  prisma: PrismaClient;
  clipId: string;
  workspaceId: string;
  requesterId: string;
}) {
  return params.prisma.clipApproval.upsert({
    where: { clipId: params.clipId },
    update: {
      state: ClipApprovalState.IN_REVIEW,
      requesterId: params.requesterId,
      decidedAt: null,
    },
    create: {
      clipId: params.clipId,
      workspaceId: params.workspaceId,
      requesterId: params.requesterId,
      state: ClipApprovalState.IN_REVIEW,
      reviewToken: createReviewToken(),
    },
  });
}

export async function decideClipApproval(params: {
  prisma: PrismaClient;
  reviewToken: string;
  state: typeof ClipApprovalState.APPROVED | typeof ClipApprovalState.CHANGES_REQUESTED;
  approverName: string | null;
  comment: string | null;
}) {
  return params.prisma.clipApproval.update({
    where: { reviewToken: params.reviewToken },
    data: {
      state: params.state,
      approverName: params.approverName,
      comment: params.comment,
      decidedAt: new Date(),
    },
  });
}
