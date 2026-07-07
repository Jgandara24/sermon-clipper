"use server";

import { WorkspaceRole } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  WorkspaceInvitationEmailMismatchError,
  WorkspaceInvitationExpiredError,
  WorkspaceInvitationUnavailableError,
} from "@/lib/workspace-invitations";

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum([WorkspaceRole.ADMIN, WorkspaceRole.EDITOR, WorkspaceRole.APPROVER, WorkspaceRole.VIEWER]),
});

const acceptSchema = z.object({
  token: z.string().min(20),
});

export async function inviteWorkspaceMemberAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_MEMBERS");
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    redirect("/app/settings?invite=invalid");
  }

  try {
    await createWorkspaceInvitation(prisma, {
      workspaceId: membership.workspace.id,
      workspaceName: membership.workspace.name,
      invitedByUserId: user.id,
      inviterEmail: user.email,
      email: parsed.data.email,
      role: parsed.data.role,
    });
  } catch (error) {
    if (error instanceof WorkspaceInvitationUnavailableError) {
      redirect("/app/settings?invite=already-member");
    }
    throw error;
  }

  revalidatePath("/app/settings");
  redirect("/app/settings?invite=sent");
}

export async function acceptWorkspaceInvitationAction(formData: FormData) {
  const user = await requireCurrentUser();
  const parsed = acceptSchema.safeParse({
    token: formData.get("token"),
  });

  if (!parsed.success) {
    redirect("/join/invalid?error=invalid");
  }

  try {
    await acceptWorkspaceInvitation(prisma, {
      token: parsed.data.token,
      userId: user.id,
      userEmail: user.email,
    });
  } catch (error) {
    if (error instanceof WorkspaceInvitationEmailMismatchError) {
      redirect(`/join/${encodeURIComponent(parsed.data.token)}?error=email-mismatch`);
    }
    if (error instanceof WorkspaceInvitationExpiredError) {
      redirect(`/join/${encodeURIComponent(parsed.data.token)}?error=expired`);
    }
    if (error instanceof WorkspaceInvitationUnavailableError) {
      redirect(`/join/${encodeURIComponent(parsed.data.token)}?error=unavailable`);
    }
    throw error;
  }

  revalidatePath("/app");
  redirect("/app?joined=workspace");
}
