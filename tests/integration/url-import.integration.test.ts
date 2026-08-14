import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AuthProvider,
  ChannelImportPlatform,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFinalizeJobHandler } from "@/lib/jobs/handlers/finalize";
import { JobFailureError } from "@/lib/jobs/types";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { YtDlpDownloadError, type YtDlpMetadata } from "@/lib/media/ytdlp";
import { createDraftProjectForWorkspace } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;
let fixtureDir: string;
let tinyVideoPath: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function metadataFixture(overrides: Partial<YtDlpMetadata> = {}): YtDlpMetadata {
  return {
    videoId: "dQw4w9WgXcQ",
    title: "Sunday Morning Message",
    durationS: 5,
    thumbnailUrl: null,
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "integration-storage");

  // A real 5-second mp4: the injected download fake copies this into the handler's workDir so
  // the unchanged ffprobe/probe flow runs against a genuine video file.
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "url-import-fixture-"));
  tinyVideoPath = path.join(fixtureDir, "tiny.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    tinyVideoPath,
  ]);

  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("url-import")}@example.com`,
      authProvider: AuthProvider.DEV,
    },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "URL Import Test",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  workspaceId = workspace.id;

  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  }
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("URL import pipeline", () => {
  it("creates a QUEUED FINALIZE job for a pasted URL (no WAITING stub)", async () => {
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      { name: "Pasted URL Sermon", sourceUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ" },
      userId,
    );

    expect(project.status).toBe(ProjectStatus.QUEUED);

    const sourceVideo = await prisma.sourceVideo.findUniqueOrThrow({
      where: { id: project.sourceVideoId ?? "" },
    });
    expect(sourceVideo.origin).toBe(SourceOrigin.URL);
    expect(sourceVideo.originUrl).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(sourceVideo.storageKey).toBeNull();

    const finalizeJob = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `finalize:${project.id}` },
    });
    expect(finalizeJob.state).toBe(ProcessingJobState.QUEUED);
    expect(finalizeJob.type).toBe(ProcessingJobType.FINALIZE);
    expect(finalizeJob.errorCode).toBeNull();
  });

  it("runs the FINALIZE URL branch against an injected yt-dlp fake and proceeds to PROBE", async () => {
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      { name: "URL Import Happy Path", sourceUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ" },
      userId,
    );
    const job = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `finalize:${project.id}` },
    });
    const channelSource = await prisma.channelImportSource.create({
      data: {
        workspaceId,
        platform: ChannelImportPlatform.YOUTUBE,
        channelId: uniqueKey("UCchannel"),
        channelTitle: "Cost Attribution Channel",
        uploadsPlaylistId: uniqueKey("UUplaylist"),
      },
    });
    await prisma.channelImportedVideo.create({
      data: {
        channelImportSourceId: channelSource.id,
        platformVideoId: "dQw4w9WgXcQ",
        projectId: project.id,
        publishedAt: new Date(),
        status: "imported",
      },
    });

    const downloadCalls: Array<{ url: string; maxBytes: number }> = [];
    const handler = createFinalizeJobHandler({
      fetchMetadata: async () => metadataFixture(),
      downloadVideo: async (url, destPath, opts) => {
        downloadCalls.push({ url, maxBytes: opts.maxBytes });
        await copyFile(tinyVideoPath, destPath);
        return {
          bytes: 74_000,
          sourceDurationS: 5,
          bitrateBitsPerSecond: 118_400,
          proxyUsed: false,
          proxyHost: null,
          wallTimeMs: 50,
        };
      },
    });

    await handler({ job, prisma });

    expect(downloadCalls).toEqual([
      { url: "https://youtube.com/watch?v=dQw4w9WgXcQ", maxBytes: MAX_UPLOAD_BYTES },
    ]);

    const sourceVideo = await prisma.sourceVideo.findUniqueOrThrow({
      where: { id: project.sourceVideoId ?? "" },
    });
    expect(sourceVideo.storageKey).toBe(`src/${workspaceId}/${sourceVideo.id}-url-import.mp4`);
    await expect(getStorageProvider().exists(sourceVideo.storageKey ?? "")).resolves.toBe(true);
    // Duration comes from the real ffprobe run over the downloaded file, not the yt-dlp metadata.
    expect(Number(sourceVideo.durationS)).toBeGreaterThan(4);
    expect(Number(sourceVideo.durationS)).toBeLessThan(6);
    expect(sourceVideo.width).toBe(1280);
    expect(sourceVideo.height).toBe(720);

    const updatedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updatedProject.status).toBe(ProjectStatus.PROCESSING);

    const probeJob = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `probe:${project.id}` },
    });
    expect(probeJob.state).toBe(ProcessingJobState.QUEUED);
    expect(probeJob.type).toBe(ProcessingJobType.PROBE);

    const finalizeJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(Number(finalizeJob.minutesReserved)).toBeGreaterThan(0);

    const costEvents = await prisma.operationalEvent.findMany({
      where: { jobId: job.id, eventType: "processing_cost_fact" },
      orderBy: { createdAt: "asc" },
    });
    expect(costEvents).toHaveLength(2);
    expect(costEvents.map((event) => event.category)).toEqual(["cost", "cost"]);
    expect(costEvents.map((event) => (event.metadata as { provider: string }).provider)).toEqual(
      expect.arrayContaining(["yt_dlp_direct", "railway_egress"]),
    );
    for (const event of costEvents) {
      expect(event.metadata).toMatchObject({
        details: {
          channelImportSourceId: channelSource.id,
          platformVideoId: "dQw4w9WgXcQ",
          channelTitle: "Cost Attribution Channel",
        },
      });
    }
    expect(JSON.stringify(costEvents)).not.toContain("YTDLP_PROXY_URL");
  });

  it("fails VIDEO_TOO_LONG from pre-download metadata without ever downloading", async () => {
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      { name: "URL Import Too Long", sourceUrl: "https://youtube.com/watch?v=too-long" },
      userId,
    );
    const job = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `finalize:${project.id}` },
    });

    let downloadCalled = false;
    const handler = createFinalizeJobHandler({
      fetchMetadata: async () => metadataFixture({ durationS: 4 * 60 * 60 }),
      downloadVideo: async () => {
        downloadCalled = true;
        throw new Error("download must not run");
      },
    });

    const failure = await handler({ job, prisma }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(JobFailureError);
    expect((failure as JobFailureError).code).toBe("VIDEO_TOO_LONG");
    expect((failure as JobFailureError).retryable).toBe(false);
    expect(downloadCalled).toBe(false);

    const sourceVideo = await prisma.sourceVideo.findUniqueOrThrow({
      where: { id: project.sourceVideoId ?? "" },
    });
    expect(sourceVideo.storageKey).toBeNull();
  });

  it("fails URL_IMPORT_FAILED when yt-dlp cannot read the link", async () => {
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      { name: "URL Import Bad Link", sourceUrl: "https://example.com/not-a-video" },
      userId,
    );
    const job = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `finalize:${project.id}` },
    });

    const handler = createFinalizeJobHandler({
      fetchMetadata: async () => {
        throw new Error("ERROR: Unsupported URL");
      },
      downloadVideo: async () => {
        throw new Error("download should not run");
      },
    });

    const failure = await handler({ job, prisma }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(JobFailureError);
    expect((failure as JobFailureError).code).toBe("URL_IMPORT_FAILED");
  });

  it("records known failed-transfer bytes and retry attribution", async () => {
    const project = await createDraftProjectForWorkspace(
      prisma,
      workspaceId,
      { name: "URL Import Failed Transfer", sourceUrl: "https://youtube.com/watch?v=partial" },
      userId,
    );
    const queuedJob = await prisma.processingJob.findUniqueOrThrow({
      where: { idempotencyKey: `finalize:${project.id}` },
    });
    const job = await prisma.processingJob.update({
      where: { id: queuedJob.id },
      data: { attempt: 2 },
    });
    const telemetry = {
      bytes: 12_345,
      sourceDurationS: 5,
      bitrateBitsPerSecond: 19_752,
      proxyUsed: true,
      proxyHost: "proxy.example",
      wallTimeMs: 500,
    };
    const handler = createFinalizeJobHandler({
      fetchMetadata: async () => metadataFixture(),
      downloadVideo: async () => {
        throw new YtDlpDownloadError("partial transfer", { telemetry });
      },
    });

    await expect(handler({ job, prisma })).rejects.toMatchObject({ code: "URL_IMPORT_FAILED" });
    const costEvents = await prisma.operationalEvent.findMany({
      where: { jobId: job.id, eventType: "processing_cost_fact" },
    });
    expect(costEvents).toHaveLength(2);
    for (const event of costEvents) {
      expect(event.metadata).toMatchObject({
        bytes: 12_345,
        attempt: 2,
        retry: true,
        outcome: "failed",
        details: { proxyUsed: true, proxyHost: "proxy.example" },
      });
      expect(JSON.stringify(event.metadata)).not.toContain("user:pass");
    }
  });
});
