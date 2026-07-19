import type { PrismaClient } from "@prisma/client";
import { listRecentUploads, type YouTubeUploadItem } from "@/lib/integrations/youtube";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { createDraftProjectForWorkspace } from "@/lib/project-service";
import { channelImportDailyProjectLimit, checkChannelImportLimit } from "@/lib/rate-limit";

/**
 * Channel auto-import polling (worker-side).
 *
 * `pollDueChannelImportSources` walks every enabled `ChannelImportSource` and turns
 * genuinely-new uploads into draft Projects via `createDraftProjectForWorkspace` — the same
 * URL-import path a manual paste uses (Phase 1), so each import enqueues a QUEUED FINALIZE
 * job and flows through the normal pipeline.
 *
 * Cadence lives in the caller: the worker loop invokes this on `CHANNEL_POLL_INTERVAL_MS`
 * (the same timestamp-comparison pattern as the retention cleanup scan), so "due" here means
 * "enabled" — this module does not re-implement scheduling.
 *
 * New-video rules (confirmed decisions; see docs/AUTO_IMPORT_LOOP.md):
 * - The cutoff is `lastPolledAt`, or `registeredAt` for a never-polled source — only videos
 *   published strictly after the cutoff are candidates. A fresh registration is never
 *   bulk-backfilled.
 * - Candidates already recorded in `channel_imported_videos` as `"imported"` or `"failed"` are
 *   skipped (row-level dedup), which also covers videos published mid-poll that straddle the
 *   next cutoff. `"failed"` is terminal — not retried; the error lands on the source's
 *   `lastPollErrorMessage` where the settings UI can surface it.
 * - Every processed candidate gets exactly one `ChannelImportedVideo` row: `"imported"` with
 *   the created project id, `"failed"`, or `"skipped_cap"` when the workspace's daily import
 *   cap (`checkChannelImportLimit`) is hit. `"skipped_cap"` is pacing, not an outcome: the row
 *   is retryable, and the next poll lowers its listing cutoff to just before the oldest
 *   pending skip so the video re-enters the candidate list (title fresh from the API) and
 *   imports once the rolling 24h window has room. Lowering the cutoff can never reintroduce
 *   backfill: a skipped_cap row only ever exists for a video that was strictly newer than some
 *   earlier cutoff (>= registeredAt), so the effective cutoff never drops below registration.
 *
 * Error isolation: any per-source failure (the YouTube API call or an unexpected DB error)
 * marks that source (`lastPollErrorAt`/`lastPollErrorMessage`) and moves on — it never
 * aborts the run for the other sources. A fully clean poll clears both error fields so they
 * always describe the most recent poll's health.
 *
 * Testability: the YouTube client is injectable (`listUploads`), the same trust boundary as
 * the injected fetch in youtube.ts — tests never call googleapis.com. `now` is injectable so
 * tests can roll the cap window forward.
 *
 * Operational events (`category: "channel_import"`, all recorded via the *Safely helper so
 * observability can never break polling), with severities chosen deliberately — only "error"
 * emails the operator (alerts.ts), and nothing here is error-worthy:
 * - `channel_poll_ran` (info): once per run when any enabled source exists — the liveness
 *   signal for the runbook — carrying the run summary as metadata.
 * - `channel_import_created` (info): one per project auto-created from an upload.
 * - `channel_import_skipped_cap` (warning): once per source-poll when videos are *newly*
 *   deferred by the daily cap — a nudge that `CHANNEL_IMPORT_DAILY_LIMIT` may be too low.
 *   Re-deferrals on later polls stay silent so a capped source doesn't warn every 45 minutes.
 * - `channel_poll_failed` (warning, not error): a single source's failed poll self-heals on
 *   the next cycle and is durably recorded on the source row where the settings UI shows it.
 */

export type ListUploads = (
  playlistId: string,
  options: { after?: Date },
) => Promise<YouTubeUploadItem[]>;

export type ChannelPollerDeps = {
  listUploads?: ListUploads;
  now?: () => Date;
};

export type ChannelPollSummary = {
  /** Sources whose upload list was fetched and processed (even if some videos failed). */
  sourcesPolled: number;
  /** Sources whose poll aborted before completing (e.g. the YouTube API call failed). */
  sourcesFailed: number;
  videosImported: number;
  videosFailed: number;
  /** Videos deferred by the daily import cap this poll (retried on a later poll). */
  videosSkippedCap: number;
};

const ERROR_MESSAGE_MAX_LENGTH = 500;

function truncateErrorMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

type PollableSource = {
  id: string;
  workspaceId: string;
  channelTitle: string;
  uploadsPlaylistId: string;
  registeredAt: Date;
  lastPolledAt: Date | null;
  workspace: { ownerId: string };
};

export async function pollDueChannelImportSources(
  client: PrismaClient,
  deps: ChannelPollerDeps = {},
): Promise<ChannelPollSummary> {
  const listUploads: ListUploads =
    deps.listUploads ?? ((playlistId, options) => listRecentUploads(playlistId, options));
  const now = deps.now ?? (() => new Date());

  const sources = await client.channelImportSource.findMany({
    where: { enabled: true },
    include: { workspace: { select: { ownerId: true } } },
    orderBy: { registeredAt: "asc" },
  });

  const summary: ChannelPollSummary = {
    sourcesPolled: 0,
    sourcesFailed: 0,
    videosImported: 0,
    videosFailed: 0,
    videosSkippedCap: 0,
  };

  for (const source of sources) {
    // Captured before the API call: a video published while the poll runs may land on either
    // side of this instant, which is exactly why the row-level dedup also exists.
    const polledAt = now();
    try {
      const result = await pollOneSource(client, source, polledAt, listUploads);
      summary.sourcesPolled++;
      summary.videosImported += result.videosImported;
      summary.videosFailed += result.videosFailed;
      summary.videosSkippedCap += result.videosSkippedCap;
    } catch (error) {
      // A source deleted while its poll ran (workspace removed, registration deleted) is not
      // a failure — there is no row left to mark and nobody left to notify. Only skip when the
      // row is provably gone; if the existence check itself errors, treat it as a real failure.
      let stillExists = true;
      try {
        stillExists =
          (await client.channelImportSource.findUnique({
            where: { id: source.id },
            select: { id: true },
          })) !== null;
      } catch {
        // Keep stillExists = true: an unreachable database is a failure, not a deletion.
      }
      if (!stillExists) continue;

      // Per-source isolation: record the failure on this source and keep polling the rest.
      summary.sourcesFailed++;
      try {
        await client.channelImportSource.update({
          where: { id: source.id },
          data: {
            lastPollErrorAt: polledAt,
            lastPollErrorMessage: truncateErrorMessage(errorMessage(error)),
          },
        });
      } catch (updateError) {
        console.error(
          "[channel-poller] failed to record poll error for source",
          source.id,
          errorMessage(updateError),
        );
      }
      // Warning, not error: one source's failed poll self-heals next cycle; the durable
      // record lives on the source row where /app/settings/imports surfaces it.
      await recordOperationalEventSafely(client, {
        workspaceId: source.workspaceId,
        category: "channel_import",
        eventType: "channel_poll_failed",
        severity: "warning",
        message: `Polling ${source.channelTitle} failed: ${truncateErrorMessage(errorMessage(error))}`,
        metadata: { channelImportSourceId: source.id, channelTitle: source.channelTitle },
      });
    }
  }

  if (sources.length > 0) {
    // Liveness signal (workspace-agnostic — one poll run spans every registered workspace).
    await recordOperationalEventSafely(client, {
      category: "channel_import",
      eventType: "channel_poll_ran",
      message: "Channel import poll completed.",
      metadata: { ...summary },
    });
  }

  return summary;
}

async function pollOneSource(
  client: PrismaClient,
  source: PollableSource,
  polledAt: Date,
  listUploads: ListUploads,
): Promise<{ videosImported: number; videosFailed: number; videosSkippedCap: number }> {
  const baseCutoff = source.lastPolledAt ?? source.registeredAt;

  // Pending over-cap skips are retryable: lower the listing cutoff to just before the oldest
  // pending skip so those videos re-enter the candidate list (title fresh from the API). This
  // never reintroduces backfill — a skipped_cap row only exists for a video strictly newer
  // than some earlier cutoff (>= registeredAt), so the effective cutoff stays >= registration.
  const oldestPendingSkip = await client.channelImportedVideo.findFirst({
    where: { channelImportSourceId: source.id, status: "skipped_cap" },
    orderBy: { publishedAt: "asc" },
    select: { publishedAt: true },
  });
  const cutoff = new Date(
    oldestPendingSkip
      ? Math.min(baseCutoff.getTime(), oldestPendingSkip.publishedAt.getTime() - 1)
      : baseCutoff.getTime(),
  );
  const uploads = await listUploads(source.uploadsPlaylistId, { after: cutoff });

  // Re-apply the cutoff defensively (the real client already filters by `after`) so the
  // no-backfill rule never depends on the injected client honoring the option.
  const candidates = uploads.filter((upload) => upload.publishedAt.getTime() > cutoff.getTime());

  const seenRows = candidates.length
    ? await client.channelImportedVideo.findMany({
        where: {
          channelImportSourceId: source.id,
          platformVideoId: { in: candidates.map((candidate) => candidate.videoId) },
        },
        select: { platformVideoId: true, status: true },
      })
    : [];
  // "skipped_cap" rows are NOT done — they must be retried; only imported/failed are final.
  const done = new Set(
    seenRows.filter((row) => row.status !== "skipped_cap").map((row) => row.platformVideoId),
  );
  const previouslySkipped = new Set(
    seenRows.filter((row) => row.status === "skipped_cap").map((row) => row.platformVideoId),
  );

  // Import oldest-first so project creation order matches publication order.
  const freshVideos = candidates
    .filter((candidate) => !done.has(candidate.videoId))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

  let videosImported = 0;
  let videosSkippedCap = 0;
  const newlySkippedVideoIds: string[] = [];
  const videoFailures: string[] = [];
  // Once the cap is hit it stays hit for this poll (the imported-count only grows), so the
  // remaining, newer videos skip without re-querying.
  let overCap = false;
  for (const video of freshVideos) {
    const uniqueWhere = {
      channelImportSourceId_platformVideoId: {
        channelImportSourceId: source.id,
        platformVideoId: video.videoId,
      },
    };

    if (!overCap) {
      const decision = await checkChannelImportLimit(client, source.workspaceId, polledAt);
      overCap = !decision.allowed;
    }
    if (overCap) {
      videosSkippedCap++;
      if (!previouslySkipped.has(video.videoId)) {
        newlySkippedVideoIds.push(video.videoId);
      }
      try {
        // Upsert: the video may already carry a skipped_cap row from an earlier capped poll.
        await client.channelImportedVideo.upsert({
          where: uniqueWhere,
          update: {},
          create: {
            channelImportSourceId: source.id,
            platformVideoId: video.videoId,
            publishedAt: video.publishedAt,
            status: "skipped_cap",
          },
        });
      } catch (recordError) {
        console.error(
          "[channel-poller] failed to record skipped_cap video for source",
          source.id,
          errorMessage(recordError),
        );
      }
      continue;
    }

    try {
      const project = await createDraftProjectForWorkspace(
        client,
        source.workspaceId,
        { name: video.title, sourceUrl: youtubeWatchUrl(video.videoId), publishedAt: video.publishedAt },
        source.workspace.ownerId,
      );
      // Upserts (not creates): a retried skipped_cap row transitions in place to its outcome.
      await client.channelImportedVideo.upsert({
        where: uniqueWhere,
        update: { status: "imported", projectId: project.id },
        create: {
          channelImportSourceId: source.id,
          platformVideoId: video.videoId,
          projectId: project.id,
          publishedAt: video.publishedAt,
          status: "imported",
        },
      });
      videosImported++;
      await recordOperationalEventSafely(client, {
        workspaceId: source.workspaceId,
        category: "channel_import",
        eventType: "channel_import_created",
        message: `Imported "${video.title}" from ${source.channelTitle}.`,
        projectId: project.id,
        metadata: {
          channelImportSourceId: source.id,
          channelTitle: source.channelTitle,
          videoId: video.videoId,
          publishedAt: video.publishedAt.toISOString(),
        },
      });
    } catch (error) {
      videoFailures.push(`${video.videoId}: ${errorMessage(error)}`);
      try {
        await client.channelImportedVideo.upsert({
          where: uniqueWhere,
          update: { status: "failed" },
          create: {
            channelImportSourceId: source.id,
            platformVideoId: video.videoId,
            publishedAt: video.publishedAt,
            status: "failed",
          },
        });
      } catch (recordError) {
        console.error(
          "[channel-poller] failed to record failed video for source",
          source.id,
          errorMessage(recordError),
        );
      }
    }
  }

  if (newlySkippedVideoIds.length > 0) {
    // One aggregate event per source-poll, and only for *newly* deferred videos — a capped
    // source retrying every cycle must not warn every 45 minutes.
    await recordOperationalEventSafely(client, {
      workspaceId: source.workspaceId,
      category: "channel_import",
      eventType: "channel_import_skipped_cap",
      severity: "warning",
      message: `Daily import cap deferred ${newlySkippedVideoIds.length} upload(s) from ${source.channelTitle} — they retry on a later poll.`,
      metadata: {
        channelImportSourceId: source.id,
        channelTitle: source.channelTitle,
        videoIds: newlySkippedVideoIds,
        deferredThisPoll: videosSkippedCap,
        limit: channelImportDailyProjectLimit(),
      },
    });
  }

  // The poll itself succeeded (we saw the upload list), so advance the cutoff even when
  // individual videos failed or were deferred — "failed" rows are terminal; "skipped_cap"
  // rows re-enter via the pending-skip cutoff lowering above. Cap skips are pacing, not
  // errors, so they never touch lastPollErrorAt/lastPollErrorMessage.
  await client.channelImportSource.update({
    where: { id: source.id },
    data: {
      lastPolledAt: polledAt,
      ...(videoFailures.length > 0
        ? {
            lastPollErrorAt: polledAt,
            lastPollErrorMessage: truncateErrorMessage(videoFailures.join("; ")),
          }
        : { lastPollErrorAt: null, lastPollErrorMessage: null }),
    },
  });

  return { videosImported, videosFailed: videoFailures.length, videosSkippedCap };
}
