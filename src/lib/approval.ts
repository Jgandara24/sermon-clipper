import { randomBytes } from "node:crypto";
import {
  ClipApprovalState,
  NotificationChannel,
  NotificationStatus,
  type ClipApproval,
  type PrismaClient,
} from "@prisma/client";
import { env } from "@/lib/env";
import { sendApprovalNotification } from "@/lib/notifications/approval";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";

const REVIEW_TOKEN_TTL_DAYS = 14;

export class ReviewLinkUnavailableError extends Error {
  constructor(readonly reason: "expired" | "revoked" | "not_found") {
    super(`Review link is ${reason}.`);
  }
}

export function createReviewToken(): string {
  return randomBytes(24).toString("base64url");
}

export function createReviewTokenExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + REVIEW_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isReviewLinkActive(
  approval: Pick<ClipApproval, "reviewTokenExpiresAt" | "reviewTokenRevokedAt">,
  now = new Date(),
): boolean {
  return !approval.reviewTokenRevokedAt && approval.reviewTokenExpiresAt > now;
}

export function reviewLinkUnavailableReason(
  approval: Pick<ClipApproval, "reviewTokenExpiresAt" | "reviewTokenRevokedAt"> | null,
  now = new Date(),
): "expired" | "revoked" | "not_found" | null {
  if (!approval) return "not_found";
  if (approval.reviewTokenRevokedAt) return "revoked";
  if (approval.reviewTokenExpiresAt <= now) return "expired";
  return null;
}

/**
 * Editorial approval gates delivery to an audience — publishing and scheduling — not a manual
 * download from the member's own editor.
 *
 * A manual MP4 export hands a file to the person who is already inside the workspace and already
 * carries the EXPORT_CLIP permission. It delivers nothing to a congregation, so requiring
 * approval for it only taught people to approve clips they had no intention of posting, which
 * devalues the approval itself.
 *
 * This is a deliberate relocation of the gate, not its removal. See DECISIONS.md
 * (2026-08-18) and P1.11/P2.4 in docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md.
 *
 * Access, billing, and role enforcement are separate and unchanged: requireApiWorkspace still
 * checks EXPORT_CLIP and still refuses a trial-expired or lapsed read-only workspace.
 */
export function isManualExportAllowedWithoutApproval(
  approvalState: ClipApprovalState | string | null | undefined,
): boolean {
  // The state is accepted and deliberately ignored: callers pass it so the relocation is
  // visible at every call site, and so a future policy change has one place to land.
  void approvalState;
  return true;
}

/** The one authority for "may this clip reach an audience?". Publishers and schedulers call it. */
export function isClipApprovedForPublish(
  approvalState: ClipApprovalState | string | null | undefined,
): boolean {
  return approvalState === ClipApprovalState.APPROVED;
}

export function publishApprovalBlockMessage(
  approvalState: ClipApprovalState | string | null | undefined,
): string {
  if (approvalState === ClipApprovalState.CHANGES_REQUESTED) {
    return "Changes were requested. Update the clip and send it for approval again before publishing or scheduling.";
  }
  if (approvalState === ClipApprovalState.IN_REVIEW) {
    return "This clip is still in review. Publishing and scheduling unlock after approval.";
  }
  return "Send this clip for approval before publishing or scheduling it.";
}

/**
 * An editor save invalidates an existing approval: the reviewer approved a specific cut, and
 * the clip is no longer that cut. Unchanged by the export-gate relocation — it protects the
 * publish gate, which still stands.
 */
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
  reviewerEmail?: string | null;
  reviewerPhone?: string | null;
  appBaseUrl?: string;
}) {
  const reviewToken = createReviewToken();
  const reviewTokenExpiresAt = createReviewTokenExpiresAt();
  const approval = await params.prisma.$transaction(async (tx) => {
    const saved = await tx.clipApproval.upsert({
      where: { clipId: params.clipId },
      update: {
        state: ClipApprovalState.IN_REVIEW,
        requesterId: params.requesterId,
        decidedAt: null,
        approverName: null,
        comment: null,
        reviewToken,
        reviewTokenExpiresAt,
        reviewTokenRevokedAt: null,
        reviewTokenLastViewedAt: null,
      },
      create: {
        clipId: params.clipId,
        workspaceId: params.workspaceId,
        requesterId: params.requesterId,
        state: ClipApprovalState.IN_REVIEW,
        reviewToken,
        reviewTokenExpiresAt,
      },
      include: {
        clip: { include: { project: true } },
        workspace: true,
        requester: true,
      },
    });

    await tx.clipApprovalAuditEvent.create({
      data: {
        approvalId: saved.id,
        workspaceId: params.workspaceId,
        eventType: "review_requested",
        metadata: {
          clipId: params.clipId,
          requesterId: params.requesterId,
          reviewTokenExpiresAt: reviewTokenExpiresAt.toISOString(),
        },
      },
    });

    return saved;
  });

  const reviewUrl = buildReviewUrl(approval.reviewToken, params.appBaseUrl);
  const recipients = [
    params.reviewerEmail
      ? { channel: NotificationChannel.EMAIL, recipient: params.reviewerEmail }
      : null,
    params.reviewerPhone ? { channel: NotificationChannel.SMS, recipient: params.reviewerPhone } : null,
  ].filter((item): item is { channel: NotificationChannel; recipient: string } => Boolean(item));

  for (const recipient of recipients) {
    const result = await sendApprovalNotification({
      channel: recipient.channel,
      recipient: recipient.recipient,
      reviewUrl,
      clipTitle: approval.clip.title,
      workspaceName: approval.workspace.name,
      requesterEmail: approval.requester?.email,
    });

    await params.prisma.$transaction(async (tx) => {
      await tx.approvalNotification.create({
        data: {
          approvalId: approval.id,
          workspaceId: approval.workspaceId,
          channel: recipient.channel,
          recipient: recipient.recipient,
          provider: result.provider,
          status: result.status,
          errorMessage: result.errorMessage ?? null,
          providerMessageId: result.providerMessageId ?? null,
          sentAt: result.status === NotificationStatus.SENT ? new Date() : null,
          metadata: { reviewUrl },
        },
      });
      await tx.clipApprovalAuditEvent.create({
        data: {
          approvalId: approval.id,
          workspaceId: approval.workspaceId,
          eventType:
            result.status === NotificationStatus.SENT
              ? "notification_sent"
              : result.status === NotificationStatus.FAILED
                ? "notification_failed"
                : "notification_skipped",
          metadata: {
            channel: recipient.channel,
            recipient: recipient.recipient,
            provider: result.provider,
            errorMessage: result.errorMessage ?? null,
          },
        },
      });
      await tx.operationalEvent.create({
        data: {
          workspaceId: approval.workspaceId,
          category: "approval",
          eventType:
            result.status === NotificationStatus.SENT
              ? "approval_notification_sent"
              : result.status === NotificationStatus.FAILED
                ? "approval_notification_failed"
                : "approval_notification_skipped",
          severity: result.status === NotificationStatus.FAILED ? "error" : "info",
          message: `Approval notification ${result.status.toLowerCase()}.`,
          metadata: {
            approvalId: approval.id,
            clipId: params.clipId,
            channel: recipient.channel,
            provider: result.provider,
            errorMessage: result.errorMessage ?? null,
          },
        },
      });
    });
  }
  if (recipients.length === 0) {
    await recordOperationalEventSafely(params.prisma, {
      workspaceId: approval.workspaceId,
      category: "approval",
      eventType: "approval_requested_without_notification",
      severity: "warning",
      message: "Approval was requested without an email or SMS reviewer recipient.",
      metadata: { approvalId: approval.id, clipId: params.clipId },
    });
  }

  return approval;
}

export async function decideClipApproval(params: {
  prisma: PrismaClient;
  reviewToken: string;
  state: typeof ClipApprovalState.APPROVED | typeof ClipApprovalState.CHANGES_REQUESTED;
  approverName: string | null;
  comment: string | null;
}) {
  const now = new Date();
  const approval = await params.prisma.clipApproval.findUnique({
    where: { reviewToken: params.reviewToken },
  });
  const unavailableReason = reviewLinkUnavailableReason(approval, now);
  if (unavailableReason) {
    throw new ReviewLinkUnavailableError(unavailableReason);
  }

  return params.prisma.$transaction(async (tx) => {
    const updated = await tx.clipApproval.update({
      where: { reviewToken: params.reviewToken },
      data: {
        state: params.state,
        approverName: params.approverName,
        comment: params.comment,
        decidedAt: now,
      },
    });

    await tx.clipApprovalAuditEvent.create({
      data: {
        approvalId: updated.id,
        workspaceId: updated.workspaceId,
        eventType: "decision_recorded",
        metadata: {
          state: params.state,
          approverName: params.approverName,
        },
      },
    });

    return updated;
  });
}

export async function recordReviewLinkViewed(params: {
  prisma: PrismaClient;
  approvalId: string;
  workspaceId: string;
}) {
  await params.prisma.$transaction([
    params.prisma.clipApproval.update({
      where: { id: params.approvalId },
      data: { reviewTokenLastViewedAt: new Date() },
    }),
    params.prisma.clipApprovalAuditEvent.create({
      data: {
        approvalId: params.approvalId,
        workspaceId: params.workspaceId,
        eventType: "review_link_viewed",
      },
    }),
  ]);
}

export async function revokeClipApprovalReviewLink(params: {
  prisma: PrismaClient;
  clipId: string;
  reason: string;
}) {
  const existing = await params.prisma.clipApproval.findUnique({ where: { clipId: params.clipId } });
  if (!existing || existing.reviewTokenRevokedAt) return null;

  return params.prisma.$transaction(async (tx) => {
    const updated = await tx.clipApproval.update({
      where: { clipId: params.clipId },
      data: { reviewTokenRevokedAt: new Date() },
    });
    await tx.clipApprovalAuditEvent.create({
      data: {
        approvalId: updated.id,
        workspaceId: updated.workspaceId,
        eventType: "review_link_revoked",
        metadata: { reason: params.reason },
      },
    });
    return updated;
  });
}

export function buildReviewUrl(reviewToken: string, appBaseUrl = env.NEXT_PUBLIC_APP_URL): string {
  const path = `/review/${reviewToken}`;
  if (!appBaseUrl) return path;
  return new URL(path, appBaseUrl).toString();
}
