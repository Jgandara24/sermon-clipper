import {
  GeneratedClipStatus,
  Prisma,
  ProjectStatus,
  SermonOutlineStatus,
  SermonSectionType,
} from "@prisma/client";
import { getAnalysisProvider } from "@/lib/analysis";
import { buildCandidateWindows, dedupByOverlap, refineBoundaries } from "@/lib/analysis/chunking";
import { scoringModel } from "@/lib/analysis/claude-provider";
import type {
  ExclusionRange,
  OutlineSectionType,
  OutlineStatus,
  SermonOutlineDraft,
} from "@/lib/analysis/outline/types";
import {
  runSemanticPipeline,
  semanticPipelineEnabled,
} from "@/lib/analysis/semantic/pipeline";
import { filterSermonCandidates } from "@/lib/analysis/sermon-boundary";
import { AnalysisProviderUnavailableError, type ScoredCandidate } from "@/lib/analysis/types";
import { buildAnalysisUsage, type AnalysisModelCall } from "@/lib/analysis/usage";
import type { VideoSource } from "@/lib/analysis/visual-gate";
import { env } from "@/lib/env";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import {
  clearReschedulableScheduledPosts,
  scheduledDateForRank,
  slotAlreadyPublished,
} from "@/lib/scheduling";
import { getStorageProvider } from "@/lib/storage";

const MIN_CANDIDATE_MS = 20_000;
const MAX_CANDIDATE_MS = 90_000;
const CANDIDATE_POOL_SIZE = 18;
const DEFAULT_TARGET_CLIP_COUNT = 6;
// A fallback-pipeline window mostly inside an excluded range (worship, announcements, …) is
// not eligible content; smaller brushes against a block-granularity exclusion are tolerated.
const MAX_EXCLUSION_OVERLAP_FRACTION = 0.25;

const NO_CLIPS_MESSAGE =
  "We didn't find strong standalone moments. Try a narrower timeframe or a prompt.";
const ANALYZE_FAILED_MESSAGE = "Clip analysis failed — your minutes were returned.";

const OUTLINE_STATUS_ENUM: Record<OutlineStatus, SermonOutlineStatus> = {
  generated: SermonOutlineStatus.GENERATED,
  heuristic: SermonOutlineStatus.HEURISTIC,
  fallback_single: SermonOutlineStatus.FALLBACK_SINGLE,
};

const SECTION_TYPE_ENUM: Record<OutlineSectionType, SermonSectionType> = {
  introduction: SermonSectionType.INTRODUCTION,
  point: SermonSectionType.POINT,
  conclusion: SermonSectionType.CONCLUSION,
  main_message: SermonSectionType.MAIN_MESSAGE,
};

type KeptClip = ScoredCandidate & { sectionPosition: number | null };

function readGenre(processingConfig: unknown): string {
  if (processingConfig && typeof processingConfig === "object" && "genre" in processingConfig) {
    const genre = (processingConfig as { genre?: unknown }).genre;
    if (typeof genre === "string" && genre.length > 0) return genre;
  }
  return "sermon";
}

/**
 * Set at project creation from the church's sermons-per-week (docs/BUSINESS_OVERVIEW.md):
 * 6 for a once-a-week church, 3 for a twice-a-week church. This is the size of the
 * primary daily-posting set within the larger CANDIDATE_POOL_SIZE we keep as clips.
 */
function readTargetClipCount(processingConfig: unknown): number {
  if (processingConfig && typeof processingConfig === "object" && "targetClipCount" in processingConfig) {
    const value = (processingConfig as { targetClipCount?: unknown }).targetClipCount;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return DEFAULT_TARGET_CLIP_COUNT;
}

/** Video for the visual gate: a local path or signed URL, or null when neither is possible. */
async function resolveVideoSource(storageKey: string | null | undefined): Promise<VideoSource | null> {
  if (!storageKey) return null;
  try {
    const storage = getStorageProvider();
    if (env.STORAGE_PROVIDER === "local") {
      return { kind: "path", path: storage.absolutePath(storageKey) };
    }
    if (storage.createSignedReadUrl) {
      // Long enough to outlive frame sampling across a full clip set, nothing more.
      const url = await storage.createSignedReadUrl(storageKey, { expiresInSeconds: 3600, disposition: "inline" });
      return { kind: "url", url };
    }
  } catch {
    // Unresolvable video isn't fatal to analysis — the gate reports skipped_unavailable.
  }
  return null;
}

function exclusionOverlapFraction(
  candidate: { startMs: number; endMs: number },
  exclusions: ExclusionRange[],
): number {
  const duration = Math.max(1, candidate.endMs - candidate.startMs);
  const overlap = exclusions.reduce(
    (sum, e) => sum + Math.max(0, Math.min(candidate.endMs, e.endMs) - Math.max(candidate.startMs, e.startMs)),
    0,
  );
  return overlap / duration;
}

/** Primary section for a fallback-pipeline clip: the outline section containing its midpoint. */
function sectionPositionForClip(
  clip: { startMs: number; endMs: number },
  outline: SermonOutlineDraft | null,
): number | null {
  if (!outline) return null;
  const mid = (clip.startMs + clip.endMs) / 2;
  return outline.sections.find((s) => s.startMs <= mid && mid <= s.endMs)?.position ?? null;
}

/**
 * Analysis entrypoint. Primary path is the semantic outline-first pipeline (sermon outline →
 * per-section discovery → context-aware scoring → visual gate → diversity selection); the
 * evenly distributed candidate-window pipeline (guide §10) remains the fallback whenever
 * outlining or moment discovery fails, and the only path for non-sermon genres. Both paths
 * persist through the same transaction, which also replaces the project's sermon outline.
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
    throw new JobFailureError("ANALYZE_FAILED", ANALYZE_FAILED_MESSAGE);
  }

  const segments = transcript.segments.map((segment) => ({
    idx: segment.idx,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));

  const genre = readGenre(project.processingConfig);
  const targetClipCount = readTargetClipCount(project.processingConfig);
  const isSermon = genre.toLowerCase() === "sermon";
  const sourceDurationMs = project.sourceVideo?.durationS
    ? project.sourceVideo.durationS.toNumber() * 1000
    : segments[segments.length - 1].endMs;

  let outlineDraft: SermonOutlineDraft | null = null;
  let kept: KeptClip[] | null = null;
  let semanticCalls: AnalysisModelCall[] = [];
  let providerName: string | null = null;
  let candidateCount = 0;
  let scoredCount = 0;
  const semanticMetadata: Record<string, unknown> = {};

  if (isSermon && semanticPipelineEnabled()) {
    const video = await resolveVideoSource(project.sourceVideo?.storageKey);
    let semantic;
    try {
      semantic = await runSemanticPipeline({
        segments,
        fullText: transcript.fullText,
        genre,
        sourceDurationMs,
        maxClips: CANDIDATE_POOL_SIZE,
        minMs: MIN_CANDIDATE_MS,
        maxMs: MAX_CANDIDATE_MS,
        video,
      });
    } catch (error) {
      // Truncated/unparseable model output is retryable at the job layer, same as Stage A/B.
      throw new JobFailureError("ANALYZE_FAILED", ANALYZE_FAILED_MESSAGE, { cause: error });
    }

    outlineDraft = semantic.outline;
    semanticCalls = semantic.calls;
    semanticMetadata.outlineStatus = semantic.outline.status;
    semanticMetadata.visualGateStatus = semantic.visualGateStatus;
    semanticMetadata.semanticDiagnostics = semantic.diagnostics;

    if (semantic.clips !== null) {
      kept = semantic.clips;
      providerName = scoringModel();
      candidateCount = semantic.diagnostics.resolvedCandidates;
      scoredCount = semantic.diagnostics.scoredCandidates;
      semanticMetadata.pipeline = "semantic";
      if (kept.length === 0) {
        // Eligibility gates rejected every candidate. Fail closed — do NOT fall back to the
        // window pipeline, which would ship exactly the content the gates refused.
        throw new JobFailureError("NO_CLIPS_FOUND", NO_CLIPS_MESSAGE);
      }
    } else {
      semanticMetadata.pipeline = "window";
      semanticMetadata.fallbackReason = semantic.fallbackReason;
    }
  }

  if (kept === null) {
    const candidates = buildCandidateWindows(segments, {
      minMs: MIN_CANDIDATE_MS,
      maxMs: MAX_CANDIDATE_MS,
    });

    if (candidates.length === 0) {
      throw new JobFailureError("NO_CLIPS_FOUND", NO_CLIPS_MESSAGE);
    }
    candidateCount = candidates.length;

    const provider = await getAnalysisProvider();
    providerName = provider.name;

    let scored;
    try {
      const plain = candidates.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));
      let scoreableCandidates = isSermon ? filterSermonCandidates(plain) : plain;
      // Even the fallback pipeline honors the outline's exclusion ranges: excluded portions
      // must produce no candidates and never reach scoring.
      const exclusions = outlineDraft?.exclusions ?? [];
      if (exclusions.length > 0) {
        scoreableCandidates = scoreableCandidates.filter(
          (c) => exclusionOverlapFraction(c, exclusions) <= MAX_EXCLUSION_OVERLAP_FRACTION,
        );
      }
      if (scoreableCandidates.length === 0) {
        throw new JobFailureError("NO_CLIPS_FOUND", NO_CLIPS_MESSAGE);
      }

      scored = await provider.scoreCandidates(
        scoreableCandidates,
        { fullText: transcript.fullText, genre },
      );
    } catch (error) {
      if (error instanceof JobFailureError) throw error;
      if (error instanceof AnalysisProviderUnavailableError) {
        throw new JobFailureError(
          "ANALYZE_PROVIDER_UNAVAILABLE",
          "AI clip analysis isn't configured on this environment yet.",
          { cause: error },
        );
      }
      throw new JobFailureError("ANALYZE_FAILED", ANALYZE_FAILED_MESSAGE, { cause: error });
    }

    if (scored.length === 0) {
      throw new JobFailureError("NO_CLIPS_FOUND", NO_CLIPS_MESSAGE);
    }
    scoredCount = scored.length;

    const refined = scored.map((clip) => refineBoundaries(clip, sourceDurationMs));
    const deduped = dedupByOverlap(
      refined.map((clip) => ({ ...clip, score: clip.total })),
      0.5,
    );
    kept = deduped
      .sort((a, b) => b.total - a.total)
      .slice(0, CANDIDATE_POOL_SIZE)
      .map((clip) => ({ ...clip, sectionPosition: sectionPositionForClip(clip, outlineDraft) }));

    const providerUsage = provider.lastUsage;
    if (providerUsage) semanticCalls = [...semanticCalls, ...providerUsage.calls];
  }

  const keptClips = kept;

  await prisma.$transaction(async (tx) => {
    await tx.scriptureReference.deleteMany({ where: { projectId: project.id } });
    // Unfired calendar slots are re-derived below; published/in-flight rows survive the clip
    // deleteMany as history (clip_id is ON DELETE SET NULL).
    await clearReschedulableScheduledPosts(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
    });
    await tx.generatedClip.deleteMany({ where: { projectId: project.id } });
    // Reanalysis replaces the generated outline; sections cascade with it.
    await tx.sermonOutline.deleteMany({ where: { projectId: project.id } });

    const sectionIdByPosition = new Map<number, string>();
    if (outlineDraft) {
      const createdOutline = await tx.sermonOutline.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          mainIdea: outlineDraft.mainIdea,
          generatedTitle: outlineDraft.generatedTitle,
          modelVersion: outlineDraft.modelVersion,
          confidence: outlineDraft.confidence,
          status: OUTLINE_STATUS_ENUM[outlineDraft.status],
          exclusions: outlineDraft.exclusions as Prisma.InputJsonValue,
        },
      });
      for (const section of outlineDraft.sections) {
        const createdSection = await tx.sermonSection.create({
          data: {
            outlineId: createdOutline.id,
            position: section.position,
            type: SECTION_TYPE_ENUM[section.type],
            heading: section.heading,
            summary: section.summary,
            startSegmentIdx: section.startSegmentIdx,
            endSegmentIdx: section.endSegmentIdx,
            startMs: section.startMs,
            endMs: section.endMs,
            confidence: section.confidence,
          },
        });
        sectionIdByPosition.set(section.position, createdSection.id);
      }
    }

    for (const [idx, clip] of keptClips.entries()) {
      const created = await tx.generatedClip.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          sectionId:
            clip.sectionPosition !== null
              ? (sectionIdByPosition.get(clip.sectionPosition) ?? null)
              : null,
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

      // Only the primary daily-posting set (rank <= targetClipCount) gets a calendar slot;
      // the rest of the CANDIDATE_POOL_SIZE stays available as unscheduled extras. Skips
      // legacy projects created before Project.sermonDate existed (schema default is nullable).
      const rank = idx + 1;
      if (rank <= targetClipCount && project.sermonDate) {
        const scheduledDate = scheduledDateForRank(project.sermonDate, rank);
        // Never re-arm a slot whose post already went out (or is going out) — a re-analysis
        // after publishing would otherwise duplicate content on the Page.
        const published = await slotAlreadyPublished(tx, {
          workspaceId: project.workspaceId,
          scheduledDate,
        });
        if (!published) {
          await tx.scheduledPost.create({
            data: {
              workspaceId: project.workspaceId,
              clipId: created.id,
              scheduledDate,
            },
          });
        }
      }
    }

    await tx.project.update({ where: { id: project.id }, data: { status: ProjectStatus.READY } });
  });

  // Provider token usage (Claude only; heuristic spends nothing) flows into the analysis
  // success event's metadata, where /app/settings/operations rolls it up as estimated spend.
  // Semantic-path calls (outline, discovery, scoring, visual gate) all land here too.
  const usage = semanticCalls.length > 0 ? buildAnalysisUsage(semanticCalls) : null;

  return {
    metadata: {
      provider: providerName ?? "unknown",
      modelVersions: [...new Set(keptClips.map((clip) => clip.modelVersion))],
      candidateCount,
      scoredCount,
      keptCount: keptClips.length,
      targetClipCount,
      genre,
      ...semanticMetadata,
      ...(usage ? { usage } : {}),
    },
  };
};
