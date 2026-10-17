import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "@/lib/env";
import { artifactTimeToSource, sha256Schema, sourceTimeMappingSchema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileBufferWithTimeout, execFileWithTimeout } from "./child-process";

export const FRAME_HASH_VERSION = "gray-area-9x8-dhash-v1";
const inputSchema = z.object({ path: z.string().min(1), sha256: sha256Schema,
  byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), mapping: sourceTimeMappingSchema }).strict();
export type FrameHashInput = z.infer<typeof inputSchema>;
export const frameHashSettingsSchema = z.object({
  intervalMs: z.number().int().positive(), maxFrames: z.number().int().positive().max(2147483646),
  threads: z.number().int().positive(), timeoutMs: z.number().int().positive().max(2147483647),
  maxOutputBytes: z.number().int().positive().max(2147483647),
}).strict();
export type FrameHashSettings = z.infer<typeof frameHashSettingsSchema>;
const hashSchema = z.string().regex(/^[0-9a-f]{16}$/);
export const frameHashSampleSchema = z.object({
  timeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), differenceHash: hashSchema,
  meanLuma: z.number().min(0).max(255), grayscaleThumbnailSha256: sha256Schema,
}).strict();
export type FrameHashSample = z.infer<typeof frameHashSampleSchema>;

export function differenceHash64(pixels: Uint8Array): string {
  if (pixels.length !== 72) throw new Error("FRAME_HASH_REQUIRES_9_BY_8_PIXELS");
  let bits = BigInt(0);
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
    bits = (bits << BigInt(1)) | BigInt(pixels[row * 9 + column] > pixels[row * 9 + column + 1] ? 1 : 0);
  }
  return bits.toString(16).padStart(16, "0");
}
export function frameHashDistance(left: string, right: string): number {
  let bits = BigInt(`0x${hashSchema.parse(left)}`) ^ BigInt(`0x${hashSchema.parse(right)}`);
  let count = 0;
  while (bits) { bits &= bits - BigInt(1); count++; }
  return count;
}

/** Samples existing frames, never synthetic duplicates. Hashes describe resized grayscale pixels, not full frames. */
export async function extractFrameHashes(inputValue: FrameHashInput, settingsValue: FrameHashSettings) {
  const input = inputSchema.parse(inputValue), settings = frameHashSettingsSchema.parse(settingsValue);
  if (!path.isAbsolute(input.path) || !(await lstat(input.path)).isFile()) throw new Error("MEDIA_FRAME_HASH_LOCAL_FILE_REQUIRED");
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("MEDIA_FRAME_HASH_INPUT_CHANGED");
  const { stdout: version } = await execFileWithTimeout(ffmpegPath(), ["-version"], {
    timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes,
  });
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const filter = [
    "settb=1/1000", `select='isnan(prev_selected_pts)+gte(pts-prev_selected_pts,${settings.intervalMs})'`,
    "scale=9:8:flags=area", "format=gray", "showinfo",
  ].join(",");
  const { stdout, stderr } = await execFileBufferWithTimeout(ffmpegPath(), [
    "-nostdin", "-hide_banner", "-nostats", "-v", "info", "-protocol_whitelist", "file,pipe", "-copyts",
    "-threads", String(settings.threads), "-i", input.path, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", String(settings.threads), "-vf", filter, "-fps_mode", "passthrough", "-pix_fmt", "gray",
    "-threads", String(settings.threads), "-frames:v", String(settings.maxFrames + 1), "-f", "rawvideo", "pipe:1",
  ], { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes });
  const after = await fileIdentity(input.path);
  if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("MEDIA_FRAME_HASH_INPUT_CHANGED");
  if (stdout.length === 0 || stdout.length % 72 !== 0) throw new Error("MEDIA_FRAME_HASH_PIXELS_INVALID");
  const frameCount = stdout.length / 72;
  if (frameCount > settings.maxFrames) throw new Error("MEDIA_FRAME_HASH_LIMIT_EXCEEDED");
  const timestamps = [...stderr.toString("utf8").matchAll(/\[Parsed_showinfo_\d+ @ [^\]]+\]\s+n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g)];
  if (timestamps.length !== frameCount) throw new Error("MEDIA_FRAME_HASH_TIMESTAMPS_MISSING");
  const samples: FrameHashSample[] = timestamps.map((match, index) => {
    const artifactMs = Number(match[2]);
    if (Number(match[1]) !== index || !Number.isSafeInteger(artifactMs)) throw new Error("MEDIA_FRAME_HASH_CLOCK_INVALID");
    const timeMs = artifactTimeToSource(input.mapping, artifactMs);
    if (timeMs >= input.mapping.sourceInterval.endMs || (index > 0 && artifactMs <= Number(timestamps[index - 1][2]))) {
      throw new Error("MEDIA_FRAME_HASH_CLOCK_INVALID");
    }
    const pixels = stdout.subarray(index * 72, (index + 1) * 72);
    return { timeMs, differenceHash: differenceHash64(pixels),
      meanLuma: pixels.reduce((sum, value) => sum + value, 0) / 72,
      grayscaleThumbnailSha256: createHash("sha256").update(pixels).digest("hex") };
  });
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    FRAME_HASH_VERSION, toolchainSha256, settings.intervalMs, settings.threads,
  ])).digest("hex");
  return { algorithmVersion: FRAME_HASH_VERSION, configurationSha256, toolchainSha256, settings,
    inputSha256: input.sha256, inputByteCount: input.byteCount, mapping: input.mapping, samples };
}

export const frameGroupingSettingsSchema = z.object({
  maxHammingDistance: z.number().int().min(0).max(64), maxMeanLumaDifference: z.number().min(0).max(255),
  maxSpanMs: z.number().int().positive(),
}).strict();
export type FrameGroupingSettings = z.infer<typeof frameGroupingSettingsSchema>;

/** Consecutive samples compare with the first member, preventing similarity drift through a chain.
 * Groups contain sampled points, not continuous semantic intervals or video-eligibility decisions.
 */
export function groupFrameHashes(input: FrameHashSample[], settingsValue: FrameGroupingSettings) {
  const samples = z.array(frameHashSampleSchema).parse(input), settings = frameGroupingSettingsSchema.parse(settingsValue);
  const groups: { representativeIndex: number; memberIndices: number[] }[] = [];
  samples.forEach((sample, index) => {
    if (index > 0 && sample.timeMs <= samples[index - 1].timeMs) throw new Error("MEDIA_FRAME_HASH_ORDER_INVALID");
    const previous = groups.at(-1);
    const representative = previous && samples[previous.representativeIndex];
    if (representative && sample.timeMs - representative.timeMs <= settings.maxSpanMs &&
        Math.abs(sample.meanLuma - representative.meanLuma) <= settings.maxMeanLumaDifference &&
        frameHashDistance(sample.differenceHash, representative.differenceHash) <= settings.maxHammingDistance) {
      previous.memberIndices.push(index);
    } else groups.push({ representativeIndex: index, memberIndices: [index] });
  });
  const algorithmVersion = "consecutive-representative-dhash-v1";
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    algorithmVersion, settings.maxHammingDistance, settings.maxMeanLumaDifference, settings.maxSpanMs,
  ])).digest("hex");
  const inputSha256 = createHash("sha256").update(JSON.stringify(samples)).digest("hex");
  return { algorithmVersion, configurationSha256, inputSha256, settings, groups };
}
