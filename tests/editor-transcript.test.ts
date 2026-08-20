import { describe, expect, it } from "vitest";
import {
  applyWordTextOverrides,
  normalizeWordText,
  restoreAllDeletedWords,
  setWordText,
  wordTextOverrides,
} from "@/lib/editor/transcript";
import { buildDefaultEditorState, editorStateSchema, type EditorState } from "@/lib/editor/types";
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
    endMs: 6000,
    words: [
      { word: "Grace", startMs: 500, endMs: 900, confidence: 0.9, isFiller: false, deleted: false },
      { word: "abounds", startMs: 1000, endMs: 1600, confidence: 0.9, isFiller: false, deleted: false },
      { word: "um", startMs: 1700, endMs: 1900, confidence: 0.3, isFiller: true, deleted: false },
      { word: "toward", startMs: 2000, endMs: 2500, confidence: 0.9, isFiller: false, deleted: false },
      { word: "us", startMs: 4000, endMs: 4400, confidence: 0.9, isFiller: false, deleted: false },
    ],
  },
];

const ALL_WORDS = flattenWords(SEGMENTS);

function baseState(): EditorState {
  return buildDefaultEditorState({ sourceVideoId: "video-1", startMs: 0, endMs: 6000 });
}

/** A document written before Slice 5 carries no `textOverrides` array at all. */
function legacyState(): EditorState {
  const state = baseState();
  const wordEdits = { ...state.wordEdits } as Partial<EditorState["wordEdits"]>;
  delete wordEdits.textOverrides;
  return { ...state, wordEdits: wordEdits as EditorState["wordEdits"] };
}

function decorate(state: EditorState) {
  return applyWordTextOverrides(applyEditorDeletions(ALL_WORDS, state), state);
}

describe("normalizeWordText", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeWordText("  Grace  ")).toBe("Grace");
  });

  it("collapses the newlines and runs of spaces a paste can carry in", () => {
    expect(normalizeWordText("Grace\n  and\tpeace")).toBe("Grace and peace");
  });

  it("reduces a whitespace-only value to the empty string", () => {
    expect(normalizeWordText(" \n\t ")).toBe("");
  });
});

describe("wordTextOverrides", () => {
  it("reads the corrections a current document carries", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(wordTextOverrides(state)).toEqual([{ wordId: "seg-1:0", text: "Mercy" }]);
  });

  it("reads a document written before word corrections existed as having none", () => {
    expect(wordTextOverrides(legacyState())).toEqual([]);
  });
});

describe("applyWordTextOverrides", () => {
  it("shows the correction in place of what the transcript said", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    const words = decorate(state);
    expect(words[0].word).toBe("Mercy");
  });

  it("keeps the transcript's own word reachable as originalWord", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(decorate(state)[0].originalWord).toBe("Grace");
  });

  it("leaves the word's identity and timestamps exactly as they were", () => {
    const before = decorate(baseState())[0];
    const after = decorate(setWordText(baseState(), "seg-1:0", "Mercy", "Grace"))[0];

    expect(after.id).toBe(before.id);
    expect(after.startMs).toBe(before.startMs);
    expect(after.endMs).toBe(before.endMs);
    expect(after.isFiller).toBe(before.isFiller);
    expect(after.effectiveDeleted).toBe(before.effectiveDeleted);
  });

  it("leaves every other word untouched", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(decorate(state).slice(1).map((word) => word.word)).toEqual([
      "abounds",
      "um",
      "toward",
      "us",
    ]);
  });

  it("renders a document written before word corrections existed unchanged", () => {
    expect(decorate(legacyState()).map((word) => word.word)).toEqual([
      "Grace",
      "abounds",
      "um",
      "toward",
      "us",
    ]);
  });

  it("ignores a correction whose word id is no longer in the range", () => {
    const state = setWordText(baseState(), "seg-9:4", "Nowhere", "Missing");
    expect(decorate(state).map((word) => word.word)).toEqual([
      "Grace",
      "abounds",
      "um",
      "toward",
      "us",
    ]);
  });
});

describe("setWordText", () => {
  it("records a correction for the word it was given", () => {
    const state = setWordText(baseState(), "seg-1:1", "abound", "abounds");
    expect(wordTextOverrides(state)).toEqual([{ wordId: "seg-1:1", text: "abound" }]);
  });

  it("replaces an existing correction rather than stacking a second one", () => {
    let state = setWordText(baseState(), "seg-1:1", "abound", "abounds");
    state = setWordText(state, "seg-1:1", "abounded", "abounds");
    expect(wordTextOverrides(state)).toEqual([{ wordId: "seg-1:1", text: "abounded" }]);
  });

  it("keeps a replaced correction in its original position", () => {
    let state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    state = setWordText(state, "seg-1:3", "towards", "toward");
    state = setWordText(state, "seg-1:0", "Favor", "Grace");
    expect(wordTextOverrides(state).map((override) => override.wordId)).toEqual([
      "seg-1:0",
      "seg-1:3",
    ]);
  });

  it("drops the correction when the transcript's own word is typed back", () => {
    let state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    state = setWordText(state, "seg-1:0", "Grace", "Grace");
    expect(wordTextOverrides(state)).toEqual([]);
  });

  it("returns to a document identical to the one it started from", () => {
    const start = baseState();
    let state = setWordText(start, "seg-1:0", "Mercy", "Grace");
    state = setWordText(state, "seg-1:0", "Grace", "Grace");
    expect(state).toEqual(start);
  });

  it("normalizes the text it stores", () => {
    const state = setWordText(baseState(), "seg-1:0", "  Mercy  ", "Grace");
    expect(wordTextOverrides(state)).toEqual([{ wordId: "seg-1:0", text: "Mercy" }]);
  });

  it("refuses to empty a word, because an empty word is a gap nobody asked for", () => {
    const start = baseState();
    expect(setWordText(start, "seg-1:0", "   ", "Grace")).toBe(start);
  });

  it("keeps the previous correction when the field is momentarily cleared", () => {
    const corrected = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(setWordText(corrected, "seg-1:0", "", "Grace")).toBe(corrected);
  });

  it("returns the same document when the correction changes nothing", () => {
    const corrected = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(setWordText(corrected, "seg-1:0", "Mercy", "Grace")).toBe(corrected);
  });

  it("never moves the clip's range", () => {
    const start = baseState();
    const state = setWordText(start, "seg-1:0", "Mercy", "Grace");
    expect(state.source).toEqual(start.source);
  });

  it("never cuts a word out of the clip", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(state.wordEdits.deletedWordIds).toEqual([]);
  });

  it("leaves the rest of the document alone", () => {
    const start = baseState();
    const state = setWordText(start, "seg-1:0", "Mercy", "Grace");
    expect(state.captions).toEqual(start.captions);
    expect(state.layout).toEqual(start.layout);
    expect(state.extensions).toEqual(start.extensions);
    expect(state.version).toBe(start.version);
  });

  it("corrects a word in a document written before word corrections existed", () => {
    const state = setWordText(legacyState(), "seg-1:0", "Mercy", "Grace");
    expect(wordTextOverrides(state)).toEqual([{ wordId: "seg-1:0", text: "Mercy" }]);
  });
});

describe("the clip range decides which words the transcript shows", () => {
  const inRange = (state: EditorState) =>
    wordsInRange(ALL_WORDS, state.source.startMs, state.source.endMs).map((word) => word.word);

  it("contracts when the start handle moves inward", () => {
    const state = baseState();
    expect(inRange(state)).toEqual(["Grace", "abounds", "um", "toward", "us"]);

    const trimmed = { ...state, source: { ...state.source, startMs: 1000 } };
    expect(inRange(trimmed)).toEqual(["abounds", "um", "toward", "us"]);
  });

  it("contracts when the end handle moves inward", () => {
    const state = baseState();
    const trimmed = { ...state, source: { ...state.source, endMs: 2000 } };
    expect(inRange(trimmed)).toEqual(["Grace", "abounds", "um"]);
  });

  it("expands when the start handle extends outward", () => {
    const narrow = { ...baseState(), source: { ...baseState().source, startMs: 2000 } };
    expect(inRange(narrow)).toEqual(["toward", "us"]);

    const widened = { ...narrow, source: { ...narrow.source, startMs: 0 } };
    expect(inRange(widened)).toEqual(["Grace", "abounds", "um", "toward", "us"]);
  });

  it("expands when the end handle extends outward", () => {
    const narrow = { ...baseState(), source: { ...baseState().source, endMs: 2000 } };
    expect(inRange(narrow)).toEqual(["Grace", "abounds", "um"]);

    const widened = { ...narrow, source: { ...narrow.source, endMs: 6000 } };
    expect(inRange(widened)).toEqual(["Grace", "abounds", "um", "toward", "us"]);
  });

  it("keeps a correction attached to its word across a trim", () => {
    const state = setWordText(baseState(), "seg-1:3", "towards", "toward");
    const trimmed = { ...state, source: { ...state.source, startMs: 2000 } };
    const words = applyWordTextOverrides(
      applyEditorDeletions(
        wordsInRange(ALL_WORDS, trimmed.source.startMs, trimmed.source.endMs),
        trimmed,
      ),
      trimmed,
    );
    expect(words.map((word) => word.word)).toEqual(["towards", "us"]);
    expect(words[0].startMs).toBe(2000);
  });
});

describe("restoreAllDeletedWords", () => {
  it("clears the cuts a legacy document carries", () => {
    const state: EditorState = {
      ...baseState(),
      wordEdits: { ...baseState().wordEdits, deletedWordIds: ["seg-1:1", "seg-1:2"] },
    };
    expect(restoreAllDeletedWords(state).wordEdits.deletedWordIds).toEqual([]);
  });

  it("leaves the clip's range alone", () => {
    const state: EditorState = {
      ...baseState(),
      wordEdits: { ...baseState().wordEdits, deletedWordIds: ["seg-1:1"] },
    };
    expect(restoreAllDeletedWords(state).source).toEqual(state.source);
  });

  it("returns the same document when there is nothing to restore", () => {
    const state = baseState();
    expect(restoreAllDeletedWords(state)).toBe(state);
  });
});

describe("editorStateSchema", () => {
  it("accepts a document that carries word corrections", () => {
    const state = setWordText(baseState(), "seg-1:0", "Mercy", "Grace");
    expect(editorStateSchema.parse(state).wordEdits.textOverrides).toEqual([
      { wordId: "seg-1:0", text: "Mercy" },
    ]);
  });

  it("still accepts a document written before word corrections existed", () => {
    const parsed = editorStateSchema.parse(legacyState());
    expect(parsed.wordEdits.textOverrides).toEqual([]);
  });

  it("gives a new document no corrections", () => {
    expect(buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 1 }).wordEdits.textOverrides).toEqual([]);
  });
});
