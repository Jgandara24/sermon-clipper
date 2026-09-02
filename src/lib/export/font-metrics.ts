import path from "node:path";
import { openSync, type Font } from "fontkit";
import { BUNDLED_CAPTION_FONTS } from "@/lib/editor/caption-fonts";
import { captionFontDir } from "@/lib/env";
import type { CaptionWordMeasurer } from "@/lib/editor/caption-layout";

/**
 * Measures caption text on the worker, from the same files the burn-in draws with.
 *
 * `caption-layout.ts` positions words but holds no fonts. This is the half that opens one, for
 * the server side. The browser has its own measurer over the same faces, and a test asserts the
 * two agree.
 *
 * There is deliberately no fallback face. libass substitutes silently when a family is missing,
 * and a measurer that did the same would put the preview and the rendered file on different
 * metrics without either side saying so — which is the whole class of defect the bundled-face
 * rule exists to prevent. An unbundled family raises instead, and the caller keeps the
 * unmeasured, whole-run path that legacy presets already use.
 */

/** A caption face was asked for that this repository does not ship. */
export class UnbundledCaptionFaceError extends Error {
  constructor(family: string) {
    super(`No bundled caption face for "${family}".`);
    this.name = "UnbundledCaptionFaceError";
  }
}

/**
 * The file a bundled family and weight resolve to, or null when the family is not bundled.
 *
 * The family must match exactly. A loose match is how a preset asking for "DejaVu" would quietly
 * receive a face nobody chose.
 */
export function resolveBundledFontFile(family: string, bold: boolean): string | null {
  const font = BUNDLED_CAPTION_FONTS.find((candidate) => candidate.family === family);
  if (!font) return null;
  return path.join(captionFontDir(), path.basename(bold ? font.boldFile : font.regularFile));
}

// Opening and parsing a TTF is the expensive part, and one render measures a word at a time.
const openedFaces = new Map<string, Font>();

function openFace(filePath: string): Font {
  const cached = openedFaces.get(filePath);
  if (cached) return cached;
  const face = openSync(filePath) as Font;
  openedFaces.set(filePath, face);
  return face;
}

export type CaptionMeasurer = {
  /** Advance width of a string at the requested size, in pixels. */
  measure: CaptionWordMeasurer;
  /** Advance width of one space, in the same face and size. */
  spaceWidth: number;
  /** The file the measurements came from, so a caller can prove which face was used. */
  filePath: string;
};

export function createCaptionMeasurer(params: {
  family: string;
  bold: boolean;
  sizePx: number;
}): CaptionMeasurer {
  const filePath = resolveBundledFontFile(params.family, params.bold);
  if (!filePath) {
    throw new UnbundledCaptionFaceError(params.family);
  }

  const face = openFace(filePath);
  const scale = params.sizePx / face.unitsPerEm;
  const measure: CaptionWordMeasurer = (text) =>
    text.length === 0 ? 0 : face.layout(text).advanceWidth * scale;

  return { measure, spaceWidth: measure(" "), filePath };
}
