import { describe, expect, it } from "vitest";
import { buildExportAudioFilter, buildExportFilterGraph } from "@/lib/export/render";

describe("buildExportAudioFilter", () => {
  const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

  it("is the loudness normalisation alone at the default volume, byte for byte", () => {
    // A document that never touched the control renders exactly what it always rendered.
    expect(buildExportAudioFilter(1)).toBe(LOUDNORM);
    expect(buildExportAudioFilter(undefined)).toBe(LOUDNORM);
  });

  it("applies the original volume after normalisation, so half as loud means half as loud", () => {
    // Before loudnorm a gain would be undone by it; after, it is what the preview plays.
    expect(buildExportAudioFilter(0.5)).toBe(`${LOUDNORM},volume=0.5`);
    expect(buildExportAudioFilter(0)).toBe(`${LOUDNORM},volume=0`);
  });

  it("keeps the schema's bounds, and ignores nonsense", () => {
    expect(buildExportAudioFilter(5)).toBe(`${LOUDNORM},volume=2`);
    expect(buildExportAudioFilter(-1)).toBe(`${LOUDNORM},volume=0`);
    expect(buildExportAudioFilter(Number.NaN)).toBe(LOUDNORM);
  });
});

describe("buildExportFilterGraph", () => {
  it("chains crop, scale-to-fill, re-crop, and subtitle burn in order", () => {
    const graph = buildExportFilterGraph({ x: 100, y: 0, w: 600, h: 1080 }, 1080, 1920, "/tmp/x/captions.ass");
    const stages = graph.split(",");
    expect(stages[0]).toBe("crop=600:1080:100:0");
    expect(stages[1]).toBe("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(stages[2]).toBe("crop=1080:1920");
    expect(stages[3]).toBe("subtitles=filename='/tmp/x/captions.ass'");
  });

  it("escapes colons and single quotes in the ass file path", () => {
    const graph = buildExportFilterGraph({ x: 0, y: 0, w: 100, h: 100 }, 1080, 1920, "/tmp/weird:it's.ass");
    expect(graph).toContain("filename='/tmp/weird\\:it\\'s.ass'");
  });
});
