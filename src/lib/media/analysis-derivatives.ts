import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ffmpegPath, ffprobePath } from "@/lib/env";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { rangeEvidenceSha256 } from "./range-evidence";
import type { MaterializedSource } from "./source-lease";

export const ANALYSIS_DERIVATION_VERSION = "analysis-audio-proxy-v2";
export const analysisDerivativeSettingsSchema = z.object({
  proxyCrf: z.number().min(0).max(51),
  proxyPreset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]),
  proxyAudioBitrateBps: z.number().int().positive(),
  flacCompressionLevel: z.number().int().min(0).max(12),
  encoderThreads: z.number().int().positive(),
  timeoutMs: z.number().int().positive().max(2147483647),
}).strict();
export type AnalysisDerivativeSettings = z.infer<typeof analysisDerivativeSettingsSchema>;

const streamSchema = z.object({
  index: z.number().int(), codec_type: z.string(), codec_name: z.string().optional(),
  width: z.number().optional(), height: z.number().optional(), channels: z.number().optional(),
  duration_ts: z.number().int().optional(), time_base: z.string().optional(),
  sample_rate: z.string().optional(), start_time: z.string().optional(), duration: z.string().optional(),
  sample_aspect_ratio: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() }).passthrough()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
}).passthrough();
const probeSchema = z.object({
  streams: z.array(streamSchema),
  format: z.object({ duration: z.string(), start_time: z.string().optional() }).passthrough(),
});
type Probe = z.infer<typeof probeSchema>;

function seconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function duration(probe: Probe): number {
  const value = seconds(probe.format.duration);
  if (value === null || value <= 0) throw new Error("MEDIA_DURATION_UNAVAILABLE");
  return value;
}
async function inspect(file: string, timeoutMs: number): Promise<Probe> {
  const { stdout } = await execFileWithTimeout(ffprobePath(), [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file,
  ], { timeoutMs, maxBuffer: 1024 * 1024 });
  return probeSchema.parse(JSON.parse(stdout));
}
function facts(probe: Probe) {
  const video = probe.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = probe.streams.find(stream => stream.codec_type === "audio");
  return {
    durationMs: duration(probe) * 1000,
    containerStartMs: seconds(probe.format.start_time) === null ? null : Number(probe.format.start_time) * 1000,
    video: video ? { codec: video.codec_name ?? null, width: video.width ?? null, height: video.height ?? null,
      startMs: seconds(video.start_time) === null ? null : Number(video.start_time) * 1000,
      sampleAspectRatio: video.sample_aspect_ratio ?? null,
      rotationDegrees: video.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? seconds(video.tags?.rotate) ?? 0 } : null,
    audio: audio ? { codec: audio.codec_name ?? null, channels: audio.channels ?? null,
      sampleRateHz: audio.sample_rate ? Number(audio.sample_rate) : null,
      startMs: seconds(audio.start_time) === null ? null : Number(audio.start_time) * 1000 } : null,
  };
}

/** Builds both outputs in one FFmpeg process. The source lease owns the returned local files. */
export async function buildAnalysisDerivatives(source: MaterializedSource, input: AnalysisDerivativeSettings) {
  const settings = analysisDerivativeSettingsSchema.parse(input);
  if (!path.isAbsolute(source.sourcePath) || !(await lstat(source.sourcePath)).isFile()) {
    throw new Error("MEDIA_SOURCE_MUST_BE_A_LOCAL_FILE");
  }
  const original = await inspect(source.sourcePath, settings.timeoutMs);
  const originS = seconds(original.format.start_time);
  if (originS === null) throw new Error("MEDIA_SOURCE_CLOCK_UNAVAILABLE");
  const video = original.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = original.streams.find(stream => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("MEDIA_AUDIO_AND_VIDEO_REQUIRED");
  // Nonzero-origin MP4 containers can report the timeline end as format.duration.
  // Prefer stream endpoints, rather than appending the timestamp origin as extra silence.
  const endpoints = [video, audio].map(stream => {
    const start = seconds(stream.start_time), length = seconds(stream.duration);
    return start === null || length === null ? null : start + length;
  });
  if (originS !== 0 && endpoints.some(value => value === null)) throw new Error("MEDIA_SOURCE_DURATION_CLOCK_UNAVAILABLE");
  const sourceDurationS = endpoints.every((value): value is number => value !== null)
    ? Math.max(...endpoints) - originS : duration(original);
  if (!Number.isFinite(sourceDurationS) || sourceDurationS <= 0) throw new Error("MEDIA_SOURCE_DURATION_CLOCK_INVALID");
  if (!Number.isSafeInteger(Math.round(sourceDurationS * 1000)) || Math.round(sourceDurationS * 1000) <= 0) {
    throw new Error("MEDIA_SOURCE_DURATION_PRECISION_INVALID");
  }
  if (!video.width || !video.height) throw new Error("MEDIA_SOURCE_DIMENSIONS_UNAVAILABLE");
  if ((source.width !== null && source.width !== video.width) || (source.height !== null && source.height !== video.height)) {
    throw new Error("MEDIA_ORIGINAL_DIMENSIONS_CHANGED");
  }
  const version = await execFileWithTimeout(ffmpegPath(), ["-version"], { timeoutMs: settings.timeoutMs, maxBuffer: 1024 * 1024 });
  const toolchainSha256 = createHash("sha256").update(version.stdout).digest("hex");
  const configurationSha256 = createHash("sha256").update(JSON.stringify([
    ANALYSIS_DERIVATION_VERSION, settings.proxyCrf, settings.proxyPreset, settings.proxyAudioBitrateBps,
    settings.flacCompressionLevel, settings.encoderThreads, toolchainSha256,
  ])).digest("hex");
  const directory = await mkdtemp(path.join(source.directory, "derivatives-"));
  const analysisPath = path.join(directory, "analysis.flac");
  const proxyPath = path.join(directory, "proxy.mp4");
  // Copy timestamps, then normalize the common container origin once. Both audio outputs share
  // one timestamp-aware resampling filter. It pads leading gaps and the source's trailing silence.
  const filter = `[0:${audio.index}]aresample=16000:async=1:first_pts=0,apad,atrim=duration=${sourceDurationS},asplit=2[analysis][preview_audio];` +
    `[0:${video.index}]scale=-2:480[preview_video]`;
  const args = [
    "-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe", "-copyts", "-start_at_zero",
    "-threads", String(settings.encoderThreads), "-i", source.sourcePath,
    "-filter_complex_threads", String(settings.encoderThreads), "-filter_complex", filter,
    "-map", "[analysis]", "-map_metadata", "-1", "-ac", "1", "-ar", "16000", "-c:a", "flac",
    "-sample_fmt", "s16", "-compression_level", String(settings.flacCompressionLevel), analysisPath,
    "-map", "[preview_video]", "-map", "[preview_audio]", "-map_metadata", "-1",
    "-c:v", "libx264", "-preset", settings.proxyPreset, "-crf", String(settings.proxyCrf),
    "-threads", String(settings.encoderThreads), "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-b:a", String(settings.proxyAudioBitrateBps), "-fps_mode", "passthrough", "-movflags", "+faststart", proxyPath,
  ];
  const started = performance.now();
  try {
    await execFileWithTimeout(ffmpegPath(), args, { timeoutMs: settings.timeoutMs, maxBuffer: 1024 * 1024 });
    const encodingWallMs = performance.now() - started;
    const checks = await Promise.allSettled([
      inspect(analysisPath, settings.timeoutMs), inspect(proxyPath, settings.timeoutMs),
      fileIdentity(analysisPath), fileIdentity(proxyPath), fileIdentity(source.sourcePath),
    ] as const);
    // Settle all readers before lease cleanup, including when one inspection fails.
    for (const check of checks) if (check.status === "rejected") throw check.reason;
    const [analysisProbe, proxyProbe, analysisIdentity, proxyIdentity, sourceIdentity] = checks.map(check => {
      if (check.status !== "fulfilled") throw new Error("MEDIA_INSPECTION_INCOMPLETE");
      return check.value;
    }) as [Probe, Probe, Awaited<ReturnType<typeof fileIdentity>>, Awaited<ReturnType<typeof fileIdentity>>, Awaited<ReturnType<typeof fileIdentity>>];
    const analysisFacts = facts(analysisProbe);
    const proxyFacts = facts(proxyProbe);
    if (sourceIdentity.sha256 !== source.sha256 || sourceIdentity.byteCount !== source.byteCount) throw new Error("MEDIA_SOURCE_BYTES_CHANGED");
    if (analysisFacts.audio?.codec !== "flac" || analysisFacts.audio.channels !== 1 || analysisFacts.audio.sampleRateHz !== 16000 || analysisFacts.video) {
      throw new Error("MEDIA_ANALYSIS_FORMAT_INVALID");
    }
    if (proxyFacts.video?.codec !== "h264" || proxyFacts.video.height !== 480 || !proxyFacts.audio) {
      throw new Error("MEDIA_PROXY_FORMAT_INVALID");
    }
    // One analysis sample bounds duration quantization; this is not a visual-quality threshold.
    if (Math.abs(analysisFacts.durationMs - sourceDurationS * 1000) > 1000 / 16000 + 0.001) {
      throw new Error("MEDIA_ANALYSIS_DURATION_INVALID");
    }
    const analysisStream = analysisProbe.streams.find(stream => stream.codec_type === "audio")!;
    const sampleCount = analysisStream.duration_ts;
    if (!Number.isSafeInteger(sampleCount) || sampleCount! <= 0 || analysisStream.time_base !== "1/16000" ||
      (analysisFacts.audio?.startMs !== null && analysisFacts.audio?.startMs !== 0)) {
      throw new Error("MEDIA_ANALYSIS_SAMPLE_CLOCK_INVALID");
    }
    // A separate source decode verifies the normalized PCM against the stored FLAC decode.
    const referenceFilter = `aresample=16000:async=1:first_pts=0,apad,atrim=duration=${sourceDurationS}`;
    const pcmHash = async (file: string, originalInput: boolean) => {
      const { stdout } = await execFileWithTimeout(ffmpegPath(), ["-nostdin", "-v", "error",
        "-protocol_whitelist", "file,pipe", ...(originalInput ? ["-copyts", "-start_at_zero"] : []),
        "-threads", String(settings.encoderThreads), "-i", file, "-map", originalInput ? `0:${audio.index}` : "0:a:0",
        "-vn", "-sn", "-dn", "-af", originalInput ? referenceFilter : "anull", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "-"],
      { timeoutMs: settings.timeoutMs, maxBuffer: 1024 * 1024 });
      const match = /^SHA256=([a-f0-9]{64})\s*$/.exec(stdout);
      if (!match) throw new Error("MEDIA_ANALYSIS_PCM_HASH_INVALID");
      return match[1];
    };
    const referencePcmSha256 = await pcmHash(source.sourcePath, true);
    if (await pcmHash(analysisPath, false) !== referencePcmSha256) throw new Error("MEDIA_ANALYSIS_PCM_MISMATCH");
    const finalSourceIdentity = await fileIdentity(source.sourcePath);
    if (finalSourceIdentity.sha256 !== source.sha256 || finalSourceIdentity.byteCount !== source.byteCount) {
      throw new Error("MEDIA_SOURCE_BYTES_CHANGED");
    }
    const audioInterval = { startMs: 0, endMs: Math.floor(Math.min(sourceDurationS * 1000, sampleCount! / 16)) };
    if (audioInterval.endMs <= 0) throw new Error("MEDIA_ANALYSIS_MAPPING_EMPTY");
    const audioMappingEvidence = { version: "analysis-audio-mapping-v1", sourceSha256: source.sha256,
      analysisSha256: analysisIdentity.sha256, sourcePresentationOriginMs: originS * 1000,
      sourceInterval: audioInterval, artifactOriginMs: 0, sampleCount: sampleCount!, sampleRateHz: 16000,
      channels: 1, sampleFormat: "s16", referenceFilter, referencePcmSha256, toolchainSha256 };
    return {
      derivationVersion: ANALYSIS_DERIVATION_VERSION, configurationSha256, toolchainSha256,
      settings, encodingWallMs, original: facts(original), sourcePresentationOriginMs: originS * 1000,
      sourceInterval: { startMs: 0, endMs: Math.round(sourceDurationS * 1000) },
      mappingStatus: "DECLARED" as const, visualQuality: "NOT_REVIEWED" as const,
      analysis: { path: analysisPath, ...analysisIdentity, facts: analysisFacts, sourceInterval: audioInterval,
        mappingEvidence: audioMappingEvidence, mappingEvidenceSha256: rangeEvidenceSha256(audioMappingEvidence) },
      proxy: { path: proxyPath, ...proxyIdentity, facts: proxyFacts },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
