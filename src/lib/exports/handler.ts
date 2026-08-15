import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExportJob, PrismaClient } from "@prisma/client";
import { recordProcessingCostFact } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import type { ProcessingCostOutcome } from "@/lib/cost/types";
import { captionFontDir, env } from "@/lib/env";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { hasInternalCuts } from "@/lib/editor/continuous-edit";
import { buildDefaultEditorState, type EditorState } from "@/lib/editor/types";
import { flattenWords, wordsInRange } from "@/lib/editor/words";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { parseLowerThird } from "@/lib/brand-template";
import { cropRectToPixels, resolveCropRect } from "@/lib/export/crop";
import { createFontkitMeasurer } from "@/lib/export/font-metrics";
import { renderClipExport } from "@/lib/export/render";
import { probeVideoFile } from "@/lib/media/probe";
import {
  getStorageProvider,
  storageProviderKind,
  storageTransferCostFact,
} from "@/lib/storage";

export class ExportFailureError extends Error {
  code: string;
  userMessage: string;

  constructor(code: string, userMessage: string, options?: { cause?: unknown }) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function recordExportStorageFact(params: {
  prisma: PrismaClient;
  job: ExportJob;
  projectId: string;
  direction: "download" | "upload";
  bytes: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  const price =
    params.direction === "download"
      ? env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD
      : env.STORAGE_UPLOAD_PRICE_PER_GB_USD;
  await recordProcessingCostFact(params.prisma, {
    ...storageTransferCostFact({
      direction: params.direction,
      bytes: params.bytes,
      provider: storageProviderKind(),
      configuredPricePerGbUsd: price ?? null,
      wallTimeMs: params.wallTimeMs,
      attempt: Math.max(1, params.job.attempt),
      outcome: params.outcome,
    }),
    workspaceId: params.job.workspaceId,
    projectId: params.projectId,
    clipId: params.job.clipId,
    exportJobId: params.job.id,
  });
}

async function recordRenderFact(params: {
  prisma: PrismaClient;
  job: ExportJob;
  projectId: string;
  durationS: number;
  cpuTimeMs: number;
  wallTimeMs: number;
  outcome: ProcessingCostOutcome;
}) {
  await recordProcessingCostFact(params.prisma, {
    stage: "render",
    quantity: params.durationS,
    unit: "second",
    unitCostUsd: 0,
    provider: "ffmpeg",
    model: null,
    providerProvenance: "local_worker_runtime",
    cpuTimeMs: params.cpuTimeMs,
    wallTimeMs: params.wallTimeMs,
    cacheState: "miss",
    attempt: Math.max(1, params.job.attempt),
    outcome: params.outcome,
    workspaceId: params.job.workspaceId,
    projectId: params.projectId,
    clipId: params.job.clipId,
    exportJobId: params.job.id,
  });
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Renders one clip export end to end (guide §15 step 3): loads the clip's latest editor state
 * and transcript, derives kept sub-ranges + crop + captions exactly like the editor preview does
 * (same pure helpers), renders via ffmpeg, then records the resulting file. Returns the new
 * ExportedFile id.
 */
export async function runExportJob(prisma: PrismaClient, job: ExportJob): Promise<string> {
  const clip = await prisma.generatedClip.findUniqueOrThrow({
    where: { id: job.clipId },
    include: {
      project: {
        include: {
          sourceVideo: { include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } } },
        },
      },
    },
  });

  const sourceVideo = clip.project.sourceVideo;
  if (!sourceVideo?.storageKey || sourceVideo.width === null || sourceVideo.height === null) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.");
  }

  const latestEdit = await prisma.clipEdit.findFirst({
    where: { clipId: job.clipId },
    orderBy: { version: "desc" },
  });
  const state: EditorState = latestEdit
    ? (latestEdit.editorState as unknown as EditorState)
    : buildDefaultEditorState({ sourceVideoId: sourceVideo.id, startMs: clip.startMs, endMs: clip.endMs });

  const segments = (sourceVideo.transcript?.segments ?? []).map((segment) => ({
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    timingMode:
      sourceVideo.transcript?.provider === "srt_upload"
        ? ("srt-interpolated" as const)
        : ("measured" as const),
    words: segment.words as Array<{
      word: string;
      startMs: number;
      endMs: number;
      confidence: number;
      isFiller: boolean;
      deleted: boolean;
    }>,
  }));

  // P1.5: deliverables render exactly one continuous range — a clip selects part of the
  // sermon, it never rewrites what was said. Legacy documents still carrying internal word
  // cuts must be converted in the editor first (the exports route rejects them up front; this
  // guard keeps the worker authoritative for jobs that predate the route check).
  if (hasInternalCuts(state)) {
    throw new ExportFailureError(
      "CONTINUOUS_RANGE_REQUIRED",
      "This clip still has word deletions from an older editor. Open it and restore the deleted words, then export.",
    );
  }

  const sourceStartMs = state.source.startMs;
  const sourceEndMs = state.source.endMs;
  if (sourceEndMs <= sourceStartMs) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.");
  }

  const cropRect = resolveCropRect(state.layout, sourceVideo.width, sourceVideo.height);
  const cropPixels = cropRectToPixels(cropRect, sourceVideo.width, sourceVideo.height);

  // Style before lines: it now decides line grouping (maxWordsPerLine) as well as looks.
  const style = resolveCaptionStyle(state.captions.presetId, state.captions.overrides);

  const allWords = flattenWords(segments);
  const clipWords = wordsInRange(allWords, sourceStartMs, sourceEndMs);
  const captionLines = applyCaptionTextOverrides(
    buildCaptionLines(
      clipWords.map((word) => ({
        id: word.id,
        word: word.word,
        startMs: word.startMs,
        // A word whose start lands inside the range may end past the trim-out point; clamp so
        // its caption never outlives the rendered video.
        endMs: Math.min(word.endMs, sourceEndMs),
      })),
      { maxWordsPerLine: style.maxWordsPerLine },
    ),
    state.captions.textOverrides,
  ).map((line) => ({
    ...line,
    // Caption timestamps are on the source timeline; the rendered file starts at the clip's
    // source start, so the output timeline is a single constant offset away. Words carry the
    // per-word highlight timing, so they remap too — dropping them would drift every pop.
    startMs: line.startMs - sourceStartMs,
    endMs: line.endMs - sourceStartMs,
    words: line.words.map((word) => ({
      ...word,
      startMs: word.startMs - sourceStartMs,
      endMs: word.endMs - sourceStartMs,
    })),
  }));

  const brandTemplate = state.brandTemplateId
    ? await prisma.brandTemplate.findFirst({
        where: { id: state.brandTemplateId, workspaceId: job.workspaceId },
      })
    : null;
  const lowerThird = brandTemplate ? parseLowerThird(brandTemplate.lowerThird) : null;
  const assContent = generateAssSubtitles({
    lines: captionLines,
    style,
    videoWidth: OUTPUT_WIDTH,
    videoHeight: OUTPUT_HEIGHT,
    // Measure with the same faces libass resolves via fontconfig — parity depends on it.
    measure: createFontkitMeasurer(captionFontDir()),
    lowerThird:
      brandTemplate && lowerThird
        ? {
            headline: lowerThird.headline || brandTemplate.churchName,
            subhead: lowerThird.subhead || brandTemplate.speakerName || "",
            primaryColor: brandTemplate.primaryColor,
            accentColor: brandTemplate.accentColor,
            startMs: 0,
            endMs: Math.min(4000, Math.max(1000, state.source.endMs - state.source.startMs)),
          }
        : null,
  });

  const storage = getStorageProvider();
  const exportsKey = `exports/${job.workspaceId}/${job.id}.mp4`;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-export-"));
  const sourceFilePath = path.join(workDir, "source-video");
  const outputPath = path.join(workDir, "output.mp4");
  let probeResult: Awaited<ReturnType<typeof probeVideoFile>> | null;
  let bytes: number;
  let checksum: string;
  let sourceBytes = Number(sourceVideo.sizeBytes ?? BigInt(0));
  const outputDurationS = (sourceEndMs - sourceStartMs) / 1_000;

  try {
    const downloadStartedAt = Date.now();
    try {
      await storage.downloadToFile(sourceVideo.storageKey, sourceFilePath);
      if (sourceBytes === 0) sourceBytes = (await stat(sourceFilePath)).size;
    } catch (error) {
      await recordExportStorageFact({
        prisma,
        job,
        projectId: clip.projectId,
        direction: "download",
        bytes: sourceBytes,
        wallTimeMs: Date.now() - downloadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    await recordExportStorageFact({
      prisma,
      job,
      projectId: clip.projectId,
      direction: "download",
      bytes: sourceBytes,
      wallTimeMs: Date.now() - downloadStartedAt,
      outcome: "succeeded",
    });

    const renderStartedAt = startRuntimeMeasurement();
    try {
      await renderClipExport({
        sourceFilePath,
        sourceStartMs,
        sourceEndMs,
        cropPixels,
        assFileContent: assContent,
        fontsDir: captionFontDir(),
        outputPath,
        outputWidth: OUTPUT_WIDTH,
        outputHeight: OUTPUT_HEIGHT,
      });
    } catch (error) {
      await recordRenderFact({
        prisma,
        job,
        projectId: clip.projectId,
        durationS: outputDurationS,
        ...finishRuntimeMeasurement(renderStartedAt),
        outcome: "failed",
      });
      throw error;
    }
    await recordRenderFact({
      prisma,
      job,
      projectId: clip.projectId,
      durationS: outputDurationS,
      ...finishRuntimeMeasurement(renderStartedAt),
      outcome: "succeeded",
    });

    const outputBytes = (await stat(outputPath)).size;
    const uploadStartedAt = Date.now();
    try {
      await storage.uploadFile(exportsKey, outputPath, "video/mp4");
    } catch (error) {
      await recordExportStorageFact({
        prisma,
        job,
        projectId: clip.projectId,
        direction: "upload",
        bytes: outputBytes,
        wallTimeMs: Date.now() - uploadStartedAt,
        outcome: "failed",
      });
      throw error;
    }
    await recordExportStorageFact({
      prisma,
      job,
      projectId: clip.projectId,
      direction: "upload",
      bytes: outputBytes,
      wallTimeMs: Date.now() - uploadStartedAt,
      outcome: "succeeded",
    });
    [probeResult, bytes, checksum] = await Promise.all([
      probeVideoFile(outputPath).catch(() => null),
      storage.size(exportsKey),
      hashFile(outputPath),
    ]);
  } catch (error) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.", {
      cause: error,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const exportedFile = await prisma.exportedFile.create({
    data: {
      storageKey: exportsKey,
      bytes: BigInt(bytes),
      width: probeResult?.width ?? OUTPUT_WIDTH,
      height: probeResult?.height ?? OUTPUT_HEIGHT,
      checksum,
      downloadExpiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS),
    },
  });

  return exportedFile.id;
}
