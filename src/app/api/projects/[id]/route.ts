import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      sourceVideo: true,
      processingJobs: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!project) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }

  try {
    assertWorkspaceScope(project.workspaceId, workspace.id, "project");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  return apiData({
    id: project.id,
    status: project.status,
    sourceVideo: project.sourceVideo
      ? {
          id: project.sourceVideo.id,
          durationS: project.sourceVideo.durationS?.toString() ?? null,
          width: project.sourceVideo.width,
          height: project.sourceVideo.height,
          thumbnailKey: project.sourceVideo.thumbnailKey,
          hasSrtOverride: Boolean(project.sourceVideo.srtOverrideKey),
        }
      : null,
    processingJobs: project.processingJobs.map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessageUser: job.errorMessageUser,
    })),
  });
}
