import {
  EditorialExceptionState,
  PublishAttemptState,
  ReviewFeedbackCategory,
  SchedulePublishStatus,
  type PrismaClient,
  type Project,
} from "@prisma/client";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { DEFAULT_EDIT_VERSION } from "@/lib/exports/edit-version";
import { enqueueExportJob } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { lockSourceVideoForRetention, sourceExpiresAtForSchedule } from "@/lib/retention";
import {
  assessPriorServiceFill,
  describePriorServiceFillRefusal,
  type PriorServiceFillRefusal,
} from "./prior-service-fill-policy";

/**
 * Giving an empty date a clip an operator chose from an older sermon.
 *
 * **This never runs by itself.** No sweep calls it, no coordinator falls back to it, and P2.7's
 * replacement does not reach for it when a sermon's own reserves run out — that path deliberately
 * empties the slot and opens an exception instead. Cross-project filling is a platform operator
 * looking at that exception and naming one specific clip. Rev2 §9 puts automatic cross-project
 * borrowing out of scope, and the way to keep it out of scope is to have no code that could do it.
 *
 * The project is locked before the source, matching ANALYZE and replacement. The source lock
 * protects against source cleanup deleting the media the new render needs. `lockSourceVideoForRetention`
 * serializes the two, and the outcome is decided by whoever gets there first —
 *
 * - cleanup first: the source key is null by the time this re-reads it, and the fill refuses.
 *   Nothing is half-done, because the refusal happens before anything is written.
 * - fill first: retention is extended inside this transaction, so when cleanup re-reads the
 *   expiry it finds a later one and keeps the source.
 *
 * Extending retention is not a substitute for re-reading the key: retention decides when media
 * *will* go, and cannot bring back media that already has.
 *
 * **No second `REPLACE` is written.** The decision that emptied this date is already on the
 * record, and a fill is not a new judgement about the clip that was rejected — it is a different
 * clip arriving. The earlier decision and its shortage evidence stay exactly as they were; the
 * exception is resolved in place rather than deleted.
 *
 * **Delivery stays blocked.** The slot returns to `NOT_STARTED` with a fresh render bound to it,
 * and P2.8 requires a human `ACCEPT` of that exact new file before anything publishes. Filling a
 * date is not approving what fills it.
 */

/** The render a filled date gets. Same priority as a replacement: somebody is waiting on it. */
export const PRIOR_SERVICE_FILL_EXPORT_PRIORITY = 100;

/** Publish-attempt states that mean a post may already exist. */
const OPEN_CLAIM_STATES: readonly PublishAttemptState[] = [
  PublishAttemptState.INTENT,
  PublishAttemptState.INDETERMINATE,
];

const FILLABLE_STATES: readonly SchedulePublishStatus[] = [
  SchedulePublishStatus.BLOCKED,
  SchedulePublishStatus.UNFILLED,
];

export class PriorServiceFillRefusedError extends Error {
  constructor(
    readonly reason: PriorServiceFillRefusal | "SLOT_MOVED" | "SLOT_MISSING" | "CANDIDATE_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "PriorServiceFillRefusedError";
  }
}

export type PriorServiceFillOutcome = {
  scheduledPostId: string;
  filledClipId: string;
  exportJobId: string;
  slotStatus: SchedulePublishStatus;
  /** The exceptions this fill answered. Resolved in place; the evidence is never deleted. */
  resolvedExceptionIds: string[];
  targetProjectId: string;
  sourceProjectId: string;
  /** True when the slot already held this clip and this render — a retry, not a second fill. */
  alreadyFilled: boolean;
};

export type ApplyPriorServiceFillInput = {
  scheduledPostId: string;
  /** The one clip the operator named. Nothing here searches for an alternative. */
  candidateClipId: string;
  operatorUserId: string;
  now?: Date;
};

/** The sermon's own date where it has one, otherwise when the project row was made. */
function serviceAt(project: Pick<Project, "sermonDate" | "createdAt">): Date {
  return project.sermonDate ?? project.createdAt;
}

export async function applyPriorServiceFill(
  client: PrismaClient,
  input: ApplyPriorServiceFillInput,
): Promise<PriorServiceFillOutcome> {
  const now = input.now ?? new Date();

  const outcome = await client.$transaction(async (tx) => {
    const slot = await tx.scheduledPost.findUnique({ where: { id: input.scheduledPostId } });
    if (!slot) {
      throw new PriorServiceFillRefusedError("SLOT_MISSING", "That date no longer exists.");
    }

    // A retry of a fill that already committed. Returning the same answer rather than refusing
    // keeps the operator's second click harmless; the conditional claim below would otherwise
    // report this as somebody else having taken the date.
    if (slot.clipId === input.candidateClipId && slot.exportJobId) {
      return {
        scheduledPostId: slot.id,
        filledClipId: slot.clipId,
        exportJobId: slot.exportJobId,
        slotStatus: slot.publishStatus,
        resolvedExceptionIds: [],
        targetProjectId: slot.projectId as string,
        sourceProjectId: "",
        alreadyFilled: true,
        workspaceId: slot.workspaceId,
      };
    }

    let candidate = await tx.generatedClip.findUnique({
      where: { id: input.candidateClipId },
      include: { project: true },
    });
    if (!candidate) {
      throw new PriorServiceFillRefusedError(
        "CANDIDATE_MISSING",
        "That clip no longer exists. Reanalysis may have replaced it.",
      );
    }

    // Retention updates this project later. Acquire it before the source to match ANALYZE;
    // re-read after waiting so a concurrent rebuild or expiry extension is not overwritten.
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${candidate.project.id}::uuid FOR NO KEY UPDATE`;
    candidate = await tx.generatedClip.findUnique({ where: { id: input.candidateClipId }, include: { project: true } });
    if (!candidate) {
      throw new PriorServiceFillRefusedError("CANDIDATE_MISSING", "That clip was replaced. Reload and look again.");
    }

    // **The lock.** Taken before every durable purge fact is read, so what is read below cannot
    // be overtaken by a cleanup between the read and the write. Cleanup holds the same row while
    // it decides, so exactly one of the two proceeds at a time.
    if (candidate.project.sourceVideoId) {
      await lockSourceVideoForRetention(tx, candidate.project.sourceVideoId);
    }

    // Re-read after the lock: this is the key cleanup would have nulled.
    const sourceVideo = candidate.project.sourceVideoId
      ? await tx.sourceVideo.findUnique({
          where: { id: candidate.project.sourceVideoId },
          select: { id: true, storageKey: true },
        })
      : null;

    const targetProject = slot.projectId
      ? await tx.project.findUnique({ where: { id: slot.projectId } })
      : null;

    const [scheduledCount, forbiddenCount, openClaimCount] = await Promise.all([
      tx.scheduledPost.count({ where: { clipId: candidate.id } }),
      tx.clipReviewFeedback.count({
        where: {
          category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
          clipReview: { clipIdSnapshot: candidate.id },
        },
      }),
      tx.publishAttempt.count({
        where: { scheduledPostId: slot.id, state: { in: [...OPEN_CLAIM_STATES] } },
      }),
    ]);

    const assessment = assessPriorServiceFill({
      slot: {
        workspaceId: slot.workspaceId,
        projectId: slot.projectId,
        publishStatus: slot.publishStatus,
        scheduledDate: slot.scheduledDate,
        hasOpenPublishClaim: openClaimCount > 0,
      },
      targetService: targetProject
        ? { id: targetProject.id, serviceAt: serviceAt(targetProject) }
        : null,
      candidateService: {
        id: candidate.project.id,
        workspaceId: candidate.project.workspaceId,
        status: candidate.project.status,
        serviceAt: serviceAt(candidate.project),
        // The fact the lock exists to make trustworthy.
        renderableSource: Boolean(sourceVideo?.storageKey),
      },
      candidate: {
        id: candidate.id,
        status: candidate.status,
        supersededAt: candidate.supersededAt,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        hasEverBeenScheduled: scheduledCount > 0,
        hasForbiddenFinding: forbiddenCount > 0,
      },
      now,
    });
    if (!assessment.eligible) {
      throw new PriorServiceFillRefusedError(
        assessment.reason,
        describePriorServiceFillRefusal(assessment.reason),
      );
    }

    const latestEdit = await tx.clipEdit.findFirst({
      where: { clipId: candidate.id },
      orderBy: { version: "desc" },
    });

    // Created inside the transaction so a rollback cannot leave a render queued for a date that
    // was never filled. Idempotent on (clip, edit version), which is what "create or reuse"
    // means: a second fill of the same cut finds the first render rather than minting a rival.
    const job = await enqueueExportJob(tx, {
      clipId: candidate.id,
      workspaceId: slot.workspaceId,
      editVersion: latestEdit?.version ?? DEFAULT_EDIT_VERSION,
      priority: PRIOR_SERVICE_FILL_EXPORT_PRIORITY,
      filename: buildDefaultExportFilename({
        seriesOrProject: candidate.project.series ?? candidate.project.name,
        clipTitle: candidate.title,
        date: slot.scheduledDate,
      }),
    });

    // **The exact conditional claim.** Not an update by id: by id *and* still empty *and* still
    // in a fillable state. A second operator filling the same date loses here rather than
    // overwriting, and the loser is told the date moved rather than silently succeeding.
    //
    // `projectId`, `scheduledDate` and `platform` are absent from `data` on purpose. A fill
    // changes what goes out on a date; it never changes whose service owns it, when it goes, or
    // where.
    const claim = await tx.scheduledPost.updateMany({
      where: {
        id: slot.id,
        clipId: null,
        publishStatus: { in: [...FILLABLE_STATES] },
      },
      data: {
        clipId: candidate.id,
        exportJobId: job.id,
        publishStatus: SchedulePublishStatus.NOT_STARTED,
        lastErrorMessage: null,
        attemptCount: 0,
        nextAttemptAt: null,
      },
    });
    if (claim.count === 0) {
      throw new PriorServiceFillRefusedError(
        "SLOT_MOVED",
        "This date was filled or changed while you were choosing. Reload and look again.",
      );
    }

    // **Retention.** The borrowed sermon's media has to outlive the date it is now posting on.
    // Inside the lock, so cleanup re-reads this expiry rather than the one it saw before.
    const expiresAt = sourceExpiresAtForSchedule([slot.scheduledDate]);
    if (
      expiresAt &&
      (candidate.project.expiresAt === null || candidate.project.expiresAt < expiresAt)
    ) {
      await tx.project.update({
        where: { id: candidate.project.id },
        data: { expiresAt },
      });
    }

    // Resolved in place. The row keeps its snapshots and its message — the shortage happened, and
    // deleting the record of it would erase why this date holds another sermon's clip.
    const open = await tx.editorialException.findMany({
      where: { scheduledPostId: slot.id, state: EditorialExceptionState.OPEN },
      select: { id: true },
    });
    if (open.length > 0) {
      await tx.editorialException.updateMany({
        where: { id: { in: open.map((row) => row.id) } },
        data: {
          state: EditorialExceptionState.RESOLVED,
          resolvedAt: now,
          resolvedByUserId: input.operatorUserId,
          resolutionReason: `Filled from an earlier service (clip ${candidate.id}).`,
        },
      });
    }

    return {
      scheduledPostId: slot.id,
      filledClipId: candidate.id,
      exportJobId: job.id,
      slotStatus: SchedulePublishStatus.NOT_STARTED,
      resolvedExceptionIds: open.map((row) => row.id),
      targetProjectId: slot.projectId as string,
      sourceProjectId: candidate.project.id,
      alreadyFilled: false,
      workspaceId: slot.workspaceId,
    };
  });

  // After the commit. An event that fails to write must not undo a fill that already happened.
  if (!outcome.alreadyFilled) {
    await recordOperationalEventSafely(client, {
      workspaceId: outcome.workspaceId,
      category: "approval",
      eventType: "prior_service_fill_applied",
      message:
        "An operator filled an empty posting date with a clip from an earlier service.",
      // Both services, because the whole point of this record is that two are involved: the one
      // that owns the date and the one the clip came from.
      projectId: outcome.targetProjectId,
      clipId: outcome.filledClipId,
      exportJobId: outcome.exportJobId,
      metadata: {
        scheduledPostId: outcome.scheduledPostId,
        targetProjectId: outcome.targetProjectId,
        sourceProjectId: outcome.sourceProjectId,
        operatorUserId: input.operatorUserId,
        resolvedExceptionIds: outcome.resolvedExceptionIds,
      },
    });
  }

  return {
    scheduledPostId: outcome.scheduledPostId,
    filledClipId: outcome.filledClipId,
    exportJobId: outcome.exportJobId,
    slotStatus: outcome.slotStatus,
    resolvedExceptionIds: outcome.resolvedExceptionIds,
    targetProjectId: outcome.targetProjectId,
    sourceProjectId: outcome.sourceProjectId,
    alreadyFilled: outcome.alreadyFilled,
  };
}
