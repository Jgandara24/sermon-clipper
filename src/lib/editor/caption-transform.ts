export type CaptionResizeCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export function resizeCaptionFromCorner({
  corner,
  pointerX,
  pointerY,
  centerX,
  centerY,
  boundsWidth,
  boundsHeight,
  startSizePx,
  minSizePx,
  maxSizePx,
}: {
  corner: CaptionResizeCorner;
  pointerX: number;
  pointerY: number;
  centerX: number;
  centerY: number;
  boundsWidth: number;
  boundsHeight: number;
  startSizePx: number;
  minSizePx: number;
  maxSizePx: number;
}): number {
  const signX = corner.endsWith("right") ? 1 : -1;
  const signY = corner.startsWith("bottom") ? 1 : -1;
  const startVectorX = (signX * boundsWidth) / 2;
  const startVectorY = (signY * boundsHeight) / 2;
  const denominator = startVectorX ** 2 + startVectorY ** 2;
  if (denominator === 0) return startSizePx;

  const pointerVectorX = pointerX - centerX;
  const pointerVectorY = pointerY - centerY;
  const scale =
    (pointerVectorX * startVectorX + pointerVectorY * startVectorY) / denominator;
  return Math.min(maxSizePx, Math.max(minSizePx, Math.round(startSizePx * scale)));
}
