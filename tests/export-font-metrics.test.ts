import { describe, expect, it } from "vitest";
import { BUNDLED_CAPTION_FONTS } from "@/lib/editor/caption-fonts";
import {
  assEmPx,
  createCaptionMeasurer,
  resolveBundledFontFile,
  UnbundledCaptionFaceError,
} from "@/lib/export/font-metrics";

describe("resolveBundledFontFile", () => {
  it("resolves every bundled family, in both weights", () => {
    for (const font of BUNDLED_CAPTION_FONTS) {
      expect(resolveBundledFontFile(font.family, false)).toContain(font.regularFile.split("/").pop());
      expect(resolveBundledFontFile(font.family, true)).toContain(font.boldFile.split("/").pop());
    }
  });

  it("returns null for a family this repository does not ship", () => {
    // Clean asks for Inter, which is not bundled. The burn-in must keep letting libass lay that
    // line out rather than measuring a file it does not have.
    expect(resolveBundledFontFile("Inter", false)).toBeNull();
    expect(resolveBundledFontFile("Georgia", false)).toBeNull();
  });

  it("matches the family name exactly, not loosely", () => {
    expect(resolveBundledFontFile("DejaVu", false)).toBeNull();
    expect(resolveBundledFontFile("dejavu sans", false)).toBeNull();
  });
});

describe("createCaptionMeasurer", () => {
  it("measures a word in the bundled face at the requested size", () => {
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });

    // DejaVu Sans has 2048 units per em and "PEACE" advances 6618 of them. That is 155.11px if
    // 48 were an em size, and it is not: libass scales the face so ascent plus descent, 2384
    // units here, equals 48. So the advance is 6618 x 48 / 2384.
    expect(measurer.measure("PEACE")).toBeCloseTo((6618 * 48) / 2384, 6);
    expect(measurer.measure("PEACE")).toBeCloseTo(133.248, 3);
  });

  it("scales linearly with the requested size", () => {
    const small = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 24 });
    const large = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });

    expect(large.measure("PEACE")).toBeCloseTo(small.measure("PEACE") * 2, 6);
  });

  it("measures the bold file as a different width from the regular one", () => {
    const regular = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });
    const bold = createCaptionMeasurer({ family: "DejaVu Sans", bold: true, sizePx: 48 });

    expect(bold.measure("PEACE")).not.toBeCloseTo(regular.measure("PEACE"), 3);
  });

  it("reports a space width in the same face and size", () => {
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });

    expect(measurer.spaceWidth).toBeGreaterThan(0);
    expect(measurer.spaceWidth).toBeCloseTo(measurer.measure(" "), 6);
  });

  it("measures an empty string as nothing", () => {
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });

    expect(measurer.measure("")).toBe(0);
  });

  it("refuses a face this repository does not ship, rather than substituting one", () => {
    // libass substitutes silently; so would a measurer with a fallback. Both would put the
    // preview and the file on different metrics without saying so.
    expect(() => createCaptionMeasurer({ family: "Inter", bold: false, sizePx: 48 })).toThrow(
      UnbundledCaptionFaceError,
    );
  });

  it("measures every bundled family, so the picker cannot offer one that cannot be measured", () => {
    for (const font of BUNDLED_CAPTION_FONTS) {
      for (const bold of [false, true]) {
        const measurer = createCaptionMeasurer({ family: font.family, bold, sizePx: 48 });
        expect(measurer.measure("Peace")).toBeGreaterThan(0);
      }
    }
  });

  it("reuses one opened face rather than reading the file per word", () => {
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: false, sizePx: 48 });
    const first = measurer.measure("Peace");

    expect(measurer.measure("Peace")).toBe(first);
  });
});

describe("an ASS font size is a height, not an em", () => {
  it("draws DejaVu Sans Bold smaller than the number in the style line", () => {
    // Em 2048, ascent plus descent 2384, so a Fontsize of 48 draws an em of 41.2px.
    expect(assEmPx(48, 1901, -483, 2048)).toBeCloseTo(41.23, 2);
  });

  it("leaves a face whose ascent and descent match its em alone", () => {
    expect(assEmPx(48, 1600, -448, 2048)).toBe(48);
  });

  it("falls back to the size given when the metrics are unusable", () => {
    expect(assEmPx(48, 0, 0, 2048)).toBe(48);
  });

  it("measures a word the width libass will draw it", () => {
    // Verified against a real render: the step from PEACE to IS measures 163px, and the advance
    // of PEACE plus a space predicts 163.09px under this rule. Measuring at the style's own
    // number gave 189.84px, which put an extra space between every pair of words.
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: true, sizePx: 48 });

    expect(measurer.measure("PEACE")).toBeCloseTo(148.73, 1);
    expect(measurer.measure("PEACE") + measurer.spaceWidth).toBeCloseTo(163.09, 1);
  });

  it("reports the em it measured at, so a renderer can draw at the same size", () => {
    const measurer = createCaptionMeasurer({ family: "DejaVu Sans", bold: true, sizePx: 48 });

    expect(measurer.emPx).toBeCloseTo(41.23, 2);
    expect(measurer.emPx).toBeLessThan(48);
  });
});
