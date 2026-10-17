import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpegPath, ffprobePath } from "@/lib/env";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";
import { addTimeMs, compareTimeMs, exactTimeMsSchema, normalizeTimeMs, type ExactTimeMs } from "./exact-time";

import { rangeEvidenceSha256 } from "./range-evidence";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({ path: z.string().min(1), sha256: sha256Schema, byteCount: positive,
  sourceDurationMs: positive, sourceOriginMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  width: positive, height: positive }).strict();
const intervalSchema = z.object({ startMs: exactTimeMsSchema, endMs: exactTimeMsSchema }).strict();
export const rangeExtractionSettingsSchema = z.object({ mode: z.enum(["lossless-mezzanine", "stream-copy", "prefer-stream-copy"]), threads: positive,
  timeoutMs: positive.max(2147483647), maxOutputBytes: positive.max(2147483647), maxFileBytes: positive,
  maxProofFrames: positive }).strict();
export type RangeExtractionInput = z.infer<typeof inputSchema>;
export type RangeExtractionSettings = z.infer<typeof rangeExtractionSettingsSchema>;
const streamSchema = z.object({ codec_type: z.string(), codec_name: z.string().optional(),
  time_base: z.string().regex(/^[1-9]\d*\/[1-9]\d*$/), width: positive.optional(), height: positive.optional(),
  sample_rate: z.string().regex(/^[1-9]\d*$/).optional(), channels: positive.optional(), pix_fmt: z.string().optional(),
  sample_fmt: z.string().optional() });

function ticks(time: ExactTimeMs, timeBase: string, rounding: "exact" | "ceil" | "floor") {
  const value = normalizeTimeMs(time);
  const n = typeof value === "number" ? BigInt(value) : BigInt(value.numerator);
  const d = typeof value === "number" ? BigInt(1) : BigInt(value.denominator);
  const [tn, td] = timeBase.split("/").map(BigInt);
  const numerator = n * td, denominator = d * tn * BigInt(1000);
  if (rounding === "exact" && numerator % denominator !== BigInt(0)) throw new Error("RANGE_BOUNDARY_NOT_ON_VIDEO_CLOCK");
  const result = (numerator + (rounding === "ceil" ? denominator - BigInt(1) : BigInt(0))) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RANGE_TIMESTAMP_EXCEEDS_FILTER_PRECISION");
  return result.toString();
}

function proofRows(output: string, maxFrames: number) {
  if (!/^#hash: SHA256$/m.test(output)) throw new Error("RANGE_PROOF_INVALID");
  const rows = output.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#")).map(line => {
    const fields = line.split(",").map(value => value.trim());
    if (fields.length !== 6 || !/^[01]$/.test(fields[0]) ||
      fields.slice(1, 5).some(value => !/^-?\d+$/.test(value))) throw new Error("RANGE_PROOF_INVALID");
    sha256Schema.parse(fields[5]);
    return fields;
  });
  if (rows.length > maxFrames) throw new Error("RANGE_PROOF_LIMIT_EXCEEDED");
  if (!rows.some(row => row[0] === "0")) throw new Error("RANGE_PROOF_EMPTY");
  // Mux interleaving can differ. Preserve order within each stream.
  return { headers: output.split(/\r?\n/).filter(line => /^#(?:tb|dimensions|sample_rate|channel_layout_name) /.test(line)),
    video: rows.filter(row => row[0] === "0"), audio: rows.filter(row => row[0] === "1") };
}

/** Preserves absolute media timestamps and checks decoded frame/sample identity.
 * This does not select production codecs, approve visual quality, register files, or permit source deletion.
 */
export async function extractCandidateRange(inputValue: RangeExtractionInput,
  intervalValue: { startMs: ExactTimeMs; endMs: ExactTimeMs }, outputRoot: string, settingsValue: RangeExtractionSettings) {
  const input = inputSchema.parse(inputValue), interval = intervalSchema.parse(intervalValue), settings = rangeExtractionSettingsSchema.parse(settingsValue);
  if (compareTimeMs(interval.startMs, interval.endMs) >= 0 || compareTimeMs(interval.endMs, input.sourceDurationMs) > 0) {
    throw new Error("RANGE_OUTSIDE_SOURCE");
  }
  if (!path.isAbsolute(input.path) || !path.isAbsolute(outputRoot) || !(await lstat(input.path)).isFile()) {
    throw new Error("RANGE_LOCAL_PATH_REQUIRED");
  }
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("RANGE_INPUT_CHANGED");
  const limits = { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes };
  const run = (args: string[]) => execFileWithTimeout(ffmpegPath(), args, limits);
  const { stdout: probeText } = await execFileWithTimeout(ffprobePath(), ["-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_streams", "-of", "json", input.path], limits);
  const streams = z.object({ streams: z.array(streamSchema) }).parse(JSON.parse(probeText)).streams;
  const video = streams.filter(stream => stream.codec_type === "video"), audio = streams.filter(stream => stream.codec_type === "audio");
  if (video.length !== 1 || audio.length > 1) throw new Error("RANGE_STREAM_SELECTION_REQUIRED");
  if (video[0].width !== input.width || video[0].height !== input.height) throw new Error("RANGE_ORIGINAL_DIMENSIONS_CHANGED");
  const start = addTimeMs(interval.startMs, input.sourceOriginMs), end = addTimeMs(interval.endMs, input.sourceOriginMs);
  const videoStart = ticks(start, video[0].time_base, "exact"), videoEnd = ticks(end, video[0].time_base, "exact");
  const videoFilter = `trim=start_pts=${videoStart}:end_pts=${videoEnd}`;
  const sampleRate = audio[0]?.sample_rate;
  if (audio.length && (!sampleRate || !audio[0].channels)) throw new Error("RANGE_AUDIO_FACTS_MISSING");
  // Float64 exactly represents these decoded formats. It cannot preserve every signed 64-bit integer sample.
  if (audio.length && !["u8", "u8p", "s16", "s16p", "s32", "s32p", "flt", "fltp", "dbl", "dblp"].includes(audio[0].sample_fmt ?? "")) {
    throw new Error("RANGE_AUDIO_SAMPLE_FORMAT_UNSUPPORTED");
  }
  const audioClock = sampleRate ? `1/${sampleRate}` : undefined;
  const audioFilter = audioClock ? `asettb=${audioClock},atrim=start_pts=${ticks(start, audioClock, "ceil")}:end_pts=${ticks(end, audioClock, "ceil")}` : undefined;
  const sourceArgs = (file: string) => ["-nostdin", "-v", "error", "-xerror", "-n", "-protocol_whitelist", "file,pipe",
    "-copyts", "-threads", String(settings.threads), "-i", file, "-map", "0:v:0", ...(audio.length ? ["-map", "0:a:0"] : []),
    "-sn", "-dn", "-filter_threads", String(settings.threads)];
  const filters = ["-vf", videoFilter, ...(audioFilter ? ["-af", audioFilter] : [])];
  const clocks = ["-enc_time_base:v", video[0].time_base, ...(audioClock ? ["-enc_time_base:a", audioClock] : []),
    "-fps_mode:v", "passthrough", "-avoid_negative_ts", "disabled", "-threads", String(settings.threads)];
  const { stdout: version } = await run(["-version"]);
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const directory = await mkdtemp(path.join(outputRoot, "candidate-range-"));
  try {
    const outputPath = path.join(directory, "range.nut");
    const proof = async (file: string, original: boolean) => {
      const { stdout } = await run([...sourceArgs(file), ...(original ? ["-vf", videoFilter] : []),
        ...(audioFilter ? ["-af", `${original ? audioFilter + "," : ""}asetnsamples=n=1024:p=0`] : []),
        "-c:v", "rawvideo", ...(audio.length ? ["-c:a", "pcm_f64le"] : []), ...clocks,
        "-f", "framehash", "-hash", "sha256", "pipe:1"]);
      return proofRows(stdout, settings.maxProofFrames);
    };
    const expected = await proof(input.path, true);
    const attempts: { mode: "stream-copy" | "lossless-mezzanine"; outcome: "ACCEPTED" | "REJECTED"; reason: string | null }[] = [];
    const verify = async () => {
      const identity = await fileIdentity(outputPath);
      if (identity.byteCount > settings.maxFileBytes) throw new Error("RANGE_FILE_LIMIT_EXCEEDED");
      const actual = await proof(outputPath, false);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("RANGE_DECODED_CONTENT_OR_CLOCK_CHANGED");
      // A matching short output is not proof that the requested interval exists in the source.
      if (BigInt(actual.video[0][2]) !== BigInt(videoStart) ||
        BigInt(actual.video.at(-1)![2]) + BigInt(actual.video.at(-1)![3]) !== BigInt(videoEnd) ||
        actual.video.some((frame, index) => BigInt(frame[3]) <= BigInt(0) || (index > 0 &&
          BigInt(actual.video[index - 1][2]) + BigInt(actual.video[index - 1][3]) !== BigInt(frame[2])))) {
        throw new Error("RANGE_VIDEO_COVERAGE_UNPROVEN");
      }
      return { identity, actual };
    };
    let verified: Awaited<ReturnType<typeof verify>> | undefined;
    if (settings.mode !== "lossless-mezzanine") {
      try {
        const seconds = (time: ExactTimeMs) => {
          const us = BigInt(ticks(time, "1/1000000", "floor"));
          return `${us / BigInt(1000000)}.${String(us % BigInt(1000000)).padStart(6, "0")}`;
        };
        // FFmpeg seeks at microsecond precision. Output offset restores the absolute clock.
        // Verification, not the rounded seek command, establishes exact frame/sample boundaries.
        await run([...sourceArgs(input.path), "-ss", seconds(start), "-to", seconds(end), "-c", "copy",
          "-avoid_negative_ts", "disabled", "-output_ts_offset", seconds(start), "-f", "nut", outputPath]);
        verified = await verify();
        attempts.push({ mode: "stream-copy", outcome: "ACCEPTED", reason: null });
      } catch (error) {
        const failure = error as { code?: unknown; message?: string; stderr?: string };
        const reason = failure.message === "RANGE_DECODED_CONTENT_OR_CLOCK_CHANGED" || failure.message === "RANGE_VIDEO_COVERAGE_UNPROVEN" || failure.message === "RANGE_PROOF_EMPTY"
          ? failure.message : failure.code === 1 && !/No space left|Permission denied|Cannot allocate memory/i.test(failure.stderr ?? "")
            ? "RANGE_COPY_PROCESS_REJECTED" : null;
        // Timeouts, limits, filesystem errors, and unknown failures never trigger additional work.
        if (!reason || settings.mode === "stream-copy") throw error;
        attempts.push({ mode: "stream-copy", outcome: "REJECTED", reason });
        await rm(outputPath, { force: true });
      }
    }
    if (!verified) {
      await run([...sourceArgs(input.path), ...filters, "-c:v", "ffv1", "-level", "3",
        ...(audio.length ? ["-c:a", "pcm_f64le"] : []), ...clocks, "-f", "nut", outputPath]);
      verified = await verify();
      attempts.push({ mode: "lossless-mezzanine", outcome: "ACCEPTED", reason: null });
    }
    const { identity, actual } = verified;
    const after = await fileIdentity(input.path);
    if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("RANGE_INPUT_CHANGED");
    const evidence = { version: "verified-candidate-range-v3", sourceSha256: input.sha256,
      sourceInterval: { startMs: normalizeTimeMs(interval.startMs), endMs: normalizeTimeMs(interval.endMs) },
      sourceOriginMs: input.sourceOriginMs, width: input.width, height: input.height,
      videoTimeBase: video[0].time_base, audioTimeBase: audioClock ?? null,
      videoFrames: actual.video.length, audioBlocks: actual.audio.length,
      videoStartPts: videoStart, videoEndPts: videoEnd,
      audioStartPts: actual.audio[0]?.[2] ?? null,
      audioEndPts: actual.audio.length ? String(BigInt(actual.audio.at(-1)![2]) + BigInt(actual.audio.at(-1)![3])) : null,
      audioSamples: actual.audio.reduce((sum, frame) => sum + BigInt(frame[3]), BigInt(0)).toString(),
      decodedProofSha256: createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
      toolchainSha256, outputSha256: identity.sha256, outputByteCount: identity.byteCount,
      requestedMode: settings.mode, mode: attempts.at(-1)!.mode, attempts, visualQuality: "NOT_REVIEWED" as const };
    return { directory, path: outputPath, ...identity, evidence,
      evidenceSha256: rangeEvidenceSha256(evidence) };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Range extraction and cleanup failed."); }
    throw error;
  }
}

/** Compatibility entry point for callers that explicitly request the lossless path. */
export async function extractLosslessCandidateRange(input: RangeExtractionInput,
  interval: { startMs: ExactTimeMs; endMs: ExactTimeMs }, outputRoot: string, settings: RangeExtractionSettings) {
  if (settings.mode !== "lossless-mezzanine") throw new Error("RANGE_LOSSLESS_MODE_REQUIRED");
  return extractCandidateRange(input, interval, outputRoot, settings);
}
