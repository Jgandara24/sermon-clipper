import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import type { TimeRange } from "./kept-ranges";

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

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  try {
    await execFileWithTimeout(ffmpegPath, args, {
      maxBuffer: 1024 * 1024 * 64,
      // Per encode pass; clip exports are seconds-to-minutes of output, so a pass that runs
      // this long is wedged, not slow.
      timeoutMs: envTimeoutMs("EXPORT_FFMPEG_TIMEOUT_MS", 900_000),
    });
  } catch (error) {
    throw new RenderError(`ffmpeg failed: ${(error as Error).message}`);
  }
}

export type RenderClipExportParams = {
  sourceFilePath: string;
  keptRanges: TimeRange[];
  cropPixels: { x: number; y: number; w: number; h: number };
  assFileContent: string;
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
};

/**
 * Renders a clip export per guide §15 step 3: sub-range extraction (+concat for word-deletes)
 * → crop → scale → subtitles burn → loudnorm → x264/AAC encode. Three ffmpeg passes rather than
 * one filter_complex graph — simpler to reason about and debug, at the cost of one extra
 * encode; acceptable for short (seconds-to-minutes) clip exports.
 */
export async function renderClipExport(params: RenderClipExportParams): Promise<void> {
  if (params.keptRanges.length === 0) {
    throw new RenderError("Nothing survived the edits — every word in this clip was deleted.");
  }

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const workDir = await mkdtemp(path.join(tmpdir(), "sermon-clipper-export-"));

  try {
    // Pass 1: extract + re-encode each kept sub-range for frame-accurate cuts (stream copy can
    // only cut at keyframes, which isn't precise enough for word-level deletes).
    const segmentPaths: string[] = [];
    for (const [index, range] of params.keptRanges.entries()) {
      const segmentPath = path.join(workDir, `seg-${index}.mp4`);
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-ss",
        (range.startMs / 1000).toFixed(3),
        "-i",
        params.sourceFilePath,
        "-t",
        ((range.endMs - range.startMs) / 1000).toFixed(3),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-avoid_negative_ts",
        "make_zero",
        segmentPath,
      ]);
      segmentPaths.push(segmentPath);
    }

    // Pass 2: concat via the concat demuxer — all segments share identical encode params, so a
    // stream copy concat is lossless and fast even with just one segment (the no-deletes case).
    const concatListPath = path.join(workDir, "concat.txt");
    await writeFile(
      concatListPath,
      segmentPaths.map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const concatenatedPath = path.join(workDir, "concatenated.mp4");
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      concatenatedPath,
    ]);

    // Pass 3: crop/scale/caption-burn/loudnorm in one final encode.
    const assFilePath = path.join(workDir, "captions.ass");
    await writeFile(assFilePath, params.assFileContent, "utf8");

    await mkdir(path.dirname(params.outputPath), { recursive: true });
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      concatenatedPath,
      "-vf",
      buildExportFilterGraph(params.cropPixels, params.outputWidth, params.outputHeight, assFilePath),
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
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
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
