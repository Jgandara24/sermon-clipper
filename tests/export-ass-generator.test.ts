import { describe, expect, it } from "vitest";
import { generateAssSubtitles } from "@/lib/export/ass-generator";
import { getCaptionPreset } from "@/lib/editor/caption-presets";

const LINES = [
  { startMs: 0, endMs: 1200, text: "peace is not the absence" },
  { startMs: 1200, endMs: 2400, text: "of trouble." },
];

describe("generateAssSubtitles", () => {
  it("emits script info sized to the output frame", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("emits one Dialogue line per caption line with correct timestamps", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    const dialogueLines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain("0:00:00.00,0:00:01.20");
    expect(dialogueLines[1]).toContain("0:00:01.20,0:00:02.40");
  });

  it("uppercases text for a preset whose case is Uppercase", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("karaoke").style, 1080, 1920);
    expect(ass).toContain("PEACE IS NOT THE ABSENCE");
    expect(ass).not.toContain("peace is not the absence");
  });

  it("uses bottom-center alignment (2) for bottom/center presets", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"));
    expect(styleLine).toBeDefined();
    const fields = styleLine!.split(",");
    // Alignment is field index 18 in the Format list (0-indexed after "Style: Default").
    expect(fields[18]).toBe("2");
  });

  it("uses middle-center alignment (5) for the karaoke preset's middle position", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("karaoke").style, 1080, 1920);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: Default"));
    const fields = styleLine!.split(",");
    expect(fields[18]).toBe("5");
  });

  it("converts hex colors into ASS &H00BBGGRR order", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
    // clean preset textColor is #FFFFFF -> &H00FFFFFF
    expect(ass).toContain("&H00FFFFFF");
  });

  it("escapes ASS override-block braces in caption text", () => {
    const ass = generateAssSubtitles(
      [{ startMs: 0, endMs: 1000, text: "he said {this}" }],
      getCaptionPreset("clean").style,
      1080,
      1920,
    );
    expect(ass).not.toContain("{this}");
    expect(ass).toContain("(this)");
  });

  it("emits a lower-third dialogue event when brand data is provided", () => {
    const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920, {
      headline: "First Baptist",
      subhead: "Sunday message",
      primaryColor: "#0f766e",
      accentColor: "#facc15",
      startMs: 0,
      endMs: 4000,
    });

    expect(ass).toContain("Style: LowerThird");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:04.00,LowerThird");
    expect(ass).toContain("First Baptist\\NSunday message");
  });
  describe("a caption the member dragged", () => {
    const dragged = { ...getCaptionPreset("clean").style, box: { xPct: 0.25, yPct: 0.4 } };

    it("burns in at the exact point it was dropped", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      // 0.25 * 1080 = 270, 0.4 * 1920 = 768.
      expect(ass).toContain("\\pos(270,768)");
    });

    it("centres the text on that point, so the preview and the render agree", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      expect(ass).toContain("{\\an5\\pos(270,768)}");
    });

    it("positions every caption line, not just the first", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      const positioned = ass
        .split("\n")
        .filter((line) => line.startsWith("Dialogue: 0") && line.includes("\\pos("));
      expect(positioned).toHaveLength(2);
    });

    it("still renders the words themselves", () => {
      const ass = generateAssSubtitles(LINES, dragged, 1080, 1920);
      expect(ass).toContain("peace is not the absence");
    });

    it("emits no position tag at all when nothing was dragged", () => {
      const ass = generateAssSubtitles(LINES, getCaptionPreset("clean").style, 1080, 1920);
      // Every clip made before direct manipulation must render exactly as it always did.
      expect(ass).not.toContain("\\pos(");
      expect(ass).not.toContain("\\an5");
    });

    it("treats an explicitly absent box the same as no box", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: null },
        1080,
        1920,
      );
      expect(ass).not.toContain("\\pos(");
    });
  });

  describe("editing guides never reach a render", () => {
    it("carries no safe-zone, centre-guide, or selection markup", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: { xPct: 0.5, yPct: 0.8 } },
        1080,
        1920,
      );
      // The guides and handles are DOM in the editor and have no representation here at all.
      for (const marker of ["safe-zone", "safe zone", "centre-guide", "canvas-handle", "ALL CAPTIONS"]) {
        expect(ass).not.toContain(marker);
      }
    });

    it("emits only caption dialogue events", () => {
      const ass = generateAssSubtitles(
        LINES,
        { ...getCaptionPreset("clean").style, box: { xPct: 0.5, yPct: 0.8 } },
        1080,
        1920,
      );
      const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
      expect(events).toHaveLength(LINES.length);
    });
  });
});
