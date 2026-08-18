import { describe, expect, it } from "vitest";
import {
  buildAudioFilterGraph,
  buildExportFilterGraph,
  RenderError,
  renderClipExport,
} from "@/lib/export/render";

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

  it("points libass at the shipped caption fonts via fontsdir", () => {
    const graph = buildExportFilterGraph(
      { x: 0, y: 0, w: 1080, h: 1920 },
      1080,
      1920,
      "/tmp/captions.ass",
      "/usr/share/fonts/truetype/custom",
    );
    expect(graph).toContain(":fontsdir='/usr/share/fonts/truetype/custom'");
  });
});

describe("buildAudioFilterGraph", () => {
  // ffmpeg's loudnorm reconfigures its output link mid-stream, and `volume` cannot renegotiate
  // it — "Cannot select channel layout ... Error reinitializing filters!" kills the render.
  // An explicit aformat between them pins the link, so the chain survives the reconfigure.
  it("pins the audio format between loudness normalization and the volume change", () => {
    expect(buildAudioFilterGraph(0.42)).toBe(
      "loudnorm=I=-16:TP=-1.5:LRA=11," +
        "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo," +
        "volume=0.42",
    );
  });

  // Full volume is the default for every clip, so it must produce exactly the graph that
  // shipped before the audio panel existed — no extra filters, nothing new to renegotiate.
  it("emits only loudness normalization at full volume", () => {
    expect(buildAudioFilterGraph()).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(buildAudioFilterGraph(1)).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
    expect(buildAudioFilterGraph(2)).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
  });

  it("clamps volume to the editor range", () => {
    expect(buildAudioFilterGraph(-1)).toContain("volume=0.00");
  });
});

describe("renderClipExport", () => {
  it("rejects an empty source range before touching ffmpeg (P1.5: one continuous range)", async () => {
    await expect(
      renderClipExport({
        sourceFilePath: "/nonexistent/source.mp4",
        sourceStartMs: 5000,
        sourceEndMs: 5000,
        cropPixels: { x: 0, y: 0, w: 608, h: 1080 },
        assFileContent: "",
        fontsDir: "/nonexistent/fonts",
        outputPath: "/nonexistent/out.mp4",
        outputWidth: 1080,
        outputHeight: 1920,
      }),
    ).rejects.toThrow(RenderError);
  });
});
