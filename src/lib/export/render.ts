import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegPath as resolveFfmpegPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";

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
  fontsDir?: string,
): string {
  const { x, y, w, h } = cropPixels;
  const assOption = escapeForFilterGraph(assFilePath);
  // fontsdir makes libass resolve the ASS Fontname against our shipped TTFs directly —
  // deterministic on any host, independent of what fontconfig happens to have registered
  // (the worker image registers them too, as belt and braces).
  const fontsOption = fontsDir ? `:fontsdir='${escapeForFilterGraph(fontsDir)}'` : "";
  return (
    `crop=${w}:${h}:${x}:${y},` +
    `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,` +
    `crop=${outputWidth}:${outputHeight},` +
    `subtitles=filename='${assOption}'${fontsOption}`
  );
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  try {
    await execFileWithTimeout(ffmpegPath, args, {
      maxBuffer: 1024 * 1024 * 64,
      // Single encode pass; clip exports are seconds-to-minutes of output, so a pass that runs
      // this long is wedged, not slow.
      timeoutMs: envTimeoutMs("EXPORT_FFMPEG_TIMEOUT_MS", 900_000),
    });
  } catch (error) {
    throw new RenderError(`ffmpeg failed: ${(error as Error).message}`);
  }
}

export type RenderClipExportParams = {
  sourceFilePath: string;
  /** The clip's single continuous source range (P1.5: deliverables never contain internal cuts). */
  sourceStartMs: number;
  sourceEndMs: number;
  cropPixels: { x: number; y: number; w: number; h: number };
  assFileContent: string;
  /** Directory of the caption TTFs, passed to libass as fontsdir. */
  fontsDir: string;
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
};

/**
 * Renders a clip export as ONE ffmpeg pass over one continuous source range: seek → crop →
 * scale → subtitles burn → loudnorm → x264/AAC encode. The former multi-range extract+concat
 * pipeline (word-level internal cuts) was retired by P1.5 — deliverables select a range of the
 * sermon, they don't rewrite it — which also removed two of the three encode passes.
 */
export async function renderClipExport(params: RenderClipExportParams): Promise<void> {
  const durationMs = params.sourceEndMs - params.sourceStartMs;
  if (durationMs <= 0) {
    throw new RenderError("The clip's source range is empty — nothing to render.");
  }

  const ffmpegPath = resolveFfmpegPath();
  const workDir = await mkdtemp(path.join(tmpdir(), "sermon-clipper-export-"));

  try {
    const assFilePath = path.join(workDir, "captions.ass");
    await writeFile(assFilePath, params.assFileContent, "utf8");

    await mkdir(path.dirname(params.outputPath), { recursive: true });
    await runFfmpeg(ffmpegPath, [
      "-y",
      // Input seeking (-ss before -i) is frame-accurate here because the stream is re-encoded,
      // and avoids decoding everything before the clip start.
      "-ss",
      (params.sourceStartMs / 1000).toFixed(3),
      "-i",
      params.sourceFilePath,
      "-t",
      (durationMs / 1000).toFixed(3),
      "-vf",
      buildExportFilterGraph(
        params.cropPixels,
        params.outputWidth,
        params.outputHeight,
        assFilePath,
        params.fontsDir,
      ),
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
