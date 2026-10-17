import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "@/lib/env";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { rangeEvidenceSha256 } from "./range-evidence";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { extractRepresentativeFrames, representativeFrameSettingsSchema, type RepresentativeFrameInput } from "./representative-frames";

export const PROXY_VIEW_VERSION = "proxy-contact-sheet-v2";
const coordinate = z.number().int().nonnegative().safe();
/** Registry metadata may contain additional publication fields. Preserve only the image map. */
export const proxyViewEvidenceSchema = z.object({
  version: z.literal(PROXY_VIEW_VERSION), kind: z.enum(["TIMELINE_VIEW", "BOUNDARY_STRIP"]),
  proxySha256: sha256Schema, sourceInterval: sourceIntervalSchema,
  width: coordinate.positive(), height: coordinate.positive(), emptyCells: coordinate,
  coverage: z.literal("sampled-instants-only"), toolchainSha256: sha256Schema, decodedProofSha256: sha256Schema,
  cells: z.array(z.object({ index: coordinate, sourceTimeMs: coordinate, x: coordinate, y: coordinate,
    width: coordinate.positive(), height: coordinate.positive(), frameSha256: sha256Schema,
    originalBgraSha256: sha256Schema }).strict()).min(1).max(64),
}).superRefine((value, context) => {
  const first = value.cells[0];
  if (!first) return; // The array length constraint reports this failure.
  const columns = value.width / first.width, rows = value.height / first.height;
  if (!Number.isInteger(columns) || columns < 1 || columns > 16 || !Number.isInteger(rows) || rows < 1 ||
    rows !== Math.ceil(value.cells.length / columns) || columns > value.cells.length ||
    value.emptyCells !== columns * rows - value.cells.length || value.width * value.height > 64000000 ||
    !Number.isSafeInteger(value.sourceInterval.endMs) || value.sourceInterval.startMs !== first.sourceTimeMs ||
    value.sourceInterval.endMs !== value.cells.at(-1)!.sourceTimeMs + 1 ||
    value.cells.some((cell, index) => cell.index !== index || cell.width !== first.width || cell.height !== first.height ||
      cell.x !== index % columns * first.width || cell.y !== Math.floor(index / columns) * first.height ||
      (index > 0 && cell.sourceTimeMs <= value.cells[index - 1].sourceTimeMs))) {
    context.addIssue({ code: "custom", message: "PROXY_VIEW_CELL_MAP_INVALID" });
  }
});
export const proxyViewRequestSchema = z.object({
  kind: z.enum(["TIMELINE_VIEW", "BOUNDARY_STRIP"]),
  sourceTimesMs: z.array(z.number().int().nonnegative().safe()).min(1).max(64),
  columns: z.number().int().min(1).max(16), tileHeight: z.number().int().min(16).max(480),
  maxPixels: z.number().int().positive().max(64000000), maxFileBytes: z.number().int().positive().safe(),
  frames: representativeFrameSettingsSchema,
}).strict();
export type ProxyViewRequest = z.infer<typeof proxyViewRequestSchema>;

/** Explicit source-time samples only. The cell map does not claim continuous visual coverage. */
export async function buildProxyView(input: RepresentativeFrameInput, requestInput: ProxyViewRequest, outputRoot: string) {
  const request = proxyViewRequestSchema.parse(requestInput);
  if (request.columns > request.sourceTimesMs.length) throw new Error("PROXY_VIEW_EMPTY_COLUMNS");
  const selected = await extractRepresentativeFrames(input, request.sourceTimesMs, outputRoot, request.frames);
  try {
    const first = selected.frames[0];
    const tileWidth = Math.round(first.width * request.tileHeight / first.height / 2) * 2;
    const rows = Math.ceil(selected.frames.length / request.columns);
    const width = tileWidth * request.columns, height = rows * request.tileHeight;
    if (tileWidth < 2 || width * height > request.maxPixels) throw new Error("PROXY_VIEW_PIXEL_LIMIT_EXCEEDED");
    const output = path.join(selected.directory, "view.webp");
    const limits = { timeoutMs: request.frames.timeoutMs, maxBuffer: request.frames.maxOutputBytes };
    await execFileWithTimeout(ffmpegPath(), ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe",
      "-threads", String(request.frames.threads), "-framerate", "1", "-i", path.join(selected.directory, "frame-%06d.webp"),
      "-vf", `scale=${tileWidth}:${request.tileHeight},tile=${request.columns}x${rows}:nb_frames=${selected.frames.length}:color=black,format=rgb24`,
      "-frames:v", "1", "-an", "-c:v", "libwebp", "-lossless", "1", "-quality", String(request.frames.quality),
      "-threads", String(request.frames.threads), output], limits);
    const identity = await fileIdentity(output);
    if (identity.byteCount > request.maxFileBytes) throw new Error("PROXY_VIEW_FILE_LIMIT_EXCEEDED");
    const { stdout } = await execFileWithTimeout(ffmpegPath(), ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-threads", String(request.frames.threads), "-i", output, "-vf", "format=bgra", "-c:v", "rawvideo",
      "-threads", String(request.frames.threads), "-f", "framehash", "-hash", "sha256", "pipe:1"], limits);
    const dimensions = /^#dimensions 0:\s*(\d+)x(\d+)\s*$/m.exec(stdout);
    const frames = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
    if (!dimensions || Number(dimensions[1]) !== width || Number(dimensions[2]) !== height || frames.length !== 1) {
      throw new Error("PROXY_VIEW_OUTPUT_INVALID");
    }
    const cells = selected.frames.map((frame, index) => ({ index, sourceTimeMs: frame.sourceTimeMs,
      x: (index % request.columns) * tileWidth, y: Math.floor(index / request.columns) * request.tileHeight,
      width: tileWidth, height: request.tileHeight, frameSha256: frame.sha256, originalBgraSha256: frame.bgraSha256 }));
    const sourceInterval = { startMs: request.sourceTimesMs[0], endMs: request.sourceTimesMs.at(-1)! + 1 };
    const evidence = proxyViewEvidenceSchema.parse({ version: PROXY_VIEW_VERSION, kind: request.kind, proxySha256: input.sha256,
      sourceInterval, cells, width, height, emptyCells: request.columns * rows - cells.length,
      coverage: "sampled-instants-only", toolchainSha256: selected.toolchainSha256,
      decodedProofSha256: createHash("sha256").update(stdout).digest("hex") });
    return { path: output, ...identity, sourceInterval, evidence, derivationVersion: PROXY_VIEW_VERSION,
      configurationSha256: rangeEvidenceSha256({ version: PROXY_VIEW_VERSION, proxySha256: input.sha256,
        kind: request.kind, times: request.sourceTimesMs, columns: request.columns, tileHeight: request.tileHeight,
        quality: request.frames.quality, threads: request.frames.threads, toolchainSha256: selected.toolchainSha256 }) };
  } catch (error) {
    try { await rm(selected.directory, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Proxy view construction and cleanup failed."); }
    throw error;
  }
}
