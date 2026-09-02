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
 * Measured, not guessed: on Chromium the two agree exactly on this fixture. The allowance exists
 * for shaping and rounding differences across browser versions, and is a small fraction of the
 * space between words, so no disagreement inside it can put two words on top of each other.
 */
const TOLERANCE_PX = 0.5;

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
    const worst = Math.max(...deltas, Math.abs(browser.space - server.spaceWidth));
    // Reported so a future disagreement arrives with its size rather than only a pass or a fail.
    test.info().annotations.push({
      type: "measurer parity",
      description: `worst disagreement ${worst.toFixed(6)}px at ${style.sizePx}px in ${font}`,
    });

    for (const [index, word] of FIXTURE_WORDS.entries()) {
      expect(
        deltas[index],
        `${word}: browser ${browser.widths[index]}, fontkit ${serverWidths[index]}`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
    expect(Math.abs(browser.space - server.spaceWidth)).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  test("a disagreement stays far smaller than the space it must not close", async ({ page }) => {
    // The tolerance is only safe if it cannot produce a collision. One space at this size is the
    // gap the layout puts between words, so the allowance has to be a small part of it.
    const style = getCaptionPreset("highlighter").style;
    const face = resolveCaptionFace(style);
    const server = createCaptionMeasurer({
      family: face.family,
      bold: face.bold,
      sizePx: style.sizePx,
    });

    await page.goto("/login");
    expect(server.spaceWidth).toBeGreaterThan(TOLERANCE_PX * 10);
  });
});
