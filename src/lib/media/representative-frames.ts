import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "@/lib/env";
import { fileIdentity } from "@/lib/storage/file-identity";
import { sha256Schema, sourceTimeMappingSchema, sourceTimeToArtifact } from "@/lib/media-artifacts/types";
import { execFileWithTimeout } from "./child-process";

export const REPRESENTATIVE_FRAME_VERSION = "lossless-proxy-frame-v1";
export const representativeFrameSettingsSchema = z.object({
  quality: z.number().min(0).max(100), threads: z.number().int().positive(),
  maxFrames: z.number().int().min(1).max(1000), maxFrameBytes: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(), maxOutputBytes: z.number().int().positive().max(2147483647),
  timeoutMs: z.number().int().positive().max(2147483647),
}).strict();
export type RepresentativeFrameSettings = z.infer<typeof representativeFrameSettingsSchema>;
const inputSchema = z.object({ path: z.string().min(1), sha256: sha256Schema,
  byteCount: z.number().int().positive(), mapping: sourceTimeMappingSchema }).strict();
export type RepresentativeFrameInput = z.infer<typeof inputSchema>;

function frameProof(output: string) {
  const timebase = /^#tb 0:\s*(\d+)\/(\d+)\s*$/m.exec(output);
  const dimensions = /^#dimensions 0:\s*(\d+)x(\d+)\s*$/m.exec(output);
  if (!timebase || !dimensions || !/^#hash: SHA256\s*$/m.test(output)) throw new Error("MEDIA_FRAME_PROOF_HEADER_INVALID");
  const width = Number(dimensions[1]), height = Number(dimensions[2]);
  const numerator = Number(timebase[1]), denominator = Number(timebase[2]);
  if (!width || !height || !numerator || !denominator) throw new Error("MEDIA_FRAME_PROOF_HEADER_INVALID");
  const frames = output.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#")).map(line => {
    const fields = line.split(",").map(field => field.trim());
    if (fields.length !== 6 || fields[0] !== "0") throw new Error("MEDIA_FRAME_PROOF_INVALID");
    const pts = Number(fields[2]), size = Number(fields[4]);
    if (!Number.isSafeInteger(pts) || size !== width * height * 4) throw new Error("MEDIA_FRAME_PROOF_INVALID");
    return { artifactTimeMs: pts * numerator * 1000 / denominator, bgraSha256: sha256Schema.parse(fields[5]) };
  });
  return { width, height, frames };
}

/** Extracts full proxy frames and verifies exact BGRA pixels after lossless WebP decoding.
 * The caller owns outputRoot, normally a source lease directory. Handled failures remove this call's files.
 */
export async function extractRepresentativeFrames(inputValue: RepresentativeFrameInput, sourceTimesMs: number[],
  outputRoot: string, settingsValue: RepresentativeFrameSettings) {
  const input = inputSchema.parse(inputValue), settings = representativeFrameSettingsSchema.parse(settingsValue);
  const requested = z.array(z.number().int().nonnegative()).min(1).max(settings.maxFrames).parse(sourceTimesMs);
  const times = requested.map((time, index) => {
    if ((index > 0 && time <= requested[index - 1]) || time >= input.mapping.sourceInterval.endMs) {
      throw new Error("MEDIA_REPRESENTATIVE_TIMESTAMPS_INVALID");
    }
    return sourceTimeToArtifact(input.mapping, time);
  });
  if (!path.isAbsolute(input.path) || !path.isAbsolute(outputRoot) || !(await lstat(input.path)).isFile()) {
    throw new Error("MEDIA_REPRESENTATIVE_LOCAL_PATH_REQUIRED");
  }
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("MEDIA_REPRESENTATIVE_INPUT_CHANGED");
  const limits = { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes };
  const { stdout: version } = await execFileWithTimeout(ffmpegPath(), ["-version"], limits);
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const directory = await mkdtemp(path.join(outputRoot, "representative-frames-"));
  try {
    const selection = times.map(time => `eq(pts,${time})`).join("+");
    const { stdout } = await execFileWithTimeout(ffmpegPath(), [
      "-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe", "-copyts",
      "-threads", String(settings.threads), "-i", input.path, "-filter_complex_threads", String(settings.threads),
      "-filter_complex", `[0:v:0]settb=1/1000,select='${selection}',format=bgra,split=2[images][proof]`,
      "-map", "[images]", "-an", "-sn", "-dn", "-c:v", "libwebp", "-lossless", "1", "-quality", String(settings.quality),
      "-threads", String(settings.threads), "-frames:v", String(times.length + 1), "-fps_mode", "passthrough", "-start_number", "0", path.join(directory, "frame-%06d.webp"),
      "-map", "[proof]", "-c:v", "rawvideo", "-pix_fmt", "bgra", "-threads", String(settings.threads),
      "-frames:v", String(times.length + 1), "-fps_mode", "passthrough", "-enc_time_base", "1:1000", "-f", "framehash", "-hash", "sha256", "pipe:1",
    ], limits);
    const proof = frameProof(stdout);
    const entries = await readdir(directory);
    if (proof.frames.length !== times.length || entries.length !== times.length ||
        proof.frames.some((frame, index) => frame.artifactTimeMs !== times[index])) {
      throw new Error("MEDIA_REPRESENTATIVE_FRAME_MISSING_OR_DUPLICATED");
    }
    const frames = [];
    let totalBytes = 0;
    for (let index = 0; index < times.length; index++) {
      const file = path.join(directory, `frame-${String(index).padStart(6, "0")}.webp`);
      const identity = await fileIdentity(file);
      totalBytes += identity.byteCount;
      if (!Number.isSafeInteger(totalBytes) || identity.byteCount > settings.maxFrameBytes || totalBytes > settings.maxTotalBytes) throw new Error("MEDIA_REPRESENTATIVE_SIZE_LIMIT_EXCEEDED");
      const { stdout: decoded } = await execFileWithTimeout(ffmpegPath(), [
        "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", String(settings.threads), "-i", file,
        "-map", "0:v:0", "-an", "-vf", "format=bgra", "-c:v", "rawvideo", "-pix_fmt", "bgra",
        "-threads", String(settings.threads), "-f", "framehash", "-hash", "sha256", "pipe:1",
      ], limits);
      const actual = frameProof(decoded);
      if (actual.width !== proof.width || actual.height !== proof.height || actual.frames.length !== 1 ||
          actual.frames[0].bgraSha256 !== proof.frames[index].bgraSha256) throw new Error("MEDIA_REPRESENTATIVE_PIXELS_CHANGED");
      frames.push({ path: file, ...identity, sourceTimeMs: requested[index], width: proof.width, height: proof.height,
        bgraSha256: proof.frames[index].bgraSha256 });
    }
    const after = await fileIdentity(input.path);
    if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("MEDIA_REPRESENTATIVE_INPUT_CHANGED");
    const configurationSha256 = createHash("sha256").update(JSON.stringify([
      REPRESENTATIVE_FRAME_VERSION, input.sha256, toolchainSha256, settings.quality, settings.threads,
    ])).digest("hex");
    return { directory, frames, totalBytes, configurationSha256, toolchainSha256, derivationVersion: REPRESENTATIVE_FRAME_VERSION };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Representative extraction and cleanup failed."); }
    throw error;
  }
}
