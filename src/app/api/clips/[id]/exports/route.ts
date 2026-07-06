import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { enqueueExportJob } from "@/lib/exports/queue";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

const postBodySchema = z.object({
  filename: z.string().trim().min(1).max(200).optional(),
});

/** Enqueues an export job for a clip (guide §15/§19). Idempotent per (clip, edit version, filename). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const clip = await prisma.generatedClip.findUnique({
    where: { id },
    include: { project: true },
  });
  if (!clip) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(clip.workspaceId, auth.workspace.id, "clip");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const json = await request.json().catch(() => ({}));
  const parsed = postBodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "That export request couldn't be read.");
  }

  const latestEdit = await prisma.clipEdit.findFirst({
    where: { clipId: id },
    orderBy: { version: "desc" },
  });
  const editVersion = latestEdit?.version ?? 0;

  const filename =
    parsed.data.filename ??
    buildDefaultExportFilename({
      seriesOrProject: clip.project.series ?? clip.project.name,
      clipTitle: clip.title,
      date: new Date(),
    });

  const job = await enqueueExportJob(prisma, {
    clipId: clip.id,
    workspaceId: auth.workspace.id,
    filename,
    idempotencyKey: `export:${clip.id}:v${editVersion}:${filename}`,
  });

  return apiData({ exportJobId: job.id });
}
