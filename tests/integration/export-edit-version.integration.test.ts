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
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDefaultEditorState, wordId } from "@/lib/editor/types";
import {
  buildExportIdempotencyKey,
  EXPORT_EDIT_VERSION_MISSING,
  EXPORT_EDIT_VERSION_NOT_FOUND,
  parseExportIdempotencyKeyVersion,
} from "@/lib/exports/edit-version";
import { ExportFailureError } from "@/lib/exports/errors";
import { runExportJob } from "@/lib/exports/handler";
import {
  enqueueExportJob,
  markExportJobFailedOrRetry,
  requeueFailedExportJob,
} from "@/lib/exports/queue";
import { probeVideoFile } from "@/lib/media/probe";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;
let sourceVideoId: string;
let segmentId: string;
let clipId: string;
let storageKey: string;

const CLIP_START_MS = 0;
const CLIP_END_MS = 4000;

/** Version 1 keeps every word: the whole 0–4000ms clip survives. */
const VERSION_1_DURATION_S = 4;
/**
 * Version 2 deletes "says peace stays with us", leaving only the words' surrounding gaps:
 * 0–900 + 1200–1300 + 1700–1800 + 2200–2300 + 2600–2700 + 3000–4000 = 2300ms.
 */
const VERSION_2_DURATION_S = 2.3;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
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
    outputPath,
  ]);
}

/** The exact render length the worker derived from the state it actually loaded. */
async function renderedDurationS(exportJobId: string): Promise<number> {
  const facts = await prisma.operationalEvent.findMany({
    where: { exportJobId, eventType: "processing_cost_fact" },
  });
  const render = facts.find((fact) => (fact.metadata as { stage: string }).stage === "render");
  return Number((render?.metadata as { quantity: number } | undefined)?.quantity ?? -1);
}

async function createExportJob(params: {
  filename: string;
  editVersion: number | null;
  attempt?: number;
}) {
  return prisma.exportJob.create({
    data: {
      clipId,
      workspaceId,
      preset: ExportPreset.MP4_1080,
      state: ProcessingJobState.RUNNING,
      filename: params.filename,
      idempotencyKey: uniqueKey(params.filename),
      editVersion: params.editVersion,
      attempt: params.attempt ?? 1,
      startedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "edit-version-storage");

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("edit-version")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Edit Version Pinning",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  storageKey = `edit-version/${workspaceId}/source.mp4`;
  const storage = getStorageProvider();
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "edit-version-source.mp4",
      durationS: new Prisma.Decimal("5.00"),
      sizeBytes: BigInt(await storage.size(storageKey)),
      width: 1280,
      height: 720,
      fps: new Prisma.Decimal("30.000"),
      storageKey,
      language: "en",
    },
  });
  sourceVideoId = sourceVideo.id;

  const project = await prisma.project.create({
    data: {
      workspaceId,
      sourceVideoId,
      name: "Edit Version Sermon",
      status: ProjectStatus.READY,
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sourceVideoId,
      language: "en",
      provider: "integration-fixture",
      fullText: "John 14 says peace stays with us.",
    },
  });
  const segment = await prisma.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      idx: 0,
      startMs: 0,
      endMs: CLIP_END_MS,
      text: "John 14 says peace stays with us.",
      words: [
        { word: "John", startMs: 200, endMs: 500, confidence: 0.99, isFiller: false, deleted: false },
        { word: "14", startMs: 520, endMs: 820, confidence: 0.99, isFiller: false, deleted: false },
        { word: "says", startMs: 900, endMs: 1200, confidence: 0.99, isFiller: false, deleted: false },
        { word: "peace", startMs: 1300, endMs: 1700, confidence: 0.99, isFiller: false, deleted: false },
        { word: "stays", startMs: 1800, endMs: 2200, confidence: 0.99, isFiller: false, deleted: false },
        { word: "with", startMs: 2300, endMs: 2600, confidence: 0.99, isFiller: false, deleted: false },
        { word: "us", startMs: 2700, endMs: 3000, confidence: 0.99, isFiller: false, deleted: false },
      ],
    },
  });
  segmentId = segment.id;

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId: project.id,
      rank: 1,
      startMs: CLIP_START_MS,
      endMs: CLIP_END_MS,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A short sermon moment used to pin an export to one edit version.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  clipId = clip.id;
});

afterAll(async () => {
  if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  if (process.env.STORAGE_LOCAL_ROOT) {
    await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
  }
  await prisma.$disconnect();
});

async function saveVersion1() {
  const base = buildDefaultEditorState({
    sourceVideoId,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
  });
  return prisma.clipEdit.upsert({
    where: { clipId_version: { clipId, version: 1 } },
    update: {},
    create: {
      clipId,
      version: 1,
      savedBy: userId,
      editorState: { ...base, version: 1 } as unknown as Prisma.InputJsonValue,
    },
  });
}

async function saveVersion2() {
  const base = buildDefaultEditorState({
    sourceVideoId,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
  });
  return prisma.clipEdit.upsert({
    where: { clipId_version: { clipId, version: 2 } },
    update: {},
    create: {
      clipId,
      version: 2,
      savedBy: userId,
      editorState: {
        ...base,
        version: 2,
        wordEdits: {
          ...base.wordEdits,
          deletedWordIds: [2, 3, 4, 5, 6].map((index) => wordId(segmentId, index)),
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

describe("export renders the requested edit version, not the newest one", () => {
  it("renders version 1 even when version 2 is saved before the worker starts", async () => {
    await saveVersion1();

    // The request is made while version 1 is the newest save.
    const job = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "race-v1.mp4",
      editVersion: 1,
    });
    expect(job.editVersion).toBe(1);
    expect(parseExportIdempotencyKeyVersion(job.idempotencyKey)).toBe(1);

    // The user keeps editing and saves version 2 before the worker picks the job up.
    await saveVersion2();
    const newest = await prisma.clipEdit.findFirstOrThrow({
      where: { clipId },
      orderBy: { version: "desc" },
    });
    expect(newest.version).toBe(2);

    const claimed = await prisma.exportJob.update({
      where: { id: job.id },
      data: { state: ProcessingJobState.RUNNING, attempt: 1, startedAt: new Date() },
    });
    const outputFileId = await runExportJob(prisma, claimed);

    const rendered = await prisma.exportedFile.findUniqueOrThrow({ where: { id: outputFileId } });
    const probe = await probeVideoFile(getStorageProvider().absolutePath(rendered.storageKey));

    expect(await renderedDurationS(job.id)).toBeCloseTo(VERSION_1_DURATION_S, 3);
    expect(probe.durationS).toBeGreaterThan(VERSION_2_DURATION_S + 0.5);
    expect(probe.durationS).toBeCloseTo(VERSION_1_DURATION_S, 0);
  }, 180_000);

  it("stays pinned to the original version when the export is retried", async () => {
    await saveVersion1();
    await saveVersion2();

    const job = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "retry-v1.mp4",
      editVersion: 1,
    });
    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        state: ProcessingJobState.FAILED,
        attempt: 1,
        errorCode: "RENDER_FAILED",
        finishedAt: new Date(),
      },
    });

    const requeued = await requeueFailedExportJob(prisma, job.id);
    expect(requeued.count).toBe(1);

    const afterRequeue = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterRequeue.state).toBe(ProcessingJobState.QUEUED);
    expect(afterRequeue.editVersion).toBe(1);
    expect(afterRequeue.idempotencyKey).toBe(job.idempotencyKey);

    const claimed = await prisma.exportJob.update({
      where: { id: job.id },
      data: { state: ProcessingJobState.RUNNING, attempt: 2, startedAt: new Date() },
    });
    await runExportJob(prisma, claimed);

    expect(await renderedDurationS(job.id)).toBeCloseTo(VERSION_1_DURATION_S, 3);
  }, 180_000);

  it("renders the default editor state for version 0", async () => {
    await saveVersion2();

    const job = await createExportJob({ filename: "default-v0.mp4", editVersion: 0 });
    const outputFileId = await runExportJob(prisma, job);

    expect(outputFileId).toEqual(expect.any(String));
    // The default state deletes nothing, so version 2's cuts must not appear in the render.
    expect(await renderedDurationS(job.id)).toBeCloseTo(VERSION_1_DURATION_S, 3);
  }, 180_000);
});

describe("export fails closed when the pinned version cannot be honoured", () => {
  it("refuses a job that carries no edit version", async () => {
    await saveVersion2();
    const job = await createExportJob({ filename: "null-version.mp4", editVersion: null });

    const error = await runExportJob(prisma, job).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_MISSING);
    expect((error as ExportFailureError).terminal).toBe(true);
    expect(await prisma.operationalEvent.count({ where: { exportJobId: job.id } })).toBe(0);
  }, 60_000);

  it("refuses a job whose exact version no longer exists", async () => {
    await saveVersion1();
    await saveVersion2();
    const job = await createExportJob({ filename: "missing-version.mp4", editVersion: 99 });

    const error = await runExportJob(prisma, job).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_NOT_FOUND);
    expect((error as ExportFailureError).terminal).toBe(true);
  }, 60_000);

  it("does not spend the remaining attempts re-rendering a deterministic version failure", async () => {
    const job = await createExportJob({ filename: "terminal.mp4", editVersion: 99, attempt: 1 });

    const outcome = await markExportJobFailedOrRetry(prisma, job, {
      code: EXPORT_EDIT_VERSION_NOT_FOUND,
      message: "The saved version is no longer available.",
      terminal: true,
    });

    expect(outcome).toBe("FAILED");
    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.state).toBe(ProcessingJobState.FAILED);
    expect(stored.errorCode).toBe(EXPORT_EDIT_VERSION_NOT_FOUND);
    expect(stored.attempt).toBe(1);
  }, 60_000);
});

describe("enqueue keeps the stored version and the idempotency key in agreement", () => {
  it("writes the version it encodes into the key", async () => {
    const job = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "agreement.mp4",
      editVersion: 7,
    });

    const stored = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.editVersion).toBe(7);
    expect(parseExportIdempotencyKeyVersion(stored.idempotencyKey)).toBe(7);
    expect(stored.idempotencyKey).toBe(
      buildExportIdempotencyKey({ clipId, editVersion: 7, filename: "agreement.mp4" }),
    );
  });

  it("gives a second request for a newer version its own job rather than reusing the pinned one", async () => {
    const first = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "distinct.mp4",
      editVersion: 1,
    });
    const second = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "distinct.mp4",
      editVersion: 2,
    });

    expect(second.id).not.toBe(first.id);
    expect(first.editVersion).toBe(1);
    expect(second.editVersion).toBe(2);
  });
});
