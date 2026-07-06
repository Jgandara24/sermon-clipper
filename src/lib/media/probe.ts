import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProbeResult = {
  durationS: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
};

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
};

export class ProbeParseError extends Error {}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num)) return null;
  if (!den) return num;
  return num / den;
}

/** Pure parser for `ffprobe -print_format json -show_format -show_streams` output. */
export function parseFfprobeOutput(raw: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProbeParseError("ffprobe output was not valid JSON.");
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  if (!videoStream) {
    throw new ProbeParseError("ffprobe output did not include a video stream.");
  }

  const durationRaw = parsed.format?.duration ?? videoStream.duration;
  const durationS = durationRaw ? Number(durationRaw) : NaN;

  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new ProbeParseError("ffprobe output did not include a usable duration.");
  }

  return {
    durationS,
    width: videoStream.width ?? null,
    height: videoStream.height ?? null,
    fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
    hasAudio: Boolean(audioStream),
  };
}

export async function probeVideoFile(filePath: string): Promise<ProbeResult> {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return parseFfprobeOutput(stdout);
}

export async function extractThumbnail(
  filePath: string,
  outPath: string,
  atSeconds: number,
): Promise<void> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  await mkdir(path.dirname(outPath), { recursive: true });
  await execFileAsync(ffmpegPath, [
    "-y",
    "-ss",
    String(Math.max(0, atSeconds)),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outPath,
  ]);
}

export async function extractAudio(filePath: string, outPath: string): Promise<void> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  await mkdir(path.dirname(outPath), { recursive: true });
  await execFileAsync(ffmpegPath, ["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", outPath]);
}
