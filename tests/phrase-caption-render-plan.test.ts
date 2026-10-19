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
