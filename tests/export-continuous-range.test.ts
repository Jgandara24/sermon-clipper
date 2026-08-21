import { describe, expect, it, vi } from "vitest";
import { restoreAllDeletedWords } from "@/lib/editor/transcript";
import { buildDefaultEditorState, wordId, type EditorState } from "@/lib/editor/types";
import type { TranscriptSegmentInput } from "@/lib/editor/words";
import {
  assertContinuousRange,
  clipCutWordIds,
  CONTINUOUS_RANGE_MESSAGE,
  CONTINUOUS_RANGE_REQUIRED,
  clipRendersContinuousRange,
  rendersContinuousRange,
} from "@/lib/exports/continuous-range";
import { ExportFailureError } from "@/lib/exports/errors";

const SEGMENTS: TranscriptSegmentInput[] = [
  {
    id: "seg-1",
    startMs: 0,
    endMs: 8000,
    words: [
      { word: "Before", startMs: 500, endMs: 900, confidence: 0.9, isFiller: false, deleted: false },
      { word: "Grace", startMs: 3100, endMs: 3500, confidence: 0.9, isFiller: false, deleted: false },
      { word: "abounds", startMs: 3600, endMs: 4200, confidence: 0.9, isFiller: false, deleted: false },
      { word: "toward", startMs: 4400, endMs: 4900, confidence: 0.9, isFiller: false, deleted: false },
      { word: "us", startMs: 6000, endMs: 6400, confidence: 0.9, isFiller: false, deleted: false },
    ],
  },
];

const CLIP_START_MS = 3000;
const CLIP_END_MS = 7000;

function stateWithCuts(...ids: string[]): EditorState {
  const base = buildDefaultEditorState({
    sourceVideoId: "video-1",
    startMs: CLIP_START_MS,
    endMs: CLIP_END_MS,
  });
  return { ...base, wordEdits: { ...base.wordEdits, deletedWordIds: ids } };
}

/** A document so old it predates the field entirely. */
function stateWithoutWordEdits(): EditorState {
  const base = stateWithCuts();
  const wordEdits = { ...base.wordEdits } as Partial<EditorState["wordEdits"]>;
  delete wordEdits.deletedWordIds;
  return { ...base, wordEdits: wordEdits as EditorState["wordEdits"] };
}

describe("rendersContinuousRange", () => {
  it("accepts a clip with no cuts at all", () => {
    expect(rendersContinuousRange(stateWithCuts(), SEGMENTS)).toBe(true);
  });

  it("refuses a clip whose cut falls in the middle of the range", () => {
    expect(rendersContinuousRange(stateWithCuts(wordId("seg-1", 2)), SEGMENTS)).toBe(false);
  });

  it("refuses a cut at the very start of the range", () => {
    expect(rendersContinuousRange(stateWithCuts(wordId("seg-1", 1)), SEGMENTS)).toBe(false);
  });

  it("refuses a cut at the very end of the range", () => {
    expect(rendersContinuousRange(stateWithCuts(wordId("seg-1", 4)), SEGMENTS)).toBe(false);
  });

  it("refuses several cuts at once", () => {
    const state = stateWithCuts(wordId("seg-1", 1), wordId("seg-1", 3));
    expect(rendersContinuousRange(state, SEGMENTS)).toBe(false);
  });

  it("accepts a cut that lies outside the clip's range, because it removes nothing", () => {
    // "Before" starts at 500 ms; this clip starts at 3,000 ms, so the cut never reaches the render.
    expect(rendersContinuousRange(stateWithCuts(wordId("seg-1", 0)), SEGMENTS)).toBe(true);
  });

  it("accepts a cut naming a word that no longer exists", () => {
    expect(rendersContinuousRange(stateWithCuts("seg-9:7"), SEGMENTS)).toBe(true);
  });

  it("tolerates a document that carries no deletedWordIds at all", () => {
    expect(rendersContinuousRange(stateWithoutWordEdits(), SEGMENTS)).toBe(true);
  });

  it("accepts the clip again once the words are restored", () => {
    const cut = stateWithCuts(wordId("seg-1", 2));
    expect(rendersContinuousRange(cut, SEGMENTS)).toBe(false);
    expect(rendersContinuousRange(restoreAllDeletedWords(cut), SEGMENTS)).toBe(true);
  });
});

describe("clipCutWordIds", () => {
  it("names the words that would be cut out of the render", () => {
    const state = stateWithCuts(wordId("seg-1", 1), wordId("seg-1", 3));
    expect(clipCutWordIds(state, SEGMENTS)).toEqual([wordId("seg-1", 1), wordId("seg-1", 3)]);
  });

  it("leaves out a cut that falls outside the range", () => {
    const state = stateWithCuts(wordId("seg-1", 0), wordId("seg-1", 3));
    expect(clipCutWordIds(state, SEGMENTS)).toEqual([wordId("seg-1", 3)]);
  });

  it("is empty for a clip with nothing cut", () => {
    expect(clipCutWordIds(stateWithCuts(), SEGMENTS)).toEqual([]);
  });
});

describe("assertContinuousRange", () => {
  it("passes a continuous clip through", () => {
    expect(() => assertContinuousRange(stateWithCuts(), SEGMENTS)).not.toThrow();
  });

  it("fails a cut clip with the stable code", () => {
    try {
      assertContinuousRange(stateWithCuts(wordId("seg-1", 2)), SEGMENTS);
      expect.unreachable("a cut clip must not be exportable");
    } catch (error) {
      expect(error).toBeInstanceOf(ExportFailureError);
      expect((error as ExportFailureError).code).toBe(CONTINUOUS_RANGE_REQUIRED);
    }
  });

  it("fails terminally, so a retry cannot spend attempts on it", () => {
    try {
      assertContinuousRange(stateWithCuts(wordId("seg-1", 2)), SEGMENTS);
      expect.unreachable("a cut clip must not be exportable");
    } catch (error) {
      expect((error as ExportFailureError).terminal).toBe(true);
    }
  });

  it("tells the user what to do about it", () => {
    try {
      assertContinuousRange(stateWithCuts(wordId("seg-1", 2)), SEGMENTS);
      expect.unreachable("a cut clip must not be exportable");
    } catch (error) {
      expect((error as ExportFailureError).userMessage).toBe(CONTINUOUS_RANGE_MESSAGE);
      expect((error as ExportFailureError).userMessage).toMatch(/Restore all deleted words/);
    }
  });
});

describe("clipRendersContinuousRange", () => {
  const segmentRows = SEGMENTS.map((segment) => ({ ...segment }));

  function client(findMany = vi.fn(async () => segmentRows)) {
    return { transcriptSegment: { findMany } } as never;
  }

  it("accepts a clip with no cuts without reading the transcript at all", async () => {
    const findMany = vi.fn(async () => segmentRows);

    const ok = await clipRendersContinuousRange(client(findMany), {
      sourceVideoId: "video-1",
      state: stateWithCuts(),
    });

    expect(ok).toBe(true);
    // The common case is every clip anyone has ever made. It must not cost a transcript read.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads the transcript only when the document actually carries cuts", async () => {
    const findMany = vi.fn(async () => segmentRows);

    const ok = await clipRendersContinuousRange(client(findMany), {
      sourceVideoId: "video-1",
      state: stateWithCuts(wordId("seg-1", 2)),
    });

    expect(ok).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("accepts a cut that falls outside the clip's range", async () => {
    const ok = await clipRendersContinuousRange(client(), {
      sourceVideoId: "video-1",
      state: stateWithCuts(wordId("seg-1", 0)),
    });

    expect(ok).toBe(true);
  });

  it("treats a document it cannot read as continuous, leaving the worker to judge", async () => {
    const ok = await clipRendersContinuousRange(client(), {
      sourceVideoId: "video-1",
      state: undefined as unknown as EditorState,
    });

    expect(ok).toBe(true);
  });
});
