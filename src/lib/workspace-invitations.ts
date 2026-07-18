import { randomBytes } from "node:crypto";
import {
  MemberStatus,
  NotificationStatus,
  WorkspaceInvitationStatus,
  WorkspaceRole,
  type PrismaClient,
} from "@prisma/client";
import { hashSecret } from "@/lib/auth/email-otp";
import { normalizeEmail } from "@/lib/auth/email-otp";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { sendViaResend } from "@/lib/notifications/email-provider";

export const WORKSPACE_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export class WorkspaceInvitationError extends Error {}
export class WorkspaceInvitationEmailMismatchError extends WorkspaceInvitationError {}
export class WorkspaceInvitationExpiredError extends WorkspaceInvitationError {}
export class WorkspaceInvitationUnavailableError extends WorkspaceInvitationError {}

export type WorkspaceInvitationDeliveryResult = {
  provider: string;
  status: NotificationStatus;
  errorMessage?: string | null;
};

export function createWorkspaceInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function workspaceInvitationPath(token: string): string {
  return `/join/${encodeURIComponent(token)}`;
}

export function workspaceInvitationUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${appUrl}${workspaceInvitationPath(token)}`;
}

export async function sendWorkspaceInvitationEmail(input: {
  email: string;
  workspaceName: string;
  inviterEmail: string;
  role: WorkspaceRole;
  invitationUrl: string;
  expiresAt: Date;
}): Promise<WorkspaceInvitationDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.NOTIFICATIONS_FROM_EMAIL ?? process.env.AUTH_EMAIL_FROM;
  const fromName = process.env.NOTIFICATIONS_FROM_NAME ?? process.env.AUTH_EMAIL_FROM_NAME ?? "Sermon Clipper";

  if (!apiKey || !fromEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[workspace] Invitation for ${input.email}: ${input.invitationUrl}`);
      return {
        provider: "development-log",
        status: NotificationStatus.SKIPPED,
        errorMessage: "RESEND_API_KEY and NOTIFICATIONS_FROM_EMAIL/AUTH_EMAIL_FROM are required to send email.",
      };
    }

    return {
      provider: "resend",
      status: NotificationStatus.FAILED,
      errorMessage: "RESEND_API_KEY and NOTIFICATIONS_FROM_EMAIL/AUTH_EMAIL_FROM are required in production.",
    };
  }

  const result = await sendViaResend({
    apiKey,
    to: input.email,
    subject: `Join ${input.workspaceName} on Sermon Clipper`,
    text: [
      `${input.inviterEmail} invited you to join ${input.workspaceName} as ${input.role.toLowerCase()}.`,
      "",
      "Accept the invitation:",
      input.invitationUrl,
      "",
      `This invitation expires at ${input.expiresAt.toISOString()}.`,
      "If you did not expect this invitation, you can ignore this email.",
    ].join("\n"),
    fromEmail,
    fromName,
  });

  return { provider: "resend", ...result };
}

export async function createWorkspaceInvitation(
  prisma: PrismaClient,
  params: {
    workspaceId: string;
    workspaceName: string;
    invitedByUserId: string;
    inviterEmail: string;
    email: string;
    role: Exclude<WorkspaceRole, "OWNER">;
    now?: Date;
  },
) {
  const email = normalizeEmail(params.email);
  const now = params.now ?? new Date();
  const existingUser = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        where: { workspaceId: params.workspaceId, status: MemberStatus.ACTIVE },
      },
    },
  });
  if (existingUser?.memberships.length) {
    throw new WorkspaceInvitationUnavailableError("That user is already an active workspace member.");
  }

  const token = createWorkspaceInvitationToken();
  const expiresAt = new Date(now.getTime() + WORKSPACE_INVITATION_TTL_MS);
  const invitation = await prisma.workspaceInvitation.create({
    data: {
      workspaceId: params.workspaceId,
      email,
      role: params.role,
      tokenHash: hashSecret(token),
      invitedByUserId: params.invitedByUserId,
      expiresAt,
    },
  });

  const invitationUrl = workspaceInvitationUrl(token);
  const delivery = await sendWorkspaceInvitationEmail({
    email,
    workspaceName: params.workspaceName,
    inviterEmail: params.inviterEmail,
    role: params.role,
    invitationUrl,
    expiresAt,
  });

  await prisma.workspaceInvitation.update({
    where: { id: invitation.id },
    data: {
      deliveryStatus: delivery.status,
      deliveryProvider: delivery.provider,
      deliveryErrorMessage: delivery.errorMessage ?? null,
    },
  });

  await recordOperationalEventSafely(prisma, {
    workspaceId: params.workspaceId,
    category: "auth",
    eventType:
      delivery.status === NotificationStatus.SENT
        ? "workspace_invitation_sent"
        : delivery.status === NotificationStatus.FAILED
          ? "workspace_invitation_delivery_failed"
          : "workspace_invitation_delivery_skipped",
    severity:
      delivery.status === NotificationStatus.FAILED
        ? "error"
        : delivery.status === NotificationStatus.SKIPPED
          ? "warning"
          : "info",
    message: `Workspace invitation delivery ${delivery.status.toLowerCase()}.`,
    metadata: {
      invitationId: invitation.id,
      email,
      role: params.role,
      provider: delivery.provider,
      errorMessage: delivery.errorMessage ?? null,
    },
  });

  return { invitation, token, invitationUrl, delivery };
}

export async function findWorkspaceInvitationByToken(
  prisma: PrismaClient,
  token: string,
  now = new Date(),
) {
  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { workspace: true },
  });
  if (!invitation) return null;
  if (invitation.status === WorkspaceInvitationStatus.PENDING && invitation.expiresAt <= now) {
    return prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: WorkspaceInvitationStatus.EXPIRED },
      include: { workspace: true },
    });
  }
  return invitation;
}

export async function acceptWorkspaceInvitation(
  prisma: PrismaClient,
  params: { token: string; userId: string; userEmail: string; now?: Date },
) {
  const now = params.now ?? new Date();
  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { tokenHash: hashSecret(params.token) },
    include: { workspace: true },
  });

  if (!invitation || invitation.status !== WorkspaceInvitationStatus.PENDING) {
    throw new WorkspaceInvitationUnavailableError("This invitation is no longer available.");
  }
  if (invitation.expiresAt <= now) {
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: WorkspaceInvitationStatus.EXPIRED },
    });
    throw new WorkspaceInvitationExpiredError("This invitation has expired.");
  }
  if (normalizeEmail(params.userEmail) !== invitation.email) {
    throw new WorkspaceInvitationEmailMismatchError("Sign in with the invited email address.");
  }

  const membership = await prisma.$transaction(async (tx) => {
    const joined = await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: params.userId } },
      update: { role: invitation.role, status: MemberStatus.ACTIVE },
      create: {
        workspaceId: invitation.workspaceId,
        userId: params.userId,
        role: invitation.role,
        status: MemberStatus.ACTIVE,
      },
    });

    await tx.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: WorkspaceInvitationStatus.ACCEPTED, acceptedAt: now },
    });

    return joined;
  });

  await recordOperationalEventSafely(prisma, {
    workspaceId: invitation.workspaceId,
    category: "auth",
    eventType: "workspace_invitation_accepted",
    message: "Workspace invitation accepted.",
    metadata: {
      invitationId: invitation.id,
      userId: params.userId,
      email: invitation.email,
      role: invitation.role,
    },
  });

  return { invitation, membership };
}
