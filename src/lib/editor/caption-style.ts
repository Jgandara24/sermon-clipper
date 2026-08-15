import {
  CAPTION_STYLE_LIMITS,
  clampToLimit,
  getCaptionPreset,
  type CaptionStyle,
} from "./caption-presets";
import type { EditorState } from "./types";

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Colors flow straight into the ASS file (hexToAssColor) and inline CSS; a malformed stored
 * value falls back to the preset's color rather than corrupting the render. Coerced here, not
 * rejected in zod — old documents must keep saving.
 */
function coerceColor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const withHash = value.startsWith("#") ? value : `#${value}`;
  return HEX_COLOR_PATTERN.test(withHash) ? withHash.toUpperCase() : fallback;
}

/**
 * Applies an editor state's per-clip overrides on top of its caption preset. Shared by the
 * browser preview (DOM overlay) and the server render (ASS burn-in) so both draw from the same
 * resolved style instead of two implementations drifting apart.
 *
 * Resolution order: preset (already normalized) → overrides → clamp. The kinetic fields win
 * over their legacy aliases when both are present (positionY/anchor over position,
 * outlineColor over strokeColor).
 */
export function resolveCaptionStyle(
  presetId: string,
  overrides: EditorState["captions"]["overrides"],
): CaptionStyle {
  const preset = getCaptionPreset(presetId);
  const style: CaptionStyle = { ...preset.style };

  // Legacy overrides first, so their derived kinetic values can be overwritten below.
  if (overrides.position !== undefined) {
    style.position = overrides.position;
    style.positionY = overrides.position === "top" ? 8 : overrides.position === "middle" ? 50 : 88;
    style.anchor = overrides.position === "bottom" ? "bottom" : "center";
  }
  if (overrides.sizePx !== undefined) style.sizePx = overrides.sizePx;
  if (overrides.uppercase !== undefined) style.uppercase = overrides.uppercase;
  style.highlightColor = coerceColor(overrides.highlightColor, style.highlightColor);

  if (overrides.fontFamily !== undefined) style.fontFamily = overrides.fontFamily;
  if (overrides.fontWeight !== undefined) style.fontWeight = overrides.fontWeight;
  style.textColor = coerceColor(overrides.textColor, style.textColor);
  if (overrides.highlightMode !== undefined) style.highlightMode = overrides.highlightMode;
  if (overrides.highlightScale !== undefined) style.highlightScale = overrides.highlightScale;
  style.outlineColor = coerceColor(overrides.outlineColor, style.outlineColor);
  if (overrides.outlineWidthPx !== undefined) style.outlineWidthPx = overrides.outlineWidthPx;
  style.shadowColor = coerceColor(overrides.shadowColor, style.shadowColor);
  if (overrides.shadowDistancePx !== undefined) style.shadowDistancePx = overrides.shadowDistancePx;
  if (overrides.positionX !== undefined) style.positionX = overrides.positionX;
  if (overrides.positionY !== undefined) style.positionY = overrides.positionY;
  if (overrides.anchor !== undefined) style.anchor = overrides.anchor;
  if (overrides.safeAnchor !== undefined) style.safeAnchor = overrides.safeAnchor;

  style.sizePx = clampToLimit(style.sizePx, CAPTION_STYLE_LIMITS.sizePx);
  style.fontWeight = clampToLimit(style.fontWeight, CAPTION_STYLE_LIMITS.fontWeight);
  style.highlightScale = clampToLimit(style.highlightScale, CAPTION_STYLE_LIMITS.highlightScale);
  style.outlineWidthPx = clampToLimit(style.outlineWidthPx, CAPTION_STYLE_LIMITS.outlineWidthPx);
  style.shadowDistancePx = clampToLimit(
    style.shadowDistancePx,
    CAPTION_STYLE_LIMITS.shadowDistancePx,
  );
  style.positionX = clampToLimit(style.positionX, CAPTION_STYLE_LIMITS.positionX);
  style.positionY = clampToLimit(style.positionY, CAPTION_STYLE_LIMITS.positionY);
  style.maxWordsPerLine = clampToLimit(style.maxWordsPerLine, CAPTION_STYLE_LIMITS.maxWordsPerLine);

  return style;
}
