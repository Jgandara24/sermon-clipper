import type { CaptionStyle } from "./caption-presets";

/**
 * Which face a caption style actually draws in.
 *
 * Both renderers have to answer this the same way or every measurement after it is wrong. The
 * burn-in used to take the first family of the stack and set libass's Bold flag from the weight,
 * inline; the preview handed the whole CSS stack to the browser. One rule, in one place, so the
 * word the browser measures and the glyphs libass draws come from the same file.
 */

/** The weights the bundled files are. Nothing else is available to draw with. */
export const CAPTION_REGULAR_WEIGHT = 400;
export const CAPTION_BOLD_WEIGHT = 700;

/** Where the burn-in's Bold flag has always been set. Kept here so the preview agrees with it. */
export function isBoldCaptionWeight(weight: number | undefined): boolean {
  return weight !== undefined && weight >= 600;
}

export type CaptionFace = {
  /** The family name, unquoted — the name both renderers ask for. */
  family: string;
  bold: boolean;
};

export function resolveCaptionFace(
  style: Pick<CaptionStyle, "fontFamily"> & { weight?: number },
): CaptionFace {
  return {
    family: style.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, ""),
    bold: isBoldCaptionWeight(style.weight),
  };
}

/**
 * The CSS `font` shorthand for a canvas measuring this face.
 *
 * The weight is the bundled file's own weight, not the style's number. Only a regular and a bold
 * file are shipped, so asking the browser for 800 when the file is 700 invites a synthesised
 * face — which measures differently from the file the burn-in opens, and would put the two
 * renderers back on separate metrics.
 */
export function captionFontShorthand(face: CaptionFace, sizePx: number): string {
  const weight = face.bold ? CAPTION_BOLD_WEIGHT : CAPTION_REGULAR_WEIGHT;
  // Two decimals rather than whole pixels: the em a caption is drawn at is not a round number
  // (48 becomes 41.23 for DejaVu Sans), and rounding it moved every word by a fraction.
  return `${weight} ${Math.round(sizePx * 100) / 100}px "${face.family}"`;
}

/**
 * Whether a loaded font face is the bundled one this caption needs.
 *
 * `document.fonts.check()` cannot answer this. It reports whether everything it *matched* is
 * loaded, so a family the document never declared comes back true — and the canvas then measures
 * a synthesised bold over some other face and reports a perfectly plausible width. That is how a
 * 10px disagreement per word reached the parity test with the browser insisting it was ready.
 *
 * So readiness is a positive statement instead: a face in this exact family, at this exact weight,
 * with status "loaded".
 */
export function isRequiredCaptionFaceEntry(
  entry: { family: string; weight: string; status: string },
  face: CaptionFace,
): boolean {
  const family = entry.family.trim().replace(/^['"]|['"]$/g, "");
  if (family !== face.family) return false;
  if (entry.status !== "loaded") return false;
  return entry.weight.trim() === String(face.bold ? CAPTION_BOLD_WEIGHT : CAPTION_REGULAR_WEIGHT);
}
