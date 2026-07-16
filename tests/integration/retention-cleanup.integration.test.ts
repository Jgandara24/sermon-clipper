import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthProvider,
  GeneratedClipStatus,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanupJob } from "@/lib/jobs/handlers/cleanup";
import {
  cleanupIdempotencyKey,
  enqueueDueCleanupJobs,
  sweepOrphanedExportedFiles,
} from "@/lib/retention";
import { getStorageProvider } from "@/lib/storage";

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const LONG_AGO = new Date(NOW.getTime() - 90 * DAY_MS);
const RECENT = new Date(NOW.getTime() + 6 * DAY_MS); // download link still valid

let storageRoot: string;
let userId: string;
let workspaceId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function putObject(key: string): Promise<string> {
  const storage = getStorageProvider();
  const tmpFile = path.join(storageRoot, `seed-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmpFile, "retention-test-bytes");
  await storage.uploadFile(key, tmpFile, "application/octet-stream");
  await rm(tmpFile, { force: true });
  return key;
}

async function objectExists(key: string): Promise<boolean> {
  return getStorageProvider().exists(key);
}

type SeededProject = {
  projectId: string;
  sourceVideoId: string;
  sourceKeys: string[];
  exportedFileId: string;
  exportKey: string;
};

/** Seeds a project with real storage objects, one clip, and one exported file. */
async function seedProject(options: {
  label: string;
  projectExpiresAt: Date | null;
  downloadExpiresAt: Date;
  sourceVideoId?: string;
}): Promise<SeededProject> {
  let sourceVideoId = options.sourceVideoId;
  let sourceKeys: string[] = [];
  if (!sourceVideoId) {
    const stem = uniqueKey(options.label);
    const storageKey = await putObject(`src/${workspaceId}/${stem}.mp4`);
    const audioKey = await putObject(`audio/${workspaceId}/${stem}.wav`);
    const thumbnailKey = await putObject(`thumbs/${workspaceId}/${stem}.jpg`);
    sourceKeys = [storageKey, audioKey, thumbnailKey];
    const sourceVideo = await prisma.sourceVideo.create({
      data: {
        workspaceId,
        origin: SourceOrigin.UPLOAD,
        filename: `${stem}.mp4`,
        storageKey,
        audioKey,
        thumbnailKey,
      },
    });
    sourceVideoId = sourceVideo.id;
  }

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: `Retention ${options.label}`,
      status: ProjectStatus.READY,
      sourceVideoId,
      expiresAt: options.projectExpiresAt,
    },
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: 0,
      endMs: 10_000,
      title: `Retention clip ${options.label}`,
      summary: "Clip seeded for retention cleanup tests.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });

  const exportKey = await putObject(`exports/${workspaceId}/${uniqueKey(options.label)}.mp4`);
  const exportedFile = await prisma.exportedFile.create({
    data: {
      storageKey: exportKey,
      bytes: BigInt(1024),
      width: 1080,
      height: 1920,
      checksum: "test-checksum",
      downloadExpiresAt: options.downloadExpiresAt,
    },
  });
  await prisma.exportJob.create({
    data: {
      clipId: clip.id,
      workspaceId,
      state: ProcessingJobState.SUCCEEDED,
      idempotencyKey: uniqueKey(`export-${options.label}`),
      filename: `${options.label}.mp4`,
      outputFileId: exportedFile.id,
    },
  });

  return {
    projectId: project.id,
    sourceVideoId,
    sourceKeys,
    exportedFileId: exportedFile.id,
    exportKey,
  };
}

async function runCleanupForProject(projectId: string) {
  const job = await prisma.processingJob.create({
    data: {
      projectId,
      type: ProcessingJobType.CLEANUP,
      state: ProcessingJobState.RUNNING,
      idempotencyKey: uniqueKey(`cleanup-run-${projectId}`),
    },
  });
  return runCleanupJob({ job, prisma });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "sermon-retention-"));
  process.env.STORAGE_LOCAL_ROOT = storageRoot;
  process.env.STORAGE_PROVIDER = "local";
  // getStorageProvider memoizes on globalThis; clear any provider another import created first.
  (globalThis as { storageProvider?: unknown }).storageProvider = undefined;

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("retention")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { name: "Retention Cleanup", ownerId: user.id },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  }
  if (userId) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  }
  await prisma.$disconnect();
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

describe("retention cleanup", () => {
  it("purges an expired project's media and exports but keeps the database records", async () => {
    const seeded = await seedProject({
      label: "expired",
      projectExpiresAt: LONG_AGO,
      downloadExpiresAt: RECENT,
    });

    const result = await runCleanupForProject(seeded.projectId);

    expect(result?.metadata).toMatchObject({
      projectExpired: true,
      exportRowsDeleted: 1,
      sourceMediaPurged: true,
    });
    for (const key of seeded.sourceKeys) {
      await expect(objectExists(key)).resolves.toBe(false);
    }
    await expect(objectExists(seeded.exportKey)).resolves.toBe(false);

    // Records survive; only media keys are cleared and the exported-file row is gone.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: seeded.projectId } });
    expect(project.expiresAt).toEqual(LONG_AGO);
    const sourceVideo = await prisma.sourceVideo.findUniqueOrThrow({
      where: { id: seeded.sourceVideoId },
    });
    expect(sourceVideo.storageKey).toBeNull();
    expect(sourceVideo.audioKey).toBeNull();
    expect(sourceVideo.thumbnailKey).toBeNull();
    await expect(
      prisma.exportedFile.findUnique({ where: { id: seeded.exportedFileId } }),
    ).resolves.toBeNull();
    const exportJob = await prisma.exportJob.findFirstOrThrow({
      where: { clip: { projectId: seeded.projectId } },
    });
    expect(exportJob.outputFileId).toBeNull();

    const event = await prisma.operationalEvent.findFirst({
      where: { workspaceId, eventType: "retention_cleanup", projectId: seeded.projectId },
    });
    expect(event).not.toBeNull();
  });

  it("removes only past-grace exports from an active project and leaves its media alone", async () => {
    const seeded = await seedProject({
      label: "active",
      projectExpiresAt: null,
      downloadExpiresAt: LONG_AGO, // stale: expired far beyond the 30-day grace
    });
    const freshExportKey = await putObject(`exports/${workspaceId}/${uniqueKey("fresh")}.mp4`);
    const freshFile = await prisma.exportedFile.create({
      data: {
        storageKey: freshExportKey,
        bytes: BigInt(2048),
        width: 1080,
        height: 1920,
        checksum: "fresh-checksum",
        downloadExpiresAt: RECENT,
      },
    });
    const clip = await prisma.generatedClip.findFirstOrThrow({
      where: { projectId: seeded.projectId },
    });
    await prisma.exportJob.create({
      data: {
        clipId: clip.id,
        workspaceId,
        state: ProcessingJobState.SUCCEEDED,
        idempotencyKey: uniqueKey("export-fresh"),
        filename: "fresh.mp4",
        outputFileId: freshFile.id,
      },
    });

    const result = await runCleanupForProject(seeded.projectId);

    expect(result?.metadata).toMatchObject({
      projectExpired: false,
      exportRowsDeleted: 1,
      sourceMediaPurged: false,
    });
    await expect(objectExists(seeded.exportKey)).resolves.toBe(false);
    await expect(objectExists(freshExportKey)).resolves.toBe(true);
    await expect(
      prisma.exportedFile.findUnique({ where: { id: freshFile.id } }),
    ).resolves.not.toBeNull();
    for (const key of seeded.sourceKeys) {
      await expect(objectExists(key)).resolves.toBe(true);
    }
    const sourceVideo = await prisma.sourceVideo.findUniqueOrThrow({
      where: { id: seeded.sourceVideoId },
    });
    expect(sourceVideo.storageKey).not.toBeNull();
  });

  it("keeps shared source media while any referencing project is still active", async () => {
    const expired = await seedProject({
      label: "shared-expired",
      projectExpiresAt: LONG_AGO,
      downloadExpiresAt: RECENT,
    });
    await prisma.project.create({
      data: {
        workspaceId,
        name: "Retention shared active",
        status: ProjectStatus.READY,
        sourceVideoId: expired.sourceVideoId,
        expiresAt: null,
      },
    });

    const result = await runCleanupForProject(expired.projectId);

    expect(result?.metadata).toMatchObject({ projectExpired: true, sourceMediaPurged: false });
    for (const key of expired.sourceKeys) {
      await expect(objectExists(key)).resolves.toBe(true);
    }
  });

  it("is idempotent: re-running after a purge removes nothing further and does not error", async () => {
    const seeded = await seedProject({
      label: "rerun",
      projectExpiresAt: LONG_AGO,
      downloadExpiresAt: RECENT,
    });

    await runCleanupForProject(seeded.projectId);
    const second = await runCleanupForProject(seeded.projectId);

    expect(second?.metadata).toMatchObject({
      exportObjectsRemoved: 0,
      exportRowsDeleted: 0,
      sourceMediaPurged: false,
    });
  });

  it("enqueues cleanup jobs for due projects exactly once per day bucket", async () => {
    const seeded = await seedProject({
      label: "enqueue",
      projectExpiresAt: LONG_AGO,
      downloadExpiresAt: RECENT,
    });

    const first = await enqueueDueCleanupJobs(prisma, NOW);
    expect(first.enqueued).toBeGreaterThanOrEqual(1);
    const job = await prisma.processingJob.findUnique({
      where: { idempotencyKey: cleanupIdempotencyKey(seeded.projectId, NOW) },
    });
    expect(job?.type).toBe(ProcessingJobType.CLEANUP);
    expect(job?.projectId).toBe(seeded.projectId);

    // Second same-day scan must not create a duplicate job for this project.
    await enqueueDueCleanupJobs(prisma, NOW);
    const jobs = await prisma.processingJob.findMany({
      where: { projectId: seeded.projectId, type: ProcessingJobType.CLEANUP },
    });
    expect(jobs).toHaveLength(1);
  });

  it("does not enqueue cleanup for projects with nothing to clean", async () => {
    const activeFresh = await seedProject({
      label: "no-work",
      projectExpiresAt: null,
      downloadExpiresAt: RECENT,
    });

    await enqueueDueCleanupJobs(prisma, NOW);

    const jobs = await prisma.processingJob.findMany({
      where: { projectId: activeFresh.projectId, type: ProcessingJobType.CLEANUP },
    });
    expect(jobs).toHaveLength(0);
  });

  it("sweeps orphaned exported files past grace", async () => {
    const orphanKey = await putObject(`exports/${workspaceId}/${uniqueKey("orphan")}.mp4`);
    const orphan = await prisma.exportedFile.create({
      data: {
        storageKey: orphanKey,
        bytes: BigInt(512),
        width: 1080,
        height: 1920,
        checksum: "orphan-checksum",
        downloadExpiresAt: LONG_AGO,
      },
    });
    const freshOrphanKey = await putObject(`exports/${workspaceId}/${uniqueKey("orphan-fresh")}.mp4`);
    const freshOrphan = await prisma.exportedFile.create({
      data: {
        storageKey: freshOrphanKey,
        bytes: BigInt(512),
        width: 1080,
        height: 1920,
        checksum: "orphan-fresh-checksum",
        downloadExpiresAt: RECENT,
      },
    });

    const sweep = await sweepOrphanedExportedFiles(prisma, NOW);

    expect(sweep.rowsDeleted).toBeGreaterThanOrEqual(1);
    await expect(objectExists(orphanKey)).resolves.toBe(false);
    await expect(
      prisma.exportedFile.findUnique({ where: { id: orphan.id } }),
    ).resolves.toBeNull();
    await expect(objectExists(freshOrphanKey)).resolves.toBe(true);
    await expect(
      prisma.exportedFile.findUnique({ where: { id: freshOrphan.id } }),
    ).resolves.not.toBeNull();
  });
});
