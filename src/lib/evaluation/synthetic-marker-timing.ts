import { lstat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { captureLocalProcess } from "@/lib/evaluation/local-process-measurement";

const seconds = z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite());
const probeSchema = z.object({
  format: z.object({ start_time: seconds }),
  streams: z.array(z.object({ width: z.number().int(), height: z.number().int(), start_time: seconds })).length(1),
  frames: z.array(z.object({ best_effort_timestamp_time: seconds })).min(3).max(360),
});
const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
const detector = { sampleWidth: 8, sampleHeight: 8, scale: "area", pixelFormat: "rgb24",
  rMin: 220, gMax: 40, bMax: 40, presentPixels: 64, absentMaximumPixels: 32 } as const;
type CropSize = 40 | 80;
type Frame = { timeMs: number; redPixelsOf64: number };
type Observation = {
  status: "observed" | "unavailable"; reason: string | null;
  clocks: { containerStartMs: number; videoStartMs: number; firstFrameMs: number } | null;
  crop: { x: 0; y: 0; width: CropSize; height: CropSize }; detector: typeof detector;
  probedFrameCount: number | null; decodedFrameCount: number | null;
  cadence: { minimumMs: number; maximumMs: number } | null;
  eventMs: number | null; frames: Frame[];
};
const initial = (crop: CropSize): Observation => ({ status: "unavailable", reason: null,
  clocks: null, crop: { x: 0, y: 0, width: crop, height: crop }, detector,
  probedFrameCount: null, decodedFrameCount: null, cadence: null, eventMs: null, frames: [] });

/** Fixture only: zero-start, constant 30 fps video. Never guess a clock from frame indices. */
export function inspectSyntheticMarker(probe: unknown, pixels: Buffer, crop: CropSize): Observation {
  const result = initial(crop);
  const refuse = (reason: string): Observation => ({ ...result, status: "unavailable", reason, eventMs: null });
  const parsed = probeSchema.safeParse(probe);
  if (!parsed.success) return refuse("missing_or_invalid_probe");
  const { format, streams: [video], frames } = parsed.data;
  const times = frames.map((frame) => round(frame.best_effort_timestamp_time * 1000));
  result.clocks = { containerStartMs: round(format.start_time * 1000),
    videoStartMs: round(video.start_time * 1000), firstFrameMs: times[0] };
  result.probedFrameCount = times.length;
  result.decodedFrameCount = pixels.length % 192 === 0 ? pixels.length / 192 : null;
  if (video.width !== crop * 8 || video.height !== crop * 4.5) return refuse("unsupported_dimensions");
  if (Object.values(result.clocks).some((value) => value !== 0)) return refuse("unsupported_nonzero_start");
  if (result.decodedFrameCount !== times.length) return refuse("frame_count_mismatch");
  const intervals = times.slice(1).map((time, index) => round(time - times[index]));
  result.cadence = { minimumMs: Math.min(...intervals), maximumMs: Math.max(...intervals) };
  // ffprobe reports six decimal places in seconds; permit only that rounding error.
  if (intervals.some((interval) => Math.abs(interval - 1000 / 30) > 0.002)) return refuse("unsupported_frame_cadence");
  result.frames = times.map((timeMs, index) => {
    let redPixelsOf64 = 0;
    for (let p = index * 192; p < (index + 1) * 192; p += 3) {
      if (pixels[p] >= detector.rMin && pixels[p + 1] <= detector.gMax && pixels[p + 2] <= detector.bMax) redPixelsOf64++;
    }
    return { timeMs, redPixelsOf64 };
  });
  const first = result.frames.findIndex((frame) => frame.redPixelsOf64 === detector.presentPixels);
  if (first < 0) return refuse("marker_absent");
  if (first < 2 || first > times.length - 2 ||
      result.frames.slice(0, first).some((frame) => frame.redPixelsOf64 > detector.absentMaximumPixels) ||
      result.frames.slice(first).some((frame) => frame.redPixelsOf64 !== detector.presentPixels)) {
    return refuse("marker_ambiguous");
  }
  return { ...result, status: "observed", reason: null, eventMs: times[first] };
}

/** Read only an explicit local fixture. Output is projected; paths and raw process output are excluded. */
export async function measureSyntheticMarker(file: string, crop: CropSize) {
  const started = performance.now();
  let observation = initial(crop);
  let probeWallTimeMs: number | null = null;
  let decodeWallTimeMs: number | null = null;
  let failureReason = "input_unavailable";
  try {
    if (!path.isAbsolute(file)) throw new Error("unsupported_input");
    const before = await lstat(file);
    if (!before.isFile() || before.size > 50 * 1024 * 1024) throw new Error("unsupported_input");
    const inputArgs = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", file];
    const probe = await captureLocalProcess("ffprobe", ["-v", "error", ...inputArgs, "-select_streams", "v:0",
      "-show_entries", "format=start_time:stream=width,height,start_time:frame=best_effort_timestamp_time", "-of", "json"], 10_000);
    probeWallTimeMs = probe.wallTimeMs;
    failureReason = probe.outcome === "succeeded" ? "invalid_probe_json" : `probe_${probe.failure}`;
    if (probe.outcome !== "succeeded") throw new Error("probe_failed");
    const metadata: unknown = JSON.parse(probe.stdout.toString("utf8"));
    // Keep supported clocks in refused reports, but do not launch a decoder for unsupported input.
    observation = inspectSyntheticMarker(metadata, Buffer.alloc(0), crop);
    observation.decodedFrameCount = null;
    if (observation.reason !== "frame_count_mismatch") throw new Error(observation.reason ?? "invalid_probe");
    const decoded = await captureLocalProcess("ffmpeg", ["-nostdin", "-v", "error", "-copyts", ...inputArgs,
      "-map", "0:v:0", "-an", "-vf", `crop=${crop}:${crop}:0:0,scale=8:8:flags=area`,
      "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-frames:v", "361", "-f", "rawvideo", "pipe:1"], 10_000);
    decodeWallTimeMs = decoded.wallTimeMs;
    failureReason = decoded.outcome === "succeeded" ? "file_recheck_failed" : `decode_${decoded.failure}`;
    if (decoded.outcome !== "succeeded") throw new Error("decode_failed");
    observation = inspectSyntheticMarker(metadata, decoded.stdout, crop);
    const after = await lstat(file);
    if ((["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const).some((key) => before[key] !== after[key])) {
      observation = { ...observation, status: "unavailable", reason: "file_changed", eventMs: null };
    }
  } catch {
    // Never copy exception text: native/JSON errors can include file paths or process output.
    observation = { ...observation, status: "unavailable", reason: observation.reason === "frame_count_mismatch"
      ? failureReason : observation.reason ?? failureReason, eventMs: null };
  }
  return { ...observation, inspection: { wallTimeMs: round(performance.now() - started), probeWallTimeMs,
    decodeWallTimeMs, cpuAndMemory: "NOT_MEASURED" } };
}

export function compareSyntheticMarker(source: Observation, artifact: Observation,
  mapping: { sourceStartMs: number; sourceEndMs: number; fixtureMarkerAtMs: number }) {
  const result = { scope: "synthetic_marker_event_only", status: "unavailable", reason: null as string | null,
    ...mapping, clockPolicy: "container_video_and_first_frame_start_at_zero",
    expectedEventMs: null as number | null, observedEventMs: artifact.eventMs,
    deltaMs: null as number | null, toleranceMs: null as number | null };
  if (source.status !== "observed" || artifact.status !== "observed" ||
      source.eventMs === null || artifact.eventMs === null || !source.cadence || !artifact.cadence) {
    return { ...result, reason: "marker_observation_unavailable" };
  }
  if (!Object.values(mapping).every(Number.isFinite) || mapping.sourceStartMs < 0 ||
      mapping.sourceStartMs >= mapping.sourceEndMs || source.eventMs <= mapping.sourceStartMs || source.eventMs >= mapping.sourceEndMs) {
    return { ...result, reason: "marker_outside_declared_interval" };
  }
  // A single measured frame interval is an event-quantization allowance, not a production sync target.
  result.toleranceMs = Math.max(source.cadence.maximumMs, artifact.cadence.maximumMs);
  result.expectedEventMs = round(source.eventMs - mapping.sourceStartMs);
  result.deltaMs = round(artifact.eventMs - result.expectedEventMs);
  if (Math.abs(source.eventMs - mapping.fixtureMarkerAtMs) > source.cadence.maximumMs) {
    return { ...result, status: "mismatch", reason: "source_marker_timing_mismatch" };
  }
  return { ...result, status: Math.abs(result.deltaMs) <= result.toleranceMs ? "matched" : "mismatch",
    reason: Math.abs(result.deltaMs) <= result.toleranceMs ? null : "artifact_marker_timing_mismatch" };
}
