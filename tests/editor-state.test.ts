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

describe("caption override schema compatibility", () => {
  const base = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 0, endMs: 5000 });

  it("still parses a legacy document with only the original override keys", () => {
    const legacy = {
      ...base,
      captions: {
        presetId: "clean",
        overrides: { sizePx: 48, position: "top", uppercase: true, highlightColor: "#facc15" },
        textOverrides: [],
      },
    };
    expect(() => editorStateSchema.parse(legacy)).not.toThrow();
  });

  it("parses the kinetic override keys", () => {
    const next = {
      ...base,
      captions: {
        presetId: "kinetic",
        overrides: {
          fontFamily: "Inter",
          fontWeight: 800,
          textColor: "#FFFFFF",
          highlightMode: "word",
          highlightScale: 1.14,
          outlineColor: "#000000",
          outlineWidthPx: 6,
          shadowColor: "#000000",
          shadowDistancePx: 2,
          positionX: 50,
          positionY: 62,
          anchor: "center",
          safeAnchor: "bottom-safe",
        },
        textOverrides: [],
      },
    };
    expect(() => editorStateSchema.parse(next)).not.toThrow();
  });

  it("rejects out-of-range kinetic values", () => {
    const bad = {
      ...base,
      captions: { presetId: "kinetic", overrides: { highlightScale: 3 }, textOverrides: [] },
    };
    expect(() => editorStateSchema.parse(bad)).toThrow();
  });
});

describe("wordId", () => {
  it("combines segment id and word index deterministically", () => {
    expect(wordId("seg-1", 3)).toBe("seg-1:3");
  });
});

describe("isWordDeleted", () => {
  const base = buildDefaultEditorState({ sourceVideoId: "sv-1", startMs: 0, endMs: 10_000 });

  it("keeps filler-tagged words by default", () => {
    expect(isWordDeleted(base, "seg-1:0")).toBe(false);
  });

  it("keeps legacy restored-filler documents readable", () => {
    const state = {
      ...base,
      wordEdits: { ...base.wordEdits, restoredFillerIds: ["seg-1:0"] },
    };
    expect(isWordDeleted(state, "seg-1:0")).toBe(false);
  });

  it("deletes a filler-tagged word only when it is explicit", () => {
    const state = {
      ...base,
      wordEdits: { ...base.wordEdits, deletedWordIds: ["seg-1:0"] },
    };
    expect(isWordDeleted(state, "seg-1:0")).toBe(true);
  });

  it("treats non-filler words as not deleted by default", () => {
    expect(isWordDeleted(base, "seg-1:1")).toBe(false);
  });

  it("treats an explicitly deleted non-filler word as deleted", () => {
    const state = {
      ...base,
      wordEdits: { ...base.wordEdits, deletedWordIds: ["seg-1:1"] },
    };
    expect(isWordDeleted(state, "seg-1:1")).toBe(true);
  });
});
