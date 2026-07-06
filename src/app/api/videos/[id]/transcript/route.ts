import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const sourceVideo = await prisma.sourceVideo.findUnique({ where: { id } });
  if (!sourceVideo) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(sourceVideo.workspaceId, workspace.id, "source video");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  const transcript = await prisma.transcript.findUnique({ where: { sourceVideoId: id } });
  if (!transcript) {
    return apiData({ transcript: null, segments: [] });
  }

  const url = new URL(request.url);
  const fromMs = url.searchParams.get("fromMs");
  const toMs = url.searchParams.get("toMs");
  const q = url.searchParams.get("q");

  const segments = await prisma.transcriptSegment.findMany({
    where: {
      transcriptId: transcript.id,
      ...(fromMs ? { endMs: { gte: Number(fromMs) } } : {}),
      ...(toMs ? { startMs: { lte: Number(toMs) } } : {}),
      ...(q ? { text: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { idx: "asc" },
  });

  return apiData({
    transcript: {
      id: transcript.id,
      language: transcript.language,
      provider: transcript.provider,
    },
    segments: segments.map((segment) => ({
      id: segment.id,
      idx: segment.idx,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words,
    })),
  });
}
