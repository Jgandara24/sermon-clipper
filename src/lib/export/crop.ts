import type { EditorState } from "@/lib/editor/types";

export type NormalizedCrop = { x: number; y: number; w: number; h: number };

const TARGET_ASPECT = 9 / 16;

/**
 * Static center crop to the 9:16 target aspect ratio, normalized to the source frame (guide
 * §14 "center" mode). Crops width or height, whichever the source has too much of.
 */
export function computeCenterCrop(sourceWidth: number, sourceHeight: number): NormalizedCrop {
  const sourceAspect = sourceWidth / sourceHeight;

  if (sourceAspect > TARGET_ASPECT) {
    const cropWidth = sourceHeight * TARGET_ASPECT;
    const x = (sourceWidth - cropWidth) / 2;
    return { x: x / sourceWidth, y: 0, w: cropWidth / sourceWidth, h: 1 };
  }

  const cropHeight = sourceWidth / TARGET_ASPECT;
  const y = (sourceHeight - cropHeight) / 2;
  return { x: 0, y: y / sourceHeight, w: 1, h: cropHeight / sourceHeight };
}

/**
 * Resolves the effective normalized crop rect for a layout mode against the real source
 * dimensions. "face" mode has no real face-tracking implementation yet (guide §14 marks full
 * per-frame tracking as Phase 8 polish) so it falls back to the same center crop as "center" —
 * matching the guide's own documented fallback behavior for low-confidence tracking.
 */
export function resolveCropRect(
  layout: EditorState["layout"],
  sourceWidth: number,
  sourceHeight: number,
): NormalizedCrop {
  if (layout.mode === "manual") {
    return layout.crop;
  }
  return computeCenterCrop(sourceWidth, sourceHeight);
}

/** Converts a normalized crop rect to even pixel dimensions ffmpeg's crop/scale filters require. */
export function cropRectToPixels(
  crop: NormalizedCrop,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; w: number; h: number } {
  // Floor (never round up) to even, so w/h can never exceed the source frame even when it has
  // an odd dimension.
  const toEvenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = Math.min(toEvenFloor(crop.w * sourceWidth), toEvenFloor(sourceWidth));
  const h = Math.min(toEvenFloor(crop.h * sourceHeight), toEvenFloor(sourceHeight));
  const x = Math.max(0, Math.min(sourceWidth - w, Math.round(crop.x * sourceWidth)));
  const y = Math.max(0, Math.min(sourceHeight - h, Math.round(crop.y * sourceHeight)));
  return { x, y, w, h };
}
