import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { arch, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const localMediaMeasurementInput = z.object({
  sourceFile: z.string().min(1),
  artifactFile: z.string().min(1),
  artifactId: z.string().regex(/^[A-Za-z0-9._-]{3,128}$/),
  kind: z.enum(["proxy", "range", "audio"]),
  sourceStartMs: z.number().finite().nonnegative(),
  sourceEndMs: z.number().finite().positive(),
}).strict().refine((input) => input.sourceEndMs > input.sourceStartMs, {
  message: "sourceEndMs must be greater than sourceStartMs",
});

export type LocalMediaMeasurementInput = z.infer<typeof localMediaMeasurementInput>;

const probeStream = z.object({
  codec_type: z.string().optional(), codec_name: z.string().optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  avg_frame_rate: z.string().optional(), duration: z.string().optional(),
  start_time: z.string().optional(), sample_rate: z.string().optional(),
  channels: z.number().int().positive().optional(),
});
const probeOutput = z.object({
  streams: z.array(probeStream),
  format: z.object({ duration: z.string().optional(), start_time: z.string().optional() }),
});

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function secondsToMs(value: string | undefined): number | null {
  const seconds = finiteNumber(value);
  return seconds === null ? null : seconds * 1000;
}

function frameRate(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length > 2) return null;
  const numerator = finiteNumber(parts[0]);
  const denominator = parts.length === 2 ? finiteNumber(parts[1]) : 1;
  if (numerator === null || denominator === null || denominator <= 0 || numerator <= 0) return null;
  return numerator / denominator;
}

/** A narrow projection: never include filenames, media tags, or raw ffprobe output in reports. */
export function parseLocalMediaProbe(raw: string) {
  const parsed = probeOutput.parse(JSON.parse(raw));
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  if (!video && !audio) throw new Error("No audio or video stream was found.");
  const durationMs = [parsed.format.duration, video?.duration, audio?.duration]
    .map(secondsToMs).find((duration) => duration !== null && duration > 0);
  if (durationMs === undefined || durationMs === null) throw new Error("No positive media duration was found.");
  return {
    durationMs,
    containerStartMs: secondsToMs(parsed.format.start_time),
    video: video ? {
      codec: video.codec_name ?? null, width: video.width ?? null, height: video.height ?? null,
      fps: frameRate(video.avg_frame_rate), startMs: secondsToMs(video.start_time),
      durationMs: secondsToMs(video.duration),
    } : null,
    audio: audio ? {
      codec: audio.codec_name ?? null, channels: audio.channels ?? null,
      sampleRateHz: finiteNumber(audio.sample_rate), startMs: secondsToMs(audio.start_time),
      durationMs: secondsToMs(audio.duration),
    } : null,
  };
}

export type LocalMediaProbe = ReturnType<typeof parseLocalMediaProbe>;
type FileMeasurement = { sha256: string; bytes: number; probe: LocalMediaProbe; inspectionWallMs: number };

/** Mapping is a caller declaration. Matching duration does not establish matching content. */
export function compareLocalMedia(
  input: LocalMediaMeasurementInput,
  source: FileMeasurement,
  artifact: FileMeasurement,
) {
  const checked = localMediaMeasurementInput.parse(input);
  if (!source.probe.video) throw new Error("The source must have a video stream.");
  if (checked.sourceEndMs > source.probe.durationMs) throw new Error("The declared range exceeds the source duration.");
  if (checked.kind === "audio" ? !artifact.probe.audio : !artifact.probe.video) {
    throw new Error("The artifact has no stream for the declared kind.");
  }
  const expectedDurationMs = checked.sourceEndMs - checked.sourceStartMs;
  const originalVideo = source.probe.video;
  const artifactVideo = artifact.probe.video;
  return {
    declaredMapping: {
      sourceStartMs: checked.sourceStartMs, sourceEndMs: checked.sourceEndMs,
      expectedDurationMs, timeScale: "1:1" as const, provenance: "caller_declared" as const,
      origin: "relative_to_source_presentation_start" as const,
      verification: "NOT_VERIFIED" as const,
    },
    observations: {
      durationDifferenceMs: artifact.probe.durationMs - expectedDurationMs,
      artifactToSourceByteRatio: artifact.bytes / source.bytes,
      originalDimensionsPreserved: !artifactVideo || originalVideo.width === null || originalVideo.height === null ||
        artifactVideo.width === null || artifactVideo.height === null ? null :
        artifactVideo.width === originalVideo.width && artifactVideo.height === originalVideo.height,
    },
  };
}

// Standalone local tool: no app environment, database client, storage provider, or paid API.
const childEnvironment = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "test" as const });
const childOptions = () => ({
  env: childEnvironment(), encoding: "utf8" as const, timeout: 60_000,
  killSignal: "SIGKILL" as const, maxBuffer: 1024 * 1024,
});

async function inspectFile(file: string): Promise<FileMeasurement> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) throw new Error("Use a local file path, not a URL.");
  const resolved = await realpath(file);
  const before = await stat(resolved, { bigint: true });
  if (!before.isFile() || before.size <= 0 || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Use a nonempty regular media file with a safe byte count.");
  }
  const started = performance.now();
  const hash = createHash("sha256");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const [probe] = await Promise.all([
      execFileAsync("ffprobe", [
        "-v", "error", "-protocol_whitelist", "file,pipe",
        "-format_whitelist", "mov,matroska,webm,mp3,wav,flac,ogg,aac,mpegts",
        "-show_entries", "format=duration,start_time:stream=codec_type,codec_name,width,height,avg_frame_rate,duration,start_time,sample_rate,channels",
        "-of", "json", resolved,
      ], { ...childOptions(), signal: controller.signal }),
      (async () => {
        for await (const chunk of createReadStream(resolved, { signal: controller.signal })) hash.update(chunk);
      })(),
    ]);
    const after = await stat(resolved, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) throw new Error("The media file changed during inspection. Run the measurement again.");
    return {
      sha256: hash.digest("hex"), bytes: Number(before.size), probe: parseLocalMediaProbe(probe.stdout),
      inspectionWallMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function measureLocalMedia(rawInput: LocalMediaMeasurementInput) {
  const input = localMediaMeasurementInput.parse(rawInput);
  const version = await execFileAsync("ffprobe", ["-version"], childOptions());
  const source = await inspectFile(input.sourceFile);
  const artifact = await inspectFile(input.artifactFile);
  const comparison = compareLocalMedia(input, source, artifact);
  return {
    schemaVersion: 1 as const,
    evidenceType: "local_media_inspection" as const,
    recordedAt: new Date().toISOString(), artifactId: input.artifactId, artifactKind: input.kind,
    tools: { ffprobe: version.stdout.split(/\r?\n/)[0], node: process.version, platform: platform(), arch: arch() },
    source, artifact, ...comparison,
    review: { visualQuality: "NOT_REVIEWED", captionAccuracy: "NOT_REVIEWED", sourceContentMapping: "NOT_VERIFIED" },
    unmeasured: ["derivation_runtime", "derivation_cpu", "derivation_peak_memory", "derivation_peak_disk", "remote_transfer", "provider_cost"],
    limits: [
      "Inspection time measures hashing and probing existing files, not creating derivatives.",
      "The declared range is not verified by content alignment. Equal durations do not prove coverage.",
      "Container and stream start times are reported separately; neither is a measured source-content offset.",
      "A byte ratio for a shorter range is not an encoding-efficiency comparison.",
      "No human review, P2 proof, or P4 acceptance is recorded by this report.",
    ],
  };
}
