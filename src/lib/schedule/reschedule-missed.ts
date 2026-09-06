import {
  EditorialExceptionState,
  Prisma,
  SchedulePublishStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  calendarDateInTimezone,
  parseChurchProfile,
  weekdayNameInTimezone,
} from "@/lib/church-profile";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { lockSourceVideoForRetention, sourceExpiresAtForSchedule } from "@/lib/retention";

/**
 * Moving a missed post to a date an operator chose.
 *
 * **`MISSED` is terminal for automation.** Nothing sweeps missed slots, nothing retries them, and
 * the allocator does not shift later posts up to cover one — a missed Tuesday stays missed and
 * Wednesday stays Wednesday. That is Addendum Decision O, and it is what keeps a single late
 * render from silently rewriting a church's whole week. The only way out is this command, run by
 * a person who picked a date.
 *
 * **The same row moves; a second one is never inserted.** `scheduled_posts` has a partial unique
 * index — one non-`MISSED` row per workspace date — and `clip_id` is globally unique. Inserting a
 * new row for the same clip would violate the second constraint, and inserting one for a date that
 * is already spoken for would violate the first. Mutating in place sidesteps both and keeps the
 * publish history attached to the row it belongs to.
 *
 * **The binding is retained, never re-derived.** Whatever clip and export the slot held, it keeps.
 * This command does not go looking for a fresher render, because "the newest successful export"
 * is precisely the lookup P1.11 exists to forbid. Delivery eligibility stays authoritative: a
 * rescheduled date publishes only if the exact bound render is still accepted (P2.8).
 */

export type RescheduleMissedRefusal =
  | "slot_not_missed"
  | "slot_has_no_clip"
  | "date_in_past"
  | "date_is_sunday"
  | "date_already_taken";

export type RescheduleAssessment =
  | { eligible: true }
  | { eligible: false; reason: RescheduleMissedRefusal };

export class RescheduleMissedRefusedError extends Error {
  constructor(
    readonly reason: RescheduleMissedRefusal | "SLOT_MISSING" | "SLOT_MOVED",
    message: string,
  ) {
    super(message);
    this.name = "RescheduleMissedRefusedError";
  }
}

/** Sunday never receives a post. The product's rule, not a church setting. */
const DARK_WEEKDAY = "Sunday";

export type RescheduleFacts = {
  slot: { publishStatus: SchedulePublishStatus; clipId: string | null };
  /** The church's calendar date, pinned to UTC midnight — the shape `scheduledDate` is stored in. */
  newDate: Date;
  /** Today in the church's timezone, in the same shape. */
  churchToday: Date;
  /** Whether another non-`MISSED` row in this workspace already holds the new date. */
  dateAlreadyTaken: boolean;
};

/**
 * Whether a missed date may move to this new one.
 *
 * Pure, so the awkward part — dates and weekdays — has a truth table that does not need a
 * database. The weekday is read **in UTC**, because `newDate` is already the church's own calendar
 * date pinned to UTC midnight; reading it in the church's zone would apply that offset a second
 * time and report the previous day. `allocatePostingSlots` documents the same trap.
 */
export function assessMissedReschedule(facts: RescheduleFacts): RescheduleAssessment {
  if (facts.slot.publishStatus !== SchedulePublishStatus.MISSED) {
    return { eligible: false, reason: "slot_not_missed" };
  }
  // A detached history row: the clip was regenerated out from under it. There is nothing to post,
  // so moving the date would only give the church an empty day on a different afternoon.
  if (!facts.slot.clipId) return { eligible: false, reason: "slot_has_no_clip" };

  if (facts.newDate.getTime() < facts.churchToday.getTime()) {
    return { eligible: false, reason: "date_in_past" };
  }
  if (weekdayNameInTimezone(facts.newDate, "UTC") === DARK_WEEKDAY) {
    return { eligible: false, reason: "date_is_sunday" };
  }
  if (facts.dateAlreadyTaken) return { eligible: false, reason: "date_already_taken" };

  return { eligible: true };
}

export function describeRescheduleRefusal(reason: RescheduleMissedRefusal): string {
  switch (reason) {
    case "slot_not_missed":
      return "Only a missed date can be rescheduled. This one is not missed.";
    case "slot_has_no_clip":
      return "This date holds no clip — its clip was regenerated — so there is nothing to move.";
    case "date_in_past":
      return "That date has already passed for this church.";
    case "date_is_sunday":
      return "Sunday never receives a post.";
    case "date_already_taken":
      return "This church already has a post booked for that date.";
    default:
      return `That date cannot be used (${reason}).`;
  }
}

export type RescheduleMissedOutcome = {
  scheduledPostId: string;
  previousDate: Date;
  newDate: Date;
  clipId: string;
  exportJobId: string | null;
  resolvedExceptionIds: string[];
};

export type RescheduleMissedInput = {
  scheduledPostId: string;
  /** The church's calendar date, as `YYYY-MM-DD`. Pinned to UTC midnight by the caller. */
  newDate: Date;
  operatorUserId: string;
  now?: Date;
};

export async function rescheduleMissedSlot(
  client: PrismaClient,
  input: RescheduleMissedInput,
): Promise<RescheduleMissedOutcome> {
  const now = input.now ?? new Date();

  const outcome = await client.$transaction(async (tx) => {
    const slot = await tx.scheduledPost.findUnique({
      where: { id: input.scheduledPostId },
      include: {
        workspace: { select: { settings: true } },
        project: { select: { id: true, sourceVideoId: true, expiresAt: true } },
      },
    });
    if (!slot) {
      throw new RescheduleMissedRefusedError("SLOT_MISSING", "That date no longer exists.");
    }

    const profile = parseChurchProfile(slot.workspace.settings);

    // Any other row that still holds the target date. `MISSED` rows do not count: the partial
    // unique index releases the date when a slot is missed, which is what makes two missed posts
    // able to move to the same free day one after the other.
    const collision = await tx.scheduledPost.count({
      where: {
        workspaceId: slot.workspaceId,
        scheduledDate: input.newDate,
        publishStatus: { not: SchedulePublishStatus.MISSED },
        id: { not: slot.id },
      },
    });

    const assessment = assessMissedReschedule({
      slot: { publishStatus: slot.publishStatus, clipId: slot.clipId },
      newDate: input.newDate,
      churchToday: calendarDateInTimezone(now, profile.timezone),
      dateAlreadyTaken: collision > 0,
    });
    if (!assessment.eligible) {
      throw new RescheduleMissedRefusedError(
        assessment.reason,
        describeRescheduleRefusal(assessment.reason),
      );
    }

    // The same row, conditionally. Still missed at the moment of writing, or somebody else moved
    // it first. `clipId` and `exportJobId` are absent from `data`: the binding is retained exactly
    // as it stands, never re-derived.
    let claim: Prisma.BatchPayload;
    try {
      claim = await tx.scheduledPost.updateMany({
        where: { id: slot.id, publishStatus: SchedulePublishStatus.MISSED },
        data: {
          scheduledDate: input.newDate,
          publishStatus: SchedulePublishStatus.NOT_STARTED,
          // Facts about the attempt that failed to happen, not about the clip. A new date is a
          // new attempt, so the backoff and the last error go; the publish-attempt rows stay,
          // because they are the record that a call may have gone out.
          attemptCount: 0,
          nextAttemptAt: null,
          lastErrorMessage: null,
        },
      });
    } catch (error) {
      // The partial unique index, reached despite the count above — two operators picking the
      // same free day at the same instant. Reported as the refusal it is.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RescheduleMissedRefusedError(
          "date_already_taken",
          describeRescheduleRefusal("date_already_taken"),
        );
      }
      throw error;
    }
    if (claim.count === 0) {
      throw new RescheduleMissedRefusedError(
        "SLOT_MOVED",
        "This date stopped being missed while you were choosing. Reload and look again.",
      );
    }

    // The source has to outlive the new posting date, which is later than the one retention was
    // last computed against. Locked first, because cleanup may be reading this same expiry now.
    if (slot.project?.sourceVideoId) {
      await lockSourceVideoForRetention(tx, slot.project.sourceVideoId);
      const expiresAt = sourceExpiresAtForSchedule([input.newDate]);
      if (expiresAt && (slot.project.expiresAt === null || slot.project.expiresAt < expiresAt)) {
        await tx.project.update({ where: { id: slot.project.id }, data: { expiresAt } });
      }
    }

    // Resolved in place, keeping the record that the date was missed at all.
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
          resolutionReason: `Rescheduled to ${input.newDate.toISOString().slice(0, 10)}.`,
        },
      });
    }

    return {
      scheduledPostId: slot.id,
      previousDate: slot.scheduledDate,
      newDate: input.newDate,
      clipId: slot.clipId as string,
      exportJobId: slot.exportJobId,
      resolvedExceptionIds: open.map((row) => row.id),
      workspaceId: slot.workspaceId,
      projectId: slot.project?.id ?? null,
    };
  });

  await recordOperationalEventSafely(client, {
    workspaceId: outcome.workspaceId,
    category: "scheduling",
    eventType: "missed_post_rescheduled",
    message: "An operator moved a missed post to a new date.",
    projectId: outcome.projectId,
    clipId: outcome.clipId,
    exportJobId: outcome.exportJobId,
    metadata: {
      scheduledPostId: outcome.scheduledPostId,
      previousDate: outcome.previousDate.toISOString().slice(0, 10),
      newDate: outcome.newDate.toISOString().slice(0, 10),
      operatorUserId: input.operatorUserId,
      resolvedExceptionIds: outcome.resolvedExceptionIds,
    },
  });

  return {
    scheduledPostId: outcome.scheduledPostId,
    previousDate: outcome.previousDate,
    newDate: outcome.newDate,
    clipId: outcome.clipId,
    exportJobId: outcome.exportJobId,
    resolvedExceptionIds: outcome.resolvedExceptionIds,
  };
}
