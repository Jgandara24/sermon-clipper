import { ffmpegPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";

/**
 * Phase 1 lab only (LAB_DROPOUT_CHECK_ENABLED, docs/PHASE1_LAB_PLAN.md). Fix Q (lab sermon 4f clip 2,
 * 2026-10-21): the livestream lost its sound for 3.5 seconds at 51:56.5, and the clip played it. The
 * recording holds digital silence there (-91 dB); the speech around it measures about -31 dB. Jake:
 * "we can't allows that to be posted." The five lab services hold one such gap in 5.6 hours, so a
 * pause in the room does not reach this level.
 */
export const DROPOUT_NOISE_DB = -80;
export const DROPOUT_MIN_MS = 1_000;

export type AudioDropout = { startMs: number; endMs: number };

const toMs = (seconds: string) => Math.round(Number(seconds) * 1000);

/** The silences in ffmpeg's silencedetect log. One still open at the end of the file runs to its end. */
export function parseSilenceDetect(log: string): AudioDropout[] {
  const dropouts: AudioDropout[] = [];
  let startMs: number | null = null;
  for (const line of log.split("\n")) {
    const start = /silence_start: (-?[\d.]+)/.exec(line);
    if (start) startMs = Math.max(0, toMs(start[1]));
    const end = /silence_end: ([\d.]+)/.exec(line);
    if (end && startMs !== null) {
      dropouts.push({ startMs, endMs: toMs(end[1]) });
      startMs = null;
    }
  }
  if (startMs !== null) dropouts.push({ startMs, endMs: Infinity });
  return dropouts;
}

/** The first dropout that silences at least DROPOUT_MIN_MS of the clip; null when none does. */
export function dropoutInClip(clip: { startMs: number; endMs: number }, dropouts: AudioDropout[]): AudioDropout | null {
  return (
    dropouts.find((d) => Math.min(d.endMs, clip.endMs) - Math.max(d.startMs, clip.startMs) >= DROPOUT_MIN_MS) ?? null
  );
}

/** Scans the whole source once, about 20 seconds for an hour-long service. */
export async function findAudioDropouts(sourceFilePath: string): Promise<AudioDropout[]> {
  const { stderr } = await execFileWithTimeout(
    ffmpegPath(),
    [
      "-hide_banner", "-nostats",
      "-i", sourceFilePath,
      "-vn",
      "-af", `silencedetect=noise=${DROPOUT_NOISE_DB}dB:d=${DROPOUT_MIN_MS / 1000}`,
      "-f", "null", "-",
    ],
    { maxBuffer: 1024 * 1024 * 8, timeoutMs: envTimeoutMs("LAB_DROPOUT_CHECK_TIMEOUT_MS", 5 * 60_000) },
  );
  return parseSilenceDetect(stderr);
}
