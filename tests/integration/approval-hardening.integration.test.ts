import {
  AuthProvider,
  ClipApprovalState,
  NotificationStatus,
  PrismaClient,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideClipApproval,
  requestClipApproval,
  ReviewLinkUnavailableError,
} from "@/lib/approval";

const prisma = new PrismaClient();

let workspaceId: string;
let userId: string;
let projectId: string;
let clipId: string;
const originalResendApiKey = process.env.RESEND_API_KEY;
const originalFromEmail = process.env.NOTIFICATIONS_FROM_EMAIL;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  process.env.RESEND_API_KEY = "";
  process.env.NOTIFICATIONS_FROM_EMAIL = "";

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("approval-hardening")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Approval Hardening Workspace",
      ownerId: user.id,
      members: { create: { userId: user.id, role: WorkspaceRole.OWNER } },
    },
  });
  workspaceId = workspace.id;

  const project = await prisma.project.create({
    data: { workspaceId, name: "Approval Hardening Project" },
  });
  projectId = project.id;

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: 1,
      startMs: 0,
      endMs: 30_000,
      title: "Approval Hardening Clip",
      summary: "A test clip for approval hardening.",
    },
  });
  clipId = clip.id;
});

afterAll(async () => {
  process.env.RESEND_API_KEY = originalResendApiKey;
  process.env.NOTIFICATIONS_FROM_EMAIL = originalFromEmail;
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("approval review hardening", () => {
  it("creates expiring review links, notification rows, and audit events", async () => {
    const approval = await requestClipApproval({
      prisma,
      clipId,
      workspaceId,
      requesterId: userId,
      reviewerEmail: "reviewer@example.com",
      appBaseUrl: "https://example.test",
    });

    expect(approval.state).toBe(ClipApprovalState.IN_REVIEW);
    expect(approval.reviewTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const notification = await prisma.approvalNotification.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(notification.recipient).toBe("reviewer@example.com");
    expect(notification.status).toBe(NotificationStatus.SKIPPED);

    const auditEvents = await prisma.clipApprovalAuditEvent.findMany({
      where: { approvalId: approval.id },
      orderBy: { createdAt: "asc" },
    });
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      "review_requested",
      "notification_skipped",
    ]);
  });

  it("blocks decisions after review link revocation", async () => {
    const approval = await prisma.clipApproval.update({
      where: { clipId },
      data: { reviewTokenRevokedAt: new Date() },
    });

    await expect(
      decideClipApproval({
        prisma,
        reviewToken: approval.reviewToken,
        state: ClipApprovalState.APPROVED,
        approverName: "Pastor",
        comment: null,
      }),
    ).rejects.toMatchObject(new ReviewLinkUnavailableError("revoked"));
  });
});
