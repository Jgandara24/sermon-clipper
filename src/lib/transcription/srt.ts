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
  if (tokens.length === 0) return [];

  const duration = Math.max(endMs - startMs, tokens.length);
  const perWord = duration / tokens.length;

  return tokens.map((word, idx) => ({
    word,
    startMs: Math.round(startMs + idx * perWord),
    endMs: Math.round(startMs + (idx + 1) * perWord),
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

  return { language, segments };
}
