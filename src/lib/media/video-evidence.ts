import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath } from "@/lib/env";
import { fileIdentity } from "@/lib/storage/file-identity";
import { artifactTimeToSource, sha256Schema, sourceTimeMappingSchema } from "@/lib/media-artifacts/types";
import { execFileWithTimeout } from "./child-process";

export const VIDEO_EVIDENCE_VERSION = "ffmpeg-video-facts-v1";
export const videoEvidenceSettingsSchema = z.object({
  sceneThreshold: z.number().min(0).max(100),
  blackPixelThreshold: z.number().min(0).max(1),
  blackPictureRatio: z.number().min(0).max(1),
  blackMinimumMs: z.number().int().positive(),
  freezeNoiseRatio: z.number().min(0).max(1),
  freezeMinimumMs: z.number().int().positive(),
  threads: z.number().int().positive(),
  timeoutMs: z.number().int().positive().max(2147483647),
  maxMetadataBytes: z.number().int().positive().max(2147483647),
}).strict();
export type VideoEvidenceSettings = z.infer<typeof videoEvidenceSettingsSchema>;
const inputSchema = z.object({
  path: z.string().min(1), sha256: sha256Schema,
  byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), mapping: sourceTimeMappingSchema,
}).strict();
export type VideoEvidenceInput = z.infer<typeof inputSchema>;

type Frame = { timeMs: number; values: Map<string, number> };
type Interval = { startMs: number; endMs: number; endReason: "DETECTED" | "LAST_OBSERVED_FRAME" };

/** Only numeric lavfi metadata is accepted. Malformed output must not become an empty fact set. */
function metadataFrames(output: string): Frame[] {
  const frames: Frame[] = [];
  let current: Frame | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = /^frame:\d+\s+pts:\s*-?\d+\s+pts_time:\s*(\S+)\s*$/.exec(line);
    if (header) {
      const timeMs = Number(header[1]) * 1000;
      if (!Number.isFinite(timeMs) || (current && timeMs < current.timeMs)) throw new Error("MEDIA_VIDEO_CLOCK_INVALID");
      current = { timeMs, values: new Map() };
      frames.push(current);
      continue;
    }
    const value = /^(lavfi\.[\w.]+)=([^\s]+)$/.exec(line);
    if (!current || !value || !Number.isFinite(Number(value[2])) || current.values.has(value[1])) {
      throw new Error("MEDIA_VIDEO_METADATA_INVALID");
    }
    current.values.set(value[1], Number(value[2]));
  }
  if (!frames.length) throw new Error("MEDIA_VIDEO_FRAMES_MISSING");
  return frames;
}

/** Reads pixels only from the caller's local proxy. This function makes no semantic region decisions. */
export async function extractVideoEvidence(inputValue: VideoEvidenceInput, settingsValue: VideoEvidenceSettings) {
  const input = inputSchema.parse(inputValue);
  const settings = videoEvidenceSettingsSchema.parse(settingsValue);
  if (!path.isAbsolute(input.path) || !(await lstat(input.path)).isFile()) throw new Error("MEDIA_VIDEO_LOCAL_FILE_REQUIRED");
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("MEDIA_VIDEO_INPUT_CHANGED");
  const { stdout: version } = await execFileWithTimeout(ffmpegPath(), ["-version"], {
    timeoutMs: settings.timeoutMs, maxBuffer: settings.maxMetadataBytes,
  });
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const filter = [
    "format=yuv420p", `scdet=threshold=${settings.sceneThreshold}`,
    `blackdetect=d=${settings.blackMinimumMs / 1000}:pix_th=${settings.blackPixelThreshold}:pic_th=${settings.blackPictureRatio}`,
    `freezedetect=n=${settings.freezeNoiseRatio}:d=${settings.freezeMinimumMs / 1000}`,
    "signalstats", "metadata=mode=print:file=-",
  ].join(",");
  const { stdout } = await execFileWithTimeout(ffmpegPath(), [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-copyts",
    "-threads", String(settings.threads), "-i", input.path, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", String(settings.threads), "-vf", filter, "-fps_mode", "passthrough", "-f", "null", "-",
  ], { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxMetadataBytes });
  const after = await fileIdentity(input.path);
  if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("MEDIA_VIDEO_INPUT_CHANGED");
  const frames = metadataFrames(stdout);
  const toSource = (ms: number) => artifactTimeToSource(input.mapping, Math.round(ms));
  const scenes: { timeMs: number; score: number }[] = [];
  const motion: { timeMs: number; lumaDifference: number; sceneScore: number }[] = [];
  const black: Interval[] = [], freeze: Interval[] = [];
  let blackStart: number | undefined, freezeStart: number | undefined;
  for (const frame of frames) {
    const timeMs = toSource(frame.timeMs);
    // The exclusive source end is a valid interval boundary, but cannot contain a frame.
    if (timeMs >= input.mapping.sourceInterval.endMs) throw new Error("MEDIA_VIDEO_FRAME_OUTSIDE_INTERVAL");
    const score = frame.values.get("lavfi.scd.score"), lumaDifference = frame.values.get("lavfi.signalstats.YDIF");
    if (score === undefined || lumaDifference === undefined || score < 0 || score > 100 || lumaDifference < 0 || lumaDifference > 255) {
      throw new Error("MEDIA_VIDEO_METRICS_MISSING");
    }
    motion.push({ timeMs, lumaDifference, sceneScore: score });
    const scene = frame.values.get("lavfi.scd.time");
    if (scene !== undefined) scenes.push({ timeMs: toSource(scene * 1000), score });
    const bs = frame.values.get("lavfi.black_start"), be = frame.values.get("lavfi.black_end");
    if (bs !== undefined) {
      if (blackStart !== undefined) throw new Error("MEDIA_BLACK_INTERVAL_INVALID");
      blackStart = toSource(bs * 1000);
    }
    if (be !== undefined) {
      if (blackStart === undefined) throw new Error("MEDIA_BLACK_INTERVAL_INVALID");
      const endMs = toSource(be * 1000);
      if (endMs < blackStart) throw new Error("MEDIA_BLACK_INTERVAL_INVALID");
      if (endMs - blackStart >= settings.blackMinimumMs) black.push({ startMs: blackStart, endMs, endReason: "DETECTED" });
      blackStart = undefined;
    }
    const fs = frame.values.get("lavfi.freezedetect.freeze_start"), fe = frame.values.get("lavfi.freezedetect.freeze_end");
    if (fs !== undefined) {
      if (freezeStart !== undefined) throw new Error("MEDIA_FREEZE_INTERVAL_INVALID");
      freezeStart = toSource(fs * 1000);
    }
    if (fe !== undefined) {
      if (freezeStart === undefined) throw new Error("MEDIA_FREEZE_INTERVAL_INVALID");
      const endMs = toSource(fe * 1000);
      if (endMs <= freezeStart) throw new Error("MEDIA_FREEZE_INTERVAL_INVALID");
      freeze.push({ startMs: freezeStart, endMs, endReason: "DETECTED" });
      freezeStart = undefined;
    }
  }
  // A declared source interval cannot prove that video continues through its end.
  // Keep trailing facts bounded by the final frame we actually inspected.
  const endMs = motion[motion.length - 1].timeMs;
  if (blackStart !== undefined && endMs - blackStart >= settings.blackMinimumMs) black.push({ startMs: blackStart, endMs, endReason: "LAST_OBSERVED_FRAME" });
  if (freezeStart !== undefined) freeze.push({ startMs: freezeStart, endMs, endReason: "LAST_OBSERVED_FRAME" });
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    VIDEO_EVIDENCE_VERSION, toolchainSha256, settings.sceneThreshold, settings.blackPixelThreshold,
    settings.blackPictureRatio, settings.blackMinimumMs, settings.freezeNoiseRatio, settings.freezeMinimumMs, settings.threads,
  ])).digest("hex");
  return { detectorVersion: VIDEO_EVIDENCE_VERSION, configurationSha256, toolchainSha256, settings,
    inputSha256: input.sha256, inputByteCount: input.byteCount, mapping: input.mapping,
    frameCount: frames.length, firstFrameMs: motion[0].timeMs, lastFrameMs: motion[motion.length - 1].timeMs,
    motionMetric: "8-bit-luma-mean-absolute-frame-difference" as const, scenes, black, freeze, motion };
}
