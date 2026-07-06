import { describe, expect, it } from "vitest";
import {
  buildDefaultEditorState,
  editorStateSchema,
  isWordDeleted,
  wordId,
} from "@/lib/editor/types";

describe("buildDefaultEditorState", () => {
  it("builds a state that validates against the schema", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 1000, endMs: 5000 });
    expect(() => editorStateSchema.parse(state)).not.toThrow();
    expect(state.source).toEqual({ videoId: "sv-1", startMs: 1000, endMs: 5000 });
    expect(state.layout.mode).toBe("center");
  });
});

describe("wordId", () => {
  it("combines segment id and word index deterministically", () => {
    expect(wordId("seg-1", 3)).toBe("seg-1:3");
  });
});

describe("isWordDeleted", () => {
  const base = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 0, endMs: 10_000 });

  it("treats filler words as deleted by default", () => {
    expect(isWordDeleted(base, "seg-1:0", true)).toBe(true);
  });

  it("treats a restored filler word as not deleted", () => {
    const state = {
      ...base,
      wordEdits: { ...base.wordEdits, restoredFillerIds: ["seg-1:0"] },
    };
    expect(isWordDeleted(state, "seg-1:0", true)).toBe(false);
  });

  it("treats non-filler words as not deleted by default", () => {
    expect(isWordDeleted(base, "seg-1:1", false)).toBe(false);
  });

  it("treats an explicitly deleted non-filler word as deleted", () => {
    const state = {
      ...base,
      wordEdits: { ...base.wordEdits, deletedWordIds: ["seg-1:1"] },
    };
    expect(isWordDeleted(state, "seg-1:1", false)).toBe(true);
  });
});
