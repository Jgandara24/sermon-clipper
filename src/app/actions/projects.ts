"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { createDraftProjectForWorkspace } from "@/lib/project-service";
import { prisma } from "@/lib/prisma";

const projectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourceUrl: z.string().trim().url().optional().or(z.literal("")),
  series: z.string().trim().max(80).optional().or(z.literal("")),
  speaker: z.string().trim().max(80).optional().or(z.literal("")),
});

export async function createDraftProjectAction(formData: FormData) {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);

  const parsed = projectSchema.safeParse({
    name: formData.get("name"),
    sourceUrl: formData.get("sourceUrl"),
    series: formData.get("series"),
    speaker: formData.get("speaker"),
  });

  if (!parsed.success) {
    redirect("/app?error=invalid-project");
  }

  const project = await createDraftProjectForWorkspace(prisma, workspace.id, parsed.data, user.id);

  revalidatePath("/app");
  redirect(`/app/projects/${project.id}`);
}
