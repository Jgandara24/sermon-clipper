import { MemberStatus, PrismaClient, WorkspaceRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  WorkspaceInvitationEmailMismatchError,
} from "@/lib/workspace-invitations";

const prisma = new PrismaClient();
const workspaceIdsToDelete: string[] = [];
const userEmailsToDelete: string[] = [];
const originalEnv = { ...process.env };

beforeAll(() => {
  process.env = { ...process.env, NODE_ENV: "test" };
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATIONS_FROM_EMAIL;
  delete process.env.AUTH_EMAIL_FROM;
});

afterAll(async () => {
  process.env = { ...originalEnv };
  if (workspaceIdsToDelete.length > 0) {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIdsToDelete } } });
  }
  if (userEmailsToDelete.length > 0) {
    await prisma.user.deleteMany({ where: { email: { in: userEmailsToDelete } } });
  }
  await prisma.$disconnect();
});

async function createWorkspace() {
  const ownerEmail = `invite-owner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  userEmailsToDelete.push(ownerEmail);
  const owner = await prisma.user.create({ data: { email: ownerEmail } });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Invite Church",
      ownerId: owner.id,
      members: { create: { userId: owner.id, role: WorkspaceRole.OWNER } },
    },
  });
  workspaceIdsToDelete.push(workspace.id);
  return { owner, workspace };
}

function inviteeEmail() {
  const email = `invitee-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  userEmailsToDelete.push(email);
  return email;
}

describe("workspace invitations integration", () => {
  it("creates an invitation and accepts it into an active workspace membership", async () => {
    const { owner, workspace } = await createWorkspace();
    const email = inviteeEmail();
    const invitee = await prisma.user.create({ data: { email } });

    const { invitation, token, delivery } = await createWorkspaceInvitation(prisma, {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      invitedByUserId: owner.id,
      inviterEmail: owner.email,
      email,
      role: WorkspaceRole.EDITOR,
    });

    expect(delivery.provider).toBe("development-log");
    expect(invitation.email).toBe(email);

    const result = await acceptWorkspaceInvitation(prisma, {
      token,
      userId: invitee.id,
      userEmail: invitee.email,
    });

    expect(result.membership.status).toBe(MemberStatus.ACTIVE);
    expect(result.membership.role).toBe(WorkspaceRole.EDITOR);

    const accepted = await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.acceptedAt).not.toBeNull();
  });

  it("rejects acceptance from the wrong signed-in email", async () => {
    const { owner, workspace } = await createWorkspace();
    const email = inviteeEmail();
    const wrongUserEmail = inviteeEmail();
    const wrongUser = await prisma.user.create({ data: { email: wrongUserEmail } });

    const { token } = await createWorkspaceInvitation(prisma, {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      invitedByUserId: owner.id,
      inviterEmail: owner.email,
      email,
      role: WorkspaceRole.VIEWER,
    });

    await expect(
      acceptWorkspaceInvitation(prisma, {
        token,
        userId: wrongUser.id,
        userEmail: wrongUser.email,
      }),
    ).rejects.toBeInstanceOf(WorkspaceInvitationEmailMismatchError);
  });
});
