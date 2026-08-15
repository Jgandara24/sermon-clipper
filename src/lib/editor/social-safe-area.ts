export type CaptionSafeAnchor = "top-safe" | "center" | "bottom-safe" | "custom";

/**
 * Product-owned, conservative safe area for a 9:16 video. The profile is versioned because
 * social-app chrome changes over time. Platform previews can be added without changing the
 * persisted caption coordinates.
 */
export const UNIVERSAL_SOCIAL_SAFE_AREA = {
  id: "universal-social",
  version: 1,
  aspectRatio: "9:16",
  insetTopPct: 14,
  insetRightPct: 16,
  insetBottomPct: 22,
  insetLeftPct: 8,
} as const;

export function safeAreaBounds(frame: { width: number; height: number }) {
  return {
    top: (UNIVERSAL_SOCIAL_SAFE_AREA.insetTopPct / 100) * frame.height,
    right:
      frame.width - (UNIVERSAL_SOCIAL_SAFE_AREA.insetRightPct / 100) * frame.width,
    bottom:
      frame.height - (UNIVERSAL_SOCIAL_SAFE_AREA.insetBottomPct / 100) * frame.height,
    left: (UNIVERSAL_SOCIAL_SAFE_AREA.insetLeftPct / 100) * frame.width,
  };
}
