"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { buildLowerThird, brandTemplateInputSchema } from "@/lib/brand-template";
import { prisma } from "@/lib/prisma";

export async function saveBrandTemplateAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_TEMPLATES");
  const workspace = membership.workspace;

  const parsed = brandTemplateInputSchema.safeParse({
    name: formData.get("name"),
    churchName: formData.get("churchName"),
    speakerName: formData.get("speakerName"),
    primaryColor: formData.get("primaryColor"),
    accentColor: formData.get("accentColor"),
    captionPresetId: formData.get("captionPresetId"),
    lowerThirdHeadline: formData.get("lowerThirdHeadline"),
    lowerThirdSubhead: formData.get("lowerThirdSubhead"),
    isDefault: formData.get("isDefault") === "on",
  });

  if (!parsed.success) {
    redirect("/app/templates?error=invalid-template");
  }

  const templateId = formData.get("templateId");
  const data = {
    workspaceId: workspace.id,
    name: parsed.data.name,
    churchName: parsed.data.churchName,
    speakerName: parsed.data.speakerName || null,
    primaryColor: parsed.data.primaryColor,
    accentColor: parsed.data.accentColor,
    captionPresetId: parsed.data.captionPresetId,
    lowerThird: buildLowerThird(parsed.data),
    isDefault: parsed.data.isDefault ?? false,
  };

  if (typeof templateId === "string" && templateId.length > 0) {
    const existing = await prisma.brandTemplate.findUnique({ where: { id: templateId } });
    if (!existing || existing.workspaceId !== workspace.id) {
      redirect("/app/templates?error=not-found");
    }
  }

  // Clearing other defaults and saving the new one must commit together — as two separate
  // statements, interleaved saves (or a crash in between) could leave two defaults standing.
  await prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.brandTemplate.updateMany({
        where: { workspaceId: workspace.id, isDefault: true },
        data: { isDefault: false },
      });
    }
    if (typeof templateId === "string" && templateId.length > 0) {
      await tx.brandTemplate.update({ where: { id: templateId }, data });
    } else {
      await tx.brandTemplate.create({ data });
    }
  });

  revalidatePath("/app/templates");
  revalidatePath("/app");
  redirect("/app/templates");
}
