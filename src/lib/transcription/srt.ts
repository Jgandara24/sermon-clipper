import { distributeDurationByWeight } from "./timing";
import type { TranscriptSegmentResult, TranscriptWord, TranscriptionResult } from "./types";

export class SrtParseError extends Error {}

function timecodeToMs(timecode: string): number {
  const match = timecode.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    throw new SrtParseError(`Invalid SRT timecode: "${timecode.trim()}"`);
  }
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(millis)
  );
}

function interpolateWords(text: string, startMs: number, endMs: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  // Weighted (by word length + punctuation pauses) rather than uniform slices, so word-level
  // caption highlighting paces naturally through interpolated cues instead of jerking.
  return distributeDurationByWeight(tokens, startMs, endMs).map(({ token, startMs, endMs }) => ({
    word: token,
    startMs,
    endMs,
    confidence: 1,
    isFiller: false,
    deleted: false,
  }));
}

/**
 * Parses an SRT file into the same shape a TranscriptionProvider returns. Word timing is
 * linearly interpolated within each cue — SRT files don't carry per-word timestamps, so this is
 * an approximation, not a measurement (documented limitation, guide §9 step 5).
 */
export function parseSrt(srtText: string, language = "en"): TranscriptionResult {
  const normalized = srtText.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new SrtParseError("SRT file is empty.");
  }

  const blocks = normalized.split(/\n\s*\n/);
  const segments: TranscriptSegmentResult[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;

    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) continue;

    const [fromRaw, toRaw] = lines[timingLineIndex].split("-->");
    const startMs = timecodeToMs(fromRaw);
    const endMs = timecodeToMs(toRaw);

    if (endMs <= startMs) {
      throw new SrtParseError(`Cue end time must be after start time: "${lines[timingLineIndex]}"`);
    }

    const text = lines
      .slice(timingLineIndex + 1)
      .join(" ")
      .trim();
    if (!text) continue;

    segments.push({
      startMs,
      endMs,
      text,
      words: interpolateWords(text, startMs, endMs),
    });
  }

  if (segments.length === 0) {
    throw new SrtParseError("No valid cues found in SRT file.");
  }

  // Some caption tools keep the prior cue visible after the next cue starts. Those display
  // windows overlap even though the speech is sequential. For word timing, the next cue start
  // is the only precise boundary present in the SRT, so do not spread the prior cue beyond it.
  const speechSegments = segments.map((segment, index) => {
    const nextStartMs = segments[index + 1]?.startMs;
    const endMs =
      nextStartMs !== undefined && nextStartMs > segment.startMs
        ? Math.min(segment.endMs, nextStartMs)
        : segment.endMs;
    if (endMs === segment.endMs) return segment;
    return {
      ...segment,
      endMs,
      words: interpolateWords(segment.text, segment.startMs, endMs),
    };
  });

  return { language, segments: speechSegments };
}
