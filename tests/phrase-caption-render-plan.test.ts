import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/export/font-metrics", () => ({
  createCaptionMeasurer: () => ({ measure: (text: string) => text.length * 10, spaceWidth: 10 }),
  UnbundledCaptionFaceError: class extends Error {},
}));
vi.mock("@/lib/export/ass-generator", () => ({ generateAssSubtitles: vi.fn(() => "synthetic subtitle plan") }));
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { buildInitialEditorState } from "@/lib/editor/types";
import { buildExportRenderPlan, type ExportRenderPlanInput } from "@/lib/exports/render-plan";
import first from "./fixtures/p4-approved-caption-input.json";

function input(): ExportRenderPlanInput {
  const [startMs, endMs] = first.sourceRangeMs;
  return {
    state: buildInitialEditorState({ sourceVideoId: "codex-recording-1", startMs, endMs }),
    segments: first.segments.map((segment, index) => ({ id: `segment-${index}`, ...segment })),
    sourceWidth: 1920,
    sourceHeight: 1080,
    outputWidth: 1080,
    outputHeight: 1920,
    brandTemplate: null,
  };
}

describe("buildExportRenderPlan with phrase captions (lab only)", () => {
  it("keeps the five-word lines and the clip's capital letters by default", () => {
    buildExportRenderPlan(input());
    const [lines, style] = vi.mocked(generateAssSubtitles).mock.lastCall!;
    expect(lines.map((line) => line.text)[1]).toBe("the level of your relationship");
    expect(style.textCase).toBe("uppercase");
  });

  it("uses phrase lines, on the file's clock, in the transcript's own capital letters", () => {
    const plan = buildExportRenderPlan({ ...input(), captionGrouping: "phrases" });
    const [lines, style] = vi.mocked(generateAssSubtitles).mock.lastCall!;
    expect(lines.map((line) => line.text)).toEqual([
      "They're the one that determines",
      "the level of your relationship with God",
      "not God",
      "Therefore, draw near to God",
      "and he'll draw near to you",
      "Did you get it?",
      "Did you get it?",
    ]);
    expect(lines[0].startMs).toBe(0);
    expect(lines.at(-1)!.endMs).toBeLessThanOrEqual(16_000);
    expect(style.textCase).toBe("original");
    expect(plan.captionLineCount).toBe(7);
  });
});

describe("buildExportRenderPlan cleans phrase captions (fix G)", () => {
  it("drops a quiet congregation response and shows a stammer once", () => {
    const base = input();
    const [startMs] = first.sourceRangeMs;
    base.segments = [{ id: "s", startMs, endMs: startMs + 4_000, words: [
      { word: "I,", startMs: startMs, endMs: startMs + 200, confidence: 1, isFiller: false, deleted: false },
      { word: "I", startMs: startMs + 250, endMs: startMs + 400, confidence: 1, isFiller: false, deleted: false },
      { word: "married", startMs: startMs + 450, endMs: startMs + 900, confidence: 1, isFiller: false, deleted: false },
      { word: "her.", startMs: startMs + 950, endMs: startMs + 1_300, confidence: 1, isFiller: false, deleted: false },
      { word: "Amen.", startMs: startMs + 1_500, endMs: startMs + 1_800, confidence: 1, isFiller: false, deleted: false },
    ] }];
    const levels = new Map([["s:0", -28], ["s:1", -27], ["s:2", -28], ["s:3", -29], ["s:4", -60]]);
    buildExportRenderPlan({ ...base, captionGrouping: "phrases", captionWordLevels: levels });
    const [lines] = vi.mocked(generateAssSubtitles).mock.lastCall!;
    expect(lines.map((line) => line.text)).toEqual(["I married her"]);
    expect(lines[0].startMs).toBe(0);
  });
});
