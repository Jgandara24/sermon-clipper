import { SAFE_AREA_VALUES } from "@/lib/editor/social-safe-area-values";

/**
 * The frame's reserved edges, stated once and read by everything that places anything.
 *
 * Before this existed the same idea was written down in five places and disagreed with itself in
 * three of them: the canvas guide drew the top band at 6 percent, the burn-in put a top-anchored
 * caption at 8, and the preview's own resting position put it at 10. A guide drawn from one number
 * and a caption placed by another is drift a viewer sees and no test catches — and the title
 * overlay was about to add a sixth copy.
 *
 * Nothing here moves anything. Every value is what its consumer already used, so no stored clip
 * re-renders; what changes is that there is now one place to move them from.
 */

export const SOCIAL_SAFE_AREA = SAFE_AREA_VALUES;
export const SOCIAL_SAFE_AREA_VERSION = SAFE_AREA_VALUES.version;

/** Where a thing can be pinned. `custom` means the document carries its own point instead. */
export type SafeAreaAnchor = "top-safe" | "center" | "bottom-safe" | "custom";

/** A fraction of the frame, as the percentage string CSS wants. */
function pct(fraction: number): string {
  return `${+(fraction * 100).toFixed(4)}%`;
}

/**
 * The fraction of the frame's height an anchored edge sits at.
 *
 * Derived, not listed. The bottom anchor is the chrome edge itself; the top one sits a stated
 * padding below the top band, which is what the burn-in has always done.
 */
export function safeAreaAnchorY(anchor: Exclude<SafeAreaAnchor, "custom">): number {
  if (anchor === "top-safe") return SAFE_AREA_VALUES.chrome.top + SAFE_AREA_VALUES.topPadding;
  if (anchor === "bottom-safe") return 1 - SAFE_AREA_VALUES.chrome.bottom;
  return 0.5;
}

/**
 * The vertical margin the ASS style line declares, in pixels.
 *
 * A margin is a distance from an edge, not a position: a top-anchored caption is that far below
 * the top, a bottom-anchored one that far above the bottom, and a centred one needs neither.
 */
export function captionMarginVPx(
  position: "top" | "middle" | "bottom",
  videoHeight: number,
): number {
  if (position === "top") return Math.round(videoHeight * safeAreaAnchorY("top-safe"));
  if (position === "middle") return 0;
  return Math.round(videoHeight * (1 - safeAreaAnchorY("bottom-safe")));
}

/** The caption's left and right margin in the exported file. */
export function captionMarginHPx(): number {
  return SAFE_AREA_VALUES.captionMarginHPx;
}

/** How wide a caption row may be before it has to wrap. */
export function captionMaxWidthPx(videoWidth: number): number {
  return videoWidth - captionMarginHPx() * 2;
}

/**
 * Where an undragged caption sits in the preview, as the centre of its block on the canvas.
 *
 * Derived from the burn-in's own margin, not listed. The burn-in anchors an edge: a bottom
 * caption's last row sits on the bottom margin line and rows grow upward, a top caption's first
 * row sits on the top margin line and rows grow downward, and a middle caption is centred on the
 * frame. The canvas object is positioned by its centre, so the centre is that edge moved in by
 * half the block, where the block is `rows` rows pitched at the caption's size, which is the pitch
 * the burn-in uses.
 *
 * Until 2026-09-05 this returned its own set of fractions (0.86, 0.1, 0.45), and the preview then
 * shifted multi-row blocks to keep an edge still. The two renderers disagreed by a constant per
 * position, 96px in the middle case. Nothing rendered reads this function, so changing it moved
 * no stored clip; it moved the preview onto the file.
 */
export function captionRestCentre(
  position: "top" | "middle" | "bottom",
  block: { rows: number; sizePx: number; videoHeight: number },
): { xPct: number; yPct: number } {
  const halfBlock = (Math.max(1, block.rows) * block.sizePx) / 2;
  const margin = captionMarginVPx(position, block.videoHeight);
  const centreY =
    position === "top"
      ? margin + halfBlock
      : position === "middle"
        ? block.videoHeight / 2
        : block.videoHeight - margin - halfBlock;
  return { xPct: 0.5, yPct: centreY / block.videoHeight };
}

/** The canvas guide, as the percentages the overlay is drawn with. */
export function safeAreaGuideGeometry(): {
  left: string;
  right: string;
  top: string;
  bottom: string;
  topBandHeight: string;
  bottomBandHeight: string;
} {
  const { chrome } = SAFE_AREA_VALUES;
  return {
    left: pct(chrome.left),
    right: pct(chrome.right),
    top: pct(chrome.top),
    bottom: pct(chrome.bottom),
    topBandHeight: pct(chrome.top),
    bottomBandHeight: pct(chrome.bottom),
  };
}

/** The brand template's lower third, off the same side margins as the guide. */
export function lowerThirdGeometry(): { left: string; right: string; bottom: string } {
  const { chrome, lowerThirdBottom } = SAFE_AREA_VALUES;
  return { left: pct(chrome.left), right: pct(chrome.right), bottom: pct(lowerThirdBottom) };
}
