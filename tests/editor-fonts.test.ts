import { describe, expect, it } from "vitest";
import {
  assBoldFlag,
  assFontName,
  captionFontFile,
  nearestFontWeight,
  resolveCaptionFont,
} from "@/lib/editor/fonts";

describe("resolveCaptionFont", () => {
  it("resolves legacy CSS stacks stored in presets", () => {
    expect(resolveCaptionFont("Inter, system-ui, sans-serif").id).toBe("inter");
    expect(resolveCaptionFont("'Source Serif 4', Georgia, serif").id).toBe("source-serif");
  });

  it("resolves registry ids and falls back to Poppins for unknown families", () => {
    expect(resolveCaptionFont("source-serif").id).toBe("source-serif");
    expect(resolveCaptionFont("Poppins, sans-serif").id).toBe("poppins");
    expect(resolveCaptionFont("Comic Sans MS, cursive").id).toBe("poppins");
  });
});

describe("weight resolution", () => {
  it("picks the nearest supported weight at or below the request", () => {
    const inter = resolveCaptionFont("inter");
    expect(nearestFontWeight(inter, 800)).toBe(800);
    expect(nearestFontWeight(inter, 650)).toBe(600);
    expect(nearestFontWeight(inter, 100)).toBe(400);
  });

  it("maps weights to the fontconfig family names fc-scan reports", () => {
    expect(assFontName("Inter, system-ui, sans-serif", 400)).toBe("Inter");
    expect(assFontName("inter", 800)).toBe("Inter ExtraBold");
    expect(assFontName("inter", 700)).toBe("Inter");
    expect(assFontName("source-serif", 600)).toBe("Source Serif 4 Semibold");
    expect(assFontName("poppins", 600)).toBe("Poppins SemiBold");
    expect(assFontName("poppins", 800)).toBe("Poppins ExtraBold");
  });

  it("sets the ASS Bold flag only for base-family 700", () => {
    expect(assBoldFlag("inter", 700)).toBe(true);
    expect(assBoldFlag("inter", 800)).toBe(false);
    expect(assBoldFlag("inter", 400)).toBe(false);
    expect(assBoldFlag("poppins", 700)).toBe(true);
  });

  it("returns a shipped file for every registry weight", () => {
    expect(captionFontFile("inter", 800)).toBe("Inter-ExtraBold.ttf");
    expect(captionFontFile("source-serif", 500)).toBe("SourceSerif4-Regular.ttf");
    expect(captionFontFile("poppins", 800)).toBe("Poppins-ExtraBold.ttf");
  });
});
