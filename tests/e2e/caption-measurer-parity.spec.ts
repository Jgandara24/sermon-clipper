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
 * How far the two measurers may disagree about one word.
 *
 * Measured on both platforms this runs on, and the difference between them has a mechanism:
 *
 *  - macOS Chromium agrees with fontkit exactly. PEACE is 173.1328125px from both.
 *  - Linux Chromium in CI returns whole numbers, because it quantises each glyph's advance to an
 *    integer before summing. The error therefore grows with the number of glyphs, not with the
 *    width: IS (2 glyphs) is out by 0.57px, ABSENCE (7) by 0.72px, TROUBLE. (8) by 1.32px.
 *
 * So a flat pixel allowance is the wrong shape, and a generous one would stop discriminating. The
 * bound scales with glyph count instead, with a floor for very short words. It fits every
 * measurement above with room to spare, and still refuses the thing this test exists to catch: a
 * wrong face is a proportional error, and the synthesised bold that reached this test on its first
 * run was out by 10.45px on a five-glyph word, against the 1.25px allowed here.
 *
 * What this bounds is how far the preview's idea of a line can sit from the file's. It is not a
 * collision bound — each renderer lays a line out with its own measurer used consistently, so a
 * disagreement here cannot make two words overlap in either one.
 */
const TOLERANCE_PER_GLYPH_PX = 0.25;
const TOLERANCE_FLOOR_PX = 1;

function toleranceFor(text: string): number {
  return Math.max(TOLERANCE_FLOOR_PX, TOLERANCE_PER_GLYPH_PX * text.length);
}

/**
 * How far the two may disagree about a whole line, as a fraction of its width.
 *
 * The per-glyph error accumulates across a line, and the line is what a viewer actually compares
 * between the preview and the exported file. Observed: 1135.8px of line against the browser's
 * 1141px, a drift of 0.46%.
 */
const LINE_TOLERANCE_FRACTION = 0.01;

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

    const overBudget = FIXTURE_WORDS.map((word, index) => ({
      word,
      delta: deltas[index],
      allowed: toleranceFor(word),
    })).filter((entry) => entry.delta > entry.allowed);
    expect(overBudget, report).toEqual([]);
    expect(spaceDelta, report).toBeLessThanOrEqual(toleranceFor(" "));

    // The line is what a viewer compares between the preview and the exported file, so the
    // accumulated drift matters more than any single word.
    const serverLine =
      serverWidths.reduce((total, width) => total + width, 0) +
      server.spaceWidth * (FIXTURE_WORDS.length - 1);
    const browserLine =
      browser.widths.reduce((total, width) => total + width, 0) +
      browser.space * (FIXTURE_WORDS.length - 1);
    expect(
      Math.abs(browserLine - serverLine) / serverLine,
      `line: browser ${browserLine}, fontkit ${serverLine}`,
    ).toBeLessThanOrEqual(LINE_TOLERANCE_FRACTION);
  });

  test("the allowance stays a small part of the gap between two words", async () => {
    // A tolerance is only meaningful next to the distance it is compared against. If the
    // allowance for a word approached a space, the two renderers could disagree about a line by
    // roughly the width of the gaps in it, and this test would be asserting nothing worth
    // asserting.
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const server = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });

    const worstAllowed = Math.max(...FIXTURE_WORDS.map(toleranceFor));
    expect(server.spaceWidth).toBeGreaterThan(worstAllowed * 5);
  });
});
