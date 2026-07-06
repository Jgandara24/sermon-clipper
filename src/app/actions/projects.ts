"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { runOnePendingJob } from "@/lib/jobs/runner";
import {
  createDraftProjectForWorkspace,
  createProjectFromUploadedSourceVideo,
} from "@/lib/project-service";
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

const uploadedProjectSchema = z.object({
  sourceVideoId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  series: z.string().trim().max(80).optional().or(z.literal("")),
  speaker: z.string().trim().max(80).optional().or(z.literal("")),
});

export async function createProjectFromUploadAction(formData: FormData) {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);

  const parsed = uploadedProjectSchema.safeParse({
    sourceVideoId: formData.get("sourceVideoId"),
    name: formData.get("name"),
    series: formData.get("series"),
    speaker: formData.get("speaker"),
  });

  if (!parsed.success) {
    redirect("/app?error=invalid-project");
  }

  const project = await createProjectFromUploadedSourceVideo(
    prisma,
    workspace.id,
    parsed.data,
    user.id,
  );

  // Best-effort inline processing so local dev/demo works without a separate `npm run worker`
  // terminal. The persistent worker process is the real, scalable job runner (see DECISIONS.md);
  // this just walks the FINALIZE -> PROBE chain immediately when nothing else already is.
  after(async () => {
    for (let i = 0; i < 5; i += 1) {
      const processed = await runOnePendingJob();
      if (!processed) break;
    }
  });

  revalidatePath("/app");
  redirect(`/app/projects/${project.id}`);
}
