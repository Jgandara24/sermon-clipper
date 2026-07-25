import { getCaptionPreset, type CaptionStyle } from "./caption-presets";
import type { EditorState } from "./types";

/**
 * Applies an editor state's per-clip overrides on top of its caption preset. Shared by the
 * browser preview (DOM overlay) and the server render (ASS burn-in) so both draw from the same
 * resolved style instead of two implementations drifting apart.
 */
export function resolveCaptionStyle(
  presetId: string,
  overrides: EditorState["captions"]["overrides"],
): CaptionStyle {
  const preset = getCaptionPreset(presetId);
  const style: CaptionStyle = { ...preset.style };
  if (overrides.sizePx !== undefined) style.sizePx = overrides.sizePx;
  if (overrides.position !== undefined) style.position = overrides.position;
  if (overrides.uppercase !== undefined) style.uppercase = overrides.uppercase;
  if (overrides.highlightColor !== undefined) style.highlightColor = overrides.highlightColor;
  if (overrides.fontFamily !== undefined) style.fontFamily = overrides.fontFamily;
  if (overrides.bold !== undefined) style.bold = overrides.bold;
  if (overrides.textColor !== undefined) style.textColor = overrides.textColor;
  if (overrides.offset !== undefined) style.offset = overrides.offset;
  return style;
}
