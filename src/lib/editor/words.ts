import { isWordDeleted, wordId, type EditorState } from "./types";

export type TranscriptSegmentInput = {
  id: string;
  startMs: number;
  endMs: number;
  /** Stored SRT cues need a compatibility repair when their display windows overlap. */
  timingMode?: "measured" | "srt-interpolated";
  words: Array<{
    word: string;
    startMs: number;
    endMs: number;
    confidence: number;
    isFiller: boolean;
    deleted: boolean;
  }>;
};

export type EditorWord = {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
  isFiller: boolean;
};

export type WordTextOverride = { wordId: string; text: string };

/** Flattens every segment's word list into one time-ordered list with stable editor word ids. */
export function flattenWords(segments: TranscriptSegmentInput[]): EditorWord[] {
  const words: EditorWord[] = [];
  for (const [segmentIndex, segment] of segments.entries()) {
    const nextStartMs = segments[segmentIndex + 1]?.startMs;
    const repairedEndMs =
      segment.timingMode === "srt-interpolated" &&
      nextStartMs !== undefined &&
      nextStartMs > segment.startMs
        ? Math.min(segment.endMs, nextStartMs)
        : segment.endMs;
    const originalDuration = segment.endMs - segment.startMs;
    const repairedDuration = repairedEndMs - segment.startMs;
    const retime = (ms: number) =>
      repairedEndMs === segment.endMs || originalDuration <= 0
        ? ms
        : Math.round(
            segment.startMs +
              ((ms - segment.startMs) / originalDuration) * repairedDuration,
          );

    segment.words.forEach((word, index) => {
      words.push({
        id: wordId(segment.id, index),
        word: word.word,
        startMs: retime(word.startMs),
        endMs: retime(word.endMs),
        isFiller: word.isFiller,
      });
    });
  }
  return words.sort((a, b) => a.startMs - b.startMs);
}

export function wordsInRange(words: EditorWord[], startMs: number, endMs: number): EditorWord[] {
  return words.filter((word) => word.startMs >= startMs && word.startMs < endMs);
}

export function applyWordTextOverrides(
  words: EditorWord[],
  overrides: readonly WordTextOverride[],
): EditorWord[] {
  const overrideMap = new Map(overrides.map((override) => [override.wordId, override.text]));
  return words.map((word) => {
    const text = overrideMap.get(word.id)?.trim();
    return text ? { ...word, word: text } : word;
  });
}

export type EditorWordWithDeletion = EditorWord & { effectiveDeleted: boolean };

/** Annotates each word with its explicit deletion state; filler tags are display metadata only. */
export function applyEditorDeletions(
  words: EditorWord[],
  state: EditorState,
): EditorWordWithDeletion[] {
  return words.map((word) => ({
    ...word,
    effectiveDeleted: isWordDeleted(state, word.id),
  }));
}
