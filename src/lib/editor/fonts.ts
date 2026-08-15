/**
 * Registry of the caption fonts shipped in public/fonts (and copied into the worker image at
 * /usr/share/fonts/truetype/custom — see Dockerfile.worker). Everything that names a font
 * resolves through here so three consumers can never disagree:
 *  - the browser preview (cssFamily via @font-face in globals.css),
 *  - the ASS generator (assFontName must equal the family name fc-list reports),
 *  - fontkit text measurement (files, keyed by weight).
 *
 * ASS's Bold flag is binary, so reliable non-400/700 weights go through the sub-family name
 * fontconfig registers for the static instance (e.g. "Inter ExtraBold"), not a weight number.
 */

export type CaptionFont = {
  /** Stable id stored in overrides.fontFamily (also accepts full legacy CSS stacks). */
  id: string;
  label: string;
  cssFamily: string;
  /** TTF filename per supported weight, relative to the font directory. */
  files: Record<number, string>;
  /** fontconfig family name per weight — what the ASS Fontname must be. */
  assFontNames: Record<number, string>;
};

export const CAPTION_FONTS: CaptionFont[] = [
  {
    id: "inter",
    label: "Inter",
    cssFamily: "Inter",
    files: {
      400: "Inter-Regular.ttf",
      600: "Inter-SemiBold.ttf",
      700: "Inter-Bold.ttf",
      800: "Inter-ExtraBold.ttf",
    },
    // Verified with fc-scan: SemiBold/ExtraBold register their own sub-family names; Regular
    // and Bold live under the base family (Bold selected via the ASS Bold flag).
    assFontNames: {
      400: "Inter",
      600: "Inter SemiBold",
      700: "Inter",
      800: "Inter ExtraBold",
    },
  },
  {
    id: "source-serif",
    label: "Source Serif",
    cssFamily: "Source Serif 4",
    files: {
      400: "SourceSerif4-Regular.ttf",
      600: "SourceSerif4-Semibold.ttf",
      700: "SourceSerif4-Bold.ttf",
    },
    assFontNames: {
      400: "Source Serif 4",
      600: "Source Serif 4 Semibold",
      700: "Source Serif 4",
    },
  },
  {
    id: "poppins",
    label: "Poppins",
    cssFamily: "Poppins",
    files: {
      400: "Poppins-Regular.ttf",
      600: "Poppins-SemiBold.ttf",
      700: "Poppins-Bold.ttf",
      800: "Poppins-ExtraBold.ttf",
    },
    assFontNames: {
      400: "Poppins",
      600: "Poppins SemiBold",
      700: "Poppins",
      800: "Poppins ExtraBold",
    },
  },
];

const FALLBACK_FONT = CAPTION_FONTS.find((font) => font.id === "poppins") ?? CAPTION_FONTS[0];

/**
 * Resolves a stored fontFamily value — a registry id ("inter") or a legacy CSS stack
 * ("Inter, system-ui, sans-serif" / "'Source Serif 4', Georgia, serif") — to a registry
 * entry. Unknown families fall back to Poppins rather than failing the render.
 */
export function resolveCaptionFont(fontFamily: string): CaptionFont {
  const first = fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return (
    CAPTION_FONTS.find(
      (font) => font.id === first || font.cssFamily.toLowerCase() === first,
    ) ?? FALLBACK_FONT
  );
}

/** Nearest supported weight at or below the request (else the lightest available). */
export function nearestFontWeight(font: CaptionFont, weight: number): number {
  const weights = Object.keys(font.files)
    .map(Number)
    .sort((a, b) => a - b);
  const atOrBelow = weights.filter((w) => w <= weight);
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : weights[0];
}

/** The ASS Fontname (fontconfig family) for a stored fontFamily + weight. */
export function assFontName(fontFamily: string, weight: number): string {
  const font = resolveCaptionFont(fontFamily);
  return font.assFontNames[nearestFontWeight(font, weight)];
}

/** Whether the resolved weight needs the ASS Bold flag (700 within a base family). */
export function assBoldFlag(fontFamily: string, weight: number): boolean {
  const font = resolveCaptionFont(fontFamily);
  const resolved = nearestFontWeight(font, weight);
  // Only weights served by the base family name use the Bold flag; sub-family instances
  // (SemiBold/ExtraBold) already carry their weight in the face itself.
  return resolved === 700 && font.assFontNames[700] === font.assFontNames[400];
}

/** The font file (relative to the font dir) for a stored fontFamily + weight. */
export function captionFontFile(fontFamily: string, weight: number): string {
  const font = resolveCaptionFont(fontFamily);
  return font.files[nearestFontWeight(font, weight)];
}
