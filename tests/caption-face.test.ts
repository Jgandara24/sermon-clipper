import { describe, expect, it } from "vitest";
import { getCaptionPreset } from "@/lib/editor/caption-presets";
import {
  captionFontShorthand,
  CAPTION_BOLD_WEIGHT,
  CAPTION_REGULAR_WEIGHT,
  isBoldCaptionWeight,
  isRequiredCaptionFaceEntry,
  resolveCaptionFace,
} from "@/lib/editor/caption-face";

describe("resolveCaptionFace", () => {
  it("takes the first family of the stack, which is the one both renderers ask for", () => {
    expect(resolveCaptionFace({ fontFamily: "'DejaVu Sans', sans-serif" })).toEqual({
      family: "DejaVu Sans",
      bold: false,
    });
  });

  it("strips quotes and surrounding space from the family name", () => {
    expect(resolveCaptionFace({ fontFamily: '  "DejaVu Serif" , serif' }).family).toBe("DejaVu Serif");
    expect(resolveCaptionFace({ fontFamily: "Inter, system-ui, sans-serif" }).family).toBe("Inter");
  });

  it("reads Highlighter as its bundled family in bold", () => {
    expect(resolveCaptionFace(getCaptionPreset("highlighter").style)).toEqual({
      family: "DejaVu Sans",
      bold: true,
    });
  });

  it("reads Clean as an unbundled family that is not bold", () => {
    // Clean keeps the stack it has always had. The burn-in lets libass lay it out, so nothing
    // here needs a bundled file for it.
    expect(resolveCaptionFace(getCaptionPreset("clean").style)).toEqual({
      family: "Inter",
      bold: false,
    });
  });
});

describe("isBoldCaptionWeight", () => {
  it("draws the line at 600, exactly where the burn-in's Bold flag has always drawn it", () => {
    expect(isBoldCaptionWeight(599)).toBe(false);
    expect(isBoldCaptionWeight(600)).toBe(true);
    expect(isBoldCaptionWeight(800)).toBe(true);
  });

  it("treats an unset weight as not bold", () => {
    // Every preset that predates Slice 7 leaves weight undefined on purpose.
    expect(isBoldCaptionWeight(undefined)).toBe(false);
  });
});

describe("captionFontShorthand", () => {
  it("names the exact weights the bundled files carry, not the style's own number", () => {
    // Only a regular and a bold file are bundled. Asking the browser for 800 when the file is 700
    // invites a synthesised face, which measures differently from the file the burn-in opens.
    expect(captionFontShorthand({ family: "DejaVu Sans", bold: true }, 48)).toBe(
      `${CAPTION_BOLD_WEIGHT} 48px "DejaVu Sans"`,
    );
    expect(captionFontShorthand({ family: "DejaVu Sans", bold: false }, 48)).toBe(
      `${CAPTION_REGULAR_WEIGHT} 48px "DejaVu Sans"`,
    );
  });

  it("uses 400 and 700, the weights the bundled files actually are", () => {
    expect(CAPTION_REGULAR_WEIGHT).toBe(400);
    expect(CAPTION_BOLD_WEIGHT).toBe(700);
  });

  it("quotes the family, so a multi-word name survives", () => {
    expect(captionFontShorthand({ family: "DejaVu Sans Mono", bold: false }, 32)).toContain(
      '"DejaVu Sans Mono"',
    );
  });

  it("keeps two decimals of the size, because the em is not a round number", () => {
    // The em a caption is drawn at is the size that makes the face's ascent plus descent equal
    // its nominal size: 48 becomes 41.23 for DejaVu Sans. Rounding that to whole pixels moved
    // every word by a fraction and put the two renderers back on different numbers.
    expect(captionFontShorthand({ family: "DejaVu Sans", bold: false }, 41.234)).toContain("41.23px");
    expect(captionFontShorthand({ family: "DejaVu Sans", bold: false }, 48)).toContain("48px");
  });
});

describe("isRequiredCaptionFaceEntry", () => {
  const bold = { family: "DejaVu Sans", bold: true };
  const regular = { family: "DejaVu Sans", bold: false };

  it("accepts the exact family, weight and loaded status", () => {
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "700", status: "loaded" }, bold),
    ).toBe(true);
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "400", status: "loaded" }, regular),
    ).toBe(true);
  });

  it("rejects a face that has not finished loading", () => {
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "700", status: "unloaded" }, bold),
    ).toBe(false);
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "700", status: "loading" }, bold),
    ).toBe(false);
  });

  it("rejects the other weight of the right family", () => {
    // The trap this replaces: the regular face is loaded, the bold one is not, and the canvas
    // synthesises bold from it and reports a plausible width.
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "400", status: "loaded" }, bold),
    ).toBe(false);
  });

  it("rejects another family entirely", () => {
    expect(
      isRequiredCaptionFaceEntry({ family: "Geist", weight: "700", status: "loaded" }, bold),
    ).toBe(false);
  });

  it("rejects a variable-weight range rather than assuming it covers the weight", () => {
    // A range would have to be parsed to be trusted, and none of the bundled faces is variable.
    expect(
      isRequiredCaptionFaceEntry({ family: "DejaVu Sans", weight: "100 900", status: "loaded" }, bold),
    ).toBe(false);
  });

  it("tolerates the quoting and spacing a browser may report", () => {
    expect(
      isRequiredCaptionFaceEntry({ family: '"DejaVu Sans"', weight: " 700 ", status: "loaded" }, bold),
    ).toBe(true);
  });
});
