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

  it("uppercases text for presets with uppercase: true", () => {
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
});
