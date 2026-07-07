import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { requestClipApproval } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const clip = await prisma.generatedClip.findUnique({ where: { id } });
  if (!clip) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(clip.workspaceId, auth.workspace.id, "clip");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const approval = await requestClipApproval({
    prisma,
    clipId: clip.id,
    workspaceId: auth.workspace.id,
    requesterId: auth.user.id,
  });

  return apiData({
    id: approval.id,
    state: approval.state,
    reviewUrl: `/review/${approval.reviewToken}`,
  });
}
