import { GeneratedClipStatus, ProjectStatus } from "@prisma/client";
import { getAnalysisProvider, type AnalysisProviderSelection } from "@/lib/analysis";
import { readCandidateLimit, readTargetClipCount } from "@/lib/analysis/candidate-limit";
import { buildCandidateWindows, dedupByOverlap, refineBoundaries } from "@/lib/analysis/chunking";
import { filterSermonCandidates } from "@/lib/analysis/sermon-boundary";
import { analysisCallCostFact } from "@/lib/analysis/usage";
import { resolveAndSnapshotProjectAnalysisRouting } from "@/lib/analysis/routing-store";
import { AnalysisProviderUnavailableError, type ScoredCandidate } from "@/lib/analysis/types";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
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
import { settleTranscriptionFallbackHold } from "@/lib/transcription/fallback-hold";
import { resolveTranscriptionProviderPolicy } from "@/lib/transcription/policy";

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
  selectProvider?: (
    routing?: Parameters<typeof getAnalysisProvider>[0],
  ) => Promise<AnalysisProviderSelection>;
  resolveRouting?: typeof resolveAndSnapshotProjectAnalysisRouting;
  recordCostFact?: typeof recordProcessingCostFactSafely;
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
  record: typeof recordProcessingCostFactSafely;
}) {
  const { selection } = params;
  const calls = selection.provider.lastUsage?.calls ?? [];
  if (calls.length > 0) {
    for (const call of calls) {
      await params.record(params.prisma, {
        ...analysisCallCostFact(call, selection.selectionReason),
        attempt: Math.max(1, params.attempt),
        outcome: call.outcome ?? params.outcome,
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        jobId: params.jobId,
      });
    }
    return;
  }

  const modelBacked = selection.providerKind !== "heuristic";
  await params.record(params.prisma, {
    stage: modelBacked ? "analysis_classification" : "analysis_scoring",
    quantity: 1,
    unit: modelBacked ? "call" : "operation",
    unitCostUsd: modelBacked ? null : 0,
    provider:
      selection.providerKind === "claude"
        ? "anthropic"
        : selection.providerKind === "google"
          ? "google"
          : selection.providerKind,
    model: selection.provider.name,
    providerProvenance: selection.selectionReason,
    cpuTimeMs: modelBacked ? null : params.runtime.cpuTimeMs,
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
  const resolveRouting = dependencies.resolveRouting ?? resolveAndSnapshotProjectAnalysisRouting;
  const recordCostFact = dependencies.recordCostFact ?? recordProcessingCostFactSafely;
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
    throw new JobFailureError("ANALYZE_FAILED", "Clip analysis failed. Try again.");
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
    const routing = await resolveRouting(prisma, project.id);
    selection = await selectProvider(routing);
  } catch (error) {
    if (error instanceof AnalysisProviderUnavailableError) {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_unavailable",
        severity: "error",
        message: "ANALYZE failed closed because the selected provider was unavailable.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          emergencyOverride: false,
          detail: error instanceof Error ? error.message : String(error),
        },
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
  let scored: ScoredCandidate[] | undefined;
  let scoreFailure: { error: unknown } | null = null;
  try {
    scored = await provider.scoreCandidates(
      scoreableCandidates,
      { fullText: transcript.fullText, genre },
    );
  } catch (error) {
    scoreFailure = { error };
  }

  // One best-effort recording pass for both outcomes. Recording after the try/catch keeps every
  // model call recorded exactly once (the old success-then-catch shape re-recorded already
  // written calls when a later insert failed — double counting), and a telemetry write failure
  // must not fail paid work that succeeded — it surfaces as a warning event instead.
  try {
    await recordAnalysisCostFacts({
      prisma,
      workspaceId: project.workspaceId,
      projectId: project.id,
      jobId: job.id,
      attempt: job.attempt,
      selection,
      runtime: finishRuntimeMeasurement(analysisRuntime),
      outcome: scoreFailure ? "failed" : "succeeded",
      record: recordCostFact,
    });
  } catch (recordError) {
    await recordOperationalEventSafely(prisma, {
      workspaceId: project.workspaceId,
      category: "cost",
      eventType: "cost_fact_record_failed",
      severity: "warning",
      message: "ANALYZE could not record its analysis cost facts.",
      projectId: project.id,
      jobId: job.id,
      metadata: {
        detail: recordError instanceof Error ? recordError.message : String(recordError),
      },
    });
  }

  if (scoreFailure) {
    const error = scoreFailure.error;
    if (error instanceof AnalysisProviderUnavailableError) {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_failed",
        severity: "error",
        message: "ANALYZE failed closed after the selected provider became unavailable.",
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
    if (selection.providerKind !== "heuristic" && process.env.NODE_ENV === "production") {
      await recordOperationalEventSafely(prisma, {
        workspaceId: project.workspaceId,
        category: "analysis",
        eventType: "analysis_provider_failed",
        severity: "error",
        message: "ANALYZE failed closed after the selected provider call failed.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          provider: selection.providerKind,
          selectionReason: selection.selectionReason,
          emergencyOverride: false,
        },
      });
    }
    throw new JobFailureError("ANALYZE_FAILED", "Clip analysis failed. Try again.", {
      cause: error,
    });
  }

  if (!scored || scored.length === 0) {
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
    // Before the clips go. ClipEdit, ClipApproval, and ExportJob all cascade from GeneratedClip,
    // so this delete destroys the very evidence of human work the hold needs to weigh. Settling
    // inside this transaction also means a rebuild that throws resolves nothing.
    const holdOutcome = await settleTranscriptionFallbackHold(tx, {
      projectId: project.id,
      transcriptProvider: transcript.provider,
      primaryProvider: resolveTranscriptionProviderPolicy(process.env).primary,
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
        // The earliest armed row owns the date in every state; a later project keeps its
        // analyzed candidates but cannot silently double-book. Wave 1's partial unique index
        // (non-MISSED workspace/date) backs this read-then-create at commit time.
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

    if (holdOutcome.settled !== "no_hold") {
      await recordOperationalEvent(tx, {
        workspaceId: project.workspaceId,
        category: "transcription",
        eventType:
          holdOutcome.settled === "resolved"
            ? "transcription_fallback_hold_resolved"
            : "transcription_fallback_hold_kept_open",
        severity: holdOutcome.settled === "resolved" ? "info" : "warning",
        message:
          holdOutcome.settled === "resolved"
            ? "The backup-transcript hold cleared: the sermon was re-transcribed by the usual provider and the clips were rebuilt."
            : holdOutcome.reason === "human_work_needs_reconciliation"
              ? "The backup-transcript hold stays open: clips made from the backup transcript were edited, approved, or exported, so someone needs to check them."
              : "The backup-transcript hold stays open: this transcript did not come from the usual provider.",
        projectId: project.id,
        jobId: job.id,
        metadata:
          holdOutcome.settled === "kept_open"
            ? { reason: holdOutcome.reason }
            : { reason: "primary_rebuilt_clean" },
      });
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
