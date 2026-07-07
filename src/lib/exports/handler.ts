import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExportJob, PrismaClient } from "@prisma/client";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { buildDefaultEditorState, type EditorState } from "@/lib/editor/types";
import { applyEditorDeletions, flattenWords, wordsInRange } from "@/lib/editor/words";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { parseLowerThird } from "@/lib/brand-template";
import { cropRectToPixels, resolveCropRect } from "@/lib/export/crop";
import { computeKeptRanges, mapToKeptTimeline } from "@/lib/export/kept-ranges";
import { renderClipExport } from "@/lib/export/render";
import { probeVideoFile } from "@/lib/media/probe";
import { getStorageProvider } from "@/lib/storage";

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
    words: segment.words as Array<{
      word: string;
      startMs: number;
      endMs: number;
      confidence: number;
      isFiller: boolean;
      deleted: boolean;
    }>,
  }));

  const allWords = flattenWords(segments);
  const wordsInClip = applyEditorDeletions(
    wordsInRange(allWords, state.source.startMs, state.source.endMs),
    state,
  );

  const keptRanges = computeKeptRanges(wordsInClip, state.source.startMs, state.source.endMs);
  if (keptRanges.length === 0) {
    throw new ExportFailureError("RENDER_FAILED", "Export failed on our side — your clip is safe.");
  }

  const cropRect = resolveCropRect(state.layout, sourceVideo.width, sourceVideo.height);
  const cropPixels = cropRectToPixels(cropRect, sourceVideo.width, sourceVideo.height);

  const activeWords = wordsInClip.filter((word) => !word.effectiveDeleted);
  const captionLines = applyCaptionTextOverrides(
    buildCaptionLines(
      activeWords.map((word) => ({
        id: word.id,
        word: word.word,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    ),
    state.captions.textOverrides,
  ).map((line) => ({
    ...line,
    // Caption timestamps are on the original source timeline; remap to the concatenated
    // (post-cut) output timeline the rendered file actually plays on.
    startMs: mapToKeptTimeline(line.startMs, keptRanges),
    endMs: mapToKeptTimeline(line.endMs, keptRanges),
  }));

  const style = resolveCaptionStyle(state.captions.presetId, state.captions.overrides);
  const brandTemplate = state.brandTemplateId
    ? await prisma.brandTemplate.findFirst({
        where: { id: state.brandTemplateId, workspaceId: job.workspaceId },
      })
    : null;
  const lowerThird = brandTemplate ? parseLowerThird(brandTemplate.lowerThird) : null;
  const assContent = generateAssSubtitles(
    captionLines,
    style,
    OUTPUT_WIDTH,
    OUTPUT_HEIGHT,
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
  );

  const storage = getStorageProvider();
  const exportsKey = `exports/${job.workspaceId}/${job.id}.mp4`;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sermon-export-"));
  const sourceFilePath = path.join(workDir, "source-video");
  const outputPath = path.join(workDir, "output.mp4");
  let probeResult: Awaited<ReturnType<typeof probeVideoFile>> | null;
  let bytes: number;
  let checksum: string;

  try {
    await storage.downloadToFile(sourceVideo.storageKey, sourceFilePath);
    await renderClipExport({
      sourceFilePath,
      keptRanges,
      cropPixels,
      assFileContent: assContent,
      outputPath,
      outputWidth: OUTPUT_WIDTH,
      outputHeight: OUTPUT_HEIGHT,
    });
    await storage.uploadFile(exportsKey, outputPath, "video/mp4");
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
