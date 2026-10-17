import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath, ffprobePath } from "@/lib/env";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { rangeEvidenceSha256 } from "./range-evidence";

export const SERMON_AUDIO_VERSION = "sermon-audio-sample-trim-v1";
export const sermonCorridorSchema = z.object({
  sourceInterval: sourceIntervalSchema,
  detectorVersion: z.string().trim().min(1), evidenceSha256: sha256Schema,
  confidence: z.number().finite().min(0).max(1),
}).strict();
export const sermonAudioSettingsSchema = z.object({
  threads: z.number().int().positive(), flacCompressionLevel: z.number().int().min(0).max(12),
  timeoutMs: z.number().int().positive().max(2147483647),
  maxMetadataBytes: z.number().int().positive().max(2147483647),
  maxFileBytes: z.number().int().positive().safe(),
}).strict();
const inputSchema = z.object({ path: z.string().min(1), sha256: sha256Schema,
  byteCount: z.number().int().positive().safe(), sourceInterval: sourceIntervalSchema }).strict();
export type SermonAudioInput = z.infer<typeof inputSchema>;
export type SermonCorridor = z.infer<typeof sermonCorridorSchema>;
export type SermonAudioSettings = z.infer<typeof sermonAudioSettingsSchema>;

/** Trim one selected corridor from zero-origin analysis FLAC. This function does not select or approve a corridor. */
export async function extractSermonAudio(inputValue: SermonAudioInput, corridorValue: SermonCorridor,
  temporaryRoot: string, settingsValue: SermonAudioSettings) {
  const input = inputSchema.parse(inputValue), corridor = sermonCorridorSchema.parse(corridorValue);
  const settings = sermonAudioSettingsSchema.parse(settingsValue);
  if (!path.isAbsolute(input.path) || !path.isAbsolute(temporaryRoot) || !(await lstat(input.path)).isFile()) {
    throw new Error("SERMON_AUDIO_LOCAL_FILE_REQUIRED");
  }
  const startSamples = (corridor.sourceInterval.startMs - input.sourceInterval.startMs) * 16;
  const endSamples = (corridor.sourceInterval.endMs - input.sourceInterval.startMs) * 16;
  if (!Number.isSafeInteger(startSamples) || !Number.isSafeInteger(endSamples) || startSamples < 0 ||
    corridor.sourceInterval.endMs > input.sourceInterval.endMs) throw new Error("SERMON_AUDIO_CORRIDOR_OUTSIDE_INPUT");
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("SERMON_AUDIO_INPUT_CHANGED");
  const limits = { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxMetadataBytes };
  const probe = async (file: string) => {
    const { stdout } = await execFileWithTimeout(ffprobePath(), ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_streams", "-of", "json", file], limits);
    const parsed = z.object({ streams: z.array(z.object({ codec_name: z.string(), codec_type: z.string(),
      channels: z.number(), sample_rate: z.string(), time_base: z.string(), duration_ts: z.number().int().positive().safe(),
      start_time: z.string().optional() })) }).parse(JSON.parse(stdout));
    const stream = parsed.streams[0];
    if (parsed.streams.length !== 1 || stream.codec_name !== "flac" || stream.codec_type !== "audio" ||
      stream.channels !== 1 || stream.sample_rate !== "16000" || stream.time_base !== "1/16000" ||
      (stream.start_time !== undefined && Number(stream.start_time) !== 0)) throw new Error("SERMON_AUDIO_FORMAT_REQUIRED");
    return stream;
  };
  const source = await probe(input.path);
  if (endSamples > source.duration_ts) throw new Error("SERMON_AUDIO_CORRIDOR_OUTSIDE_SAMPLES");
  const { stdout: toolchain } = await execFileWithTimeout(ffmpegPath(), ["-version"], limits);
  const directory = await mkdtemp(path.join(temporaryRoot, "sermon-audio-"));
  const outputPath = path.join(directory, "sermon.flac");
  const trim = `atrim=start_sample=${startSamples}:end_sample=${endSamples},asetpts=PTS-STARTPTS`;
  const pcmHash = async (file: string, filter: string) => {
    const { stdout } = await execFileWithTimeout(ffmpegPath(), ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-threads", String(settings.threads), "-i", file, "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-af", filter, "-c:a", "pcm_s32le", "-f", "hash", "-hash", "sha256", "-"], limits);
    const match = /^SHA256=([a-f0-9]{64})\s*$/.exec(stdout);
    if (!match) throw new Error("SERMON_AUDIO_PCM_HASH_INVALID");
    return match[1];
  };
  try {
    await execFileWithTimeout(ffmpegPath(), ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe",
      "-threads", String(settings.threads), "-i", input.path, "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-af", trim, "-c:a", "flac", "-compression_level", String(settings.flacCompressionLevel),
      "-threads", String(settings.threads), "-map_metadata", "-1", "-fs", String(settings.maxFileBytes), outputPath], limits);
    const output = await probe(outputPath);
    if (output.duration_ts !== endSamples - startSamples) throw new Error("SERMON_AUDIO_SAMPLE_COUNT_MISMATCH");
    const sourcePcmSha256 = await pcmHash(input.path, trim);
    if (await pcmHash(outputPath, "anull") !== sourcePcmSha256) throw new Error("SERMON_AUDIO_PCM_MISMATCH");
    const after = await fileIdentity(input.path), identity = await fileIdentity(outputPath);
    if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("SERMON_AUDIO_INPUT_CHANGED");
    if (identity.byteCount > settings.maxFileBytes) throw new Error("SERMON_AUDIO_SIZE_LIMIT");
    const evidence = { version: SERMON_AUDIO_VERSION, inputSha256: input.sha256,
      inputSourceInterval: input.sourceInterval, corridor, sourceOffsetMs: corridor.sourceInterval.startMs,
      durationMs: corridor.sourceInterval.endMs - corridor.sourceInterval.startMs,
      sampleCount: output.duration_ts, sampleRateHz: 16000, channels: 1,
      startSamples, endSamples, sourcePcmSha256, output: identity, settings,
      toolchainSha256: rangeEvidenceSha256(toolchain) };
    return { path: outputPath, directory, ...identity, evidence, evidenceSha256: rangeEvidenceSha256(evidence) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
