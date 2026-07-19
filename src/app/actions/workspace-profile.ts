"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const churchProfileSchema = z.object({
  timezone: z.string().trim().min(2).max(80),
  serviceDay: z.string().trim().min(2).max(24),
  sermonsPerWeek: z.coerce.number().int().min(1).max(2),
  secondServiceDay: z.string().trim().min(2).max(24).optional(),
  postsPerDay: z.coerce.number().int().min(1).max(10),
});

export async function updateChurchProfileAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_WORKSPACE_PROFILE");

  const parsed = churchProfileSchema.safeParse({
    timezone: formData.get("timezone"),
    serviceDay: formData.get("serviceDay"),
    sermonsPerWeek: formData.get("sermonsPerWeek"),
    secondServiceDay: formData.get("secondServiceDay") || undefined,
    postsPerDay: formData.get("postsPerDay"),
  });

  if (!parsed.success) {
    redirect("/app/settings?profile=invalid");
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: membership.workspace.id },
    select: { settings: true },
  });
  const currentSettings =
    workspace.settings && typeof workspace.settings === "object"
      ? (workspace.settings as Record<string, unknown>)
      : {};

  await prisma.workspace.update({
    where: { id: membership.workspace.id },
    data: {
      settings: {
        ...currentSettings,
        churchProfile: {
          timezone: parsed.data.timezone,
          serviceDay: parsed.data.serviceDay,
          sermonsPerWeek: parsed.data.sermonsPerWeek,
          secondServiceDay:
            parsed.data.sermonsPerWeek === 2 ? (parsed.data.secondServiceDay || "Wednesday") : null,
          postsPerDay: parsed.data.postsPerDay,
        },
      },
    },
  });

  revalidatePath("/app/settings");
  redirect("/app/settings?profile=saved");
}
