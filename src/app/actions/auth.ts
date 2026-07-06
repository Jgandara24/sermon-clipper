"use server";

import { AuthProvider, WorkspaceRole } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DEV_SESSION_COOKIE, getPrimaryWorkspaceForUser, requireCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
});

const onboardingSchema = z.object({
  workspaceName: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(2).max(80),
  serviceDay: z.string().trim().min(2).max(24),
});

export async function devLoginAction(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    redirect("/login?error=invalid-email");
  }

  const user = await prisma.user.upsert({
    where: { email: parsed.data.email },
    update: { authProvider: AuthProvider.DEV },
    create: {
      email: parsed.data.email,
      name: parsed.data.email === "demo@sermonclipper.local" ? "Demo Volunteer" : null,
      authProvider: AuthProvider.DEV,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(DEV_SESSION_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  const workspace = await getPrimaryWorkspaceForUser(user.id);
  redirect(workspace ? "/app" : "/onboarding");
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.delete(DEV_SESSION_COOKIE);
  redirect("/login");
}

export async function createWorkspaceAction(formData: FormData) {
  const user = await requireCurrentUser();
  const parsed = onboardingSchema.safeParse({
    workspaceName: formData.get("workspaceName"),
    timezone: formData.get("timezone"),
    serviceDay: formData.get("serviceDay"),
  });

  if (!parsed.success) {
    redirect("/onboarding?error=invalid-workspace");
  }

  await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: parsed.data.workspaceName,
        ownerId: user.id,
        settings: {
          churchProfile: {
            timezone: parsed.data.timezone,
            serviceDay: parsed.data.serviceDay,
          },
          defaultProcessingConfig: {
            language: "en",
            clipLength: "60-89s",
            genre: "sermon",
          },
        },
      },
    });

    await tx.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: WorkspaceRole.OWNER,
      },
    });
  });

  redirect("/app");
}
