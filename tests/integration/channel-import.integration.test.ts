import {
  AuthProvider,
  PrismaClient,
  ProcessingJobType,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { registerChannelImportSource } from "@/lib/channel-import-service";
import {
  pollDueChannelImportSources,
  youtubeWatchUrl,
  type ListUploads,
} from "@/lib/integrations/channel-poller";
import type { YouTubeChannel, YouTubeUploadItem } from "@/lib/integrations/youtube";

/**
 * Phase 3 polling loop, end to end against a real database with an injected YouTube client
 * (the only fake — the same trust boundary as the unit tests' injected fetch):
 *
 * - First poll imports exactly one project + one ChannelImportedVideo row per new video.
 * - A second poll over the *identical* upload list imports nothing (dedup proof).
 * - A video published before registration is never imported (no-backfill rule).
 * - A failing source records lastPollErrorAt/lastPollErrorMessage without blocking a healthy
 *   source polled in the same run.
 *
 * Integration suites run in parallel against a shared database and the poller walks every
 * enabled source, so per-video assertions are exact but scoped to this file's own sources,
 * while `sourcesPolled` is asserted as a lower bound (other suites' sources yield zero
 * uploads from the injected client and are otherwise unaffected).
 */

const prisma = new PrismaClient();

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Unique per test run so reruns never collide with leftover rows. */
function uniqueChannelId() {
  const suffix = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return `UCpolltest00${suffix}`.slice(0, 24);
}

function fakeResolver(channelId: string, title: string): () => Promise<YouTubeChannel> {
  return async () => ({
    channelId,
    title,
    handle: null,
    uploadsPlaylistId: `UU${channelId.slice(2)}`,
  });
}

async function createWorkspace(label: string) {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey(label)}@example.com`, authProvider: AuthProvider.DEV },
  });
  createdUserIds.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: label, ownerId: user.id } });
  createdWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });
  return workspace.id;
}

function upload(videoId: string, title: string, publishedAt: Date): YouTubeUploadItem {
  return { videoId, title, publishedAt };
}

/** Injected client scoped to specific playlists; every other source sees an empty list. */
function uploadsForPlaylists(lists: Record<string, YouTubeUploadItem[]>): ListUploads {
  return async (playlistId) => lists[playlistId] ?? [];
}

afterAll(async () => {
  // channel_import_sources (and their imported-video rows) cascade with their workspaces.
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("pollDueChannelImportSources", () => {
  it("imports each new video exactly once, never backfills, and dedups an identical second poll", async () => {
    const workspaceId = await createWorkspace("Channel Poll Dedup");
    const channelId = uniqueChannelId();
    const source = await registerChannelImportSource(
      prisma,
      workspaceId,
      channelId,
      fakeResolver(channelId, "Dedup Church"),
    );

    const registeredAt = source.registeredAt.getTime();
    const uploads = [
      // Newest first, like the real playlistItems.list response.
      upload("vidnew2", "Sunday Sermon Part 2", new Date(registeredAt + 2_000)),
      upload("vidnew1", "Sunday Sermon Part 1", new Date(registeredAt + 1_000)),
      // Published before registration — must never be imported (no bulk backfill). The fake
      // ignores the `after` option on purpose so this exercises the poller's own cutoff.
      upload("vidold1", "Pre-registration Sermon", new Date(registeredAt - 3_600_000)),
    ];
    const listUploads = uploadsForPlaylists({ [source.uploadsPlaylistId]: uploads });

    const firstPass = await pollDueChannelImportSources(prisma, { listUploads });
    expect(firstPass.videosImported).toBe(2);
    expect(firstPass.videosFailed).toBe(0);
    expect(firstPass.sourcesFailed).toBe(0);
    expect(firstPass.sourcesPolled).toBeGreaterThanOrEqual(1);

    // Exactly one row per new video, none for the pre-registration video.
    const rows = await prisma.channelImportedVideo.findMany({
      where: { channelImportSourceId: source.id },
      orderBy: { publishedAt: "asc" },
    });
    expect(rows.map((row) => row.platformVideoId)).toEqual(["vidnew1", "vidnew2"]);
    expect(rows.every((row) => row.status === "imported" && row.projectId !== null)).toBe(true);

    // Exactly one project per new video, created through the real URL-import path: a URL
    // source video plus the FINALIZE job createDraftProjectForWorkspace enqueues. (Job *state*
    // is asserted by the Phase 1 suites — a concurrently-running suite's job runner may have
    // already claimed these jobs by the time we look.)
    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: { sourceVideo: true, processingJobs: true },
    });
    expect(projects).toHaveLength(2);
    for (const project of projects) {
      expect(project.sourceVideo?.origin).toBe(SourceOrigin.URL);
      expect(project.processingJobs.map((job) => job.type)).toEqual([ProcessingJobType.FINALIZE]);
    }
    const projectByName = new Map(projects.map((project) => [project.name, project]));
    expect(projectByName.get("Sunday Sermon Part 1")?.sourceVideo?.originUrl).toBe(
      youtubeWatchUrl("vidnew1"),
    );
    expect(projectByName.get("Sunday Sermon Part 2")?.sourceVideo?.originUrl).toBe(
      youtubeWatchUrl("vidnew2"),
    );

    const polledOnce = await prisma.channelImportSource.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(polledOnce.lastPolledAt).not.toBeNull();
    expect(polledOnce.lastPollErrorAt).toBeNull();
    expect(polledOnce.lastPollErrorMessage).toBeNull();

    // Phase 4.2: one channel_import_created event per auto-created project, and at least one
    // workspace-agnostic channel_poll_ran liveness event from this run (other parallel suites
    // may add more, so the run-level event is a lower bound).
    const createdEvents = await prisma.operationalEvent.findMany({
      where: { workspaceId, category: "channel_import", eventType: "channel_import_created" },
    });
    expect(createdEvents).toHaveLength(2);
    expect(new Set(createdEvents.map((event) => event.projectId))).toEqual(
      new Set(projects.map((project) => project.id)),
    );
    expect(createdEvents.every((event) => event.severity === "info")).toBe(true);
    expect(
      await prisma.operationalEvent.count({
        where: {
          category: "channel_import",
          eventType: "channel_poll_ran",
          createdAt: { gte: polledOnce.lastPolledAt! },
        },
      }),
    ).toBeGreaterThanOrEqual(1);

    // Second poll over the identical list: nothing new is created (dedup proof).
    const secondPass = await pollDueChannelImportSources(prisma, { listUploads });
    expect(secondPass.videosImported).toBe(0);
    expect(secondPass.videosFailed).toBe(0);
    expect(secondPass.sourcesFailed).toBe(0);

    expect(
      await prisma.channelImportedVideo.count({ where: { channelImportSourceId: source.id } }),
    ).toBe(2);
    expect(await prisma.project.count({ where: { workspaceId } })).toBe(2);
    expect(
      await prisma.operationalEvent.count({
        where: { workspaceId, category: "channel_import", eventType: "channel_import_created" },
      }),
    ).toBe(2);

    const polledTwice = await prisma.channelImportSource.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(polledTwice.lastPolledAt?.getTime()).toBeGreaterThanOrEqual(
      polledOnce.lastPolledAt!.getTime(),
    );

    // Keep this source out of the next test's poll run.
    await prisma.channelImportSource.update({
      where: { id: source.id },
      data: { enabled: false },
    });
  });

  it("records lastPollErrorMessage on a failing source without blocking a healthy source in the same run", async () => {
    const workspaceId = await createWorkspace("Channel Poll Isolation");
    const failingChannelId = uniqueChannelId();
    const healthyChannelId = uniqueChannelId();

    const failingSource = await registerChannelImportSource(
      prisma,
      workspaceId,
      failingChannelId,
      fakeResolver(failingChannelId, "Broken Channel"),
    );
    // Make the failing source unambiguously first in registeredAt order, so the healthy
    // source's success proves the run continued *past* the failure.
    await prisma.channelImportSource.update({
      where: { id: failingSource.id },
      data: { registeredAt: new Date(failingSource.registeredAt.getTime() - 60_000) },
    });
    const healthySource = await registerChannelImportSource(
      prisma,
      workspaceId,
      healthyChannelId,
      fakeResolver(healthyChannelId, "Healthy Channel"),
    );

    const newVideo = upload(
      "vidhealthy1",
      "Healthy Upload",
      new Date(healthySource.registeredAt.getTime() + 1_000),
    );
    const listUploads: ListUploads = async (playlistId) => {
      if (playlistId === failingSource.uploadsPlaylistId) {
        throw new Error("YouTube API rejected the request (HTTP 403, quotaExceeded).");
      }
      if (playlistId === healthySource.uploadsPlaylistId) {
        return [newVideo];
      }
      return [];
    };

    const summary = await pollDueChannelImportSources(prisma, { listUploads });
    expect(summary.sourcesFailed).toBe(1);
    expect(summary.videosImported).toBe(1);
    expect(summary.videosFailed).toBe(0);
    expect(summary.sourcesPolled).toBeGreaterThanOrEqual(1);

    const failed = await prisma.channelImportSource.findUniqueOrThrow({
      where: { id: failingSource.id },
    });
    expect(failed.lastPolledAt).toBeNull();
    expect(failed.lastPollErrorAt).not.toBeNull();
    expect(failed.lastPollErrorMessage).toContain("quotaExceeded");
    expect(
      await prisma.channelImportedVideo.count({
        where: { channelImportSourceId: failingSource.id },
      }),
    ).toBe(0);

    const healthy = await prisma.channelImportSource.findUniqueOrThrow({
      where: { id: healthySource.id },
    });
    expect(healthy.lastPolledAt).not.toBeNull();
    expect(healthy.lastPollErrorAt).toBeNull();
    const healthyRows = await prisma.channelImportedVideo.findMany({
      where: { channelImportSourceId: healthySource.id },
    });
    expect(healthyRows).toHaveLength(1);
    expect(healthyRows[0].platformVideoId).toBe("vidhealthy1");
    expect(healthyRows[0].status).toBe("imported");
    expect(healthyRows[0].projectId).not.toBeNull();

    // Phase 4.2: the failed source records a warning-severity channel_poll_failed event —
    // warning, not error, so a single flaky poll never emails the operator.
    const failureEvents = await prisma.operationalEvent.findMany({
      where: { workspaceId, category: "channel_import", eventType: "channel_poll_failed" },
    });
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0].severity).toBe("warning");
    expect(failureEvents[0].message).toContain("quotaExceeded");
    expect(failureEvents[0].message).toContain("Broken Channel");

    // Keep these sources out of the next test's poll runs.
    await prisma.channelImportSource.updateMany({
      where: { id: { in: [failingSource.id, healthySource.id] } },
      data: { enabled: false },
    });
  });

  it("defers the video over the daily cap as skipped_cap and imports it once the window rolls over", async () => {
    // The env accessor re-reads process.env on every access, and tests within this file run
    // sequentially, so a scoped override is safe. No other suite reads this variable.
    const previousLimit = process.env.CHANNEL_IMPORT_DAILY_LIMIT;
    process.env.CHANNEL_IMPORT_DAILY_LIMIT = "2";
    try {
      const workspaceId = await createWorkspace("Channel Poll Cap");
      const channelId = uniqueChannelId();
      const source = await registerChannelImportSource(
        prisma,
        workspaceId,
        channelId,
        fakeResolver(channelId, "Busy Church"),
      );

      const registeredAt = source.registeredAt.getTime();
      const uploads = [
        // Newest first, like the real playlistItems.list response.
        upload("vidcap3", "Capped Sermon 3", new Date(registeredAt + 3_000)),
        upload("vidcap2", "Capped Sermon 2", new Date(registeredAt + 2_000)),
        upload("vidcap1", "Capped Sermon 1", new Date(registeredAt + 1_000)),
      ];
      const listUploads = uploadsForPlaylists({ [source.uploadsPlaylistId]: uploads });

      // First poll: the cap (2/day) admits the two oldest videos; the third is deferred.
      const firstPoll = await pollDueChannelImportSources(prisma, { listUploads });
      expect(firstPoll.videosImported).toBe(2);
      expect(firstPoll.videosSkippedCap).toBe(1);
      expect(firstPoll.videosFailed).toBe(0);
      expect(firstPoll.sourcesFailed).toBe(0);

      const rowsAfterFirst = await prisma.channelImportedVideo.findMany({
        where: { channelImportSourceId: source.id },
        orderBy: { publishedAt: "asc" },
      });
      expect(rowsAfterFirst.map((row) => [row.platformVideoId, row.status])).toEqual([
        ["vidcap1", "imported"],
        ["vidcap2", "imported"],
        ["vidcap3", "skipped_cap"],
      ]);
      expect(rowsAfterFirst[2].projectId).toBeNull();
      expect(await prisma.project.count({ where: { workspaceId } })).toBe(2);

      // A cap deferral is pacing, not an error: the source stays clean and warns once.
      const afterFirst = await prisma.channelImportSource.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(afterFirst.lastPollErrorAt).toBeNull();
      expect(afterFirst.lastPollErrorMessage).toBeNull();
      const capEvents = await prisma.operationalEvent.findMany({
        where: { workspaceId, category: "channel_import", eventType: "channel_import_skipped_cap" },
      });
      expect(capEvents).toHaveLength(1);
      expect(capEvents[0].severity).toBe("warning");
      expect(capEvents[0].metadata).toMatchObject({ videoIds: ["vidcap3"], limit: 2 });

      // Second poll inside the same window: still deferred (the skipped_cap row is retryable,
      // not "seen and done"), no duplicate project, and the re-deferral stays silent.
      const secondPoll = await pollDueChannelImportSources(prisma, { listUploads });
      expect(secondPoll.videosImported).toBe(0);
      expect(secondPoll.videosSkippedCap).toBe(1);
      expect(await prisma.project.count({ where: { workspaceId } })).toBe(2);
      expect(
        (
          await prisma.channelImportedVideo.findUniqueOrThrow({
            where: {
              channelImportSourceId_platformVideoId: {
                channelImportSourceId: source.id,
                platformVideoId: "vidcap3",
              },
            },
          })
        ).status,
      ).toBe("skipped_cap");
      expect(
        await prisma.operationalEvent.count({
          where: { workspaceId, category: "channel_import", eventType: "channel_import_skipped_cap" },
        }),
      ).toBe(1);

      // Third poll after the rolling 24h window has passed: the deferred video imports even
      // though its publishedAt now sits *before* lastPolledAt — the pending skip lowers the
      // listing cutoff without readmitting anything older (no-backfill still holds).
      const rolledOver = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
      const thirdPoll = await pollDueChannelImportSources(prisma, {
        listUploads,
        now: rolledOver,
      });
      expect(thirdPoll.videosImported).toBe(1);
      expect(thirdPoll.videosSkippedCap).toBe(0);
      expect(thirdPoll.videosFailed).toBe(0);

      const retriedRow = await prisma.channelImportedVideo.findUniqueOrThrow({
        where: {
          channelImportSourceId_platformVideoId: {
            channelImportSourceId: source.id,
            platformVideoId: "vidcap3",
          },
        },
      });
      expect(retriedRow.status).toBe("imported");
      expect(retriedRow.projectId).not.toBeNull();
      expect(
        await prisma.channelImportedVideo.count({ where: { channelImportSourceId: source.id } }),
      ).toBe(3);

      const projects = await prisma.project.findMany({
        where: { workspaceId },
        include: { sourceVideo: true },
      });
      expect(projects).toHaveLength(3);
      const retried = projects.find((project) => project.id === retriedRow.projectId);
      expect(retried?.name).toBe("Capped Sermon 3");
      expect(retried?.sourceVideo?.originUrl).toBe(youtubeWatchUrl("vidcap3"));

      // Keep this source (with its far-future lastPolledAt) out of any later poll runs.
      await prisma.channelImportSource.update({
        where: { id: source.id },
        data: { enabled: false },
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CHANNEL_IMPORT_DAILY_LIMIT;
      } else {
        process.env.CHANNEL_IMPORT_DAILY_LIMIT = previousLimit;
      }
    }
  });
});
