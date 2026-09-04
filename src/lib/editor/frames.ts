// Which frames the Video row shows, and which it still has to make.
//
// The row is a strip of square tiles across the window. Each tile shows the source at its own
// centre, rounded to a grid so a window that shifts a little reuses the frames it already has
// rather than seeking for every pixel of a drag. Pure, so the scheduling is tested without a
// video element; the extracting itself lives in the component.

import type { TrimViewport } from "./trim";

/** Tiles are square, the height of the Video row. */
export const FRAME_TILE_WIDTH_PX = 64;
/** The grid frames are cached on. Coarser than a tile ever moves in one drag frame. */
export const FRAME_KEY_MS = 250;

/** What a tile has settled into. A frame still being made is simply absent. */
export type FrameState = "ready" | "placeholder";

export function tileCountFor(widthPx: number, tileWidthPx = FRAME_TILE_WIDTH_PX): number {
  return Math.max(1, Math.round(widthPx / tileWidthPx));
}

export function frameKey(ms: number): number {
  return Math.round(ms / FRAME_KEY_MS) * FRAME_KEY_MS;
}

/** The source time each tile shows: its centre, on the cache grid. */
export function frameSlots(view: TrimViewport, tileCount: number): number[] {
  if (!(view.end > view.start) || tileCount < 1) return [];
  const span = view.end - view.start;
  return Array.from({ length: tileCount }, (_, index) =>
    frameKey(view.start + (span * (index + 0.5)) / tileCount),
  );
}

/**
 * The frames the window needs that are neither made nor given up on, left to right, once each.
 * A frame that could not be produced is not asked for again: the placeholder is the answer.
 */
export function pendingFrameKeys(
  slots: readonly number[],
  cache: ReadonlyMap<number, FrameState>,
): number[] {
  const pending: number[] = [];
  const seen = new Set<number>();
  for (const key of slots) {
    if (seen.has(key) || cache.has(key)) continue;
    seen.add(key);
    pending.push(key);
  }
  return pending;
}
