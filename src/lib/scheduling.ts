/**
 * Maps a clip's rank (1-indexed, best first) to its calendar posting date, per Pulpit
 * Engine's scheduling rule (docs/BUSINESS_OVERVIEW.md): the Nth-best clip posts N days
 * after the sermon date — rank 1 is the day after the sermon, rank 6 is six days after.
 * `sermonDate` must already be a calendar-date-normalized UTC midnight (see
 * calendarDateInTimezone in church-profile.ts) so this stays plain UTC date arithmetic.
 */
export function scheduledDateForRank(sermonDate: Date, rank: number): Date {
  const result = new Date(sermonDate);
  result.setUTCDate(result.getUTCDate() + rank);
  return result;
}

type ScheduledPostQueryClient = {
  scheduledPost: {
    deleteMany(args: {
      where: {
        workspaceId: string;
        clip: { projectId: string };
        publishStatus: { in: ("NOT_STARTED" | "FAILED")[] };
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

/**
 * Clears the re-schedulable (NOT_STARTED/FAILED) calendar slots of a project's clips before
 * re-analysis regenerates them. SUCCEEDED/IN_PROGRESS rows are publish history — the only
 * record a real Facebook post exists — and must survive; scheduled_posts.clip_id is
 * ON DELETE SET NULL so the subsequent clip deleteMany detaches them instead of cascading.
 */
export async function clearReschedulableScheduledPosts(
  tx: ScheduledPostQueryClient,
  params: { workspaceId: string; projectId: string },
): Promise<{ count: number }> {
  return tx.scheduledPost.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      clip: { projectId: params.projectId },
      publishStatus: { in: ["NOT_STARTED", "FAILED"] },
    },
  });
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
