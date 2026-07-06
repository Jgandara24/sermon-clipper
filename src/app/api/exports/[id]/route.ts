import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

/** Single export job status for polling (guide §19 GET /api/exports/:id -> {state, progress, downloadUrl?}). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const job = await prisma.exportJob.findUnique({ where: { id }, include: { outputFile: true } });
  if (!job) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(job.workspaceId, auth.workspace.id, "export job");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const now = new Date();
  const linkExpired = Boolean(job.outputFile) && job.outputFile!.downloadExpiresAt <= now;

  return apiData({
    id: job.id,
    state: job.state,
    progress: job.progress,
    errorCode: job.errorCode,
    errorMessageUser: job.errorMessageUser,
    downloadUrl: job.outputFile && !linkExpired ? `/api/exports/${job.id}/download` : null,
    linkExpired,
  });
}
