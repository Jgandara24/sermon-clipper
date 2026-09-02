import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AuthProvider,
  ExportPreset,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProjectStatus,
  RenderQcStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportFailureError } from "@/lib/exports/errors";
import { runExportJob } from "@/lib/exports/handler";
import { RENDER_QC_FAILED } from "@/lib/qc/render-output";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;
let healthyClipId: string;
let truncatedClipId: string;

const CLIP_START_MS = 0;
const CLIP_END_MS = 4000;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A source of the given length, with both streams, in the shape the worker expects. */
async function createSourceVideo(outputPath: string, durationS: number) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `testsrc=size=1280x720:rate=30:duration=${durationS}`,
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${durationS}`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);
}

const WORDS = [
  { word: "John", startMs: 200, endMs: 500, confidence: 0.99, isFiller: false, deleted: false },
  { word: "14", startMs: 520, endMs: 820, confidence: 0.99, isFiller: false, deleted: false },
  { word: "says", startMs: 900, endMs: 1200, confidence: 0.99, isFiller: false, deleted: false },
  { word: "peace", startMs: 1300, endMs: 1700, confidence: 0.99, isFiller: false, deleted: false },
  { word: "stays", startMs: 1800, endMs: 2200, confidence: 0.99, isFiller: false, deleted: false },
  { word: "with", startMs: 2300, endMs: 2600, confidence: 0.99, isFiller: false, deleted: false },
  { word: "us", startMs: 2700, endMs: 3000, confidence: 0.99, isFiller: false, deleted: false },
];

/** Builds one source, project, transcript and clip. Returns the clip id. */
async function createClipOnSource(label: string, sourceDurationS: number): Promise<string> {
  const storage = getStorageProvider();
  const storageKey = `render-qc/${workspaceId}/${label}.mp4`;
  await createSourceVideo(storage.absolutePath(storageKey), sourceDurationS);

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: `${label}.mp4`,
      durationS: new Prisma.Decimal(sourceDurationS.toFixed(2)),
      sizeBytes: BigInt(await storage.size(storageKey)),
      width: 1280,
      height: 720,
      fps: new Prisma.Decimal("30.000"),
      storageKey,
      language: "en",
    },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      sourceVideoId: sourceVideo.id,
      name: `Render QC ${label}`,
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId: sourceVideo.id,
      language: "en",
      provider: "integration-fixture",
      fullText: "John 14 says peace stays with us.",
    },
  });
  await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: 0,
      endMs: CLIP_END_MS,
      text: "John 14 says peace stays with us.",
      words: WORDS,
    },
  });

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A short sermon moment used to exercise mandatory render QC.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  return clip.id;
}

/** A job pinned to version 0: the defaults, so no ClipEdit row is needed. */
async function createExportJob(clipId: string, filename: string) {
  return prisma.exportJob.create({
    data: {
      clipId,
      workspaceId,
      preset: ExportPreset.MP4_1080,
      state: ProcessingJobState.RUNNING,
      filename,
      idempotencyKey: uniqueKey(filename),
      editVersion: 0,
      attempt: 1,
      startedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "render-qc-storage");

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("render-qc")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Render QC",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  healthyClipId = await createClipOnSource("healthy", 5);
  // The source runs out long before the clip does, so the render comes out about a second long
  // against the four seconds the edit asks for. Nothing else about it is wrong.
  truncatedClipId = await createClipOnSource("truncated", 1);
}, 120_000);

afterAll(async () => {
  if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  if (process.env.STORAGE_LOCAL_ROOT) {
    await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
  }
  await prisma.$disconnect();
});

describe("a healthy render passes QC and is recorded from what was measured", () => {
  it("stores the probed dimensions and one checksum shared with the QC record", async () => {
    const job = await createExportJob(healthyClipId, "healthy.mp4");

    const outputFileId = await runExportJob(prisma, job);

    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.qcStatus).toBe(RenderQcStatus.PASSED);
    expect(stored.qcCheckedAt).not.toBeNull();

    const file = await prisma.exportedFile.findUniqueOrThrow({ where: { id: outputFileId } });
    // The single source of truth: the checksum QC computed is the checksum the file carries.
    expect(stored.qcChecksum).toBe(file.checksum);
    expect(file.width).toBe(1080);
    expect(file.height).toBe(1920);
    expect(Number(file.bytes)).toBeGreaterThan(0);

    const details = stored.qcDetails as { version: number; checks: Array<{ name: string; passed: boolean }> };
    expect(details.version).toBe(1);
    expect(details.checks.every((check) => check.passed)).toBe(true);
    // The clip has words, so the burn-in had captions to draw and QC saw them.
    expect(details.checks.find((check) => check.name === "captionEvents")?.passed).toBe(true);
  }, 180_000);
});

describe("a render that does not match the edit is refused before it is stored", () => {
  it("fails with the QC code, records why, and uploads nothing", async () => {
    const job = await createExportJob(truncatedClipId, "truncated.mp4");

    await expect(runExportJob(prisma, job)).rejects.toMatchObject({ code: RENDER_QC_FAILED });

    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.qcStatus).toBe(RenderQcStatus.FAILED);
    expect(stored.qcChecksum).not.toBeNull();

    const details = stored.qcDetails as { checks: Array<{ name: string; passed: boolean; detail: string }> };
    const duration = details.checks.find((check) => check.name === "duration");
    expect(duration?.passed).toBe(false);
    expect(duration?.detail).toContain("off by");

    // Nothing reached storage: QC runs before the upload, so a refused render leaves no object
    // behind to be served, counted, or cleaned up later.
    const storage = getStorageProvider();
    expect(await storage.exists(`exports/${workspaceId}/${job.id}.mp4`)).toBe(false);

    // And no ExportedFile row was created for it.
    expect(await prisma.exportedFile.count({ where: { storageKey: `exports/${workspaceId}/${job.id}.mp4` } })).toBe(0);
  }, 180_000);

  it("records an operational event naming the clip that failed", async () => {
    const job = await createExportJob(truncatedClipId, "truncated-event.mp4");

    await expect(runExportJob(prisma, job)).rejects.toBeInstanceOf(ExportFailureError);

    const event = await prisma.operationalEvent.findFirstOrThrow({
      where: { exportJobId: job.id, eventType: "export_render_qc_failed" },
    });
    expect(event.clipId).toBe(truncatedClipId);
    expect(event.severity).toBe("warning");
    const metadata = event.metadata as { failures: Array<{ name: string }> };
    expect(metadata.failures.map((failure) => failure.name)).toContain("duration");
  }, 180_000);

  it("stays retryable, so a transient bad render is not terminal", async () => {
    const job = await createExportJob(truncatedClipId, "truncated-retryable.mp4");

    await expect(runExportJob(prisma, job)).rejects.toMatchObject({ terminal: false });
  }, 180_000);
});
