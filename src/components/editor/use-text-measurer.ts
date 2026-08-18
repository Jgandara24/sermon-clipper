"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TextMeasurer } from "@/lib/editor/caption-layout";
import { resolveCaptionFont } from "@/lib/editor/fonts";

/**
 * Browser-side text measurement for caption layout: canvas 2D measureText against the same
 * self-hosted faces the worker measures with fontkit. Measuring before the webfont loads
 * yields fallback-font widths (and a one-frame caption jump when the real font arrives), so
 * consumers get `ready` and should treat pre-ready layout as provisional.
 */
export function useTextMeasurer(fontFamily: string, fontWeight: number): {
  measure: TextMeasurer;
  ready: boolean;
} {
  const font = resolveCaptionFont(fontFamily);
  const fontKey = `${font.cssFamily}|${fontWeight}`;
  // Readiness is keyed by font, so switching family resets it without a setState-in-effect.
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const ready = readyKey === fontKey;
  const cacheRef = useRef(new Map<string, number>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (typeof document === "undefined" || !("fonts" in document)) {
      queueMicrotask(() => {
        if (!cancelled) setReadyKey(fontKey);
      });
      return;
    }
    document.fonts
      .load(`${fontWeight} 40px "${font.cssFamily}"`)
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setReadyKey(fontKey);
      });
    return () => {
      cancelled = true;
    };
  }, [font.cssFamily, fontWeight, fontKey]);

  const measure = useCallback<TextMeasurer>(
    (text, fontPx, family, weight) => {
      const resolved = resolveCaptionFont(family);
      // `ready` participates in the key so provisional (fallback-font) widths never serve
      // after the real face has loaded.
      const key = `${ready}|${resolved.cssFamily}|${weight}|${fontPx}|${text}`;
      const cached = cacheRef.current.get(key);
      if (cached !== undefined) return cached;
      if (typeof document === "undefined") return text.length * (fontPx / 2);
      canvasRef.current ??= document.createElement("canvas");
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return text.length * (fontPx / 2);
      ctx.font = `${weight} ${fontPx}px "${resolved.cssFamily}"`;
      const width = ctx.measureText(text).width;
      cacheRef.current.set(key, width);
      return width;
    },
    [ready],
  );

  return { measure, ready };
}
