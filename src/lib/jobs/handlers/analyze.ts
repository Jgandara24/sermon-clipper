import { GeneratedClipStatus, ProjectStatus } from "@prisma/client";
import { getAnalysisProvider, type AnalysisProviderSelection } from "@/lib/analysis";
import { readCandidateLimit, readTargetClipCount } from "@/lib/analysis/candidate-limit";
import { buildCandidateWindows, dedupByOverlap, refineBoundaries } from "@/lib/analysis/chunking";
import { filterSermonCandidates } from "@/lib/analysis/sermon-boundary";
import { analysisCallCostFact } from "@/lib/analysis/usage";
import { AnalysisProviderUnavailableError } from "@/lib/analysis/types";
import { recordProcessingCostFact } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement, type RuntimeMeasurement } from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { JobFailureError, type JobHandler } from "@/lib/jobs/types";
import {
  recordOperationalEvent,
  recordOperationalEventSafely,
} from "@/lib/observability/operational-events";
import {
  clearReschedulableScheduledPosts,
  findScheduledPostCollision,
  scheduledDateForRank,
} from "@/lib/scheduling";

const MIN_CANDIDATE_MS = 20_000;
const MAX_CANDIDATE_MS = 90_000;

function readGenre(processingConfig: unknown): string {
  if (processingConfig && typeof processingConfig === "object" && "genre" in processingConfig) {
    const genre = (processingConfig as { genre?: unknown }).genre;
    if (typeof genre === "string" && genre.length > 0) return genre;
  }
  return "sermon";
}

type AnalyzeJobDependencies = {
  selectProvider?: () => Promise<AnalysisProviderSelection>;
};

async function recordAnalysisCostFacts(params: {
  prisma: Parameters<JobHandler>[0]["prisma"];
  workspaceId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  selection: AnalysisProviderSelection;
  runtime: RuntimeMeasurement;
  outcome: ProcessingCostOutcome;
}) {
  const { selection } = params;
  const calls = selection.provider.lastUsage?.calls ?? [];
  if (calls.length > 0) {
    for (const [index, call] of calls.entries()) {
      await recordProcessingCostFact(params.prisma, {
        ...analysisCallCostFact(
          call,
          index === 0 ? "analysis_classification" : "analysis_scoring",
          selection.selectionReason,
        ),
        attempt: Math.max(1, params.attempt),
        outcome: call.outcome ?? params.outcome,
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        jobId: params.jobId,
      });
    }
    return;
  }

  await recordProcessingCostFact(params.prisma, {
    stage: selection.providerKind === "claude" ? "analysis_classification" : "analysis_scoring",
    quantity: 1,
    unit: selection.providerKind === "claude" ? "call" : "operation",
    unitCostUsd: selection.providerKind === "claude" ? null : 0,
    provider: selection.providerKind === "claude" ? "anthropic" : "heuristic",
    model: selection.providerKind === "claude" ? null : selection.provider.name,
    providerProvenance: selection.selectionReason,
    cpuTimeMs: selection.providerKind === "claude" ? null : params.runtime.cpuTimeMs,
    wallTimeMs: params.runtime.wallTimeMs,
    cacheState: "not_applicable",
    attempt: Math.max(1, params.attempt),
    outcome: params.outcome,
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    jobId: params.jobId,
  });
}

/** Builds the ANALYZE handler with an injectable provider boundary for policy tests. */
export function createAnalyzeJobHandler(dependencies: AnalyzeJobDependencies = {}): JobHandler {
  const selectProvider = dependencies.selectProvider ?? getAnalysisProvider;
  return async ({ job, prisma }) => {
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
  const targetClipCount = readTargetClipCount(project.processingConfig);
  const candidateLimit = readCandidateLimit(project.processingConfig, {
    masterDefault: env.CANDIDATE_LIMIT_DEFAULT,
    masterMaximum: env.CANDIDATE_LIMIT_MAXIMUM,
  });
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

  let selection;
  try {
    selection = await selectProvider();
  } catch (error) {
    if (error instanceof AnalysisProviderUnavailableError) {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_unavailable",
        severity: "error",
        message: "ANALYZE failed closed because the Claude provider was unavailable.",
        projectId: project.id,
        jobId: job.id,
        metadata: { selectionReason: "production_no_api_key", emergencyOverride: false },
      });
      throw new JobFailureError(
        "ANALYZE_PROVIDER_UNAVAILABLE",
        "AI clip analysis isn't configured on this environment yet.",
        { cause: error },
      );
    }
    throw error;
  }
  const { provider } = selection;
  if (selection.emergencyOverride) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: project.workspaceId,
      category: "analysis",
      eventType: "analysis_heuristic_emergency_override",
      severity: "warning",
      message: "ANALYZE used the production heuristic emergency override.",
      projectId: project.id,
      jobId: job.id,
      metadata: {
        provider: selection.providerKind,
        selectionReason: selection.selectionReason,
        emergencyOverride: true,
      },
    });
  }

  const scoreableCandidates =
    genre.toLowerCase() === "sermon"
      ? filterSermonCandidates(candidates.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })))
      : candidates.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));
  const analysisRuntime = startRuntimeMeasurement();
  let scored;
  try {
    scored = await provider.scoreCandidates(
      scoreableCandidates,
      { fullText: transcript.fullText, genre },
    );
    await recordAnalysisCostFacts({
      prisma,
      workspaceId: project.workspaceId,
      projectId: project.id,
      jobId: job.id,
      attempt: job.attempt,
      selection,
      runtime: finishRuntimeMeasurement(analysisRuntime),
      outcome: "succeeded",
    });
  } catch (error) {
    await recordAnalysisCostFacts({
      prisma,
      workspaceId: project.workspaceId,
      projectId: project.id,
      jobId: job.id,
      attempt: job.attempt,
      selection,
      runtime: finishRuntimeMeasurement(analysisRuntime),
      outcome: "failed",
    });
    if (error instanceof AnalysisProviderUnavailableError) {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_failed",
        severity: "error",
        message: "ANALYZE failed closed after the Claude provider became unavailable.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          provider: selection.providerKind,
          selectionReason: selection.selectionReason,
          emergencyOverride: selection.emergencyOverride,
        },
      });
      throw new JobFailureError(
        "ANALYZE_PROVIDER_UNAVAILABLE",
        "AI clip analysis isn't configured on this environment yet.",
        { cause: error },
      );
    }
    if (selection.providerKind === "claude" && process.env.NODE_ENV === "production") {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_failed",
        severity: "error",
        message: "ANALYZE failed closed after the Claude provider call failed.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          provider: selection.providerKind,
          selectionReason: selection.selectionReason,
          emergencyOverride: false,
        },
      });
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
  const kept = deduped.sort((a, b) => b.total - a.total).slice(0, candidateLimit);

  await prisma.$transaction(async (tx) => {
    await tx.scriptureReference.deleteMany({ where: { projectId: project.id } });
    // Unfired calendar slots are re-derived below; published/in-flight rows survive the clip
    // deleteMany as history (clip_id is ON DELETE SET NULL).
    await clearReschedulableScheduledPosts(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
    });
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

      // Only the primary daily-posting set (rank <= targetClipCount) gets a calendar slot;
      // the rest of the candidate pool stays available as unscheduled extras. Skips
      // legacy projects created before Project.sermonDate existed (schema default is nullable).
      const rank = idx + 1;
      if (rank <= targetClipCount && project.sermonDate) {
        const scheduledDate = scheduledDateForRank(project.sermonDate, rank);
        // Until Wave 1 adds active-date uniqueness, the earliest armed row owns the date in every
        // state. A later project keeps its analyzed candidates but cannot silently double-book.
        const collision = await findScheduledPostCollision(tx, {
          workspaceId: project.workspaceId,
          scheduledDate,
        });
        if (collision) {
          await recordOperationalEvent(tx, {
            workspaceId: project.workspaceId,
            category: "scheduling",
            eventType: "scheduled_post_collision",
            severity: "warning",
            message: "A later project could not arm an already-reserved posting date.",
            projectId: project.id,
            jobId: job.id,
            metadata: {
              scheduledDate: scheduledDate.toISOString().slice(0, 10),
              existingScheduledPostId: collision.id,
              existingProjectId: collision.projectId,
              existingPublishStatus: collision.publishStatus,
              laterProjectId: project.id,
              laterClipId: created.id,
              rank,
            },
          });
        } else {
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

  return {
    metadata: {
      provider: provider.name,
      providerKind: selection.providerKind,
      selectionReason: selection.selectionReason,
      emergencyOverride: selection.emergencyOverride,
      modelVersions: [...new Set(kept.map((clip) => clip.modelVersion))],
      candidateCount: candidates.length,
      scoredCount: scored.length,
      keptCount: kept.length,
      candidateLimit,
      targetClipCount,
      genre,
    },
  };
  };
}

/**
 * Chunks the transcript into candidate windows, scores them, refines boundaries, dedups
 * overlapping candidates, and persists the top-ranked clips. Guide §10.
 */
export const runAnalyzeJob = createAnalyzeJobHandler();
