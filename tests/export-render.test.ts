import { describe, expect, it } from "vitest";
import { buildExportFilterGraph } from "@/lib/export/render";

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
