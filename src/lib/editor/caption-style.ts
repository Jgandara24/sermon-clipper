import { getCaptionPreset, type CaptionStyle } from "./caption-presets";
import { resolveTextCase } from "./text-case";
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
  // A dragged position wins over the discrete one, in the preview and in the burn-in alike.
  style.box = overrides.box ?? null;
  // One case model, and one place that decides which case a stored document means. A clip saved
  // before the model existed carries only the old boolean, and it keeps rendering exactly as it
  // did: true was upper-cased, false was untouched.
  style.textCase = resolveTextCase({
    textCase: overrides.textCase,
    legacyUppercase: overrides.uppercase,
    fallback: preset.style.textCase,
  });
  if (overrides.highlightColor !== undefined) style.highlightColor = overrides.highlightColor;
  return style;
}
