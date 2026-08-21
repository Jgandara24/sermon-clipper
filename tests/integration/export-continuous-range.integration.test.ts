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
import { restoreAllDeletedWords } from "@/lib/editor/transcript";
import { buildDefaultEditorState, wordId, type EditorState } from "@/lib/editor/types";
import { CONTINUOUS_RANGE_REQUIRED } from "@/lib/exports/continuous-range";
import { ExportFailureError } from "@/lib/exports/errors";
import { runExportJob } from "@/lib/exports/handler";
import { enqueueExportJob, requeueFailedExportJob } from "@/lib/exports/queue";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;
let sourceVideoId: string;
let segmentId: string;
let clipId: string;

const CLIP_START_MS = 0;
const CLIP_END_MS = 4000;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTinySourceVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function createExportJob(params: {
  filename: string;
  editVersion: number;
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

function baseState(): EditorState {
  return buildDefaultEditorState({
    sourceVideoId,
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
  });
}

/** A document from when the editor could cut words out of the middle of a clip. */
function legacyCutState(version: number): EditorState {
  const base = baseState();
  return {
    ...base,
    version,
    wordEdits: {
      ...base.wordEdits,
      deletedWordIds: [2, 3, 4].map((index) => wordId(segmentId, index)),
    },
  };
}

async function saveVersion(version: number, state: EditorState) {
  return prisma.clipEdit.upsert({
    where: { clipId_version: { clipId, version } },
    update: { editorState: state as unknown as Prisma.InputJsonValue },
    create: {
      clipId,
      version,
      savedBy: userId,
      editorState: state as unknown as Prisma.InputJsonValue,
    },
  });
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "continuous-range-storage");

  const user = await prisma.user.create({
    data: { email: `${uniqueKey("continuous")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Continuous Range Gate",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  const storageKey = `continuous-range/${workspaceId}/source.mp4`;
  const storage = getStorageProvider();
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "continuous-range-source.mp4",
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
      name: "Continuous Range Sermon",
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
      summary: "A sermon moment used to exercise the continuous-range export gate.",
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

describe("the worker refuses to deliver a shortened export", () => {
  it("fails a pinned document that still cuts words out of the middle", async () => {
    await saveVersion(1, legacyCutState(1));
    const job = await createExportJob({ filename: "cut-v1.mp4", editVersion: 1 });

    const error = await runExportJob(prisma, job).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(CONTINUOUS_RANGE_REQUIRED);
  }, 60_000);

  it("fails terminally, so the refusal is not retried into the attempt budget", async () => {
    await saveVersion(1, legacyCutState(1));
    const job = await createExportJob({ filename: "cut-terminal.mp4", editVersion: 1 });

    const error = await runExportJob(prisma, job).catch((thrown: unknown) => thrown);

    expect((error as ExportFailureError).terminal).toBe(true);
    expect((error as ExportFailureError).userMessage).toMatch(/Restore all deleted words/);
  }, 60_000);

  it("starts no render work at all for a refused export", async () => {
    await saveVersion(1, legacyCutState(1));
    const job = await createExportJob({ filename: "cut-no-work.mp4", editVersion: 1 });

    const filesBefore = await prisma.exportedFile.count();

    await runExportJob(prisma, job).catch(() => null);

    // Cost facts are recorded as the render proceeds. None means the source was never downloaded,
    // never probed, and ffmpeg was never started.
    expect(await prisma.operationalEvent.count({ where: { exportJobId: job.id } })).toBe(0);
    expect(await prisma.exportedFile.count()).toBe(filesBefore);
  }, 60_000);

  it("still refuses when an old job is retried", async () => {
    await saveVersion(1, legacyCutState(1));

    // A job queued before the rule existed, failed for some other reason, and requeued.
    const job = await enqueueExportJob(prisma, {
      clipId,
      workspaceId,
      filename: "cut-retry.mp4",
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
    expect((await requeueFailedExportJob(prisma, job.id)).count).toBe(1);

    const claimed = await prisma.exportJob.update({
      where: { id: job.id },
      data: { state: ProcessingJobState.RUNNING, attempt: 2, startedAt: new Date() },
    });
    const filesBefore = await prisma.exportedFile.count();
    const error = await runExportJob(prisma, claimed).catch((thrown: unknown) => thrown);

    // The retry is pinned to the same cut document, so it reaches the same answer.
    expect((error as ExportFailureError).code).toBe(CONTINUOUS_RANGE_REQUIRED);
    expect(await prisma.exportedFile.count()).toBe(filesBefore);
    expect(await prisma.operationalEvent.count({ where: { exportJobId: job.id } })).toBe(0);
  }, 60_000);

  it("leaves the stored document alone rather than quietly repairing it", async () => {
    await saveVersion(1, legacyCutState(1));
    const job = await createExportJob({ filename: "cut-untouched.mp4", editVersion: 1 });

    await runExportJob(prisma, job).catch(() => null);

    const stored = await prisma.clipEdit.findUniqueOrThrow({
      where: { clipId_version: { clipId, version: 1 } },
    });
    // Word ids are positional; a silent rewrite could repoint them. Restoring is the user's call.
    expect(
      (stored.editorState as unknown as EditorState).wordEdits.deletedWordIds,
    ).toHaveLength(3);
  }, 60_000);
});

describe("export succeeds once the user restores the words", () => {
  it("renders the restored version", async () => {
    await saveVersion(1, legacyCutState(1));
    // What "Restore all deleted words" saves: a new version, made by the user, with the cuts gone.
    await saveVersion(2, { ...restoreAllDeletedWords(legacyCutState(1)), version: 2 });

    const job = await createExportJob({ filename: "restored-v2.mp4", editVersion: 2 });
    const outputFileId = await runExportJob(prisma, job);

    expect(outputFileId).toEqual(expect.any(String));
    const rendered = await prisma.exportedFile.findUniqueOrThrow({ where: { id: outputFileId } });
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1920);
  }, 180_000);

  it("renders the whole clip, not the shortened one", async () => {
    await saveVersion(2, { ...restoreAllDeletedWords(legacyCutState(1)), version: 2 });

    const job = await createExportJob({ filename: "restored-length.mp4", editVersion: 2 });
    await runExportJob(prisma, job);

    const facts = await prisma.operationalEvent.findMany({
      where: { exportJobId: job.id, eventType: "processing_cost_fact" },
    });
    const render = facts.find((fact) => (fact.metadata as { stage: string }).stage === "render");
    // The three cuts removed 1,300 ms between them; the restored clip is the full four seconds.
    expect(Number((render?.metadata as { quantity: number }).quantity)).toBeCloseTo(4, 3);
  }, 180_000);
});
