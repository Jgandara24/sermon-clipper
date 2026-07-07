import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { WorkspacePermission } from "@/lib/authorization";
import { assertWorkspacePermission } from "@/lib/authorization";
import { AUTH_SESSION_COOKIE, hashSecret } from "@/lib/auth/email-otp";
import { prisma } from "@/lib/prisma";

export const DEV_SESSION_COOKIE = "sermon_clipper_dev_user";

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(AUTH_SESSION_COOKIE)?.value;

  if (sessionToken) {
    const session = await prisma.authSession.findUnique({
      where: { tokenHash: hashSecret(sessionToken) },
      include: { user: true },
    });

    if (session && !session.revokedAt && session.expiresAt > new Date()) {
      return session.user;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    const userId = cookieStore.get(DEV_SESSION_COOKIE)?.value;
    if (userId) {
      return prisma.user.findUnique({
        where: { id: userId },
      });
    }
  }

  return null;
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function getPrimaryWorkspaceForUser(userId: string) {
  const membership = await getPrimaryWorkspaceMembershipForUser(userId);
  return membership?.workspace ?? null;
}

export async function getPrimaryWorkspaceMembershipForUser(userId: string) {
  return prisma.workspaceMember.findFirst({
    where: {
      userId,
      status: "ACTIVE",
    },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function requirePrimaryWorkspace(userId: string) {
  const workspace = await getPrimaryWorkspaceForUser(userId);

  if (!workspace) {
    redirect("/onboarding");
  }

  return workspace;
}

export async function requirePrimaryWorkspaceMembership(userId: string) {
  const membership = await getPrimaryWorkspaceMembershipForUser(userId);

  if (!membership) {
    redirect("/onboarding");
  }

  return membership;
}

export async function requirePrimaryWorkspacePermission(
  userId: string,
  permission: WorkspacePermission,
) {
  const membership = await requirePrimaryWorkspaceMembership(userId);

  try {
    assertWorkspacePermission(membership.role, permission);
  } catch {
    redirect("/app?error=permission-denied");
  }

  return membership;
}
