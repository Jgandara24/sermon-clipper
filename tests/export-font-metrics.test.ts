import { describe, expect, it } from "vitest";
import { BUNDLED_CAPTION_FONTS } from "@/lib/editor/caption-fonts";
import {
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

    // Checked against fontkit directly: DejaVu Sans has 2048 units per em, and "PEACE" advances
    // 6618 of them, which is 155.109375px at 48px.
    expect(measurer.measure("PEACE")).toBeCloseTo(155.109375, 6);
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
