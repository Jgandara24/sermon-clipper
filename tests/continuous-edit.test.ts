import { describe, expect, it } from "vitest";
import { convertToContinuous, hasInternalCuts } from "@/lib/editor/continuous-edit";
import { buildDefaultEditorState, editorStateSchema } from "@/lib/editor/types";

function stateWithCuts() {
  const state = buildDefaultEditorState({ sourceVideoId: "vid", startMs: 1000, endMs: 9000 });
  return {
    ...state,
    wordEdits: { deletedWordIds: ["seg-1:2", "seg-1:5"], restoredFillerIds: ["seg-1:3"] },
  };
}

describe("hasInternalCuts", () => {
  it("is false for a fresh default state", () => {
    expect(hasInternalCuts(buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 5000 }))).toBe(
      false,
    );
  });

  it("is true when legacy word deletions exist", () => {
    expect(hasInternalCuts(stateWithCuts())).toBe(true);
  });
});

describe("convertToContinuous", () => {
  it("clears deletion and restored-filler lists without touching anything else", () => {
    const before = stateWithCuts();
    const after = convertToContinuous(before);

    expect(after.wordEdits).toEqual({ deletedWordIds: [], restoredFillerIds: [] });
    expect(after.source).toEqual(before.source);
    expect(after.captions).toEqual(before.captions);
    expect(editorStateSchema.parse(after)).toBeTruthy();
  });

  it("returns the same reference for an already-continuous state", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 5000 });
    expect(convertToContinuous(state)).toBe(state);
  });
});
