import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** DOWNLOAD_LINK_EXPIRED recovery (guide §20): re-signs (extends) an expired export's download link. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  if (!job.outputFile) {
    return apiError("RENDER_FAILED", "Export failed on our side — your clip is safe.", { status: 404 });
  }

  await prisma.exportedFile.update({
    where: { id: job.outputFile.id },
    data: { downloadExpiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS) },
  });

  return apiData({ downloadUrl: `/api/exports/${job.id}/download` });
}
