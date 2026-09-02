"use client";

import { useEffect, useMemo, useState } from "react";
import {
  captionFontShorthand,
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
};

function unready(font: string): CaptionTextMeasurer {
  return { measure: () => 0, spaceWidth: 0, ready: false, font };
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

    // `load` asks for this exact face rather than waiting on every font the page wants; `ready`
    // then covers the case where it had already resolved.
    void Promise.resolve(fonts.load(font))
      .then(() => fonts.ready)
      .then(() => {
        if (cancelled || !fonts.check(font)) return;
        setLoadedFont(font);
      })
      .catch(() => {
        // Leave it unready. A measurement now would be the fallback's metrics.
      });

    return () => {
      cancelled = true;
    };
  }, [font]);

  return useMemo(() => {
    if (loadedFont !== font || typeof document === "undefined") return unready(font);

    // A canvas is a measuring instrument, not rendered output, so it is built here rather than
    // held across renders. It is only ever built once the face is ready, which is rare.
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return unready(font);

    context.font = font;
    const measure: CaptionWordMeasurer = (text) =>
      text.length === 0 ? 0 : context.measureText(text).width;
    return { measure, spaceWidth: measure(" "), ready: true, font };
  }, [loadedFont, font]);
}
