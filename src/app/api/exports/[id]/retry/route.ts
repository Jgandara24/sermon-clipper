import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { requeueFailedExportJob } from "@/lib/exports/queue";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

/** "Try again" on a failed export — reuses the same job row rather than creating a new one (guide §15 step 6). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const job = await prisma.exportJob.findUnique({ where: { id } });
  if (!job) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(job.workspaceId, auth.workspace.id, "export job");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const result = await requeueFailedExportJob(prisma, id);
  if (result.count === 0) {
    return apiError("INVALID_REQUEST", "This export isn't in a failed state.");
  }

  return apiData({ id, state: "QUEUED" });
}
