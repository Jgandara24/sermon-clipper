import { GeneratedClipStatus } from "@prisma/client";
import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["SUGGESTED", "KEPT", "HIDDEN"]).optional(),
  liked: z.boolean().nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const clip = await prisma.generatedClip.findUnique({ where: { id } });
  if (!clip) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(clip.workspaceId, workspace.id, "clip");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const json = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "That update couldn't be read.");
  }

  const updated = await prisma.generatedClip.update({
    where: { id },
    data: {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.status !== undefined
        ? { status: parsed.data.status as GeneratedClipStatus }
        : {}),
      ...(parsed.data.liked !== undefined ? { liked: parsed.data.liked } : {}),
    },
  });

  return apiData({
    id: updated.id,
    title: updated.title,
    status: updated.status,
    liked: updated.liked,
  });
}
