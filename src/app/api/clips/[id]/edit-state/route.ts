import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { buildDefaultEditorState, editorStateSchema } from "@/lib/editor/types";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

async function loadClipWithAccess(clipId: string, workspaceId: string) {
  const clip = await prisma.generatedClip.findUnique({
    where: { id: clipId },
    include: { project: { include: { sourceVideo: true } } },
  });

  if (!clip) {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 404,
      }),
    } as const;
  }

  try {
    assertWorkspaceScope(clip.workspaceId, workspaceId, "clip");
  } catch {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 403,
      }),
    } as const;
  }

  return { clip } as const;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const access = await loadClipWithAccess(id, auth.workspace.id);
  if ("error" in access) return access.error;
  const { clip } = access;

  const latest = await prisma.clipEdit.findFirst({
    where: { clipId: id },
    orderBy: { version: "desc" },
  });

  if (latest) {
    return apiData({ version: latest.version, state: latest.editorState });
  }

  if (!clip.project.sourceVideo) {
    return apiError("PERMISSION_DENIED", "This clip has no source video.", { status: 404 });
  }

  const defaultState = buildDefaultEditorState({
    sourceVideoId: clip.project.sourceVideo.id,
    startMs: clip.startMs,
    endMs: clip.endMs,
  });
  return apiData({ version: 0, state: defaultState });
}

const putBodySchema = z.object({
  baseVersion: z.number().int().min(0),
  state: editorStateSchema,
  isAutosave: z.boolean().optional(),
});

/** Optimistic concurrency (guide §12): rejects a save whose baseVersion isn't the current tip. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const access = await loadClipWithAccess(id, auth.workspace.id);
  if ("error" in access) return access.error;

  const json = await request.json().catch(() => null);
  const parsed = putBodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("INVALID_REQUEST", "That edit couldn't be saved.");
  }

  const latest = await prisma.clipEdit.findFirst({
    where: { clipId: id },
    orderBy: { version: "desc" },
  });
  const currentVersion = latest?.version ?? 0;

  if (parsed.data.baseVersion !== currentVersion) {
    return apiError(
      "EDIT_STATE_CONFLICT",
      "This clip changed elsewhere — refresh to see the latest edit.",
      { status: 409 },
    );
  }

  const nextVersion = currentVersion + 1;
  const created = await prisma.clipEdit.create({
    data: {
      clipId: id,
      version: nextVersion,
      editorState: { ...parsed.data.state, version: nextVersion } as Prisma.InputJsonValue,
      isAutosave: parsed.data.isAutosave ?? false,
      savedBy: auth.user.id,
    },
  });

  return apiData({ version: created.version, state: created.editorState });
}
