import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const DEV_SESSION_COOKIE = "sermon_clipper_dev_user";

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const userId = cookieStore.get(DEV_SESSION_COOKIE)?.value;

  if (!userId) {
    return null;
  }

  return prisma.user.findUnique({
    where: { id: userId },
  });
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function getPrimaryWorkspaceForUser(userId: string) {
  return prisma.workspace.findFirst({
    where: {
      members: {
        some: {
          userId,
          status: "ACTIVE",
        },
      },
    },
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
