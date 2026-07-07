import { redirect } from "next/navigation";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

function contentTypeForFilename(filename: string | null): string {
  if (filename?.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

/** Authenticated compatibility shim: redirects to a short-lived signed source-video URL. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const sourceVideo = await prisma.sourceVideo.findUnique({ where: { id } });
  if (!sourceVideo?.storageKey) {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 404,
    });
  }
  try {
    assertWorkspaceScope(sourceVideo.workspaceId, workspace.id, "source video");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
      status: 403,
    });
  }

  redirect(
    createSignedMediaUrl({
      key: sourceVideo.storageKey,
      workspaceId: workspace.id,
      contentType: contentTypeForFilename(sourceVideo.filename),
      filename: sourceVideo.filename ?? undefined,
    }),
  );
}
