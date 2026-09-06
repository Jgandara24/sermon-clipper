import {
  ClipReviewDecision,
  GeneratedClipStatus,
  ReviewFeedbackSeverity,
  ReviewerKind,
  SchedulePublishStatus,
  type PrismaClient,
} from "@prisma/client";
import { buildDefaultExportFilename } from "@/lib/export/filename";
import { DEFAULT_EDIT_VERSION } from "@/lib/exports/edit-version";
import { enqueueExportJob } from "@/lib/exports/queue";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { lockSourceVideoForRetention, sourceExpiresAtForSchedule } from "@/lib/retention";
import { resolveActionability } from "./feedback-policy";
import { selectReserve, type ReserveCandidate } from "./reserve-policy";
import { assertIdentityIsCurrent, clipDurationMs, loadReviewSubject } from "./snapshots";
import type { ReviewFeedbackInput, ReviewedRenderIdentity } from "./types";

/**
 * Replacing a scheduled clip, all at once or not at all.
 *
 * A replacement is not a decision with side effects; it is five writes that only make sense
 * together. The rejected clip is superseded, the next reserve is promoted, the slot is rebound to
 * it, a priority render is queued, and the human `REPLACE` is recorded. Land four of those and the
 * slot is worse than before it was reviewed: pointing at a clip with no render, or at a render for
 * a clip it no longer holds, with no record of who decided what.
 *
 * That is why `appendClipReview` refuses a bare `REPLACE` and why this is the only code that
 * writes one. Everything below happens inside a single transaction.
 *
 * **Concurrency.** Two operators replacing two different slots in the same sermon would both find
 * the same lowest-rank reserve. The project row is locked first, so the second waits, re-reads,
 * and takes the next one — both succeed, with different clips. `ScheduledPost.clipId` is unique,
 * which would also stop the double-promotion, but as a crash rather than as an answer.
 */

/** Slot states a replacement may act on. Everything else has already left the reviewer's hands. */
const REPLACEABLE_STATES: readonly SchedulePublishStatus[] = [
  SchedulePublishStatus.NOT_STARTED,
  SchedulePublishStatus.FAILED,
  SchedulePublishStatus.BLOCKED,
];

export class ReplacementRefusedError extends Error {
  constructor(
    readonly reason: "SLOT_NOT_REPLACEABLE" | "SLOT_MOVED",
    message: string,
  ) {
    super(message);
    this.name = "ReplacementRefusedError";
  }
}

export type ReplacementOutcome = {
  clipReviewId: string;
  supersededClipId: string;
  /** Null when the pool was exhausted; the slot is UNFILLED and an exception is open. */
  promotedClipId: string | null;
  promotedExportJobId: string | null;
  slotStatus: SchedulePublishStatus;
  editorialExceptionId: string | null;
};

export type ReplaceScheduledClipInput = {
  scheduledPostId: string;
  identity: ReviewedRenderIdentity;
  reviewerUserId?: string | null;
  note?: string | null;
  feedback?: ReviewFeedbackInput[];
};

/** The render a promoted reserve gets. Above the default so it reaches a worker first. */
export const REPLACEMENT_EXPORT_PRIORITY = 100;

export async function replaceScheduledClip(
  client: PrismaClient,
  input: ReplaceScheduledClipInput,
): Promise<ReplacementOutcome> {
  const outcome = await client.$transaction(async (tx) => {
    // Everything the reviewer decided about, re-read and verified. `loadReviewSubject` refuses a
    // slot with no clip, no bound export, or an export that never passed QC.
    const subject = await loadReviewSubject(tx, input.scheduledPostId);
    assertIdentityIsCurrent(subject, input.identity);

    // Serializes replacements within one sermon, so two of them cannot choose the same reserve.
    // Taken after the subject read and before any selection, which is the only window that
    // matters: the loser waits here and then re-reads the candidate pool below.
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${subject.projectId}::uuid FOR UPDATE`;

    const slot = await tx.scheduledPost.findUniqueOrThrow({
      where: { id: input.scheduledPostId },
    });
    if (!REPLACEABLE_STATES.includes(slot.publishStatus)) {
      // IN_PROGRESS is a Meta call that may already have posted; SUCCEEDED and MISSED are over.
      throw new ReplacementRefusedError(
        "SLOT_NOT_REPLACEABLE",
        `This slot is ${slot.publishStatus} and can no longer be replaced.`,
      );
    }
    // The subject was read before the lock. If anything moved in that window, stop rather than
    // act on a stale read.
    if (slot.clipId !== subject.clipId || slot.exportJobId !== subject.exportJobId) {
      throw new ReplacementRefusedError(
        "SLOT_MOVED",
        "This slot changed while the replacement was starting. Reload and decide again.",
      );
    }

    const candidateRows = await tx.generatedClip.findMany({
      where: { projectId: subject.projectId },
      select: {
        id: true,
        rank: true,
        status: true,
        startMs: true,
        endMs: true,
        title: true,
        scheduledPosts: { select: { id: true } },
      },
      orderBy: { rank: "asc" },
    });
    const candidates: ReserveCandidate[] = candidateRows.map((row) => ({
      id: row.id,
      rank: row.rank,
      status: row.status,
      startMs: row.startMs,
      endMs: row.endMs,
      isScheduled: row.scheduledPosts.length > 0,
    }));
    const selection = selectReserve(candidates, { excludeClipIds: [subject.clipId] });
    const reserve = selection.selected;
    const reserveRow = reserve ? candidateRows.find((row) => row.id === reserve.id) : null;

    // The rejected clip is superseded either way. A replacement that found nobody still says
    // "not this clip", and leaving it KEPT would let the next sweep hand it straight back.
    await tx.generatedClip.update({
      where: { id: subject.clipId },
      data: { status: GeneratedClipStatus.SUPERSEDED, supersededAt: new Date() },
    });

    let promotedExportJobId: string | null = null;
    if (reserve && reserveRow) {
      const latestEdit = await tx.clipEdit.findFirst({
        where: { clipId: reserve.id },
        orderBy: { version: "desc" },
      });
      const project = await tx.project.findUniqueOrThrow({ where: { id: subject.projectId } });

      // Created inside the transaction, so a rollback cannot leave an orphan render queued for a
      // clip no slot points at.
      const job = await enqueueExportJob(tx, {
        clipId: reserve.id,
        workspaceId: subject.workspaceId,
        editVersion: latestEdit?.version ?? DEFAULT_EDIT_VERSION,
        priority: REPLACEMENT_EXPORT_PRIORITY,
        filename: buildDefaultExportFilename({
          seriesOrProject: project.series ?? project.name,
          clipTitle: reserveRow.title,
          date: slot.scheduledDate,
        }),
      });
      promotedExportJobId = job.id;

      // Date and platform are untouched: a replacement changes which clip goes out, never when or
      // where. The state returns to NOT_STARTED because this slot has work to do again.
      await tx.scheduledPost.update({
        where: { id: slot.id },
        data: {
          clipId: reserve.id,
          exportJobId: job.id,
          publishStatus: SchedulePublishStatus.NOT_STARTED,
          lastErrorMessage: null,
          attemptCount: 0,
          nextAttemptAt: null,
        },
      });

      // The source media has to outlive the new render's posting date. Locked first, because
      // CLEANUP may be reading this same source's expiry to decide a deletion right now.
      if (project.sourceVideoId) {
        await lockSourceVideoForRetention(tx, project.sourceVideoId);
        const expiresAt = sourceExpiresAtForSchedule([slot.scheduledDate]);
        if (expiresAt && (project.expiresAt === null || project.expiresAt < expiresAt)) {
          await tx.project.update({ where: { id: project.id }, data: { expiresAt } });
        }
      }
    } else {
      // Nobody left. The slot keeps its date and its project — `projectId` is what preserves
      // ownership once the clip is gone — and becomes an operator's problem rather than a silent
      // hole. Both bindings are cleared so nothing downstream reads a rejected clip as current.
      await tx.scheduledPost.update({
        where: { id: slot.id },
        data: {
          clipId: null,
          exportJobId: null,
          publishStatus: SchedulePublishStatus.UNFILLED,
        },
      });
    }

    const durationMs = clipDurationMs(subject);
    const review = await tx.clipReview.create({
      data: {
        workspaceId: subject.workspaceId,
        projectId: subject.projectId,
        scheduledPostId: slot.id,
        // The rejected clip's live link, which a later deletion will clear. Its snapshot below
        // is what survives.
        clipId: subject.clipId,
        exportJobId: subject.exportJobId,
        replacementClipId: reserve?.id ?? null,
        replacementExportId: promotedExportJobId,
        reviewerUserId: input.reviewerUserId ?? null,
        reviewerKind: ReviewerKind.HUMAN,
        decision: ClipReviewDecision.REPLACE,
        projectIdSnapshot: subject.projectId,
        scheduledPostIdSnapshot: slot.id,
        clipIdSnapshot: subject.clipId,
        clipRank: subject.clipRank,
        clipStartMs: subject.clipStartMs,
        clipEndMs: subject.clipEndMs,
        exportJobIdSnapshot: subject.exportJobId,
        editVersion: subject.editVersion,
        checksum: subject.checksum,
        replacementClipIdSnapshot: reserve?.id ?? null,
        replacementClipRank: reserve?.rank ?? null,
        replacementClipStartMs: reserve?.startMs ?? null,
        replacementClipEndMs: reserve?.endMs ?? null,
        replacementExportJobIdSnapshot: promotedExportJobId,
        slotSnapshot: subject.slotSnapshot,
        note: input.note ?? null,
        feedback: {
          create: (input.feedback ?? []).map((finding) => ({
            workspaceId: subject.workspaceId,
            category: finding.category,
            severity: finding.severity ?? ReviewFeedbackSeverity.MAJOR,
            actionability: resolveActionability(finding, durationMs),
            note: finding.note,
            startMs: finding.startMs ?? null,
            endMs: finding.endMs ?? null,
            authorKind: finding.authorKind ?? ReviewerKind.HUMAN,
            authorUserId: finding.authorUserId ?? input.reviewerUserId ?? null,
          })),
        },
      },
    });

    let editorialExceptionId: string | null = null;
    if (!reserve) {
      const exception = await tx.editorialException.create({
        data: {
          workspaceId: subject.workspaceId,
          projectId: subject.projectId,
          scheduledPostId: slot.id,
          exceptionType: "reserve_pool_exhausted",
          message:
            "An operator replaced this slot's clip and the sermon had no eligible clip left, so " +
            "the date has nothing to post.",
          projectSnapshot: { projectId: subject.projectId },
          slotSnapshot: {
            scheduledDate: slot.scheduledDate.toISOString(),
            platform: slot.platform,
            rejectedClipId: subject.clipId,
            rejectedClipRank: subject.clipRank,
          },
          metadata: { clipReviewId: review.id },
        },
      });
      editorialExceptionId = exception.id;
    }

    return {
      clipReviewId: review.id,
      supersededClipId: subject.clipId,
      promotedClipId: reserve?.id ?? null,
      promotedExportJobId,
      slotStatus: reserve ? SchedulePublishStatus.NOT_STARTED : SchedulePublishStatus.UNFILLED,
      editorialExceptionId,
      workspaceId: subject.workspaceId,
      projectId: subject.projectId,
    };
  });

  // After the commit, deliberately. An alert that fails to send must not undo a replacement that
  // already happened — the slot is correct either way, and `recordOperationalEventSafely` swallows
  // its own failures for the same reason.
  await recordOperationalEventSafely(client, {
    workspaceId: outcome.workspaceId,
    category: "approval",
    eventType: outcome.promotedClipId ? "clip_replaced" : "reserve_pool_exhausted",
    severity: outcome.promotedClipId ? "info" : "warning",
    message: outcome.promotedClipId
      ? "An operator replaced a scheduled clip with the next reserve."
      : "An operator replaced a scheduled clip and the sermon had no reserve left.",
    projectId: outcome.projectId,
    clipId: outcome.promotedClipId,
    exportJobId: outcome.promotedExportJobId,
    metadata: {
      scheduledPostId: input.scheduledPostId,
      clipReviewId: outcome.clipReviewId,
      supersededClipId: outcome.supersededClipId,
      editorialExceptionId: outcome.editorialExceptionId,
    },
  });

  return {
    clipReviewId: outcome.clipReviewId,
    supersededClipId: outcome.supersededClipId,
    promotedClipId: outcome.promotedClipId,
    promotedExportJobId: outcome.promotedExportJobId,
    slotStatus: outcome.slotStatus,
    editorialExceptionId: outcome.editorialExceptionId,
  };
}
