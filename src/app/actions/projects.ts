"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { runOnePendingJob } from "@/lib/jobs/runner";
import {
  correctProjectServiceContext,
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
  const membership = await requirePrimaryWorkspacePermission(user.id, "IMPORT_MEDIA");
  const workspace = membership.workspace;

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

/** A calendar date as the browser's date input sends it. Parsed as UTC so it cannot shift a day. */
const calendarDateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the service date.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), "Enter a real service date.");

const serviceOccurrenceField = z.enum(["PRIMARY", "SECONDARY", "UNMATCHED"]);

const uploadedProjectSchema = z.object({
  sourceVideoId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  series: z.string().trim().max(80).optional().or(z.literal("")),
  speaker: z.string().trim().max(80).optional().or(z.literal("")),
  // Required for a direct upload: there is no publish timestamp to infer from, and inferring from
  // ingestion time misfiles a Tuesday upload of Sunday's sermon (P1.10).
  sermonDate: calendarDateField,
  serviceOccurrence: serviceOccurrenceField,
});

export async function createProjectFromUploadAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "IMPORT_MEDIA");
  const workspace = membership.workspace;

  const parsed = uploadedProjectSchema.safeParse({
    sourceVideoId: formData.get("sourceVideoId"),
    name: formData.get("name"),
    series: formData.get("series"),
    speaker: formData.get("speaker"),
    sermonDate: formData.get("sermonDate"),
    serviceOccurrence: formData.get("serviceOccurrence"),
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

const serviceContextCorrectionSchema = z.object({
  projectId: z.string().uuid(),
  sermonDate: calendarDateField,
  serviceOccurrence: serviceOccurrenceField,
});

/**
 * Corrects which service a project is from. Authorization is checked here rather than relied on
 * from the page that renders the form: a Server Action is a POST endpoint anyone who can reach
 * the app can call, so render-time gating is not a boundary.
 */
export async function correctProjectServiceContextAction(formData: FormData) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "IMPORT_MEDIA");

  const parsed = serviceContextCorrectionSchema.safeParse({
    projectId: formData.get("projectId"),
    sermonDate: formData.get("sermonDate"),
    serviceOccurrence: formData.get("serviceOccurrence"),
  });
  if (!parsed.success) {
    redirect(`/app/projects/${String(formData.get("projectId") ?? "")}?error=invalid-service-context`);
  }

  const result = await correctProjectServiceContext(prisma, {
    projectId: parsed.data.projectId,
    workspaceId: membership.workspace.id,
    sermonDate: parsed.data.sermonDate,
    serviceOccurrence: parsed.data.serviceOccurrence,
  });

  if (!result.ok) {
    redirect(`/app/projects/${parsed.data.projectId}?error=${result.reason.replace(/_/g, "-")}`);
  }

  revalidatePath(`/app/projects/${parsed.data.projectId}`);
  revalidatePath("/app/calendar");
  redirect(`/app/projects/${parsed.data.projectId}?updated=service-context`);
}
