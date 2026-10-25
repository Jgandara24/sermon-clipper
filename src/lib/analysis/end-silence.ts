import { ffmpegPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";

/**
 * Phase 1 lab only. Fix V (lab sermon 4h clip 5, 2026-10-23): the transcript put two "Amen." words at
 * 50:33.68 to 50:33.86, but the recording holds silence there (below -75 dB) from 50:31.5 to 50:33.72,
 * and "In the Book of Luke" starts at 50:33.74. The clip ended at 50:33.86, 100 ms into "In". Jake:
 * "End's very slightly too late." A transcript word can sit on the start of the next sentence, and
 * its onset in the recording comes a little before the word's clock.
 *
 * The cut must not land on a sound that starts right after a pause. When the recording is loud at
 * the cut and a pause of 200 ms or more ends within the 400 ms before it, the cut moves back to the
 * end of that pause. Over the 244 marked clips, 15 ends sit on such an onset; the moves are 40 to
 * 320 ms, and 167 of 174 passed clips already end in silence and do not move.
 */
export const END_SNAP_WINDOW_MS = 400;
export const END_SNAP_SILENT_DB = -55;
export const END_SNAP_LOUD_DB = -40;
export const END_SNAP_MIN_SILENCE_MS = 200;
/** The cut stays this far inside the pause: the frame at its edge already carries the onset. */
export const END_SNAP_MARGIN_MS = 40;
/** 960 samples at 48 kHz. */
export const END_SNAP_FRAME_MS = 20;
const READ_BEFORE_MS = END_SNAP_WINDOW_MS + 600;
const READ_AFTER_MS = 40;

export type RmsFrame = { startMs: number; endMs: number; db: number };

/** ffmpeg's astats metadata print: "pts_time:" lines each followed by an "RMS_level=" line. */
export function parseRmsFrames(log: string, fromMs: number): RmsFrame[] {
  const frames: RmsFrame[] = [];
  let pending: number | null = null;
  for (const line of log.split("\n")) {
    const pts = /pts_time:(-?[\d.]+)/.exec(line);
    if (pts) pending = fromMs + Math.round(Number(pts[1]) * 1000);
    const rms = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (rms && pending !== null) {
      frames.push({ startMs: pending, endMs: pending + END_SNAP_FRAME_MS, db: rms[1] === "-inf" ? -99 : Number(rms[1]) });
      pending = null;
    }
  }
  return frames;
}

/**
 * Where the cut should move, or null when it stays: the recording is loud at the cut, and a run of
 * silent frames lasting END_SNAP_MIN_SILENCE_MS or more ends within END_SNAP_WINDOW_MS before it.
 * A short dip inside a word (a stop consonant) is not a pause and does not move the cut.
 */
export function snapEndIntoSilence(frames: RmsFrame[], endMs: number): { endMs: number; movedMs: number } | null {
  const sorted = [...frames].sort((a, b) => a.startMs - b.startMs);
  const atCut = sorted.filter((f) => f.endMs > endMs - 3 * END_SNAP_FRAME_MS && f.startMs < endMs + END_SNAP_FRAME_MS);
  if (atCut.length === 0 || Math.max(...atCut.map((f) => f.db)) < END_SNAP_LOUD_DB) return null;

  const before = sorted.filter((f) => f.endMs <= endMs - END_SNAP_FRAME_MS);
  let i = before.length - 1;
  while (i >= 0 && before[i].endMs >= endMs - END_SNAP_WINDOW_MS && before[i].db > END_SNAP_SILENT_DB) i -= 1;
  if (i < 0 || before[i].endMs < endMs - END_SNAP_WINDOW_MS) return null;
  const runEnd = before[i].endMs;
  while (i - 1 >= 0 && before[i - 1].db <= END_SNAP_SILENT_DB && before[i - 1].endMs === before[i].startMs) i -= 1;
  if (runEnd - before[i].startMs < END_SNAP_MIN_SILENCE_MS) return null;
  const cut = runEnd - END_SNAP_MARGIN_MS;
  return { endMs: cut, movedMs: cut - endMs };
}

/** 20 ms RMS frames of the source's sound from `fromMs` to `toMs`, on the source clock. */
export async function readRmsFrames(sourceFilePath: string, fromMs: number, toMs: number): Promise<RmsFrame[]> {
  const { stdout } = await execFileWithTimeout(
    ffmpegPath(),
    [
      "-hide_banner", "-nostats", "-loglevel", "error",
      "-ss", (fromMs / 1000).toFixed(3),
      "-t", ((toMs - fromMs) / 1000).toFixed(3),
      "-i", sourceFilePath,
      "-vn",
      "-af", "aresample=48000,asetnsamples=960,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
    ],
    { maxBuffer: 1024 * 1024 * 4, timeoutMs: envTimeoutMs("LAB_END_SNAP_TIMEOUT_MS", 60_000) },
  );
  return parseRmsFrames(stdout, fromMs);
}

/** The clip's end moved back into the pause before the sound it cut into; null when it stays. */
export async function snapClipEnd(
  sourceFilePath: string,
  range: { startMs: number; endMs: number },
): Promise<{ endMs: number; movedMs: number } | null> {
  const frames = await readRmsFrames(sourceFilePath, Math.max(0, range.endMs - READ_BEFORE_MS), range.endMs + READ_AFTER_MS);
  const snapped = snapEndIntoSilence(frames, range.endMs);
  return snapped && snapped.endMs > range.startMs ? snapped : null;
}
