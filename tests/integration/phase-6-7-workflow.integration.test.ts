import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AuthProvider,
  ClipApprovalState,
  ExportPreset,
  GeneratedClipStatus,
  Prisma,
  PrismaClient,
  ProcessingJobState,
  ProcessingJobType,
  ProjectStatus,
  SourceOrigin,
  WorkspaceRole,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalStateAfterEditorSave, isClipApprovedForExport } from "@/lib/approval";
import { buildDefaultEditorState, wordId } from "@/lib/editor/types";
import { probeVideoFile } from "@/lib/media/probe";
import { markExportJobSucceeded } from "@/lib/exports/queue";
import { runExportJob } from "@/lib/exports/handler";
import { runOnePendingJob } from "@/lib/jobs/runner";
import { createProjectFromUploadedSourceVideo } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const LOCAL_TINY_WHISPER_MODEL = path.join(process.cwd(), ".data", "models", "ggml-tiny.en.bin");

let userId: string;
let workspaceId: string;
let projectId: string;
let sourceVideoId: string;
let clipId: string;
let storageKey: string;
let exportJobId: string;

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

async function createSpokenSermonVideo(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tmpDir = path.join(path.dirname(outputPath), uniqueKey("tts"));
  await mkdir(tmpDir, { recursive: true });
  const aiffPath = path.join(tmpDir, "sermon.aiff");
  const script = [
    "John fourteen says peace stays with us because Jesus tells the church not to let their hearts be troubled.",
    "This complete sermon moment teaches hope, prayer, grace, and pastoral comfort for anxious people.",
    "John fourteen gives the church a clear promise from Jesus, and that promise is useful for a short clip.",
    "The point is simple, biblical, pastoral, and ready for a church member to share with a friend.",
  ].join(" ");

  try {
    await execFileAsync("say", ["-o", aiffPath, script]);
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1280x720:rate=30:duration=60",
      "-i",
      aiffPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      outputPath,
    ]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "integration-storage");

  const user = await prisma.user.create({
    data: {
      email: `${uniqueKey("phase-67-workflow")}@example.com`,
      authProvider: AuthProvider.DEV,
    },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: "Phase 6 7 Workflow Test",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("60.00"),
    },
  });
  workspaceId = workspace.id;

  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: WorkspaceRole.OWNER },
  });

  storageKey = `integration/${workspace.id}/source.mp4`;
  const storage = getStorageProvider();
  await createTinySourceVideo(storage.absolutePath(storageKey));

  const sourceVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId,
      origin: SourceOrigin.UPLOAD,
      filename: "workflow-source.mp4",
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
      name: "Workflow Sermon",
      status: ProjectStatus.READY,
      processingConfig: { genre: "sermon" },
    },
  });
  projectId = project.id;

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
      endMs: 4000,
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

  const clip = await prisma.generatedClip.create({
    data: {
      workspaceId,
      projectId,
      rank: 1,
      startMs: 0,
      endMs: 4000,
      title: "Peace Stays With Us",
      hookText: "Peace stays",
      summary: "A short sermon moment with a scripture reference and pastoral application.",
      status: GeneratedClipStatus.SUGGESTED,
    },
  });
  clipId = clip.id;

  await prisma.clipScore.create({
    data: {
      workspaceId,
      clipId,
      total: 91,
      modelVersion: "integration-fixture",
      excerpt: "John 14 says peace stays with us.",
      subscores: {
        biblical_usefulness: { score: 92, letter: "A-", note: "References John 14." },
        theological_clarity: { score: 90, letter: "A-", note: "Clear and self-contained." },
        pastoral_tone: { score: 91, letter: "A-", note: "Encouraging tone." },
        scripture_relevance: { score: 95, letter: "A", note: "Detected John 14." },
      },
    },
  });

  await prisma.scriptureReference.create({
    data: {
      workspaceId,
      projectId,
      clipId,
      detectedText: "John 14",
      normalized: "John 14",
      book: "John",
      chapterStart: 14,
      confidence: new Prisma.Decimal("0.80"),
    },
  });

  const template = await prisma.brandTemplate.create({
    data: {
      workspaceId,
      name: "Sunday Sermon",
      churchName: "Workflow Church",
      speakerName: "Pastor Test",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      captionPresetId: "clean",
      lowerThird: { headline: "Workflow Church", subhead: "Sunday message", showSpeaker: true },
      isDefault: true,
    },
  });

  const editorState = buildDefaultEditorState({ sourceVideoId, startMs: 0, endMs: 4000 });
  await prisma.clipEdit.create({
    data: {
      clipId,
      version: 1,
      isAutosave: false,
      savedBy: userId,
      editorState: {
        ...editorState,
        version: 1,
        brandTemplateId: template.id,
        wordEdits: { ...editorState.wordEdits, deletedWordIds: [wordId(segment.id, 2)] },
        captions: {
          ...editorState.captions,
          presetId: template.captionPresetId,
          overrides: { ...editorState.captions.overrides, highlightColor: template.accentColor },
        },
        overlays: [{ type: "lowerThird", templateId: template.id, startMs: 0, endMs: 4000 }],
      },
    },
  });

  await prisma.clipApproval.create({
    data: {
      workspaceId,
      clipId,
      requesterId: userId,
      state: ClipApprovalState.APPROVED,
      reviewToken: uniqueKey("review-token"),
      reviewTokenExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      approverName: "Pastor Test",
      decidedAt: new Date(),
    },
  });
});

afterAll(async () => {
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) {
    await prisma.user.delete({ where: { id: userId } });
  }
  if (process.env.STORAGE_LOCAL_ROOT) {
    await rm(process.env.STORAGE_LOCAL_ROOT, { recursive: true, force: true });
  }
  await prisma.$disconnect();
});

describe("Phase 6/7 reviewed branded export workflow", () => {
  it("renders an approved, branded, transcript-edited vertical MP4", async () => {
    const approval = await prisma.clipApproval.findUniqueOrThrow({ where: { clipId } });
    expect(isClipApprovedForExport(approval.state)).toBe(true);

    const job = await prisma.exportJob.create({
      data: {
        clipId,
        workspaceId,
        preset: ExportPreset.MP4_1080,
        state: ProcessingJobState.RUNNING,
        filename: "workflow-export.mp4",
        idempotencyKey: uniqueKey("workflow-export"),
        attempt: 1,
        startedAt: new Date(),
      },
    });
    exportJobId = job.id;

    const outputFileId = await runExportJob(prisma, job);
    await markExportJobSucceeded(prisma, job.id, outputFileId);

    const completed = await prisma.exportJob.findUniqueOrThrow({
      where: { id: exportJobId },
      include: { outputFile: true },
    });
    expect(completed.state).toBe(ProcessingJobState.SUCCEEDED);
    expect(completed.outputFile).not.toBeNull();
    expect(completed.outputFile?.width).toBe(1080);
    expect(completed.outputFile?.height).toBe(1920);
    expect(Number(completed.outputFile?.bytes ?? 0)).toBeGreaterThan(0);

    const storage = getStorageProvider();
    const renderedPath = storage.absolutePath(completed.outputFile!.storageKey);
    const probe = await probeVideoFile(renderedPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.durationS).toBeGreaterThan(0);
  }, 120_000);

  it("invalidates approval after a subsequent editor save policy decision", () => {
    expect(approvalStateAfterEditorSave(ClipApprovalState.APPROVED)).toBe(ClipApprovalState.DRAFT);
  });

  it("records transcription provider metadata in operational events", async () => {
    const storage = getStorageProvider();
    const srtKey = `integration/${workspaceId}/${uniqueKey("transcript")}.srt`;
    await writeFile(
      storage.absolutePath(srtKey),
      "1\n00:00:00,000 --> 00:00:04,000\nJohn 14 says peace stays with us.\n",
    );

    const sourceVideo = await prisma.sourceVideo.create({
      data: {
        workspaceId,
        origin: SourceOrigin.UPLOAD,
        filename: "srt-override.mp4",
        durationS: new Prisma.Decimal("4.00"),
        sizeBytes: BigInt(1024),
        language: "en",
        srtOverrideKey: srtKey,
      },
    });

    const project = await prisma.project.create({
      data: {
        workspaceId,
        sourceVideoId: sourceVideo.id,
        name: "SRT Override Sermon",
        status: ProjectStatus.PROCESSING,
        processingConfig: { genre: "sermon" },
      },
    });

    const job = await prisma.processingJob.create({
      data: {
        projectId: project.id,
        type: ProcessingJobType.TRANSCRIBE,
        idempotencyKey: uniqueKey("srt-transcribe"),
      },
    });

    await expect(runOnePendingJob()).resolves.toBe(true);

    const event = await prisma.operationalEvent.findFirstOrThrow({
      where: { jobId: job.id, eventType: "processing_job_succeeded" },
    });
    expect(event.category).toBe("transcription");
    expect(event.metadata).toMatchObject({
      type: "TRANSCRIBE",
      provider: "srt_upload",
      language: "en",
      source: "srt_override",
      segmentCount: 1,
      wordCount: 7,
    });
  });

  it.skipIf(!existsSync(LOCAL_TINY_WHISPER_MODEL))(
    "turns an uploaded spoken sermon video into ranked scripture-aware clips without an SRT override",
    async () => {
      process.env.WHISPER_MODEL_PATH = LOCAL_TINY_WHISPER_MODEL;
      process.env.WHISPER_CPP_BINARY = process.env.WHISPER_CPP_BINARY ?? "whisper-cli";

      const storage = getStorageProvider();
      const asrStorageKey = `integration/${workspaceId}/spoken-sermon.mp4`;
      await createSpokenSermonVideo(storage.absolutePath(asrStorageKey));

      const sourceVideo = await prisma.sourceVideo.create({
        data: {
          workspaceId,
          origin: SourceOrigin.UPLOAD,
          filename: "spoken-sermon.mp4",
          sizeBytes: BigInt(await storage.size(asrStorageKey)),
          storageKey: asrStorageKey,
          language: "en",
        },
      });

      const project = await createProjectFromUploadedSourceVideo(
        prisma,
        workspaceId,
        {
          sourceVideoId: sourceVideo.id,
          name: "Uploaded Spoken Sermon",
          series: "Peace Series",
          speaker: "Pastor Test",
        },
        userId,
      );

      for (let i = 0; i < 6; i += 1) {
        const processed = await runOnePendingJob();
        if (!processed) break;
      }

      const completed = await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        include: {
          sourceVideo: { include: { transcript: { include: { segments: true } } } },
          generatedClips: {
            orderBy: { rank: "asc" },
            include: { score: true, scriptureReferences: true },
          },
          processingJobs: { orderBy: { createdAt: "asc" } },
        },
      });

      expect(completed.status).toBe(ProjectStatus.READY);
      expect(completed.sourceVideo?.durationS?.toNumber()).toBeGreaterThan(20);
      expect(completed.sourceVideo?.transcript?.provider).toBe("whisper_cpp");
      expect(completed.sourceVideo?.transcript?.fullText.toLowerCase()).toContain("john 14");
      expect(completed.generatedClips.length).toBeGreaterThan(0);
      expect(completed.generatedClips[0].rank).toBe(1);
      expect(completed.generatedClips[0].score?.subscores).toMatchObject({
        biblical_usefulness: expect.any(Object),
        theological_clarity: expect.any(Object),
        pastoral_tone: expect.any(Object),
        scripture_relevance: expect.any(Object),
      });
      expect(completed.generatedClips[0].scriptureReferences.map((ref) => ref.normalized)).toContain("John 14");
      expect(completed.processingJobs.map((job) => job.state)).toEqual([
        ProcessingJobState.SUCCEEDED,
        ProcessingJobState.SUCCEEDED,
        ProcessingJobState.SUCCEEDED,
        ProcessingJobState.SUCCEEDED,
      ]);
    },
    120_000,
  );
});
