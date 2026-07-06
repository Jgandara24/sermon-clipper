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
});

describe("wordsInRange", () => {
  it("filters to words starting within the range", () => {
    const words = flattenWords(SEGMENTS);
    const inRange = wordsInRange(words, 0, 1000);
    expect(inRange.map((w) => w.word)).toEqual(["Peace", "um", "is"]);
  });
});

describe("applyEditorDeletions", () => {
  it("marks filler words deleted by default and respects explicit deletes/restores", () => {
    const words = flattenWords(SEGMENTS);
    const state = buildDefaultEditorState({ sourceVideoId: "sv", startMs: 0, endMs: 4000 });
    const annotated = applyEditorDeletions(words, state);

    const um = annotated.find((w) => w.word === "um")!;
    expect(um.effectiveDeleted).toBe(true);

    const peace = annotated.find((w) => w.word === "Peace")!;
    expect(peace.effectiveDeleted).toBe(false);

    const stateWithDeletion = {
      ...state,
      wordEdits: { ...state.wordEdits, deletedWordIds: ["seg-1:0"] },
    };
    const withManualDelete = applyEditorDeletions(words, stateWithDeletion);
    expect(withManualDelete.find((w) => w.word === "Peace")!.effectiveDeleted).toBe(true);
  });
});
