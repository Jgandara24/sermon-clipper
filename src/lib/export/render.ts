import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegPath as resolveFfmpegPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import { rangeDurationMs, type TimeRange } from "./output-timeline";

export class RenderError extends Error {}

/** Escapes a filesystem path for use inside an ffmpeg filtergraph option value. */
function escapeForFilterGraph(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

/**
 * Pure filtergraph builder (guide §14: "renderer consumes only the state document (pure
 * function of state → filtergraph)"): crop to the resolved rect, scale-and-fill to the exact
 * output size (avoids distortion if the crop box isn't precisely 9:16), then burn captions.
 */
export function buildExportFilterGraph(
  cropPixels: { x: number; y: number; w: number; h: number },
  outputWidth: number,
  outputHeight: number,
  assFilePath: string,
): string {
  const { x, y, w, h } = cropPixels;
  const assOption = escapeForFilterGraph(assFilePath);
  return (
    `crop=${w}:${h}:${x}:${y},` +
    `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,` +
    `crop=${outputWidth}:${outputHeight},` +
    `subtitles=filename='${assOption}'`
  );
}

const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

/**
 * The audio chain: loudness normalisation, then the clip's original volume as a gain.
 *
 * After, not before: `loudnorm` brings the programme to a fixed target, so a gain ahead of it
 * would be undone by it. Applied after, "half as loud" is half as loud in the file — the same
 * thing it is in the preview, which sets the video element's volume to the same factor. Only
 * written when it is not 1, so a document that never touched the control renders exactly the
 * bytes it always did.
 */
export function buildExportAudioFilter(originalVolume: number | undefined): string {
  if (originalVolume === undefined || !Number.isFinite(originalVolume)) return LOUDNORM;
  const volume = Math.min(2, Math.max(0, originalVolume));
  return volume === 1 ? LOUDNORM : `${LOUDNORM},volume=${volume}`;
}

export type ExportFfmpegArgsParams = {
  sourceFilePath: string;
  /** The one span of the source the file contains, on the source timeline. */
  range: TimeRange;
  cropPixels: { x: number; y: number; w: number; h: number };
  assFilePath: string;
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
  /** The document's `audio.originalVolume`. Absent means 1, which writes no filter at all. */
  originalVolume?: number;
};

/**
 * The whole render as one ffmpeg invocation, pure so a test can read it without running it.
 *
 * `-ss` before `-i` seeks the source and, because the output is transcoded, decodes from the
 * keyframe before the seek point and discards up to it — a frame-accurate cut, which a stream
 * copy could not make. It also restarts the clock: the first frame out is at zero, which is the
 * timeline the subtitle script is written on. `-t` closes the file at the range's length. The
 * filter graph then crops, fills, burns the captions and normalises the audio in the same pass,
 * and the encode is the one the deliverable always had: x264 medium at CRF 18, AAC at 192k, the
 * index moved to the front for playback that starts before the download finishes.
 */
export function buildExportFfmpegArgs(params: ExportFfmpegArgsParams): string[] {
  return [
    "-y",
    "-ss",
    (params.range.startMs / 1000).toFixed(3),
    "-i",
    params.sourceFilePath,
    "-t",
    (rangeDurationMs(params.range) / 1000).toFixed(3),
    "-vf",
    buildExportFilterGraph(
      params.cropPixels,
      params.outputWidth,
      params.outputHeight,
      params.assFilePath,
    ),
    "-af",
    buildExportAudioFilter(params.originalVolume),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    params.outputPath,
  ];
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  try {
    await execFileWithTimeout(ffmpegPath, args, {
      maxBuffer: 1024 * 1024 * 64,
      // One encode pass; clip exports are seconds-to-minutes of output, so a pass that runs
      // this long is wedged, not slow.
      timeoutMs: envTimeoutMs("EXPORT_FFMPEG_TIMEOUT_MS", 900_000),
    });
  } catch (error) {
    throw new RenderError(`ffmpeg failed: ${(error as Error).message}`);
  }
}

export type RenderClipExportParams = Omit<ExportFfmpegArgsParams, "assFilePath"> & {
  assFileContent: string;
};

/**
 * Renders a clip export: one continuous span of the source, in one ffmpeg pass.
 *
 * It used to be three — one re-encode per kept sub-range, a concat, then the final encode —
 * because a document could cut words out of the middle and the file was the surviving pieces
 * spliced together. The continuity gate now refuses such a document before anything is
 * downloaded, so every deliverable is one range and the first two passes only re-encoded the
 * source once more on its way to the third. One pass encodes the source once, which is both
 * faster and a generation better.
 */
export async function renderClipExport(params: RenderClipExportParams): Promise<void> {
  if (rangeDurationMs(params.range) <= 0) {
    throw new RenderError("The clip's range has no duration.");
  }

  const ffmpegPath = resolveFfmpegPath();
  const workDir = await mkdtemp(path.join(tmpdir(), "sermon-clipper-export-"));

  try {
    const assFilePath = path.join(workDir, "captions.ass");
    await writeFile(assFilePath, params.assFileContent, "utf8");
    await mkdir(path.dirname(params.outputPath), { recursive: true });
    await runFfmpeg(ffmpegPath, buildExportFfmpegArgs({ ...params, assFilePath }));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
