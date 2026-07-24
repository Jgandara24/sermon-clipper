import { describe, expect, it } from "vitest";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { getCaptionPreset } from "@/lib/editor/caption-presets";

describe("resolveCaptionStyle", () => {
  it("returns the preset style untouched when there are no overrides", () => {
    expect(resolveCaptionStyle("clean", {})).toEqual(getCaptionPreset("clean").style);
  });

  it("applies typography and placement overrides on top of the preset", () => {
    const style = resolveCaptionStyle("clean", {
      fontFamily: "Georgia",
      bold: true,
      textColor: "#ff0000",
      sizePx: 60,
      offset: { x: 0.5, y: 0.3 },
    });

    expect(style.fontFamily).toBe("Georgia");
    expect(style.bold).toBe(true);
    expect(style.textColor).toBe("#ff0000");
    expect(style.sizePx).toBe(60);
    expect(style.offset).toEqual({ x: 0.5, y: 0.3 });
    // Untouched fields still come from the preset.
    expect(style.highlightColor).toBe(getCaptionPreset("clean").style.highlightColor);
  });

  it("leaves bold and offset unset when not overridden", () => {
    const style = resolveCaptionStyle("clean", { sizePx: 48 });
    expect(style.bold).toBeUndefined();
    expect(style.offset).toBeUndefined();
  });
});
