import {
  EditorialExceptionState,
  GeneratedClipStatus,
  ProjectStatus,
  SchedulePublishStatus,
  type Prisma,
} from "@prisma/client";
import { buildInitialEditorState } from "@/lib/editor/types";
import { INITIAL_EDIT_VERSION } from "@/lib/exports/edit-version";
import { getAnalysisProvider, type AnalysisProviderSelection } from "@/lib/analysis";
import { assertReanalysisAllowed } from "@/lib/analysis/reanalysis-policy";
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
} from "@/lib/scheduling";
import { allocatePostingSlots, type PostingSlot } from "@/lib/schedule/posting-schedule";
import { readProjectProcessingConfig } from "@/lib/project-service";
import {
  lockSourceVideoForRetention,
  sourceExpiresAtForSchedule,
} from "@/lib/retention";
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

  // P1.7. A rebuild deletes the project's clips and everything that cascades from them. Refused
  // here, before a paid analysis call, if anyone has already done durable work on those clips;
  // asked again inside the rebuild transaction, which is the answer that binds.
  await assertReanalysisAllowed(prisma, { projectId: project.id });

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
    // The binding check. The early one saved the cost of analysis; this one closes the window
    // between it and the deletes below, in which a person could have saved an edit. A refusal
    // here rolls back nothing, because nothing has been written yet.
    await assertReanalysisAllowed(tx, { projectId: project.id });

    await tx.scriptureReference.deleteMany({ where: { projectId: project.id } });
    // Unfired calendar slots are re-derived below. Rows in any other state block the rebuild
    // above, so none are left behind detached.
    await clearReschedulableScheduledPosts(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
    });
    // The UNFILLED slots just cleared had open exceptions pointing at them. Their rows are gone,
    // so the exceptions describe a slot that no longer exists; close them as superseded rather
    // than leaving an operator queue that grows by one entry per re-analysis. The rebuild below
    // opens fresh ones for whatever the new pool still cannot fill.
    await tx.editorialException.updateMany({
      where: {
        projectId: project.id,
        exceptionType: "unfilled_schedule_slot",
        state: EditorialExceptionState.OPEN,
      },
      data: {
        state: EditorialExceptionState.RESOLVED,
        resolvedAt: new Date(),
        resolutionReason: "superseded_by_reanalysis",
      },
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

    // Scheduling reads the project's own snapshot, never the live church profile: the profile
    // may have changed since this sermon was imported, and a project must schedule the way it
    // was configured when it was created (S9). readProjectProcessingConfig fills legacy gaps.
    // Default false. When off, analysis keeps every candidate it scored and arms nothing; the
    // fact is recorded below so a quiet calendar is never mistaken for a failed analysis.
    const armingEnabled = env.AUTOMATIC_SCHEDULE_ARMING_ENABLED;
    const scheduleSnapshot = readProjectProcessingConfig(project.processingConfig);
    const postingSlots = allocatePostingSlots({
      profile: {
        timezone: scheduleSnapshot.timezone,
        sermonsPerWeek: scheduleSnapshot.sermonsPerWeek,
      },
      serviceSlot: scheduleSnapshot.serviceOccurrence,
      // The snapshot's own count, not one re-derived from a profile that may have moved on.
      slotCount: targetClipCount,
      // Legacy projects created before Project.sermonDate existed allocate nothing.
      sermonDate: project.sermonDate,
      now: new Date(),
    });

    /**
     * Arms one allocated slot. Every row written here carries its owning projectId, including a
     * slot with no clip, so the calendar can answer "which sermon owns this date" without going
     * through the clip.
     */
    const armSlot = async (
      client: typeof tx,
      params: { slot: PostingSlot; clipId: string | null },
    ) => {
      const { slot, clipId } = params;
      const scheduledDate = slot.date;
      const isoDate = scheduledDate.toISOString().slice(0, 10);

      // A date that has already passed is recorded as MISSED rather than armed. The ranks behind
      // it keep their own dates — a late upload loses the days it slept through, it does not push
      // a week of content back. Wave 1's partial unique index covers non-MISSED rows only, so
      // several MISSED rows may share a date.
      if (slot.state === "MISSED") {
        await client.scheduledPost.create({
          data: {
            workspaceId: project.workspaceId,
            projectId: project.id,
            clipId,
            scheduledDate,
            publishStatus: SchedulePublishStatus.MISSED,
          },
        });
        await recordOperationalEvent(client, {
          workspaceId: project.workspaceId,
          category: "scheduling",
          eventType: "scheduled_post_missed",
          severity: "warning",
          message: "A posting date had already passed when the sermon was analyzed.",
          projectId: project.id,
          jobId: job.id,
          clipId,
          metadata: { scheduledDate: isoDate, rank: slot.rank },
        });
        return;
      }

      // The earliest armed row owns the date in every state; a later project keeps its analyzed
      // candidates but cannot silently double-book. The DB is asked rather than the allocator
      // because only the DB knows what other projects have reserved, and Wave 1's partial unique
      // index backs this read-then-create at commit time.
      const collision = await findScheduledPostCollision(client, {
        workspaceId: project.workspaceId,
        scheduledDate,
      });
      if (collision) {
        await recordOperationalEvent(client, {
          workspaceId: project.workspaceId,
          category: "scheduling",
          eventType: "scheduled_post_collision",
          severity: "warning",
          message: "A later project could not arm an already-reserved posting date.",
          projectId: project.id,
          jobId: job.id,
          clipId,
          metadata: {
            scheduledDate: isoDate,
            existingScheduledPostId: collision.id,
            existingProjectId: collision.projectId,
            existingPublishStatus: collision.publishStatus,
            laterProjectId: project.id,
            laterClipId: clipId,
            rank: slot.rank,
          },
        });
        return;
      }

      const created = await client.scheduledPost.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          clipId,
          scheduledDate,
          publishStatus: clipId
            ? SchedulePublishStatus.NOT_STARTED
            : SchedulePublishStatus.UNFILLED,
        },
      });

      if (!clipId) {
        await client.editorialException.create({
          data: {
            workspaceId: project.workspaceId,
            projectId: project.id,
            scheduledPostId: created.id,
            exceptionType: "unfilled_schedule_slot",
            message:
              "This sermon produced fewer clips than its posting week has days, so a date has no clip.",
            projectSnapshot: { sermonDate: project.sermonDate?.toISOString() ?? null },
            slotSnapshot: { scheduledDate: isoDate, rank: slot.rank },
          },
        });
        await recordOperationalEvent(client, {
          workspaceId: project.workspaceId,
          category: "scheduling",
          eventType: "scheduled_post_unfilled",
          severity: "warning",
          message: "A posting date was armed with no clip and needs an operator.",
          projectId: project.id,
          jobId: job.id,
          metadata: { scheduledDate: isoDate, rank: slot.rank },
        });
      }
    };

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

      // ANALYZE is the only production path that creates a generated clip, which makes it the
      // only place that can tell new content from old. Writing the clip's first document here is
      // what gives new clips Uppercase without reaching a clip that predates the default: that one
      // has no document at all, and its export still builds the unchanged fallback.
      if (project.sourceVideoId) {
        await tx.clipEdit.create({
          data: {
            clipId: created.id,
            version: INITIAL_EDIT_VERSION,
            editorState: buildInitialEditorState({
              sourceVideoId: project.sourceVideoId,
              startMs: clip.startMs,
              endMs: clip.endMs,
            }) as unknown as Prisma.InputJsonValue,
            // System-created, so nobody signed it. `savedBy` is nullable for exactly this.
            savedBy: null,
          },
        });
      }

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

      // The allocator decided this rank's date before the loop. A rank past the end of the
      // allocation is a candidate the church keeps but does not post on a schedule.
      const rank = idx + 1;
      const slot = postingSlots[rank - 1];
      if (armingEnabled && slot) {
        await armSlot(tx, { slot, clipId: created.id });
      }
    }

    // Slots the candidate pool could not fill. They are armed anyway, with no clip and an open
    // exception, because an empty Tuesday is a fact the operator has to see and act on — a
    // missing row would read as a week that was never scheduled at all.
    if (armingEnabled) {
      for (const slot of postingSlots.slice(kept.length)) {
        await armSlot(tx, { slot, clipId: null });
      }
    }

    if (!armingEnabled && postingSlots.length > 0) {
      await recordOperationalEvent(tx, {
        workspaceId: project.workspaceId,
        category: "scheduling",
        eventType: "schedule_arming_disabled",
        severity: "info",
        message:
          "Automatic schedule arming is off, so this sermon's clips were kept but no posting dates were reserved.",
        projectId: project.id,
        jobId: job.id,
        metadata: {
          plannedSlots: postingSlots.length,
          firstPlannedDate: postingSlots[0].date.toISOString().slice(0, 10),
          lastPlannedDate: postingSlots[postingSlots.length - 1].date.toISOString().slice(0, 10),
          serviceOccurrence: scheduleSnapshot.serviceOccurrence,
        },
      });
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

    // Retention. This is the first code that ever sets Project.expiresAt: the source media for
    // this sermon may be purged fourteen days after the last post planned from it (S6b). Only
    // dates that were actually armed count — a slot lost to a collision reserves nothing, so it
    // must not extend how long the source is kept. The source-video row is locked first, because
    // a sibling project sharing this source may be having its own expiry read by CLEANUP right
    // now; whoever holds the lock decides, and the loser re-reads.
    if (armingEnabled) {
      const armedDates = postingSlots
        .filter((slot) => slot.state === "SCHEDULED")
        .map((slot) => slot.date);
      const expiresAt = sourceExpiresAtForSchedule(armedDates);
      if (expiresAt) {
        if (project.sourceVideoId) {
          await lockSourceVideoForRetention(tx, project.sourceVideoId);
        }
        // Never pull an expiry in: a project whose schedule shrank keeps the later date, so
        // media a still-armed sibling slot needs cannot be deleted early.
        if (project.expiresAt === null || project.expiresAt < expiresAt) {
          await tx.project.update({ where: { id: project.id }, data: { expiresAt } });
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
