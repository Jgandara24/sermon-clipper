import { describe, expect, it } from "vitest";
import { buildDefaultEditorState } from "@/lib/editor/types";
import {
  applyEditorDeletions,
  flattenWords,
  wordsInRange,
  type TranscriptSegmentInput,
} from "@/lib/editor/words";

const SEGMENTS: TranscriptSegmentInput[] = [
  {
    id: "seg-1",
    startMs: 0,
    endMs: 2000,
    words: [
      { word: "Peace", startMs: 0, endMs: 400, confidence: 0.9, isFiller: false, deleted: false },
      { word: "um", startMs: 400, endMs: 600, confidence: 0.3, isFiller: true, deleted: false },
      { word: "is", startMs: 600, endMs: 900, confidence: 0.9, isFiller: false, deleted: false },
    ],
  },
  {
    id: "seg-2",
    startMs: 2000,
    endMs: 4000,
    words: [
      { word: "here.", startMs: 2000, endMs: 2400, confidence: 0.9, isFiller: false, deleted: false },
    ],
  },
];

describe("flattenWords", () => {
  it("produces stable, time-ordered ids across segments", () => {
    const words = flattenWords(SEGMENTS);
    expect(words.map((w) => w.id)).toEqual(["seg-1:0", "seg-1:1", "seg-1:2", "seg-2:0"]);
    expect(words.map((w) => w.word)).toEqual(["Peace", "um", "is", "here."]);
  });

  it("repairs stored SRT words when rolling cue display windows overlap", () => {
    const words = flattenWords([
      {
        id: "old-cue",
        startMs: 1000,
        endMs: 5000,
        timingMode: "srt-interpolated",
        words: [
          { word: "one", startMs: 1000, endMs: 3000, confidence: 1, isFiller: false, deleted: false },
          { word: "two", startMs: 3000, endMs: 5000, confidence: 1, isFiller: false, deleted: false },
        ],
      },
      {
        id: "next-cue",
        startMs: 3000,
        endMs: 6000,
        timingMode: "srt-interpolated",
        words: [
          { word: "three", startMs: 3000, endMs: 6000, confidence: 1, isFiller: false, deleted: false },
        ],
      },
    ]);

    expect(words.map((word) => [word.word, word.startMs, word.endMs])).toEqual([
      ["one", 1000, 2000],
      ["two", 2000, 3000],
      ["three", 3000, 6000],
    ]);
  });
});

describe("wordsInRange", () => {
  it("filters to words starting within the range", () => {
    const words = flattenWords(SEGMENTS);
    const inRange = wordsInRange(words, 0, 1000);
    expect(inRange.map((w) => w.word)).toEqual(["Peace", "um", "is"]);
  });
});

describe("applyEditorDeletions", () => {
  it("keeps filler metadata by default and applies only explicit deletions", () => {
    const words = flattenWords(SEGMENTS);
    const state = buildDefaultEditorState({ sourceVideoId: "sv", startMs: 0, endMs: 4000 });
    const annotated = applyEditorDeletions(words, state);

    const um = annotated.find((w) => w.word === "um")!;
    expect(um.effectiveDeleted).toBe(false);

    const peace = annotated.find((w) => w.word === "Peace")!;
    expect(peace.effectiveDeleted).toBe(false);

    const stateWithDeletion = {
      ...state,
      wordEdits: { ...state.wordEdits, deletedWordIds: ["seg-1:0", "seg-1:1"] },
    };
    const withManualDelete = applyEditorDeletions(words, stateWithDeletion);
    expect(withManualDelete.find((w) => w.word === "Peace")!.effectiveDeleted).toBe(true);
    expect(withManualDelete.find((w) => w.word === "um")!.effectiveDeleted).toBe(true);
  });
});
