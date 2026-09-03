"use client";

import { useEffect, useMemo, useState } from "react";
import {
  captionFontShorthand,
  isRequiredCaptionFaceEntry,
  resolveCaptionFace,
  type CaptionFace,
} from "@/lib/editor/caption-face";
import type { CaptionWordMeasurer } from "@/lib/editor/caption-layout";

/**
 * The browser half of the measured caption layout.
 *
 * `caption-layout.ts` positions words from widths. On the worker fontkit supplies them; here a 2D
 * canvas does, over the same bundled face, resolved by the same rule.
 *
 * Nothing may be positioned from an unready measurer. A canvas asked to measure before the
 * `@font-face` file has loaded answers in the fallback's metrics, and the answer looks perfectly
 * valid — Slice 7 measured a fallback once and paid for it. So this reports zero and `ready:
 * false` until the exact face is loaded, which is a width no caller can mistake for a real one.
 */

export type CaptionTextMeasurer = {
  measure: CaptionWordMeasurer;
  /** Advance width of one space in this face and size. Zero until `ready`. */
  spaceWidth: number;
  /** False until the bundled face is loaded and measurements mean anything. */
  ready: boolean;
  /** The CSS shorthand measured with, so a caller can prove which face answered. */
  font: string;
  /**
   * The em to draw at, which is smaller than the caption's own size.
   *
   * An ASS font size is a height, not an em: libass scales the face so its ascent plus descent
   * equals the number. Drawing the preview at the number itself made its captions about a sixth
   * larger than the exported file's, and measuring at it put an extra space between every pair of
   * words. Zero until `ready`.
   */
  emPx: number;
};

function unready(font: string): CaptionTextMeasurer {
  return { measure: () => 0, spaceWidth: 0, ready: false, font, emPx: 0 };
}

export function useCaptionTextMeasurer(style: {
  fontFamily: string;
  sizePx: number;
  weight?: number;
}): CaptionTextMeasurer {
  const { fontFamily, sizePx, weight } = style;

  const face: CaptionFace = useMemo(
    () => resolveCaptionFace({ fontFamily, weight }),
    [fontFamily, weight],
  );
  const font = useMemo(() => captionFontShorthand(face, sizePx), [face, sizePx]);

  // The font that finished loading, rather than a boolean. Readiness is then a comparison against
  // the font currently being asked for, so changing face or size cannot leave a stale `true`
  // behind, and nothing has to be set back to false when it changes.
  const [loadedFont, setLoadedFont] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (typeof document === "undefined") return;

    const fonts = document.fonts;
    if (!fonts) {
      // No Font Loading API: which face answered would be a guess, so this stays unready and the
      // caller keeps its unmeasured path.
      return;
    }

    // Settle the document's own font loading first, so the `@font-face` rules are registered
    // before this asks for one of them; then ask for this exact face and let that settle too.
    void Promise.resolve(fonts.ready)
      .then(() => fonts.load(font))
      .then(() => fonts.ready)
      .then(() => {
        if (cancelled) return;
        // Deliberately not `fonts.check(font)`. It reports whether everything it matched is
        // loaded, so a family the document never declared comes back true, and the canvas then
        // measures a synthesised bold over another face and returns a plausible width.
        const loaded = [...fonts].some((entry) => isRequiredCaptionFaceEntry(entry, face));
        if (loaded) setLoadedFont(font);
      })
      .catch(() => {
        // Leave it unready. A measurement now would be the fallback's metrics.
      });

    return () => {
      cancelled = true;
    };
  }, [font, face]);

  return useMemo(() => {
    if (loadedFont !== font || typeof document === "undefined") return unready(font);

    // A canvas is a measuring instrument, not rendered output, so it is built here rather than
    // held across renders. It is only ever built once the face is ready, which is rare.
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return unready(font);

    // What the caption's size means to the burn-in, asked of the face itself rather than assumed.
    // A probe at the nominal size reports the face's ascent plus descent at that size; the em that
    // makes that height equal the caption's size is what libass will draw.
    context.font = font;
    const probe = context.measureText("M");
    const boxHeight = probe.fontBoundingBoxAscent + probe.fontBoundingBoxDescent;
    const emPx = boxHeight > 0 ? (sizePx * sizePx) / boxHeight : sizePx;

    const drawFont = captionFontShorthand(face, emPx);
    context.font = drawFont;
    const measure: CaptionWordMeasurer = (text) =>
      text.length === 0 ? 0 : context.measureText(text).width;
    return { measure, spaceWidth: measure(" "), ready: true, font: drawFont, emPx };
  }, [loadedFont, font, face, sizePx]);
}
