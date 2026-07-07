import { GeneratedClipStatus, ProjectStatus } from "@prisma/client";
import { getAnalysisProvider } from "@/lib/analysis";
import { buildCandidateWindows, dedupByOverlap, refineBoundaries } from "@/lib/analysis/chunking";
import { filterSermonCandidates } from "@/lib/analysis/sermon-boundary";
import { AnalysisProviderUnavailableError } from "@/lib/analysis/types";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";

const MIN_CANDIDATE_MS = 20_000;
const MAX_CANDIDATE_MS = 90_000;
const TARGET_CLIP_COUNT = 8;

function readGenre(processingConfig: unknown): string {
  if (processingConfig && typeof processingConfig === "object" && "genre" in processingConfig) {
    const genre = (processingConfig as { genre?: unknown }).genre;
    if (typeof genre === "string" && genre.length > 0) return genre;
  }
  return "sermon";
}

/**
 * Chunks the transcript into candidate windows, scores them (real Claude API if configured,
 * otherwise the deterministic heuristic fallback), refines boundaries, dedups overlapping
 * candidates by score, and persists the top-ranked clips. Guide §10.
 */
export const runAnalyzeJob: JobHandler = async ({ job, prisma }) => {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: {
      sourceVideo: {
        include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } },
      },
    },
  });

  const transcript = project.sourceVideo?.transcript;
  if (!transcript || transcript.segments.length === 0) {
    throw new JobFailureError("ANALYZE_FAILED", "Clip analysis failed — your minutes were returned.");
  }

  const segments = transcript.segments.map((segment) => ({
    idx: segment.idx,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));

  const genre = readGenre(project.processingConfig);
  const candidates = buildCandidateWindows(segments, {
    minMs: MIN_CANDIDATE_MS,
    maxMs: MAX_CANDIDATE_MS,
  });

  if (candidates.length === 0) {
    throw new JobFailureError(
      "NO_CLIPS_FOUND",
      "We didn't find strong standalone moments. Try a narrower timeframe or a prompt.",
    );
  }

  const sourceDurationMs = project.sourceVideo?.durationS
    ? project.sourceVideo.durationS.toNumber() * 1000
    : Math.max(...candidates.map((c) => c.endMs));

  const provider = await getAnalysisProvider();

  let scored;
  try {
    const scoreableCandidates =
      genre.toLowerCase() === "sermon"
        ? filterSermonCandidates(candidates.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })))
        : candidates.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));

    scored = await provider.scoreCandidates(
      scoreableCandidates,
      { fullText: transcript.fullText, genre },
    );
  } catch (error) {
    if (error instanceof AnalysisProviderUnavailableError) {
      throw new JobFailureError(
        "ANALYZE_PROVIDER_UNAVAILABLE",
        "AI clip analysis isn't configured on this environment yet.",
        { cause: error },
      );
    }
    throw new JobFailureError("ANALYZE_FAILED", "Clip analysis failed — your minutes were returned.", {
      cause: error,
    });
  }

  if (scored.length === 0) {
    throw new JobFailureError(
      "NO_CLIPS_FOUND",
      "We didn't find strong standalone moments. Try a narrower timeframe or a prompt.",
    );
  }

  const refined = scored.map((clip) => refineBoundaries(clip, sourceDurationMs));
  const deduped = dedupByOverlap(
    refined.map((clip) => ({ ...clip, score: clip.total })),
    0.5,
  );
  const kept = deduped.sort((a, b) => b.total - a.total).slice(0, TARGET_CLIP_COUNT);

  await prisma.$transaction(async (tx) => {
    await tx.scriptureReference.deleteMany({ where: { projectId: project.id } });
    await tx.generatedClip.deleteMany({ where: { projectId: project.id } });

    for (const [idx, clip] of kept.entries()) {
      const created = await tx.generatedClip.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          rank: idx + 1,
          startMs: clip.startMs,
          endMs: clip.endMs,
          title: clip.title,
          hookText: clip.hookText,
          summary: clip.summary,
          status: GeneratedClipStatus.SUGGESTED,
        },
      });

      await tx.clipScore.create({
        data: {
          workspaceId: project.workspaceId,
          clipId: created.id,
          total: clip.total,
          subscores: clip.subscores,
          modelVersion: clip.modelVersion,
          excerpt: clip.excerpt,
        },
      });

      if (clip.scriptureReferences && clip.scriptureReferences.length > 0) {
        await tx.scriptureReference.createMany({
          data: clip.scriptureReferences.map((ref) => ({
            workspaceId: project.workspaceId,
            projectId: project.id,
            clipId: created.id,
            detectedText: ref.detectedText,
            normalized: ref.normalized,
            book: ref.book,
            chapterStart: ref.chapterStart,
            verseStart: ref.verseStart,
            chapterEnd: ref.chapterEnd,
            verseEnd: ref.verseEnd,
            confidence: ref.confidence,
          })),
        });
      }
    }

    await tx.project.update({ where: { id: project.id }, data: { status: ProjectStatus.READY } });
  });

  return {
    metadata: {
      provider: provider.name,
      modelVersions: [...new Set(kept.map((clip) => clip.modelVersion))],
      candidateCount: candidates.length,
      scoredCount: scored.length,
      keptCount: kept.length,
      genre,
    },
  };
};
