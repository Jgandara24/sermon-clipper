import { accessSync, constants } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
import type { TextMeasurer } from "@/lib/editor/caption-layout";
import { CAPTION_FONTS, captionFontFile, resolveCaptionFont, nearestFontWeight } from "@/lib/editor/fonts";

function readable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Names every shipped caption face the given directory cannot supply.
 *
 * The worker readiness gate reports missing caption fonts as degraded, because a caption asset
 * must not stop TRANSCRIBE, PROBE, ANALYZE, and FINALIZE. Caption burn-in is the one job path
 * the fonts actually gate, so the export refuses here instead of silently rendering whatever
 * face libass falls back to — a wrong typeface in a delivered clip is worse than a failed job.
 */
export function missingCaptionFontFiles(
  fontDir: string,
  fileReadable: (filePath: string) => boolean = readable,
): string[] {
  return CAPTION_FONTS.flatMap((font) => Object.values(font.files)).filter(
    (file) => !fileReadable(path.join(fontDir, file)),
  );
}

/**
 * Worker-side text measurement for caption layout, backed by fontkit against the exact TTFs
 * libass will burn with (same directory the Dockerfile registers with fontconfig). Font I/O
 * is lazy and cached per (family, weight) — nothing is read at import time, which keeps the
 * esbuild worker bundle inert until the first render.
 */
export function createFontkitMeasurer(fontDir: string): TextMeasurer {
  const fonts = new Map<string, Font>();

  function loadFont(fontFamily: string, fontWeight: number): Font {
    const font = resolveCaptionFont(fontFamily);
    const weight = nearestFontWeight(font, fontWeight);
    const key = `${font.id}:${weight}`;
    let loaded = fonts.get(key);
    if (!loaded) {
      const filePath = path.join(fontDir, captionFontFile(fontFamily, fontWeight));
      loaded = fontkit.openSync(filePath) as Font;
      fonts.set(key, loaded);
    }
    return loaded;
  }

  return (text, fontPx, fontFamily, fontWeight) => {
    if (text.length === 0) return 0;
    const font = loadFont(fontFamily, fontWeight);
    const run = font.layout(text);
    return (run.advanceWidth / font.unitsPerEm) * fontPx;
  };
}
