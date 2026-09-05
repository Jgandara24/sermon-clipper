import type { PrismaClient } from "@prisma/client";
import { parseChurchProfile, wallClockInstantInTimezone } from "@/lib/church-profile";
import { env } from "@/lib/env";
import { decideWorkspaceAccess } from "@/lib/billing/access";
import { describeDeliveryIneligibility } from "@/lib/delivery/eligibility";
import {
  classifyPublishFailure,
  hasUnsettledPublishIntent,
  INDETERMINATE_PUBLISH_EXCEPTION,
  INDETERMINATE_PUBLISH_MESSAGE,
  recordPublishIntent,
  settlePublishAttempt,
} from "@/lib/delivery/publish-attempts";
import { assessScheduledPostDelivery } from "@/lib/delivery/query";
import { isEligibleForAutoPost, parseFacebookConnection } from "@/lib/facebook-connection";
import {
  publishScheduledVideo as defaultPublishScheduledVideo,
  resolvePageAccessToken as defaultResolvePageAccessToken,
  type PublishScheduledVideoInput,
} from "@/lib/integrations/facebook";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { projectsHeldForTranscriptionFallback } from "@/lib/transcription/fallback-hold";

/**
 * Tier 3 publish poller (docs/BUSINESS_OVERVIEW.md, worker-side).
 *
 * Scans every due, unposted ScheduledPost across all workspaces and — only for a workspace
 * that has both a configured Facebook Page ID and its explicit `facebookAutoPostEnabled`
 * go-live flag set (DECISIONS.md, "Tier 3 Freeze Lifted") — publishes it as a scheduled,
 * unpublished Facebook video post via the Meta Graph API.
 *
 * Fails closed at four independent layers, same discipline as the rest of this codebase's
 * integrations: the exact global AUTOMATIC_PUBLISHING_ENABLED=true switch is required; no
 * META_SYSTEM_USER_TOKEN means the whole poll is a no-op; a workspace without the go-live flag is
 * skipped per-row; a clip with no completed export is skipped per-row (this module never triggers
 * an export itself — a human still reviews/exports clips through the normal flow before Tier 3 can
 * post them).
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
// Transient failures (network blips, momentary API errors) re-queue with backoff; FAILED is
// reserved for attempts exhausted. Backoff: 5min, 30min, 2h, then 8h before the final attempt.
const MAX_PUBLISH_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];

function retryBackoffMs(attemptCount: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}
// Long enough for Facebook's servers to fetch the file after the scheduling request, short
// enough to bound how long a signed link stays valid if leaked.
const MEDIA_URL_TTL_SECONDS = 30 * 60;

// One event is enough to make the process state visible. An enabled call resets the latch so a
// later disabled period produces a new event. The promise also coalesces concurrent disabled calls.
let publishingDisabledEvent: Promise<void> | null = null;

function reportPublishingDisabled(client: PrismaClient): Promise<void> {
  if (!publishingDisabledEvent) {
    publishingDisabledEvent = recordOperationalEventSafely(client, {
      category: "facebook_publish",
      eventType: "automatic_publishing_disabled",
      message:
        "Automatic publishing is disabled by the global AUTOMATIC_PUBLISHING_ENABLED switch.",
      metadata: { automaticPublishingEnabled: false },
    }).then(() => undefined);
  }
  return publishingDisabledEvent;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Meta downloads file_url asynchronously AFTER the POST returns an id — a localhost or
 * missing app URL would mark rows SUCCEEDED while the video silently never materializes.
 * Publishing is skipped entirely (rows left NOT_STARTED) until the URL is configured.
 */
function resolvePublicAppUrl(): string | null {
  const appUrl = env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(appUrl)) return null;
  return appUrl;
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
  /** NEXT_PUBLIC_APP_URL is unset or localhost — Meta could never fetch file_url. */
  postsSkippedMisconfigured: number;
  postsFailed: number;
  /** Outcomes nobody could read. Each left a BLOCKED slot and an open exception. */
  postsIndeterminate: number;
};

export type FacebookPublisherDeps = {
  now?: () => Date;
  resolvePageAccessToken?: (pageId: string) => Promise<string>;
  publishScheduledVideo?: (
    input: PublishScheduledVideoInput,
  ) => Promise<{ facebookPostId: string }>;
  /**
   * The delivery decision, defaulting to the real module. Injectable only so tests for the
   * clamp, retry and misconfiguration paths can reach the code past it: until P2 records
   * editorial reviews, the real rule refuses every slot, and that is deliberate. Nothing in
   * production passes this — the default is the single authority.
   */
  assessDelivery?: typeof assessScheduledPostDelivery;
};

// A claim older than this with no terminal update means the worker died mid-publish
// (same recovery idea as recoverStaleProcessingJobs; @updatedAt stamps the claim time).
const STALE_CLAIM_TIMEOUT_MS = 15 * 60_000;

/**
 * Re-queues scheduled posts stuck IN_PROGRESS by a worker that died between the claim and
 * the terminal update. Counts as an attempt (so a poison post still terminates after
 * MAX_PUBLISH_ATTEMPTS — exhausted rows fail terminally here, mirroring stale job recovery).
 */
export async function recoverStaleScheduledPosts(
  client: PrismaClient,
  now = new Date(),
): Promise<{ recovered: number; failed: number; blocked: number }> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_TIMEOUT_MS);
  const staleRows = await client.scheduledPost.findMany({
    where: { publishStatus: "IN_PROGRESS", updatedAt: { lt: cutoff } },
    take: 25,
    select: { id: true, workspaceId: true, attemptCount: true },
  });

  let recovered = 0;
  let failed = 0;
  let blocked = 0;
  for (const row of staleRows) {
    // Reconcile against intent before deciding. An unsettled INTENT row means a provider call was
    // started and this process never learned how it ended, so a post may already exist on the
    // Page. Re-queueing that is how a church gets posted to twice — the previous version did
    // exactly that, because it had no way to tell the two cases apart. Only a slot with no
    // unsettled intent died before dialling and is safe to retry.
    if (await hasUnsettledPublishIntent(client, row.id)) {
      const stopped = await client.scheduledPost.updateMany({
        where: { id: row.id, publishStatus: "IN_PROGRESS", updatedAt: { lt: cutoff } },
        data: {
          publishStatus: "BLOCKED",
          nextAttemptAt: null,
          lastErrorMessage: INDETERMINATE_PUBLISH_MESSAGE,
        },
      });
      if (stopped.count === 0) continue;
      blocked++;
      await client.editorialException.create({
        data: {
          workspaceId: row.workspaceId,
          scheduledPostId: row.id,
          exceptionType: INDETERMINATE_PUBLISH_EXCEPTION,
          message: INDETERMINATE_PUBLISH_MESSAGE,
          metadata: { recoveredFrom: "stale_claim", attemptCount: row.attemptCount },
        },
      });
      await recordOperationalEventSafely(client, {
        workspaceId: row.workspaceId,
        category: "facebook_publish",
        eventType: "facebook_publish_indeterminate",
        severity: "error",
        message:
          "A publish attempt was interrupted after the Facebook call had started. The slot is blocked until someone checks the Page.",
        metadata: { scheduledPostId: row.id, recoveredFrom: "stale_claim" },
      });
      continue;
    }

    const attemptCount = row.attemptCount + 1;
    const exhausted = attemptCount >= MAX_PUBLISH_ATTEMPTS;
    const result = await client.scheduledPost.updateMany({
      // Re-check the stale condition so a concurrent terminal update wins the race.
      where: { id: row.id, publishStatus: "IN_PROGRESS", updatedAt: { lt: cutoff } },
      data: exhausted
        ? {
            publishStatus: "FAILED",
            attemptCount,
            nextAttemptAt: null,
            lastErrorMessage: "Publish attempt was interrupted repeatedly and gave up.",
          }
        : {
            publishStatus: "NOT_STARTED",
            attemptCount,
            nextAttemptAt: null,
            lastErrorMessage: "Publish attempt was interrupted (worker restart) and was re-queued.",
          },
    });
    if (result.count === 0) continue;
    if (exhausted) failed++;
    else recovered++;
    await recordOperationalEventSafely(client, {
      workspaceId: row.workspaceId,
      category: "facebook_publish",
      eventType: exhausted ? "facebook_publish_failed" : "facebook_publish_claim_recovered",
      severity: exhausted ? "error" : "warning",
      message: exhausted
        ? `Facebook scheduled post failed permanently after ${attemptCount} interrupted attempts.`
        : "Facebook scheduled post claim was stale and was re-queued.",
      metadata: { scheduledPostId: row.id, attemptCount },
    });
  }

  return { recovered, failed, blocked };
}

export async function publishDueScheduledPosts(
  client: PrismaClient,
  deps: FacebookPublisherDeps = {},
): Promise<FacebookPublishSummary> {
  const summary: FacebookPublishSummary = {
    postsScanned: 0,
    postsPublished: 0,
    postsSkippedNotEligible: 0,
    postsSkippedNotExported: 0,
    postsSkippedMisconfigured: 0,
    postsFailed: 0,
    postsIndeterminate: 0,
  };

  // This is the authoritative publish gate. Scripts and direct callers cannot bypass it. No due
  // row is inspected or claimed before the exact positive-enable value is present.
  if (!env.AUTOMATIC_PUBLISHING_ENABLED) {
    await reportPublishingDisabled(client);
    return summary;
  }
  publishingDisabledEvent = null;

  // Fail closed, quietly: Tier 3 is entirely unconfigured in this environment.
  if (!env.META_SYSTEM_USER_TOKEN) {
    return summary;
  }

  const now = deps.now ?? (() => new Date());
  const resolvePageAccessToken = deps.resolvePageAccessToken ?? defaultResolvePageAccessToken;
  const publishScheduledVideo = deps.publishScheduledVideo ?? defaultPublishScheduledVideo;
  const assessDelivery = deps.assessDelivery ?? assessScheduledPostDelivery;

  const duePosts = await client.scheduledPost.findMany({
    where: {
      platform: "FACEBOOK",
      publishStatus: "NOT_STARTED",
      scheduledDate: { lte: now() },
      // Detached history rows (clip regenerated after publish) are never publishable.
      clipId: { not: null },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now() } }],
    },
    orderBy: { scheduledDate: "asc" },
    include: {
      workspace: {
        select: {
          settings: true,
          accessPlan: true,
          trialStartedAt: true,
          trialEndsAt: true,
          paidAt: true,
        },
      },
      clip: {
        select: {
          projectId: true,
          title: true,
          hookText: true,
        },
      },
      // The export this slot is bound to, and only that one. This replaced a lookup for the
      // clip's most recently finished SUCCEEDED export, which could hand the publisher a render
      // of a cut nobody reviewed — the "latest successful export" path Rev2 §6 forbids. There is
      // deliberately no ordering and no fallback here: if the binding is absent, nothing posts.
      exportJob: { select: { outputFile: { select: { storageKey: true } } } },
    },
  });

  summary.postsScanned = duePosts.length;

  // A transcript the configured primary provider did not produce degrades exactly what a
  // published clip shows: caption text and word timing. Those clips stay visible and editable,
  // but only a person decides whether they leave for an audience. One query for the whole batch.
  const heldProjectIds = await projectsHeldForTranscriptionFallback(
    client,
    duePosts.map((post) => post.clip?.projectId).filter((id): id is string => Boolean(id)),
  );

  const appUrl = resolvePublicAppUrl();
  if (!appUrl) {
    summary.postsSkippedMisconfigured = duePosts.length;
    if (duePosts.length > 0) {
      await recordOperationalEventSafely(client, {
        category: "facebook_publish",
        eventType: "facebook_publish_misconfigured",
        severity: "error",
        message:
          "Facebook publishing skipped: NEXT_PUBLIC_APP_URL is unset or points at localhost, so Meta could never fetch the video. Due posts were left queued.",
        metadata: { duePosts: duePosts.length },
      });
    }
    return summary;
  }

  for (const post of duePosts) {
    try {
      if (!decideWorkspaceAccess(post.workspace, "publish_post", now()).allowed) {
        summary.postsSkippedNotEligible++;
        continue;
      }
      const churchProfile = parseChurchProfile(post.workspace.settings);
      const facebookConnection = parseFacebookConnection(post.workspace.settings);

      if (!isEligibleForAutoPost(facebookConnection) || !facebookConnection.pageId) {
        summary.postsSkippedNotEligible++;
        continue;
      }
      const pageId = facebookConnection.pageId;

      // The due query filters clipId NOT NULL; this narrows the type and defends in depth.
      const clip = post.clip;
      if (!clip) {
        continue;
      }

      if (clip.projectId && heldProjectIds.has(clip.projectId)) {
        summary.postsSkippedNotEligible++;
        await recordOperationalEventSafely(client, {
          workspaceId: post.workspaceId,
          category: "facebook_publish",
          eventType: "facebook_publish_skipped_transcription_hold",
          severity: "warning",
          message:
            "This clip was not published automatically: its sermon was transcribed by the backup provider, so it is waiting for a person to check it.",
          projectId: clip.projectId,
          metadata: { scheduledPostId: post.id },
        });
        continue;
      }

      // One module decides whether this slot may reach an audience. It re-reads the slot's own
      // facts rather than trusting the batch query above, so the decision is made against the
      // state at the moment of publishing, and so the rule has exactly one implementation.
      //
      // Workspace billing access and the transcription hold stay outside it, above: neither is a
      // fact about whether this render is the right render, and folding billing into a pure
      // delivery rule would make it depend on plan state.
      const eligibility = await assessDelivery(client, { scheduledPostId: post.id });
      if (!eligibility || !eligibility.eligible) {
        summary.postsSkippedNotEligible++;
        await recordOperationalEventSafely(client, {
          workspaceId: post.workspaceId,
          category: "facebook_publish",
          eventType: "facebook_publish_ineligible",
          severity: "warning",
          message: eligibility
            ? describeDeliveryIneligibility(eligibility.reason)
            : "The scheduled post disappeared between being read and being checked.",
          projectId: clip.projectId,
          metadata: {
            scheduledPostId: post.id,
            reason: eligibility ? eligibility.reason : "slot_missing",
          },
        });
        continue;
      }

      const exportedStorageKey = post.exportJob?.outputFile?.storageKey;
      if (!exportedStorageKey) {
        summary.postsSkippedNotExported++;
        continue;
      }

      // Durable claim, bound to the exact intent the eligibility decision was made about: this
      // slot, still holding this clip and this export, still NOT_STARTED. Claiming on the id
      // alone left a replacement race — a reserve swapped into the slot between the decision and
      // the claim would be published against a verdict that was never about it.
      const claim = await client.scheduledPost.updateMany({
        where: {
          id: post.id,
          publishStatus: "NOT_STARTED",
          clipId: post.clipId,
          exportJobId: post.exportJobId,
        },
        data: { publishStatus: "IN_PROGRESS" },
      });
      if (claim.count === 0) continue;

      // Intent before side effect. Written after the claim and before the provider call, so a
      // process that dies mid-publish leaves proof that a call may have gone out.
      const attemptId = await recordPublishIntent(client, {
        scheduledPostId: post.id,
        expectedClipId: post.clipId,
        expectedExportJobId: post.exportJobId,
        now: now(),
      });

      try {
        const fileUrl = `${appUrl}${createSignedMediaUrl({
          key: exportedStorageKey,
          workspaceId: post.workspaceId,
          expiresInSeconds: MEDIA_URL_TTL_SECONDS,
          contentType: "video/mp4",
          disposition: "inline",
        })}`;
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
          caption: buildCaption(clip),
          scheduledPublishAt: publishImmediately ? undefined : desiredPublishAt,
        });

        await settlePublishAttempt(client, {
          attemptId,
          outcome: { kind: "succeeded", providerPostId: facebookPostId },
          now: now(),
        });
        await client.scheduledPost.update({
          where: { id: post.id },
          data: {
            publishStatus: "SUCCEEDED",
            facebookPostId,
            publishedAt: publishImmediately ? now() : desiredPublishAt,
            lastErrorMessage: null,
            nextAttemptAt: null,
          },
        });
        summary.postsPublished++;
      } catch (error) {
        const outcome = classifyPublishFailure(error);
        await settlePublishAttempt(client, { attemptId, outcome, now: now() });

        // An outcome nobody can read is not a failure to retry. A post may exist on the Page, and
        // the retry ladder would publish a second one. The slot stops here, in BLOCKED, with an
        // open exception, until a person has looked.
        if (outcome.kind === "indeterminate") {
          summary.postsIndeterminate++;
          await client.scheduledPost.update({
            where: { id: post.id },
            data: {
              publishStatus: "BLOCKED",
              lastErrorMessage: outcome.errorMessage,
              // Deliberately not advanced: this is not an attempt that failed, and it must never
              // come back round through the backoff ladder.
              nextAttemptAt: null,
            },
          });
          await client.editorialException.create({
            data: {
              workspaceId: post.workspaceId,
              projectId: clip.projectId,
              scheduledPostId: post.id,
              exceptionType: INDETERMINATE_PUBLISH_EXCEPTION,
              message: INDETERMINATE_PUBLISH_MESSAGE,
              slotSnapshot: {
                scheduledDate: post.scheduledDate.toISOString().slice(0, 10),
                clipId: post.clipId,
                exportJobId: post.exportJobId,
              },
              metadata: { errorCode: outcome.errorCode, errorMessage: outcome.errorMessage },
            },
          });
          await recordOperationalEventSafely(client, {
            workspaceId: post.workspaceId,
            category: "facebook_publish",
            eventType: "facebook_publish_indeterminate",
            severity: "error",
            message: `Facebook publish outcome is unknown and will not be retried: ${outcome.errorMessage}`,
            projectId: clip.projectId,
            metadata: {
              scheduledPostId: post.id,
              errorCode: outcome.errorCode,
              publishAttemptId: attemptId,
            },
          });
          continue;
        }

        summary.postsFailed++;
        const message = outcome.errorMessage;
        const attemptCount = post.attemptCount + 1;
        const exhausted = attemptCount >= MAX_PUBLISH_ATTEMPTS;
        await client.scheduledPost.update({
          where: { id: post.id },
          data: exhausted
            ? { publishStatus: "FAILED", lastErrorMessage: message, attemptCount, nextAttemptAt: null }
            : {
                // Back to NOT_STARTED so the next poll past nextAttemptAt re-claims it.
                publishStatus: "NOT_STARTED",
                lastErrorMessage: message,
                attemptCount,
                nextAttemptAt: new Date(now().getTime() + retryBackoffMs(attemptCount)),
              },
        });
        await recordOperationalEventSafely(client, {
          workspaceId: post.workspaceId,
          category: "facebook_publish",
          eventType: exhausted ? "facebook_publish_failed" : "facebook_publish_retrying",
          severity: exhausted ? "error" : "warning",
          message: exhausted
            ? `Facebook scheduled post failed permanently after ${attemptCount} attempts: ${message}`
            : `Facebook scheduled post attempt ${attemptCount} failed, will retry: ${message}`,
          metadata: { scheduledPostId: post.id, attemptCount, willRetry: !exhausted },
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
