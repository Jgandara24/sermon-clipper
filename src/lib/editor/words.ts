import { isWordDeleted, wordId, type EditorState } from "./types";

export type TranscriptSegmentInput = {
  id: string;
  startMs: number;
  endMs: number;
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

/** Flattens every segment's word list into one time-ordered list with stable editor word ids. */
export function flattenWords(segments: TranscriptSegmentInput[]): EditorWord[] {
  const words: EditorWord[] = [];
  for (const segment of segments) {
    segment.words.forEach((word, index) => {
      words.push({
        id: wordId(segment.id, index),
        word: word.word,
        startMs: word.startMs,
        endMs: word.endMs,
        isFiller: word.isFiller,
      });
    });
  }
  return words.sort((a, b) => a.startMs - b.startMs);
}

export function wordsInRange(words: EditorWord[], startMs: number, endMs: number): EditorWord[] {
  return words.filter((word) => word.startMs >= startMs && word.startMs < endMs);
}

export type EditorWordWithDeletion = EditorWord & { effectiveDeleted: boolean };

/** Annotates each word with whether it's effectively deleted under the current editor state. */
export function applyEditorDeletions(
  words: EditorWord[],
  state: EditorState,
): EditorWordWithDeletion[] {
  return words.map((word) => ({
    ...word,
    effectiveDeleted: isWordDeleted(state, word.id, word.isFiller),
  }));
}
