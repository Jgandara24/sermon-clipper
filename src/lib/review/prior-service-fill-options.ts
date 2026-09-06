import {
  EditorialExceptionState,
  ProjectStatus,
  PublishAttemptState,
  ReviewFeedbackCategory,
  SchedulePublishStatus,
  type PrismaClient,
} from "@prisma/client";
import { assessPriorServiceFill } from "./prior-service-fill-policy";

/**
 * What an operator may choose from when a date has nothing to post.
 *
 * **This enumerates; it does not choose.** Nothing here scores, ranks by desirability, or marks a
 * suggestion — services come back oldest first and candidates in the selector's original rank
 * order, which is an ordering the data already had rather than an opinion this module formed. The
 * distinction matters because P3.5's policy deliberately exports no selector, and a loader that
 * quietly returned "the best option first" would put the recommendation back by the side door.
 *
 * Every candidate returned has been through `assessPriorServiceFill` against this exact slot, so
 * the list is what would actually be accepted rather than what looks plausible. The command
 * re-runs the same policy inside its transaction; this is the same question asked early enough to
 * be useful, not a substitute for asking it late enough to be safe.
 */

export type FillCandidateOption = {
  clipId: string;
  rank: number;
  title: string;
  hook: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type FillServiceOption = {
  projectId: string;
  projectName: string;
  /** The sermon's own date where it has one, so an operator can see how far back they are reaching. */
  serviceAt: string;
  series: string | null;
  speaker: string | null;
  candidates: FillCandidateOption[];
};

export type ShortageResolutionSlot = {
  scheduledPostId: string;
  scheduledDate: string;
  publishStatus: SchedulePublishStatus;
  projectId: string;
  projectName: string;
  workspaceId: string;
  churchName: string;
  /** The open exceptions this date carries. Resolved in place by a successful fill. */
  openExceptionIds: string[];
  /** Every older service with at least one clip this date could actually take. */
  services: FillServiceOption[];
};

/** How far back to look. Beyond this an operator is reaching into a different season. */
const MAX_SERVICES_CONSIDERED = 25;

export async function loadShortageResolutionOptions(
  client: PrismaClient,
  params: { scheduledPostId: string; now?: Date },
): Promise<ShortageResolutionSlot | null> {
  const now = params.now ?? new Date();

  const slot = await client.scheduledPost.findUnique({
    where: { id: params.scheduledPostId },
    include: {
      workspace: { select: { name: true } },
      project: true,
    },
  });
  if (!slot || !slot.project) return null;

  const openExceptions = await client.editorialException.findMany({
    where: { scheduledPostId: slot.id, state: EditorialExceptionState.OPEN },
    select: { id: true },
  });

  const openClaimCount = await client.publishAttempt.count({
    where: {
      scheduledPostId: slot.id,
      state: { in: [PublishAttemptState.INTENT, PublishAttemptState.INDETERMINATE] },
    },
  });

  const targetServiceAt = slot.project.sermonDate ?? slot.project.createdAt;

  // Same church, finished, and preached earlier. Everything past this point is the policy's
  // decision rather than a query's.
  const olderServices = await client.project.findMany({
    where: {
      workspaceId: slot.workspaceId,
      id: { not: slot.project.id },
      status: ProjectStatus.READY,
    },
    include: {
      sourceVideo: { select: { storageKey: true } },
      generatedClips: { orderBy: { rank: "asc" } },
    },
    orderBy: [{ sermonDate: "desc" }, { createdAt: "desc" }],
    take: MAX_SERVICES_CONSIDERED,
  });

  const services: FillServiceOption[] = [];
  for (const service of olderServices) {
    const clipIds = service.generatedClips.map((clip) => clip.id);
    if (clipIds.length === 0) continue;

    // Two scoped queries per service rather than two per clip. Both are membership questions, so
    // the answers are sets.
    const [scheduled, forbidden] = await Promise.all([
      client.scheduledPost.findMany({
        where: { clipId: { in: clipIds } },
        select: { clipId: true },
      }),
      client.clipReviewFeedback.findMany({
        where: {
          category: ReviewFeedbackCategory.FORBIDDEN_CONTENT,
          clipReview: { clipIdSnapshot: { in: clipIds } },
        },
        select: { clipReview: { select: { clipIdSnapshot: true } } },
      }),
    ]);
    const everScheduled = new Set(scheduled.map((row) => row.clipId));
    const everForbidden = new Set(forbidden.map((row) => row.clipReview.clipIdSnapshot));

    const candidates: FillCandidateOption[] = [];
    for (const clip of service.generatedClips) {
      const assessment = assessPriorServiceFill({
        slot: {
          workspaceId: slot.workspaceId,
          projectId: slot.projectId,
          publishStatus: slot.publishStatus,
          scheduledDate: slot.scheduledDate,
          hasOpenPublishClaim: openClaimCount > 0,
        },
        targetService: { id: slot.project.id, serviceAt: targetServiceAt },
        candidateService: {
          id: service.id,
          workspaceId: service.workspaceId,
          status: service.status,
          serviceAt: service.sermonDate ?? service.createdAt,
          renderableSource: Boolean(service.sourceVideo?.storageKey),
        },
        candidate: {
          id: clip.id,
          status: clip.status,
          supersededAt: clip.supersededAt,
          startMs: clip.startMs,
          endMs: clip.endMs,
          hasEverBeenScheduled: everScheduled.has(clip.id),
          hasForbiddenFinding: everForbidden.has(clip.id),
        },
        now,
      });
      if (!assessment.eligible) continue;

      candidates.push({
        clipId: clip.id,
        rank: clip.rank,
        title: clip.title,
        hook: clip.hookText,
        startMs: clip.startMs,
        endMs: clip.endMs,
        durationMs: Math.max(0, clip.endMs - clip.startMs),
      });
    }

    // A service with nothing takeable is not an option, so it is not offered as one.
    if (candidates.length === 0) continue;
    services.push({
      projectId: service.id,
      projectName: service.name,
      serviceAt: (service.sermonDate ?? service.createdAt).toISOString(),
      series: service.series,
      speaker: service.speaker,
      candidates,
    });
  }

  return {
    scheduledPostId: slot.id,
    scheduledDate: slot.scheduledDate.toISOString(),
    publishStatus: slot.publishStatus,
    projectId: slot.project.id,
    projectName: slot.project.name,
    workspaceId: slot.workspaceId,
    churchName: slot.workspace.name,
    openExceptionIds: openExceptions.map((row) => row.id),
    services,
  };
}
