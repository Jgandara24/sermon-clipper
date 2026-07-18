import type { PrismaClient } from "@prisma/client";
import { listRecentUploads, type YouTubeUploadItem } from "@/lib/integrations/youtube";
import { createDraftProjectForWorkspace } from "@/lib/project-service";

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
 * - Candidates already recorded in `channel_imported_videos` are skipped (row-level dedup),
 *   which also covers videos published mid-poll that straddle the next cutoff.
 * - Every processed candidate gets exactly one `ChannelImportedVideo` row: `"imported"` with
 *   the created project id, or `"failed"` (terminal — not retried; the error lands on the
 *   source's `lastPollErrorMessage` where the settings UI can surface it).
 *
 * Error isolation: any per-source failure (the YouTube API call or an unexpected DB error)
 * marks that source (`lastPollErrorAt`/`lastPollErrorMessage`) and moves on — it never
 * aborts the run for the other sources. A fully clean poll clears both error fields so they
 * always describe the most recent poll's health.
 *
 * Testability: the YouTube client is injectable (`listUploads`), the same trust boundary as
 * the injected fetch in youtube.ts — tests never call googleapis.com. Operational events and
 * rate limits are Phase 4; this module intentionally emits none yet.
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
    } catch (error) {
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
    }
  }

  return summary;
}

async function pollOneSource(
  client: PrismaClient,
  source: PollableSource,
  polledAt: Date,
  listUploads: ListUploads,
): Promise<{ videosImported: number; videosFailed: number }> {
  const cutoff = source.lastPolledAt ?? source.registeredAt;
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
        select: { platformVideoId: true },
      })
    : [];
  const seen = new Set(seenRows.map((row) => row.platformVideoId));

  // Import oldest-first so project creation order matches publication order.
  const freshVideos = candidates
    .filter((candidate) => !seen.has(candidate.videoId))
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

  let videosImported = 0;
  const videoFailures: string[] = [];
  for (const video of freshVideos) {
    try {
      const project = await createDraftProjectForWorkspace(
        client,
        source.workspaceId,
        { name: video.title, sourceUrl: youtubeWatchUrl(video.videoId) },
        source.workspace.ownerId,
      );
      await client.channelImportedVideo.create({
        data: {
          channelImportSourceId: source.id,
          platformVideoId: video.videoId,
          projectId: project.id,
          publishedAt: video.publishedAt,
          status: "imported",
        },
      });
      videosImported++;
    } catch (error) {
      videoFailures.push(`${video.videoId}: ${errorMessage(error)}`);
      try {
        await client.channelImportedVideo.create({
          data: {
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

  // The poll itself succeeded (we saw the upload list), so advance the cutoff even when
  // individual videos failed — "failed" rows are terminal, not retried on the next poll.
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

  return { videosImported, videosFailed: videoFailures.length };
}
