import { expect, test } from "@playwright/test";
import {
  captionFontShorthand,
  isRequiredCaptionFaceEntry,
  resolveCaptionFace,
} from "../../src/lib/editor/caption-face";
import { getCaptionPreset } from "../../src/lib/editor/caption-presets";
import { createCaptionMeasurer } from "../../src/lib/export/font-metrics";

/**
 * The two measurers have to agree, or the preview and the burned-in file lay the same line out
 * differently and Slice 8's whole premise fails.
 *
 * fontkit reads the TTF and shapes it itself. The browser hands the same file to its own shaping
 * engine. They are different implementations reading one file, so exact equality is not the thing
 * to assert — a stated tolerance is, and it has to be far smaller than a gap between words for the
 * layout to be safe.
 *
 * The page is the sign-in page: it needs no session, and the root layout carries the `@font-face`
 * rules, which is all this measures.
 */

/**
 * Maximum disagreement allowed on one word, in pixels at 48px.
 *
 * Measured, not guessed, on both platforms this runs on:
 *
 *  - macOS Chromium agrees exactly. PEACE is 173.1328125px from fontkit and from the canvas.
 *  - Linux Chromium in CI does not, and reports whole numbers: IS measures 53 there against
 *    fontkit's 52.4296875, a difference of 0.57px. That is host font hinting, not a wrong face —
 *    the readiness check below passes, so both sides are reading the bundled file.
 *
 * One pixel leaves headroom over the 0.57px actually seen without hiding anything that matters.
 * For scale, a space at this size is 16.71px, so a disagreement inside the tolerance is about
 * three percent of the gap between two words: visible to a measuring instrument, not to a viewer,
 * and static rather than moving.
 *
 * It is worth being clear about what this tolerance does and does not protect. Each renderer lays
 * a line out with its own measurer used consistently, so a disagreement here cannot make two words
 * collide in either one. What it bounds is how far the preview's idea of a line can sit from the
 * file's — the parity Slice 8 exists to keep.
 */
const TOLERANCE_PX = 1;

const FIXTURE_WORDS = ["PEACE", "IS", "NOT", "THE", "ABSENCE", "OF", "TROUBLE."];

test.describe("the caption measurers agree", () => {
  test("fontkit and the browser canvas measure the same words to the same widths", async ({
    page,
  }) => {
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const font = captionFontShorthand(face, style.sizePx);

    const server = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });
    const serverWidths = FIXTURE_WORDS.map((word) => server.measure(word));

    await page.goto("/login");

    // The same sequence the hook uses, deliberately: settle the document's own font loading,
    // ask for this exact face, let that settle, then take the face list back to Node to judge.
    const browser = await page.evaluate(
      async ({ font, words }) => {
        await document.fonts.ready;
        await document.fonts.load(font);
        await document.fonts.ready;
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("no 2d context");
        context.font = font;
        return {
          faces: [...document.fonts].map((entry) => ({
            family: entry.family,
            weight: entry.weight,
            status: entry.status,
          })),
          resolvedFont: context.font,
          widths: words.map((word) => context.measureText(word).width),
          space: context.measureText(" ").width,
        };
      },
      { font, words: FIXTURE_WORDS },
    );

    // Asserted before any width is compared. A browser that never loaded the bundled face still
    // measures — it synthesises bold over whatever it does have and returns plausible numbers,
    // which is exactly how a ten-pixel-per-word disagreement first reached this test.
    const loaded = browser.faces.some((entry) => isRequiredCaptionFaceEntry(entry, face));
    expect(
      loaded,
      `the bundled face was not loaded; document.fonts held ${JSON.stringify(browser.faces)}`,
    ).toBe(true);

    const deltas = browser.widths.map((width, index) => Math.abs(width - serverWidths[index]));
    const spaceDelta = Math.abs(browser.space - server.spaceWidth);
    const worst = Math.max(...deltas, spaceDelta);

    // Every measurement, every time, rather than stopping at the first word over the line. A
    // disagreement is worth seeing whole: one word out is a shaping quirk, all of them out is a
    // wrong face, and the two want different fixes.
    const report = [
      ...FIXTURE_WORDS.map(
        (word, index) =>
          `${word}: browser ${browser.widths[index]}, fontkit ${serverWidths[index]}, off by ${deltas[index].toFixed(4)}`,
      ),
      `space: browser ${browser.space}, fontkit ${server.spaceWidth}, off by ${spaceDelta.toFixed(4)}`,
    ].join("\n");

    test.info().annotations.push({
      type: "measurer parity",
      description: `worst ${worst.toFixed(4)}px at ${style.sizePx}px in ${font} (${browser.resolvedFont})\n${report}`,
    });

    expect(worst, report).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  test("the tolerance stays a small part of the gap between two words", async () => {
    // A tolerance is only meaningful next to the distance it is being compared against. If the
    // allowance ever approached a space, the two renderers could disagree about a line by about
    // the width of the gaps in it, and this test would be asserting nothing worth asserting.
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const server = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });

    expect(server.spaceWidth).toBeGreaterThan(TOLERANCE_PX * 10);
  });
});
