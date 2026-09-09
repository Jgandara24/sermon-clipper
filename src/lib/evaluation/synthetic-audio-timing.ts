import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { captureLocalProcess } from "@/lib/evaluation/local-process-measurement";

const seconds = z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().min(-3600).max(3600));
const probeSchema = z.object({
  format: z.object({ start_time: seconds.optional(), duration: seconds }),
  streams: z.array(z.object({ codec_name: z.enum(["aac", "flac"]), start_time: seconds.optional(),
    sample_rate: z.enum(["16000", "48000"]).transform(Number), channels: z.literal(1) })).length(1),
  frames: z.array(z.object({ best_effort_timestamp_time: seconds, nb_samples: z.number().int().min(1).max(65536) })).min(2).max(1024),
});
const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
const detector = { windowMs: 5, activeRmsMin: 0.1, quietRmsMax: 0.02, burstDurationMs: 200,
  quietWindowsEachSide: 2, pcmFormat: "f32le" } as const;
type Frame = { timeMs: number; firstSample: number; samples: number };
type Window = { timeMs: number; endMs: number; firstSample: number; samples: number; rms: number };
type Observation = {
  status: "observed" | "unavailable"; reason: string | null; detector: typeof detector;
  clocks: { containerStartMs: number | null; audioStartMs: number | null; firstFrameMs: number } | null;
  codec: string | null; sampleRateHz: number | null; channels: number | null;
  containerDurationMs: number | null; decodedDurationMs: number | null;
  probedSamples: number | null; decodedSamples: number | null; maximumClockErrorMs: number | null;
  event: { startMs: number; endMs: number } | null; frames: Frame[]; windows: Window[];
};
const initial = (): Observation => ({ status: "unavailable", reason: null, detector, clocks: null,
  codec: null, sampleRateHz: null, channels: null, containerDurationMs: null, decodedDurationMs: null,
  probedSamples: null, decodedSamples: null, maximumClockErrorMs: null, event: null, frames: [], windows: [] });

/** Generated mono AAC/FLAC only. PCM sample indices require independently checked frame clocks. */
export function inspectSyntheticAudio(probe: unknown, pcm: Buffer | null): Observation {
  const result = initial();
  const refuse = (reason: string): Observation => ({ ...result, status: "unavailable", reason, event: null });
  const parsed = probeSchema.safeParse(probe);
  if (!parsed.success) return refuse("missing_or_unsupported_probe");
  const { format, streams: [audio], frames } = parsed.data;
  const rate = audio.sample_rate;
  result.codec = audio.codec_name; result.channels = audio.channels; result.sampleRateHz = rate;
  result.containerDurationMs = round(format.duration * 1000);
  result.clocks = { containerStartMs: format.start_time === undefined ? null : round(format.start_time * 1000),
    audioStartMs: audio.start_time === undefined ? null : round(audio.start_time * 1000),
    firstFrameMs: round(frames[0].best_effort_timestamp_time * 1000) };
  let total = 0;
  result.frames = frames.map((frame) => {
    const firstSample = total; total += frame.nb_samples;
    return { timeMs: round(frame.best_effort_timestamp_time * 1000), firstSample, samples: frame.nb_samples };
  });
  result.probedSamples = total;
  if (Object.values(result.clocks).some((value) => value === null)) return refuse("missing_start_clock");
  if (Object.values(result.clocks).some((value) => value !== 0)) return refuse("unsupported_nonzero_start");
  if (total > 262144 || total / rate > 6 || format.duration <= 0 || format.duration > 6) return refuse("fixture_limit_exceeded");
  result.maximumClockErrorMs = round(Math.max(...result.frames.map((frame) => Math.abs(frame.timeMs - frame.firstSample / rate * 1000))));
  if (result.maximumClockErrorMs > 0.001) return refuse("discontinuous_sample_clock");
  if (pcm === null) return refuse("decode_required");
  result.decodedSamples = pcm.length % 4 === 0 ? pcm.length / 4 : null;
  if (result.decodedSamples !== total) return refuse("sample_count_mismatch");
  result.decodedDurationMs = round(total / rate * 1000);
  const width = rate * detector.windowMs / 1000;
  let frameIndex = 0;
  const sampleTime = (index: number) => {
    while (frameIndex + 1 < result.frames.length && index >= result.frames[frameIndex + 1].firstSample) frameIndex++;
    const frame = result.frames[frameIndex];
    return round(frame.timeMs + (index - frame.firstSample) / rate * 1000);
  };
  for (let firstSample = 0; firstSample < total; firstSample += width) {
    const samples = Math.min(width, total - firstSample);
    let squares = 0;
    for (let index = firstSample; index < firstSample + samples; index++) {
      const value = pcm.readFloatLE(index * 4);
      if (!Number.isFinite(value) || Math.abs(value) > 1) return refuse("invalid_fixture_pcm");
      squares += value ** 2;
    }
    result.windows.push({ firstSample, samples, timeMs: sampleTime(firstSample),
      endMs: sampleTime(firstSample + samples), rms: Math.sqrt(squares / samples) });
  }
  if (result.windows.some(({ rms }) => rms > detector.quietRmsMax && rms < detector.activeRmsMin)) return refuse("ambiguous_envelope");
  const first = result.windows.findIndex(({ rms }) => rms >= detector.activeRmsMin);
  if (first < 0) return refuse("event_absent");
  let last = first;
  while (last + 1 < result.windows.length && result.windows[last + 1].rms >= detector.activeRmsMin) last++;
  if (first < detector.quietWindowsEachSide || result.windows.length - last - 1 < detector.quietWindowsEachSide ||
      result.windows.slice(last + 1).some(({ rms }) => rms > detector.quietRmsMax) ||
      result.windows.slice(last + 1, last + 1 + detector.quietWindowsEachSide).some(({ samples }) => samples !== width) ||
      result.windows.slice(first, last + 1).some(({ samples }) => samples !== width) ||
      Math.abs((last - first + 1) * detector.windowMs - detector.burstDurationMs) > detector.windowMs) {
    return refuse("event_ambiguous_or_truncated");
  }
  return { ...result, status: "observed", reason: null,
    event: { startMs: result.windows[first].timeMs, endMs: result.windows[last].endMs } };
}

/** Read a bounded local fixture; retain projected clocks and checksum, never raw output or paths. */
export async function measureSyntheticAudio(file: string) {
  const started = performance.now();
  let observation = initial();
  let sha256: string | null = null; let bytes: number | null = null;
  let probeWallTimeMs: number | null = null; let decodeWallTimeMs: number | null = null;
  let failure = "input_unavailable";
  try {
    if (!path.isAbsolute(file)) throw new Error("Unsupported input.");
    const before = await lstat(file);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error("Unsupported fixture.");
    bytes = before.size;
    sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    const input = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,flac", "-i", file];
    const probe = await captureLocalProcess("ffprobe", ["-v", "error", ...input, "-select_streams", "a:0", "-show_entries",
      "format=start_time,duration:stream=codec_name,start_time,sample_rate,channels:frame=best_effort_timestamp_time,nb_samples", "-of", "json"], 10000);
    probeWallTimeMs = probe.wallTimeMs;
    failure = probe.outcome === "succeeded" ? "invalid_probe_json" : `probe_${probe.failure}`;
    if (probe.outcome !== "succeeded") throw new Error("Probe failed.");
    const metadata: unknown = JSON.parse(probe.stdout.toString("utf8"));
    observation = inspectSyntheticAudio(metadata, null);
    if (observation.reason !== "decode_required") throw new Error("Unsupported clocks.");
    const decoded = await captureLocalProcess("ffmpeg", ["-nostdin", "-v", "error", "-copyts", ...input,
      "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], 10000);
    decodeWallTimeMs = decoded.wallTimeMs;
    failure = decoded.outcome === "succeeded" ? "file_recheck_failed" : `decode_${decoded.failure}`;
    if (decoded.outcome !== "succeeded") throw new Error("Decode failed.");
    observation = inspectSyntheticAudio(metadata, decoded.stdout);
    const after = await lstat(file);
    if ((["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const).some((key) => before[key] !== after[key])) {
      observation = { ...observation, status: "unavailable", reason: "file_changed", event: null };
    }
  } catch {
    observation = { ...observation, status: "unavailable", event: null,
      reason: observation.reason === "decode_required" ? failure : observation.reason ?? failure };
  }
  return { ...observation, sha256, bytes, inspection: { wallTimeMs: round(performance.now() - started),
    probeWallTimeMs, decodeWallTimeMs, cpuAndMemory: "NOT_MEASURED" } };
}

export function compareSyntheticAudio(source: Observation, artifact: Observation,
  mapping: { sourceStartMs: number; sourceEndMs: number }) {
  const result = { scope: "synthetic_audio_event_only", status: "unavailable", reason: null as string | null,
    ...mapping, clockPolicy: "zero_container_audio_and_first_frame_with_contiguous_sample_clocks",
    expectedEvent: null as Observation["event"], observedEvent: artifact.event,
    startDeltaMs: null as number | null, endDeltaMs: null as number | null, toleranceMs: null as number | null };
  if (source.status !== "observed" || artifact.status !== "observed" || !source.event || !artifact.event ||
      !source.sampleRateHz || !artifact.sampleRateHz || source.maximumClockErrorMs === null || artifact.maximumClockErrorMs === null) {
    return { ...result, reason: "event_observation_unavailable" };
  }
  if (!Object.values(mapping).every(Number.isFinite) || mapping.sourceStartMs < 0 || mapping.sourceEndMs > 4000 ||
      source.event.startMs <= mapping.sourceStartMs || source.event.endMs >= mapping.sourceEndMs) {
    return { ...result, reason: "event_outside_fixture_interval" };
  }
  const sourceAllowance = detector.windowMs + 1000 / source.sampleRateHz + source.maximumClockErrorMs;
  result.toleranceMs = round(sourceAllowance + detector.windowMs + 1000 / artifact.sampleRateHz + artifact.maximumClockErrorMs);
  result.expectedEvent = { startMs: round(source.event.startMs - mapping.sourceStartMs), endMs: round(source.event.endMs - mapping.sourceStartMs) };
  result.startDeltaMs = round(artifact.event.startMs - result.expectedEvent.startMs);
  result.endDeltaMs = round(artifact.event.endMs - result.expectedEvent.endMs);
  if (Math.abs(source.event.startMs - 2000) > sourceAllowance || Math.abs(source.event.endMs - 2200) > sourceAllowance) {
    return { ...result, status: "mismatch", reason: "source_event_mismatch" };
  }
  const matched = Math.max(Math.abs(result.startDeltaMs), Math.abs(result.endDeltaMs)) <= result.toleranceMs;
  return { ...result, status: matched ? "matched" : "mismatch", reason: matched ? null : "artifact_event_mismatch" };
}
