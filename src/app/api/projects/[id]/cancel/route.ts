import { ProjectStatus } from "@prisma/client";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { cancelJobIfActive } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { releaseReservationsForProject } from "@/lib/usage-ledger";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace("CANCEL_PROJECT");
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: { processingJobs: true },
  });

  if (!project) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }

  try {
    assertWorkspaceScope(project.workspaceId, workspace.id, "project");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  if (project.status === ProjectStatus.READY || project.status === ProjectStatus.CANCELED) {
    return apiData({ status: project.status });
  }

  for (const job of project.processingJobs) {
    await cancelJobIfActive(prisma, job.id);
  }
  await releaseReservationsForProject(prisma, {
    projectId: project.id,
    note: "Released: project canceled.",
  });

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { status: ProjectStatus.CANCELED },
  });

  return apiData({ status: updated.status });
}
