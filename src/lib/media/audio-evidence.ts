import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath, ffprobePath } from "@/lib/env";
import { fileIdentity } from "@/lib/storage/file-identity";
import { artifactTimeToSource, sha256Schema, sourceTimeMappingSchema } from "@/lib/media-artifacts/types";
import { execFileWithTimeout } from "./child-process";

export const AUDIO_EVIDENCE_VERSION = "ffmpeg-audio-facts-v1";
export const audioEvidenceSettingsSchema = z.object({
  silenceNoiseDb: z.number().finite().max(0), silenceMinimumMs: z.number().int().positive(),
  waveformWindowSamples: z.number().int().min(16).max(2147483647),
  threads: z.number().int().positive(), timeoutMs: z.number().int().positive().max(2147483647),
  maxMetadataBytes: z.number().int().positive().max(2147483647),
}).strict().refine(value => value.waveformWindowSamples <= value.silenceMinimumMs * 16, {
  message: "Waveform windows must not exceed the minimum silence duration.",
});
export type AudioEvidenceSettings = z.infer<typeof audioEvidenceSettingsSchema>;
const inputSchema = z.object({
  path: z.string().min(1), sha256: sha256Schema,
  byteCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), mapping: sourceTimeMappingSchema,
}).strict();
export type AudioEvidenceInput = z.infer<typeof inputSchema>;

type Frame = { samplePts: number; values: Map<string, number> };
function parseMetadata(output: string): Frame[] {
  const frames: Frame[] = [];
  let current: Frame | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = /^frame:\d+\s+pts:\s*(-?\d+)\s+pts_time:\s*\S+\s*$/.exec(line);
    if (header) {
      const samplePts = Number(header[1]);
      if (!Number.isSafeInteger(samplePts) || (current && samplePts <= current.samplePts)) throw new Error("MEDIA_AUDIO_CLOCK_INVALID");
      current = { samplePts, values: new Map() };
      frames.push(current);
      continue;
    }
    const entry = /^(lavfi\.[\w.]+)=([^\s]+)$/.exec(line);
    if (!entry || !current || current.values.has(entry[1])) throw new Error("MEDIA_AUDIO_METADATA_INVALID");
    const value = entry[2] === "-inf" ? -Infinity : Number(entry[2]);
    const zeroLevel = value === -Infinity && ["lavfi.astats.Overall.Peak_level", "lavfi.astats.Overall.RMS_level"].includes(entry[1]);
    if (!Number.isFinite(value) && !zeroLevel) throw new Error("MEDIA_AUDIO_METADATA_INVALID");
    current.values.set(entry[1], value);
  }
  if (!frames.length) throw new Error("MEDIA_AUDIO_FRAMES_MISSING");
  return frames;
}

/** Measures the existing mono 16 kHz FLAC. No video stream is selected or decoded. */
export async function extractAudioEvidence(inputValue: AudioEvidenceInput, settingsValue: AudioEvidenceSettings) {
  const input = inputSchema.parse(inputValue), settings = audioEvidenceSettingsSchema.parse(settingsValue);
  if (!path.isAbsolute(input.path) || !(await lstat(input.path)).isFile()) throw new Error("MEDIA_AUDIO_LOCAL_FILE_REQUIRED");
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("MEDIA_AUDIO_INPUT_CHANGED");
  const limits = { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxMetadataBytes };
  const { stdout: probeOutput } = await execFileWithTimeout(ffprobePath(), [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", input.path,
  ], limits);
  const probe = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(),
    channels: z.number().optional(), sample_rate: z.string().optional() })) }).parse(JSON.parse(probeOutput));
  if (probe.streams.length !== 1 || probe.streams[0].codec_type !== "audio" || probe.streams[0].codec_name !== "flac" ||
      probe.streams[0].channels !== 1 || probe.streams[0].sample_rate !== "16000") throw new Error("MEDIA_ANALYSIS_AUDIO_FORMAT_REQUIRED");
  const { stdout: version } = await execFileWithTimeout(ffmpegPath(), ["-version"], limits);
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const filter = [
    "asettb=1/16000", `asetnsamples=n=${settings.waveformWindowSamples}:p=0`,
    `silencedetect=n=${settings.silenceNoiseDb}dB:d=${settings.silenceMinimumMs / 1000}`,
    "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples",
    "ametadata=mode=print:file=-",
  ].join(",");
  const { stdout } = await execFileWithTimeout(ffmpegPath(), [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-copyts", "-threads", String(settings.threads),
    "-i", input.path, "-map", "0:a:0", "-vn", "-sn", "-dn", "-filter_threads", String(settings.threads),
    "-af", filter, "-f", "null", "-",
  ], limits);
  const after = await fileIdentity(input.path);
  if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("MEDIA_AUDIO_INPUT_CHANGED");
  const frames = parseMetadata(stdout);
  const toSource = (ms: number) => artifactTimeToSource(input.mapping, Math.round(ms));
  const waveform: { startMs: number; endMs: number; sampleCount: number; peakAmplitude: number; rmsAmplitude: number }[] = [];
  const silence: { startMs: number; endMs: number; endReason: "DETECTED" | "OBSERVED_AUDIO_END" }[] = [];
  let silenceStart: number | undefined, nextSample: number | undefined;
  let totalSamples = 0;
  for (const frame of frames) {
    const count = frame.values.get("lavfi.astats.Overall.Number_of_samples");
    const peak = frame.values.get("lavfi.astats.Overall.Peak_level"), rms = frame.values.get("lavfi.astats.Overall.RMS_level");
    if (count === undefined || !Number.isSafeInteger(count) || count < 1 || count > settings.waveformWindowSamples ||
        peak === undefined || rms === undefined || peak > 0 || rms > 0) throw new Error("MEDIA_AUDIO_METRICS_INVALID");
    if (nextSample !== undefined && frame.samplePts !== nextSample) throw new Error("MEDIA_AUDIO_SAMPLE_GAP");
    nextSample = frame.samplePts + count;
    totalSamples += count;
    if (!Number.isSafeInteger(nextSample) || !Number.isSafeInteger(totalSamples)) throw new Error("MEDIA_AUDIO_CLOCK_INVALID");
    const startMs = toSource(frame.samplePts / 16), endMs = toSource(nextSample / 16);
    if (endMs < startMs) throw new Error("MEDIA_AUDIO_WINDOW_PRECISION_INVALID");
    waveform.push({ startMs, endMs, sampleCount: count, peakAmplitude: 10 ** (peak / 20), rmsAmplitude: 10 ** (rms / 20) });
    const events = [
      { type: "start", time: frame.values.get("lavfi.silence_start") },
      { type: "end", time: frame.values.get("lavfi.silence_end") },
    ].filter((event): event is { type: string; time: number } => event.time !== undefined)
      .sort((left, right) => left.time - right.time || (left.type === "end" ? -1 : 1));
    for (const event of events) {
      const timeMs = toSource(event.time * 1000);
      if (event.type === "start") {
        if (silenceStart !== undefined) throw new Error("MEDIA_SILENCE_INTERVAL_INVALID");
        silenceStart = timeMs;
      } else {
        if (silenceStart === undefined || timeMs <= silenceStart) throw new Error("MEDIA_SILENCE_INTERVAL_INVALID");
        silence.push({ startMs: silenceStart, endMs: timeMs, endReason: "DETECTED" });
        silenceStart = undefined;
      }
    }
  }
  const observedEndMs = waveform[waveform.length - 1].endMs;
  if (silenceStart !== undefined) silence.push({ startMs: silenceStart, endMs: observedEndMs, endReason: "OBSERVED_AUDIO_END" });
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    AUDIO_EVIDENCE_VERSION, toolchainSha256, settings.silenceNoiseDb, settings.silenceMinimumMs,
    settings.waveformWindowSamples, settings.threads,
  ])).digest("hex");
  return { detectorVersion: AUDIO_EVIDENCE_VERSION, configurationSha256, toolchainSha256, settings,
    inputSha256: input.sha256, inputByteCount: input.byteCount, mapping: input.mapping,
    sampleRateHz: 16000, totalSamples, observedStartMs: waveform[0].startMs, observedEndMs, waveform, silence };
}
