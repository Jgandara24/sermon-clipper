import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { loadChurchProjectPool } from "@/lib/candidates/query";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

/**
 * One service's clips, as the church may see them.
 *
 * **This response carried the Selector's score, its subscores, the model version and the excerpt
 * it quoted, and no longer carries any of them.** Plan §2.2: no church-facing API response, page,
 * label, or count promise exposes what the machine thought of a church's own sermon, or the
 * configured ceiling behind the pool. `ClipScore` is not selected below — not selected and then
 * dropped, which is the difference between a guarantee and a habit.
 */
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
    orderBy: sort === "time" ? { startMs: "asc" } : { rank: "asc" },
  });

  // Where each clip stands in the service (P3.1). The church shape, so nothing about the
  // configured limit can reach this response even by accident.
  const pool = await loadChurchProjectPool(prisma, { projectId: id });
  const byClipId = new Map((pool?.candidates ?? []).map((row) => [row.clipId, row]));

  return apiData({
    // The count that exists, never the ceiling it was allowed.
    retainedCount: pool?.retainedCount ?? clips.length,
    clips: clips.map((clip) => {
      const candidate = byClipId.get(clip.id);
      return {
        id: clip.id,
        rank: clip.rank,
        startMs: clip.startMs,
        endMs: clip.endMs,
        durationMs: Math.max(0, clip.endMs - clip.startMs),
        title: clip.title,
        hookText: clip.hookText,
        summary: clip.summary,
        status: clip.status,
        liked: clip.liked,
        state: candidate?.state ?? null,
        scheduledDate: candidate?.scheduledDate?.toISOString() ?? null,
        finalRender: candidate?.boundRender
          ? { state: candidate.boundRender.state, qcStatus: candidate.boundRender.qcStatus }
          : null,
        review: candidate?.review ?? { latestDecision: null, isAboutBoundRender: false },
        renderSourceAvailable: candidate?.renderSourceAvailable ?? false,
      };
    }),
  });
}
