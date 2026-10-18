import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/export/font-metrics", () => ({
  createCaptionMeasurer: () => ({ measure: (text: string) => text.length * 10, spaceWidth: 10 }),
  UnbundledCaptionFaceError: class extends Error {},
}));
// Capture timeline input. No media or font file is read.
vi.mock("@/lib/export/ass-generator", () => ({ generateAssSubtitles: vi.fn(() => "synthetic subtitle plan") }));
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { buildExportRenderPlan } from "@/lib/exports/render-plan";
import { editorSourceProblem } from "@/lib/analysis/complete-message/editor-validation";
import { fixture } from "./fixtures";

describe("saved manual ranges and source bounds", () => {
  it.each([3000, 19999, 20000, 90000, 90001, 103000, 152000, 180000, 180001, 300000])("keeps %i ms without a generation cap", (duration) => {
    const f = fixture(duration);
    const original = structuredClone(f);
    const plan = buildExportRenderPlan(f);
    expect(plan.range).toEqual({ startMs: f.state.source.startMs, endMs: f.state.source.endMs });
    expect(plan.outputDurationS).toBe(duration / 1000);
    expect(plan.completeMessageTiming?.finalWordEndS).toBe(duration / 1000);
    expect(f).toEqual(original);
  });
  it("accepts exact source boundaries", () => {
    const f = fixture();
    f.state.source.startMs = 0;
    f.source!.durationMs = f.state.source.endMs;
    expect(editorSourceProblem(f.state, f.source)).toBeNull();
  });
  it.each(["negative", "zero", "reversed", "short", "beyond", "missing", "identity", "fraction", "nan"])("refuses %s bounds", (kind) => {
    const f = fixture();
    if (kind === "negative") f.state.source.startMs = -1;
    if (kind === "zero") f.state.source.endMs = f.state.source.startMs;
    if (kind === "reversed") f.state.source.endMs = f.state.source.startMs - 1;
    if (kind === "short") f.state.source.endMs = f.state.source.startMs + 2999;
    if (kind === "beyond") f.state.source.endMs = f.source!.durationMs! + 1;
    if (kind === "missing") f.source!.durationMs = null;
    if (kind === "identity") f.state.source.videoId = "other-source";
    if (kind === "fraction") f.state.source.startMs += 0.1;
    if (kind === "nan") f.state.source.startMs = NaN;
    expect(() => buildExportRenderPlan(f)).toThrow("source timing review");
  });
  it.each([undefined, { completeMessagePolicy: { enabled: false } }])("keeps the disabled plan unchanged", (processingConfig) => {
    const f = fixture(300000);
    const legacy = buildExportRenderPlan({ ...f, processingConfig: undefined, source: undefined });
    expect(buildExportRenderPlan({ ...f, processingConfig, source: undefined })).toEqual(legacy);
    expect(legacy).not.toHaveProperty("completeMessageTiming");
  });
  it("refuses malformed policy before subtitle planning", () => {
    const f = fixture();
    f.processingConfig = { completeMessagePolicy: { enabled: true } };
    vi.mocked(generateAssSubtitles).mockClear();
    expect(() => buildExportRenderPlan(f)).toThrow("source timing review");
    expect(generateAssSubtitles).not.toHaveBeenCalled();
  });
});

describe("continuous captions on extended output timelines", () => {
  it.each([103000, 152000])("keeps words, corrections, and title timing for %i ms", (duration) => {
    const f = fixture(duration);
    f.state.wordEdits.textOverrides = [{ wordId: `${f.segments[0].id}:0`, text: "Considered" }];
    f.state.captions.textOverrides = [{ segmentId: "line-1", text: "Resolution." }];
    const original = structuredClone(f);
    buildExportRenderPlan(f);
    const call = vi.mocked(generateAssSubtitles).mock.lastCall!;
    expect(call[0].flatMap((line) => line.words ?? []).map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 500], [duration - 500, duration],
    ]);
    expect(call[0][0].text).toBe("Considered");
    expect(call[0][1].text).toBe("Resolution.");
    expect(call[6]?.banner).toMatchObject({ startMs: 0, endMs: 3000 });
    expect(f).toEqual(original);
  });
  it("refuses a cut word and preserves the saved document", () => {
    const f = fixture();
    f.state.wordEdits.deletedWordIds = [`${f.segments[0].id}:1`];
    const original = structuredClone(f);
    expect(() => buildExportRenderPlan(f)).toThrow("words cut out");
    expect(f).toEqual(original);
  });
  it.each(["start", "end", "missing", "invalid"])("refuses %s word evidence", (kind) => {
    const f = fixture();
    if (kind === "start") f.state.source.startMs += 1;
    if (kind === "end") f.state.source.endMs -= 1;
    if (kind === "missing") f.segments[0].words = [];
    if (kind === "invalid") f.segments[0].words[0].endMs = NaN;
    expect(() => buildExportRenderPlan(f)).toThrow("source timing review");
  });
  it("keeps filler words and ignores old cuts outside the range", () => {
    const f = fixture();
    f.segments[0].words[1].isFiller = true;
    f.segments[0].words[1].deleted = true;
    f.state.wordEdits.deletedWordIds = ["outside:0"];
    expect(buildExportRenderPlan(f).completeMessageTiming?.finalWordEndS).toBe(152);
  });
  it("keeps padding separate from word coverage", () => {
    const f = fixture();
    f.segments[0].words[0].startMs += 150;
    f.segments[0].words[1].endMs -= 150;
    const plan = buildExportRenderPlan(f);
    expect(plan.outputDurationS).toBe(152);
    expect(plan.completeMessageTiming?.finalWordEndS).toBe(151.85);
  });
  it.each(["segment", "word"])("refuses contradictory %s timing", (kind) => {
    const f = fixture();
    if (kind === "segment") f.segments[0].startMs = NaN;
    else f.segments[0].words[0].startMs -= 100;
    expect(() => buildExportRenderPlan(f)).toThrow("source timing review");
  });
  it("does not splice an extension into the continuous source range", () => {
    const f = fixture();
    f.state.extensions = [{ startMs: 0, endMs: 1000, position: "before" }];
    const plan = buildExportRenderPlan(f);
    expect(plan.range).toEqual({ startMs: f.state.source.startMs, endMs: f.state.source.endMs });
    expect(plan.outputDurationS).toBe(152);
  });
});
