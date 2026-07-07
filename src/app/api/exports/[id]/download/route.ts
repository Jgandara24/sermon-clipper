import { redirect } from "next/navigation";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

/** Authenticated compatibility shim: redirects to a short-lived signed export download URL. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  if (job.outputFile.downloadExpiresAt <= new Date()) {
    return apiError("DOWNLOAD_LINK_EXPIRED", "Link expired — here's a fresh one.", {
      status: 410,
      retryable: true,
    });
  }

  redirect(
    createSignedMediaUrl({
      key: job.outputFile.storageKey,
      workspaceId: auth.workspace.id,
      contentType: "video/mp4",
      filename: job.filename,
      disposition: "attachment",
    }),
  );
}
