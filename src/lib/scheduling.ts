import type { SchedulePublishStatus } from "@prisma/client";

type RescheduleState = "NOT_STARTED" | "FAILED" | "MISSED" | "UNFILLED";

/**
 * What posting dates a sermon gets is decided by `allocatePostingSlots` in
 * `src/lib/schedule/posting-schedule.ts`, not here. This module keeps only the database-coupled
 * scheduling helpers: what a workspace has already reserved, and what re-analysis may clear.
 *
 * `scheduledDateForRank` used to live here and was removed in P1.9. It mapped rank N to
 * `sermonDate + N days` with no weekday awareness, which posts on Sunday. Turning
 * `AUTOMATIC_SCHEDULE_ARMING_ENABLED` off disables arming; it does not bring that rule back.
 */

type ScheduledPostQueryClient = {
  scheduledPost: {
    deleteMany(args: {
      where: {
        workspaceId: string;
        OR: Array<{ clip: { projectId: string } } | { projectId: string }>;
        publishStatus: { in: RescheduleState[] };
      };
    }): Promise<{ count: number }>;
    findFirst(args: {
      where: {
        workspaceId: string;
        scheduledDate: Date;
        publishStatus: { in: ("SUCCEEDED" | "IN_PROGRESS")[] };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

type ScheduledPostCollisionClient = {
  scheduledPost: {
    findFirst(args: {
      where: { workspaceId: string; scheduledDate: Date };
      orderBy: [{ createdAt: "asc" }, { id: "asc" }];
      select: {
        id: true;
        createdAt: true;
        publishStatus: true;
        clip: { select: { projectId: true } };
      };
    }): Promise<{
      id: string;
      createdAt: Date;
      publishStatus: SchedulePublishStatus;
      clip: { projectId: string } | null;
    } | null>;
  };
};

export type ScheduledPostCollision = {
  id: string;
  createdAt: Date;
  publishStatus: SchedulePublishStatus;
  projectId: string | null;
};

/**
 * Slots a rebuild may throw away and re-derive. Kept in step with `DURABLE_PUBLISH_STATES` in
 * `reanalysis-policy.ts`: exactly the states that policy does not treat as durable work. MISSED
 * and UNFILLED belong here — neither reached an audience — and clearing them is what stops a
 * rebuild leaving them behind with a null clip.
 */
export const RESCHEDULABLE_PUBLISH_STATES = [
  "NOT_STARTED",
  "FAILED",
  "MISSED",
  "UNFILLED",
] as const;

/**
 * Clears the re-schedulable calendar slots of a project before re-analysis regenerates them.
 * SUCCEEDED/IN_PROGRESS/BLOCKED rows are publish history — the only record a real Facebook post
 * exists, or an operator's decision — and must survive; scheduled_posts.clip_id is
 * ON DELETE SET NULL so the subsequent clip deleteMany detaches them instead of cascading.
 *
 * Matches on the project as well as the clip: an UNFILLED slot has no clip to match on.
 */
export async function clearReschedulableScheduledPosts(
  tx: ScheduledPostQueryClient,
  params: { workspaceId: string; projectId: string },
): Promise<{ count: number }> {
  return tx.scheduledPost.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      OR: [{ clip: { projectId: params.projectId } }, { projectId: params.projectId }],
      publishStatus: { in: [...RESCHEDULABLE_PUBLISH_STATES] },
    },
  });
}

/** Returns the earliest row that already reserves a workspace posting date, in any state. */
export async function findScheduledPostCollision(
  tx: ScheduledPostCollisionClient,
  params: { workspaceId: string; scheduledDate: Date },
): Promise<ScheduledPostCollision | null> {
  const existing = await tx.scheduledPost.findFirst({
    where: { workspaceId: params.workspaceId, scheduledDate: params.scheduledDate },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      publishStatus: true,
      clip: { select: { projectId: true } },
    },
  });
  return existing
    ? {
        id: existing.id,
        createdAt: existing.createdAt,
        publishStatus: existing.publishStatus,
        projectId: existing.clip?.projectId ?? null,
      }
    : null;
}

/**
 * A calendar slot that already has a live or published post must not be re-armed by
 * re-analysis — same-day re-arming would post duplicate content to the Page.
 */
export async function slotAlreadyPublished(
  tx: ScheduledPostQueryClient,
  params: { workspaceId: string; scheduledDate: Date },
): Promise<boolean> {
  const existing = await tx.scheduledPost.findFirst({
    where: {
      workspaceId: params.workspaceId,
      scheduledDate: params.scheduledDate,
      publishStatus: { in: ["SUCCEEDED", "IN_PROGRESS"] },
    },
    select: { id: true },
  });
  return existing !== null;
}
