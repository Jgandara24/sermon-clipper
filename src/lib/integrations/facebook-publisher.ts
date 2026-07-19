import type { PrismaClient } from "@prisma/client";
import { parseChurchProfile, wallClockInstantInTimezone } from "@/lib/church-profile";
import { env } from "@/lib/env";
import { isEligibleForAutoPost, parseFacebookConnection } from "@/lib/facebook-connection";
import {
  publishScheduledVideo as defaultPublishScheduledVideo,
  resolvePageAccessToken as defaultResolvePageAccessToken,
  type PublishScheduledVideoInput,
} from "@/lib/integrations/facebook";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";

/**
 * Tier 3 publish poller (docs/BUSINESS_OVERVIEW.md, worker-side).
 *
 * Scans every due, unposted ScheduledPost across all workspaces and — only for a workspace
 * that has both a configured Facebook Page ID and its explicit `facebookAutoPostEnabled`
 * go-live flag set (DECISIONS.md, "Tier 3 Freeze Lifted") — publishes it as a scheduled,
 * unpublished Facebook video post via the Meta Graph API.
 *
 * Fails closed at three independent layers, same discipline as the rest of this codebase's
 * integrations: no META_SYSTEM_USER_TOKEN means the whole poll is a no-op; a workspace without
 * the go-live flag is skipped per-row; a clip with no completed export is skipped per-row (this
 * module never triggers an export itself — a human still reviews/exports clips through the
 * normal flow before Tier 3 can post them).
 *
 * Idempotency mirrors Pulpit Engine's proven `schedule_push_status` state machine: a durable
 * `NOT_STARTED -> IN_PROGRESS` claim (conditional update, only proceeds if this run wins the
 * claim) before any Graph API call, then `IN_PROGRESS -> SUCCEEDED|FAILED`. A row that already
 * has `facebookPostId` set is never reprocessed.
 *
 * Cadence lives in the caller (the worker loop, on FACEBOOK_PUBLISH_POLL_INTERVAL_MS), same
 * pattern as pollDueChannelImportSources.
 */

const DEFAULT_POST_HOUR = 9;
// Meta requires scheduled_publish_time to be at least ~10 minutes in the future; below this
// lead we publish immediately instead of scheduling. A post becomes "due" at UTC midnight of
// its scheduledDate, so the 9am-local target is routinely near or already past by the time the
// poller first sees the row (always, for churches at UTC+9 and east).
const MIN_SCHEDULE_LEAD_MS = 15 * 60_000;
// Long enough for Facebook's servers to fetch the file after the scheduling request, short
// enough to bound how long a signed link stays valid if leaked.
const MEDIA_URL_TTL_SECONDS = 30 * 60;
const ERROR_MESSAGE_MAX_LENGTH = 500;

function truncateErrorMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function absoluteMediaUrl(path: string): string {
  const appUrl = env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  return `${appUrl}${path}`;
}

function buildCaption(clip: { title: string; hookText: string | null }): string {
  return clip.hookText && clip.hookText.trim().length > 0 ? clip.hookText : clip.title;
}

export type FacebookPublishSummary = {
  postsScanned: number;
  postsPublished: number;
  /** Workspace isn't eligible yet (no Page ID, or the go-live flag is off). */
  postsSkippedNotEligible: number;
  /** Clip has no completed export yet — this module never triggers one. */
  postsSkippedNotExported: number;
  postsFailed: number;
};

export type FacebookPublisherDeps = {
  now?: () => Date;
  resolvePageAccessToken?: (pageId: string) => Promise<string>;
  publishScheduledVideo?: (
    input: PublishScheduledVideoInput,
  ) => Promise<{ facebookPostId: string }>;
};

export async function publishDueScheduledPosts(
  client: PrismaClient,
  deps: FacebookPublisherDeps = {},
): Promise<FacebookPublishSummary> {
  const summary: FacebookPublishSummary = {
    postsScanned: 0,
    postsPublished: 0,
    postsSkippedNotEligible: 0,
    postsSkippedNotExported: 0,
    postsFailed: 0,
  };

  // Fail closed, quietly: Tier 3 is entirely unconfigured in this environment.
  if (!env.META_SYSTEM_USER_TOKEN) {
    return summary;
  }

  const now = deps.now ?? (() => new Date());
  const resolvePageAccessToken = deps.resolvePageAccessToken ?? defaultResolvePageAccessToken;
  const publishScheduledVideo = deps.publishScheduledVideo ?? defaultPublishScheduledVideo;

  const duePosts = await client.scheduledPost.findMany({
    where: {
      platform: "FACEBOOK",
      publishStatus: "NOT_STARTED",
      scheduledDate: { lte: now() },
    },
    orderBy: { scheduledDate: "asc" },
    include: {
      workspace: { select: { settings: true } },
      clip: {
        select: {
          title: true,
          hookText: true,
          exportJobs: {
            where: { state: "SUCCEEDED" },
            orderBy: { finishedAt: "desc" },
            take: 1,
            select: { outputFile: { select: { storageKey: true } } },
          },
        },
      },
    },
  });

  summary.postsScanned = duePosts.length;

  for (const post of duePosts) {
    try {
      const churchProfile = parseChurchProfile(post.workspace.settings);
      const facebookConnection = parseFacebookConnection(post.workspace.settings);

      if (!isEligibleForAutoPost(facebookConnection) || !facebookConnection.pageId) {
        summary.postsSkippedNotEligible++;
        continue;
      }
      const pageId = facebookConnection.pageId;

      const exportedStorageKey = post.clip.exportJobs[0]?.outputFile?.storageKey;
      if (!exportedStorageKey) {
        summary.postsSkippedNotExported++;
        continue;
      }

      // Durable claim: only the run that flips NOT_STARTED -> IN_PROGRESS proceeds.
      const claim = await client.scheduledPost.updateMany({
        where: { id: post.id, publishStatus: "NOT_STARTED" },
        data: { publishStatus: "IN_PROGRESS" },
      });
      if (claim.count === 0) continue;

      try {
        const fileUrl = absoluteMediaUrl(
          createSignedMediaUrl({
            key: exportedStorageKey,
            workspaceId: post.workspaceId,
            expiresInSeconds: MEDIA_URL_TTL_SECONDS,
            contentType: "video/mp4",
            disposition: "inline",
          }),
        );
        const desiredPublishAt = wallClockInstantInTimezone(
          post.scheduledDate,
          DEFAULT_POST_HOUR,
          churchProfile.timezone,
        );
        const publishImmediately =
          desiredPublishAt.getTime() - now().getTime() < MIN_SCHEDULE_LEAD_MS;

        const pageAccessToken = await resolvePageAccessToken(pageId);
        const { facebookPostId } = await publishScheduledVideo({
          pageId,
          pageAccessToken,
          fileUrl,
          caption: buildCaption(post.clip),
          scheduledPublishAt: publishImmediately ? undefined : desiredPublishAt,
        });

        await client.scheduledPost.update({
          where: { id: post.id },
          data: {
            publishStatus: "SUCCEEDED",
            facebookPostId,
            publishedAt: publishImmediately ? now() : desiredPublishAt,
            lastErrorMessage: null,
          },
        });
        summary.postsPublished++;
      } catch (error) {
        summary.postsFailed++;
        const message = truncateErrorMessage(errorMessage(error));
        await client.scheduledPost.update({
          where: { id: post.id },
          data: { publishStatus: "FAILED", lastErrorMessage: message },
        });
        await recordOperationalEventSafely(client, {
          workspaceId: post.workspaceId,
          category: "facebook_publish",
          eventType: "facebook_publish_failed",
          severity: "error",
          message: `Facebook scheduled post failed: ${message}`,
          metadata: { scheduledPostId: post.id },
        });
      }
    } catch (error) {
      // Row-level isolation: an unexpected error on one row must never abort the whole poll.
      summary.postsFailed++;
      console.error(
        "[facebook-publisher] unexpected error processing scheduled post",
        post.id,
        errorMessage(error),
      );
    }
  }

  if (summary.postsScanned > 0) {
    await recordOperationalEventSafely(client, {
      category: "facebook_publish",
      eventType: "facebook_publish_poll_ran",
      message: "Facebook publish poll completed.",
      metadata: { ...summary },
    });
  }

  return summary;
}
