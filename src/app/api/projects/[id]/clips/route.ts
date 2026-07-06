import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(project.workspaceId, workspace.id, "project");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "time" ? "time" : "score";
  const filters = new Set(
    (url.searchParams.get("filter") ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  );

  const clips = await prisma.generatedClip.findMany({
    where: {
      projectId: id,
      ...(filters.has("liked") ? { liked: true } : {}),
    },
    include: { score: true },
    orderBy: sort === "time" ? { startMs: "asc" } : { rank: "asc" },
  });

  return apiData({
    clips: clips.map((clip) => ({
      id: clip.id,
      rank: clip.rank,
      startMs: clip.startMs,
      endMs: clip.endMs,
      title: clip.title,
      hookText: clip.hookText,
      summary: clip.summary,
      status: clip.status,
      liked: clip.liked,
      score: clip.score
        ? {
            total: clip.score.total,
            subscores: clip.score.subscores,
            modelVersion: clip.score.modelVersion,
            excerpt: clip.score.excerpt,
          }
        : null,
    })),
  });
}
