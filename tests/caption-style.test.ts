import { describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  getCaptionPreset,
  normalizeCaptionStyle,
} from "@/lib/editor/caption-presets";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";

describe("normalizeCaptionStyle", () => {
  it("derives kinetic fields for every shipped preset", () => {
    for (const preset of CAPTION_PRESETS) {
      const s = preset.style;
      expect(s.fontWeight).toBeGreaterThanOrEqual(100);
      expect(s.positionY).toBeGreaterThanOrEqual(0);
      expect(s.positionY).toBeLessThanOrEqual(100);
      expect(s.positionX).toBe(50);
      expect(["center", "bottom"]).toContain(s.anchor);
      expect(s.safeAnchor).toBe("custom");
      expect(s.outlineColor).toBe(s.strokeColor);
      expect(s.maxWordsPerLine).toBeGreaterThanOrEqual(2);
    }
  });

  it("maps legacy positions to positionY/anchor exactly", () => {
    const base = {
      fontFamily: "Inter",
      sizePx: 44,
      textColor: "#FFFFFF",
      highlightColor: "#2DD4BF",
      background: "none" as const,
      alignment: "center" as const,
      uppercase: false,
      strokeColor: "#000000",
      strokePx: 2,
      shadow: true,
    };

    expect(normalizeCaptionStyle({ ...base, position: "top" })).toMatchObject({
      positionY: 8,
      anchor: "center",
    });
    expect(normalizeCaptionStyle({ ...base, position: "middle" })).toMatchObject({
      positionY: 50,
      anchor: "center",
    });
    expect(normalizeCaptionStyle({ ...base, position: "bottom" })).toMatchObject({
      positionY: 88,
      anchor: "bottom",
    });
  });

  it("keeps legacy presets non-animating and derives shadow distance from the shadow flag", () => {
    expect(getCaptionPreset("clean").style).toMatchObject({
      highlightMode: "none",
      highlightScale: 1,
      shadowDistancePx: 2,
    });
    expect(getCaptionPreset("quiet").style).toMatchObject({
      highlightMode: "none",
      shadowDistancePx: 0,
    });
  });

  it("ships word-highlight presets for karaoke and kinetic", () => {
    expect(getCaptionPreset("karaoke").style.highlightMode).toBe("word");
    expect(getCaptionPreset("kinetic").style).toMatchObject({
      highlightMode: "word",
      fontWeight: 800,
      uppercase: true,
    });
    expect(getCaptionPreset("kinetic").style.highlightScale).toBeGreaterThan(1);
  });

  it("uses Poppins as the default sans-serif caption font", () => {
    for (const presetId of ["clean", "karaoke", "quiet", "kinetic"]) {
      expect(getCaptionPreset(presetId).style.fontFamily).toContain("Poppins");
    }
    expect(getCaptionPreset("bold-serif").style.fontFamily).toContain("Source Serif 4");
  });
});

describe("resolveCaptionStyle", () => {
  it("lets kinetic overrides win over the legacy position", () => {
    const style = resolveCaptionStyle("clean", {
      position: "top",
      positionX: 42,
      positionY: 62,
      anchor: "center",
      safeAnchor: "bottom-safe",
    });
    expect(style.positionX).toBe(42);
    expect(style.positionY).toBe(62);
    expect(style.anchor).toBe("center");
    expect(style.safeAnchor).toBe("bottom-safe");
  });

  it("derives positionY from a legacy position override when no kinetic override exists", () => {
    expect(resolveCaptionStyle("clean", { position: "middle" })).toMatchObject({
      positionY: 50,
      anchor: "center",
    });
  });

  it("coerces malformed colors to the preset value instead of failing", () => {
    const preset = getCaptionPreset("clean").style;
    const style = resolveCaptionStyle("clean", {
      highlightColor: "not-a-color",
      textColor: "ff00aa", // missing hash — coerced, not rejected
    });
    expect(style.highlightColor).toBe(preset.highlightColor);
    expect(style.textColor).toBe("#FF00AA");
  });

  it("clamps out-of-range numeric overrides", () => {
    const style = resolveCaptionStyle("kinetic", { highlightScale: 1.4, outlineWidthPx: 24 });
    expect(style.highlightScale).toBeLessThanOrEqual(1.4);
    expect(style.outlineWidthPx).toBeLessThanOrEqual(24);
  });

  it("applies typography overrides", () => {
    const style = resolveCaptionStyle("clean", { fontFamily: "'Source Serif 4', serif", fontWeight: 700 });
    expect(style.fontFamily).toContain("Source Serif 4");
    expect(style.fontWeight).toBe(700);
  });
});
