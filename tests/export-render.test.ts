import { describe, expect, it } from "vitest";
import {
  buildExportAudioFilter,
  buildExportFfmpegArgs,
  buildExportFilterGraph,
} from "@/lib/export/render";

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

describe("buildExportFfmpegArgs", () => {
  const params = {
    sourceFilePath: "/work/source-video",
    range: { startMs: 2_000, endMs: 8_250 },
    cropPixels: { x: 100, y: 0, w: 600, h: 1080 },
    assFilePath: "/work/captions.ass",
    outputPath: "/work/output.mp4",
    outputWidth: 1080,
    outputHeight: 1920,
  };

  it("seeks the source before opening it, and closes the file at the range's length", () => {
    const args = buildExportFfmpegArgs(params);
    // Input seeking: `-ss` ahead of `-i` decodes from the keyframe before the seek point and
    // discards up to it, and restarts the clock at zero, which is the subtitle script's timeline.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("2.000");
    expect(args[args.indexOf("-i") + 1]).toBe(params.sourceFilePath);
    expect(args.indexOf("-t")).toBeGreaterThan(args.indexOf("-i"));
    expect(args[args.indexOf("-t") + 1]).toBe("6.250");
  });

  it("is one pass: the filters, the encode, and the output, with no concat anywhere", () => {
    const args = buildExportFfmpegArgs(params);
    expect(args[args.indexOf("-vf") + 1]).toBe(
      buildExportFilterGraph(params.cropPixels, 1080, 1920, params.assFilePath),
    );
    expect(args[args.indexOf("-af") + 1]).toBe(buildExportAudioFilter(undefined));
    expect(args.slice(args.indexOf("-c:v"))).toEqual([
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      params.outputPath,
    ]);
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(args.some((arg) => arg.includes("concat"))).toBe(false);
  });

  it("carries the document's volume into the audio chain", () => {
    const args = buildExportFfmpegArgs({ ...params, originalVolume: 0.5 });
    expect(args[args.indexOf("-af") + 1]).toBe(buildExportAudioFilter(0.5));
  });
});
