import { readFile } from "node:fs/promises";
import path from "node:path";
import { ffmpegPath } from "@/lib/env";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";

/**
 * Lab only (fix G1): how loud each word is, so the captions can leave out what the congregation
 * calls back (src/lib/editor/caption-cleanup.ts). The lab export already has the source file on disk.
 */

const SAMPLE_RATE = 16_000;
const MIN_WINDOW_MS = 10;

type TimedWord = { id: string; word: string; startMs: number; endMs: number };

/** RMS level of each word in dBFS, from mono 16-bit samples that start at `startMs` on the source clock. */
export function wordLevelsDb(pcm: Int16Array, sampleRate: number, startMs: number, words: TimedWord[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const word of words) {
    const from = Math.floor(((word.startMs - startMs) * sampleRate) / 1000);
    const to = Math.max(Math.ceil(((word.endMs - startMs) * sampleRate) / 1000), from + (MIN_WINDOW_MS * sampleRate) / 1000);
    if (from < 0 || to > pcm.length) continue;
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += pcm[i] * pcm[i];
    levels.set(word.id, 20 * Math.log10(Math.sqrt(sum / (to - from)) / 32_768 + 1e-9));
  }
  return levels;
}

/** Decodes the clip's audio once (mono, 16 kHz) and measures every word in it. */
export async function measureWordLevels(params: {
  sourceFilePath: string;
  range: { startMs: number; endMs: number };
  words: TimedWord[];
  workDir: string;
}): Promise<Map<string, number>> {
  const out = path.join(params.workDir, "word-levels.pcm");
  await execFileWithTimeout(
    ffmpegPath(),
    [
      "-y", "-v", "error",
      "-ss", (params.range.startMs / 1000).toFixed(3),
      "-i", params.sourceFilePath,
      "-t", ((params.range.endMs - params.range.startMs) / 1000).toFixed(3),
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", out,
    ],
    { maxBuffer: 1024 * 1024, timeoutMs: envTimeoutMs("EXPORT_FFMPEG_TIMEOUT_MS", 900_000) },
  );
  const bytes = await readFile(out);
  const length = Math.floor(bytes.byteLength / 2);
  // A copy, so the samples start on an even byte whatever the buffer's offset.
  const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length * 2));
  return wordLevelsDb(pcm, SAMPLE_RATE, params.range.startMs, params.words);
}
