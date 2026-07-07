import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData } from "@/lib/api/response";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { prisma } from "@/lib/prisma";

/** Export history for the ExportTable (guide §4 /app/exports, §19 GET /api/exports?workspace). */
export async function GET() {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const jobs = await prisma.exportJob.findMany({
    where: { workspaceId: auth.workspace.id },
    include: { clip: true, outputFile: true },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();

  return apiData({
    exports: jobs.map((job) => ({
      id: job.id,
      clipId: job.clipId,
      clipTitle: job.clip.title,
      filename: job.filename,
      state: job.state,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessageUser: job.errorMessageUser,
      createdAt: job.createdAt,
      downloadUrl:
        job.outputFile && job.outputFile.downloadExpiresAt > now
          ? createSignedMediaUrl({
              key: job.outputFile.storageKey,
              workspaceId: auth.workspace.id,
              contentType: "video/mp4",
              filename: job.filename,
              disposition: "attachment",
            })
          : null,
      linkExpired: Boolean(job.outputFile) && job.outputFile!.downloadExpiresAt <= now,
    })),
  });
}
